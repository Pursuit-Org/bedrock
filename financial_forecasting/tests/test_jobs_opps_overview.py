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


def _set_row(id_, name, *, created_days, moved_days, touch_days=None):
    created = NOW - timedelta(days=created_days)
    return {
        "id": id_, "account_name": name, "stage": "active_in_discussions", "deal_type": "ft",
        "segment": None, "owner_email": "a@p.org", "priority": None, "created_at": created,
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
    assert d["summary"]["stalled_6wk"] == 1
    assert [r["account"] for r in d["drills"]["stalled"]] == ["Quiet"]


def test_account_activity_keeps_status_active():
    # Account-level touch 2 days ago, no activity on the opp itself.
    rows = [_set_row(UUID_A, "Acct", created_days=30, moved_days=2, touch_days=2)]
    c = make_jobs_client(OverviewConn(rows))
    d = c.get("/api/jobs/opportunities/overview").json()["data"]
    assert d["active_set"][0]["status"] == "active"


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
