"""Evals for GET /api/jobs/opportunities/projection (Jobs projection chart)."""
from datetime import date, datetime, timezone

import pytest

from services import jobs_targets_store as store
from tests.jobs_fakes import FakeConn, make_jobs_client

TODAY = "2026-09-29"   # Q3 2026


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    store.reset()
    yield
    store.reset()
    app.dependency_overrides.clear()


def _row(i, stage="active_in_discussions", tcd=None, won_at=None, est=None, roles=0):
    return {"id": f"0000000{i}-0000-0000-0000-000000000000", "account_name": f"A{i}", "title": None,
            "stage": stage, "deal_type": "ft", "owner_email": "a@pursuit.org",
            "target_close_date": tcd, "won_at": won_at, "estimated_jobs": est, "roles": roles}


def _get(rows, **params):
    conn = FakeConn(lists={"FROM bedrock.jobs_opportunity o": rows})
    c = make_jobs_client(conn)
    q = "&".join(f"{k}={v}" for k, v in {"today": TODAY, **params}.items())
    r = c.get(f"/api/jobs/opportunities/projection?{q}")
    assert r.status_code == 200, r.text
    return {b["key"]: b for b in r.json()["data"]["buckets"]}, r.json()["data"]


def test_quarter_buckets_and_split():
    b, d = _get([
        # open, dated next quarter: 5 estimated, 2 roles already created
        _row(1, tcd=date(2026, 11, 3), est=5, roles=2),
        # roles beyond the estimate never go negative
        _row(2, tcd=date(2026, 12, 1), est=1, roles=3),
        # won this quarter with roles; won this quarter with no roles -> estimate
        _row(3, stage="closed_won", won_at=datetime(2026, 8, 1, tzinfo=timezone.utc), est=9, roles=2),
        _row(4, stage="closed_won", won_at=datetime(2026, 9, 1, tzinfo=timezone.utc), est=4, roles=0),
        # open: past-due and undated
        _row(5, tcd=date(2026, 3, 1), est=2),
        _row(6, est=3, roles=1),
        # won with no date anywhere: counted, not plotted
        _row(7, stage="closed_won", won_at=None, roles=1),
    ])
    # Starts at the current quarter.
    assert list(b)[:4] == ["2026-07-01", "2026-10-01", "2027-01-01", "2027-04-01"]
    assert b["2026-10-01"]["confirmed"] == 5 and b["2026-10-01"]["estimated"] == 3
    assert b["2026-07-01"]["won"] == 6 and b["2026-07-01"]["kind"] == "current"
    assert b["overdue"]["estimated"] == 2
    assert b["undated"]["confirmed"] == 1 and b["undated"]["estimated"] == 2
    assert d["won_undated"] == 1


def test_month_targets_are_a_third_of_the_quarter():
    import asyncio

    class Pool:
        async def fetchval(self, q, *a): return True
        async def fetch(self, q, *a):
            if "jobs_team_member" in q:
                return [{"email": "a@pursuit.org"}]
            return [{"section": "pipeline", "metric": "jobs", "owner_email": None,
                     "period_start": date(2026, 10, 1), "value": 12, "team_mode": None}]
    asyncio.run(store.refresh(Pool(), force=True))
    b, _ = _get([], granularity="quarter")
    assert b["2026-10-01"]["target"] == 12 and b["2026-07-01"]["target"] is None
    b, _ = _get([], granularity="month")
    assert b["2026-11-01"]["target"] == 4.0
    # Months cover the same four whole quarters: Jul 2026 .. Jun 2027.
    months = [k for k in b if k not in ("overdue", "undated")]
    assert months[0] == "2026-07-01" and months[-1] == "2027-06-01" and len(months) == 12
    assert b["2026-11-01"]["quarter"] == "2026-10-01" and b["2026-11-01"]["quarter_label"] == "Q4 2026"


def test_deal_type_filter_bound():
    conn = FakeConn(lists={"FROM bedrock.jobs_opportunity o": []})
    c = make_jobs_client(conn)
    c.get(f"/api/jobs/opportunities/projection?today={TODAY}&deal_type=ft,unset")
    q, args = next((x[1], x[2]) for x in conn.calls if "FROM bedrock.jobs_opportunity o" in x[1])
    assert args[1] == ["ft", "unset"] and "status <> 'cancelled'" in q


def test_past_quarters_prepended():
    b, _ = _get([_row(1, stage="closed_won", won_at=datetime(2026, 2, 10, tzinfo=timezone.utc), roles=3)], past=2)
    keys = [k for k in b if k not in ("overdue", "undated")]
    assert keys[:3] == ["2026-01-01", "2026-04-01", "2026-07-01"]
    assert b["2026-01-01"]["kind"] == "past" and b["2026-01-01"]["won"] == 3
    assert b["2026-07-01"]["kind"] == "current"
