"""Evals for GET /api/jobs/opportunities/overview (the Jobs → Pipeline tab).

Two regressions, both reported 2026-09-29:
  * Stalled counted opportunities CREATED 6+ weeks ago, so deals worked every
    week read as stalled. It now measures from the last movement.
  * Closed won counted every stage-history row into closed_won, so a close
    reverted seconds later (RXR's full-time deal) counted as a win.
"""
from datetime import datetime, timedelta, timezone

import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client

NOW = datetime.now(timezone.utc)
UUID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
UUID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _set_row(id_, name, *, created_days, moved_days, touch_days=None, priority=None):
    created = NOW - timedelta(days=created_days)
    return {
        "id": id_, "account_name": name, "stage": "active_in_discussions", "deal_type": "ft",
        "segment": None, "owner_email": "a@p.org", "priority": priority, "created_at": created,
        "entered_stage": created, "stage_from_created": True,
        "opp_activity": None, "last_stage_change": None, "account_activity": None,
        "last_touch": None if touch_days is None else NOW - timedelta(days=touch_days),
        "last_movement": NOW - timedelta(days=moved_days),
    }


class OverviewConn(FakeConn):
    """Routes the two closed-stage queries by their to_stage argument, which a
    substring match can't tell apart."""
    def __init__(self, set_rows, won=None, lost=None, moved=None):
        super().__init__(lists={"WITH acct_last": set_rows,
                                "h.from_stage, h.to_stage": moved or []})
        self._closed = {"closed_won": won or [], "closed_lost": lost or []}

    async def fetch(self, query, *args):
        if "last_change" in query:
            self.calls.append(("fetch", query, args))
            return self._closed[args[4]]
        return await super().fetch(query, *args)


def test_stalled_measures_last_movement_not_creation():
    rows = [
        # Created 90 days ago but touched 3 days ago: live, not stalled.
        _set_row(UUID_A, "Worked", created_days=90, moved_days=3, touch_days=3),
        # Nothing for 60 days: stalled.
        _set_row(UUID_B, "Quiet", created_days=60, moved_days=60),
    ]
    c = make_jobs_client(OverviewConn(rows))
    d = c.get("/api/jobs/opportunities/overview?deal_type=ft").json()["data"]
    assert d["summary"]["stalled"] == 1
    assert [r["account"] for r in d["drills"]["stalled"]] == ["Quiet"]


def test_stalled_is_four_weeks_everywhere_on_the_page():
    """D3: an opportunity is stalled after 4 weeks without movement. The
    card, its drill and the Stalled status all use that one rule (they used
    to say 6 weeks, 14 days and 21 days)."""
    rows = [
        _set_row(UUID_A, "Five weeks", created_days=90, moved_days=35, touch_days=35),
        _set_row(UUID_B, "Three weeks", created_days=90, moved_days=21, touch_days=21),
    ]
    c = make_jobs_client(OverviewConn(rows))
    d = c.get("/api/jobs/opportunities/overview").json()["data"]
    assert d["summary"]["stalled"] == 1
    assert d["summary"]["stalled_label"] == "No activity in 4+ weeks"
    assert [r["account"] for r in d["drills"]["stalled"]] == ["Five weeks"]
    assert {r["account"]: r["status"] for r in d["active_set"]} == {
        "Five weeks": "stalled", "Three weeks": "active"}


def test_comments_dont_keep_an_opportunity_alive():
    """D3: notes are comments, not activity, so they don't reset the clock."""
    conn = OverviewConn([])
    make_jobs_client(conn).get("/api/jobs/opportunities/overview")
    q = next(q for q in conn.queries("fetch") if "WITH acct_last" in q)
    assert q.count("a.type IN ('email', 'call', 'meeting', 'linkedin', 'text')") == 3


def test_overview_numbers_carry_their_definitions():
    c = make_jobs_client(OverviewConn([]))
    d = c.get("/api/jobs/opportunities/overview?week_end=2026-09-27&start=2026-09-21").json()["data"]
    defs = d["definitions"]
    assert defs["stalled"]["measure"] == "stalled_opportunities"
    assert defs["in_set"]["window"] == {"from": "2026-09-21", "to": "2026-09-27", "tz": "America/New_York"}


def test_account_activity_keeps_status_active():
    # Account-level touch 2 days ago, no activity on the opp itself.
    rows = [_set_row(UUID_A, "Acct", created_days=30, moved_days=2, touch_days=2)]
    c = make_jobs_client(OverviewConn(rows))
    d = c.get("/api/jobs/opportunities/overview").json()["data"]
    assert d["active_set"][0]["status"] == "active"


