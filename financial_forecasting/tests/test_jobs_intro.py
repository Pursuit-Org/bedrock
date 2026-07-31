"""Evals for the intro-request flow.

  GET /api/jobs/intro-requests   — staff asks (bedrock) + builder asks (Sputnik)
  services/intro_notification_poller — fans Sputnik asks into the Bedrock bot

The regression these lock down: builder asks rendered as "from —" because the
route joined public.users directly. That table has RLS enabled and the app role
has no policy on it, so the LEFT JOIN matched nothing *silently* and
trim(coalesce(...)) produced '' rather than NULL. Builder identity must come
from bedrock.builder_by_id (SECURITY DEFINER).
"""
from datetime import datetime, timezone

import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client

STAFF_ID = 4
CREATED = datetime(2026, 6, 15, 23, 37, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _builder_row(**ov):
    row = {
        "intro_request_id": 15, "contact_id": 8577, "contact_name": "Paul de Lucena",
        "contact_company": "Unlocked Labs", "contact_title": "CTO",
        "specific_ask": "industry_advice", "request_context": "his background…",
        "status": "pending", "staff_response_notes": None, "responded_at": None,
        "created_at": CREATED, "builder_id": 428,
        "builder_name": "Adedoyin Ahoton", "builder_email": "adedoyin.ahoton@pursuit.org",
        "builder_cohort": "March 2025",
        # Only selected by the poller, ignored by the route.
        "staff_user_id": STAFF_ID, "staff_email": "joanna@pursuit.org",
    }
    row.update(ov)
    return row


def _conn(builder_rows):
    return FakeConn(
        lists={
            "FROM bedrock.intro_request ir": [],
            "FROM public.intro_requests ir": builder_rows,
        },
        vals={"SELECT staff_user_id FROM bedrock.staff_user_id_map": STAFF_ID},
    )


# ── builder identity ────────────────────────────────────────────────────────

def test_builder_ask_surfaces_the_builder_name():
    """The actual reported bug: this used to come back as ''."""
    conn = _conn([_builder_row()])
    r = make_jobs_client(conn).get("/api/jobs/intro-requests?box=inbox")
    assert r.status_code == 200, r.text
    row = next(d for d in r.json()["data"] if d["source"] == "builder")
    assert row["requested_by_name"] == "Adedoyin Ahoton"
    assert row["builder_id"] == 428
    assert row["builder_cohort"] == "March 2025"


def test_builder_lookup_goes_through_the_security_definer_function():
    """Guard the root cause, not just the symptom — a direct public.users join
    silently returns nothing under RLS."""
    conn = _conn([_builder_row()])
    make_jobs_client(conn).get("/api/jobs/intro-requests?box=inbox")
    sputnik_sql = next(q for q in conn.queries() if "FROM public.intro_requests ir" in q)
    assert "bedrock.builder_by_id" in sputnik_sql
    assert "JOIN public.users" not in sputnik_sql


@pytest.mark.parametrize("overrides,expected", [
    ({}, "Adedoyin Ahoton"),
    # builder_by_id concatenates first||' '||last, so a NULL half yields NULL.
    ({"builder_name": None}, "adedoyin.ahoton@pursuit.org"),
    ({"builder_name": "  "}, "adedoyin.ahoton@pursuit.org"),
    ({"builder_name": None, "builder_email": None}, "Builder #428"),
])
def test_builder_display_never_falls_through_to_a_dash(overrides, expected):
    conn = _conn([_builder_row(**overrides)])
    r = make_jobs_client(conn).get("/api/jobs/intro-requests?box=inbox")
    row = next(d for d in r.json()["data"] if d["source"] == "builder")
    assert row["requested_by_name"] == expected
    # The frontend renders `requested_by_name || requested_by || "—"`; both
    # being blank is what produced the em dash.
    assert row["requested_by_name"].strip()


# ── vocabulary / status ─────────────────────────────────────────────────────

def test_every_sputnik_ask_value_has_a_label():
    """The CHECK constraint on public.intro_requests allows these six; an
    unlabelled value leaked the raw enum into the Slack DM."""
    from routes.jobs_intro import ASK_LABELS
    for value in ("job_referral", "informational_interview", "demo_feedback",
                  "industry_advice", "introductory_call", "other"):
        assert value in ASK_LABELS, value


def test_completed_stays_distinct_from_accepted():
    """Mapping completed→approved collapsed "I'll do it" into "I did it"."""
    from routes.jobs_intro import BUILDER_STATUS_MAP
    assert BUILDER_STATUS_MAP["accepted"] == "approved"
    assert BUILDER_STATUS_MAP["completed"] == "completed"


# ── poller ──────────────────────────────────────────────────────────────────

class FakeAcquire:
    def __init__(self, conn): self._conn = conn
    async def __aenter__(self): return self._conn
    async def __aexit__(self, *a): return False


class FakePool:
    def __init__(self, conn): self._conn = conn
    def acquire(self): return FakeAcquire(self._conn)


def _poller_conn(*, watermark, rows):
    return FakeConn(
        rows={"SELECT last_seen FROM bedrock.notification_watermark": (
            {"last_seen": watermark} if watermark else None)},
        lists={"FROM public.intro_requests ir": rows},
        vals={"SELECT last_seen FROM bedrock.notification_watermark": watermark},
    )


@pytest.fixture
def _captured(monkeypatch):
    """Swap enqueue_notification so no Slack dispatch task is spawned."""
    import services.intro_notification_poller as poller
    sent = []

    async def _fake(conn, *, recipient_email, type, payload, actor_email=None):
        sent.append({"to": recipient_email, "type": type, "payload": payload,
                     "actor": actor_email})
        return "notif-1"

    monkeypatch.setattr(poller, "enqueue_notification", _fake)
    return sent


def test_first_run_seeds_the_watermark_and_skips_the_backlog(monkeypatch, _captured):
    """There are months of pending asks in the table; replaying them would DM
    the whole team about every historical request."""
    import asyncio
    from dependencies import _services
    import services.intro_notification_poller as poller

    conn = _poller_conn(watermark=None, rows=[_builder_row(staff_email="joanna@pursuit.org")])
    monkeypatch.setitem(_services, "db_pool", FakePool(conn))

    result = asyncio.run(poller.poll_once())
    assert result[poller.SOURCE_BUILDER_INTRO] == 0
    assert _captured == []
    assert conn.ran("INSERT INTO bedrock.notification_watermark")


def test_new_ask_notifies_the_connector_staff_once(monkeypatch, _captured):
    import asyncio
    from dependencies import _services
    import services.intro_notification_poller as poller

    row = _builder_row(staff_user_id=STAFF_ID, staff_email="joanna@pursuit.org")
    conn = _poller_conn(watermark=datetime(2026, 6, 1, tzinfo=timezone.utc), rows=[row])
    monkeypatch.setitem(_services, "db_pool", FakePool(conn))

    result = asyncio.run(poller.poll_once())
    assert result[poller.SOURCE_BUILDER_INTRO] == 1
    assert len(_captured) == 1
    sent = _captured[0]
    assert sent["to"] == "joanna@pursuit.org"
    assert sent["payload"]["requester_kind"] == "builder"
    assert sent["payload"]["actor_display_name"] == "Adedoyin Ahoton"
    assert sent["payload"]["ask"] == "Industry advice"      # not "industry_advice"
    # Watermark advanced to the newest row so the next poll won't resend.
    bumps = conn.executed("UPDATE bedrock.notification_watermark")
    assert len(bumps) == 1
    assert bumps[0][2][1] == CREATED


def test_unmappable_staff_id_is_skipped_without_pinning_the_watermark(monkeypatch, _captured):
    """A staff_user_id missing from staff_user_id_map must not stall the
    watermark, or every later poll re-scans it forever."""
    import asyncio
    from dependencies import _services
    import services.intro_notification_poller as poller

    conn = _poller_conn(watermark=datetime(2026, 6, 1, tzinfo=timezone.utc),
                        rows=[_builder_row(staff_email=None)])
    monkeypatch.setitem(_services, "db_pool", FakePool(conn))

    result = asyncio.run(poller.poll_once())
    assert result[poller.SOURCE_BUILDER_INTRO] == 0
    assert _captured == []
    bumps = conn.executed("UPDATE bedrock.notification_watermark")
    assert bumps[0][2][1] == CREATED


def test_watermark_is_locked_so_parallel_instances_cannot_double_notify(monkeypatch, _captured):
    """Every Cloud Run instance runs this loop; an unlocked read lets two of
    them pick up the same rows and DM the connector twice."""
    import asyncio
    from dependencies import _services
    import services.intro_notification_poller as poller

    conn = _poller_conn(watermark=datetime(2026, 6, 1, tzinfo=timezone.utc),
                        rows=[_builder_row()])
    monkeypatch.setitem(_services, "db_pool", FakePool(conn))
    asyncio.run(poller.poll_once())

    reads = [q for q in conn.queries() if "notification_watermark" in q and "SELECT" in q]
    assert reads and all("FOR UPDATE" in q for q in reads), reads


def test_poller_reads_builder_identity_via_security_definer(monkeypatch, _captured):
    import asyncio
    from dependencies import _services
    import services.intro_notification_poller as poller

    conn = _poller_conn(watermark=datetime(2026, 6, 1, tzinfo=timezone.utc),
                        rows=[_builder_row(staff_email="joanna@pursuit.org")])
    monkeypatch.setitem(_services, "db_pool", FakePool(conn))
    asyncio.run(poller.poll_once())

    sql = next(q for q in conn.queries() if "FROM public.intro_requests ir" in q)
    assert "bedrock.builder_by_id" in sql
    assert "JOIN public.users" not in sql