def test_priority_heatmap_puts_highest_priority_in_p1_row():
    # PIP-11: stored priority 5 is the highest (displayed P1). The P1 row used
    # to hold stored-1 deals, i.e. the lowest priority.
    rows = [
        _set_row(UUID_A, "Top", created_days=3, moved_days=3, priority=5),
        _set_row(UUID_B, "Top too", created_days=3, moved_days=3, priority=5),
        _set_row("cccccccc-cccc-cccc-cccc-cccccccccccc", "Second", created_days=3,
                 moved_days=3, priority=4),
    ]
    c = make_jobs_client(OverviewConn(rows))
    heat = c.get("/api/jobs/opportunities/overview").json()["data"]["heatmaps"]["priority"]
    assert [r["key"] for r in heat["rows"]] == ["P1", "P2", "P3", "P4", "P5"]
    assert [r["label"] for r in heat["rows"]] == ["P1", "P2", "P3", "P4", "P5"]
    totals = {r["key"]: r["total"] for r in heat["rows"]}
    assert totals == {"P1": 2, "P2": 1, "P3": 0, "P4": 0, "P5": 0}


def test_closed_won_counts_only_the_latest_change():
    conn = OverviewConn([])
    c = make_jobs_client(conn)
    c.get("/api/jobs/opportunities/overview?deal_type=ft")
    q = next(call[1] for call in conn.calls if "last_change" in call[1])
    # The latest change per opp, then filtered to closed_won in the window.
    assert "DISTINCT ON (h.opportunity_id)" in q
    assert "ORDER BY h.opportunity_id, h.changed_at DESC" in q
    assert "WHERE to_stage = $5" in q


def test_reverted_close_reads_as_move_in_feed():
    won_at = NOW - timedelta(days=1)
    moved = [
        # Reverted misclick: into closed_won, then straight back out.
        {"id": UUID_A, "account_name": "RXR", "deal_type": "ft",
         "from_stage": "active_opportunity_confirmed", "to_stage": "closed_won",
         "at": NOW - timedelta(days=2), "actor": "k@p.org"},
        {"id": UUID_A, "account_name": "RXR", "deal_type": "ft",
         "from_stage": "closed_won", "to_stage": "active_in_discussions",
         "at": NOW - timedelta(days=2) + timedelta(seconds=13), "actor": "k@p.org"},
        # A close that stuck.
        {"id": UUID_B, "account_name": "Mesa", "deal_type": "ft",
         "from_stage": "offer_contracting", "to_stage": "closed_won",
         "at": won_at, "actor": "k@p.org"},
    ]
    won = [{"id": UUID_B, "account_name": "Mesa", "stage": "closed_won",
            "owner_email": "a@p.org", "at": won_at}]
    c = make_jobs_client(OverviewConn([], won=won, moved=moved))
    d = c.get("/api/jobs/opportunities/overview?deal_type=ft").json()["data"]
    assert d["summary"]["moved_committed"] == 1
    assert [e["type"] for e in d["recent_activity"] if e["account"] == "Mesa"] == ["won"]
    assert all(e["type"] == "moved" for e in d["recent_activity"] if e["account"] == "RXR")


# ── multi-select deal type ─────────────────────────────────────────────────────

def test_parse_deal_types():
    from routes.jobs import _parse_deal_types, VALID_DEAL_TYPES
    assert _parse_deal_types(None) is None
    assert _parse_deal_types("all") is None
    assert _parse_deal_types("ft") == ["ft"]
    assert _parse_deal_types("unset, ft") == ["ft", "unset"]
    # Every box ticked is the same as no filter.
    assert _parse_deal_types(",".join(sorted(VALID_DEAL_TYPES)) + ",unset") is None
    # Unknown-only never widens to all.
    assert _parse_deal_types("bogus") == []


def test_overview_binds_deal_type_list():
    conn = OverviewConn([])
    c = make_jobs_client(conn)
    c.get("/api/jobs/opportunities/overview?deal_type=ft,unset")
    q, args = next((call[1], call[2]) for call in conn.calls if "WITH acct_last" in call[1])
    assert args[1] == ["ft", "unset"]
    assert "o.deal_type = ANY($2::text[])" in q
    assert "'unset' = ANY($2::text[]) AND o.deal_type IS NULL" in q


def test_opportunity_list_binds_deal_type_list():
    conn = FakeConn(lists={"FROM bedrock.jobs_opportunity o": []}, vals={"count(": 0})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/opportunities?deal_type=ft,unset")
    assert r.status_code == 200
    calls = [call for call in conn.calls if "o.deal_type = ANY(" in call[1]]
    assert calls and ["ft", "unset"] in list(calls[0][2])
