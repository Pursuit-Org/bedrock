"""Evals for GET /api/jobs/stage-flow (Overview › Stage Flow)."""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from services import jobs_targets_store as store
from tests.jobs_fakes import FakeConn, make_jobs_client

NOW = datetime.now(timezone.utc)
# A window that certainly contains "two days ago": the 7 days ending today.
P_FROM = (NOW - timedelta(days=6)).date().isoformat()
P_TO = NOW.date().isoformat()

# SQL needles, one per query the endpoint runs (first match wins).
CONTACTS_NOW = "WHERE m.stage IN ('assigned'"
CONTACT_STAMPS = "WHERE m.stage <> 'not_a_fit'"
CONTACT_HISTORY = "DISTINCT ON (h.contact_id, h.to_stage)"
DEALS_NOW = "o.title, o.stage, o.owner_email"
DEAL_ENTRIES = "WITH hist AS"
DEAL_CLOSES = "last_change"


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    store.reset()
    yield
    store.reset()
    app.dependency_overrides.clear()


def ago(days: float) -> datetime:
    return NOW - timedelta(days=days)


def _contact(cid, stage, entered_days, owner="a@pursuit.org"):
    return {"contact_id": cid, "name": f"C{cid}", "company": f"Co{cid}", "owner": owner,
            "stage": stage, "entered_stage": ago(entered_days)}


def _deal(i, stage, entered_days, owner="a@pursuit.org"):
    return {"id": f"0000000{i}-0000-0000-0000-000000000000", "account_name": f"A{i}", "title": "SWE",
            "stage": stage, "owner_email": owner, "entered_stage": ago(entered_days)}


def _get(lists, **params):
    conn = FakeConn(lists=lists)
    c = make_jobs_client(conn)
    q = "&".join(f"{k}={v}" for k, v in {"period_from": P_FROM, "period_to": P_TO, **params}.items())
    r = c.get(f"/api/jobs/stage-flow?{q}")
    return r, conn


def _rows(data):
    return {(b["key"], row["key"]): row for b in data["bands"] for row in b["rows"]}


def test_in_now_buckets_by_time_in_stage_and_bands_keep_their_units():
    r, _ = _get({
        CONTACTS_NOW: [_contact(1, "call_booked", 3), _contact(2, "call_booked", 20),
                       _contact(3, "initial_outreach", 70)],
        DEALS_NOW: [_deal(1, "active_in_discussions", 1), _deal(2, "builder_interviewing", 45),
                    # retired value folds into its current stage
                    _deal(3, "reviewing_builders", 30)],
    })
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    rows = _rows(d)
    assert [b["unit"] for b in d["bands"]] == ["contacts", "deals"]
    assert rows[("outreach", "call_booked")]["in_now"] == {"total": 2, "cells": [1, 1, 0, 0, 0]}
    assert rows[("outreach", "initial_outreach")]["in_now"]["cells"] == [0, 0, 0, 0, 1]
    assert rows[("pipeline", "builder_interviewing")]["in_now"]["cells"] == [0, 0, 0, 1, 0]
    assert rows[("pipeline", "builder_submitted")]["in_now"]["total"] == 1
    # Every stage gets a row, empty or not.
    assert rows[("pipeline", "offer_contracting")]["in_now"]["total"] == 0
    # Closed Won and the off-ramps are movement-only.
    assert rows[("pipeline", "closed_won")]["in_now"] is None
    assert rows[("outreach", "not_a_fit")]["in_now"] is None
    # Each count is a slice of `members`, so the drill matches the number.
    cb = [m for m in d["members"] if m["band"] == "outreach" and m["stage"] == "call_booked"]
    assert len(cb) == 2 and {m["bucket"] for m in cb} == {0, 1}


def test_contacts_moved_in_dedupes_stamp_and_history():
    r, _ = _get({
        CONTACT_STAMPS: [{"contact_id": 1, "name": "C1", "company": "Co1", "owner": "a@pursuit.org",
                          "assigned_at": ago(30), "first_outreach_at": ago(2), "converted_at": None}],
        CONTACT_HISTORY: [
            # same entry the stamp already counted
            {"contact_id": 1, "to_stage": "initial_outreach", "changed_at": ago(2),
             "name": "C1", "company": "Co1", "owner": "a@pursuit.org"},
            {"contact_id": 1, "to_stage": "call_booked", "changed_at": ago(1),
             "name": "C1", "company": "Co1", "owner": "a@pursuit.org"},
            # legacy on_hold reads as Revisit
            {"contact_id": 2, "to_stage": "on_hold", "changed_at": ago(1),
             "name": "C2", "company": "Co2", "owner": "a@pursuit.org"},
        ],
    })
    rows = _rows(r.json()["data"])
    assert rows[("outreach", "initial_outreach")]["moved_in"] == 1
    assert rows[("outreach", "call_booked")]["moved_in"] == 1
    assert rows[("outreach", "assigned")]["moved_in"] == 0   # assigned before the window
    assert rows[("outreach", "revisit")]["moved_in"] == 1


def test_deals_moved_in_folds_retired_stages_and_closes_are_sticky():
    oid = "00000009-0000-0000-0000-000000000000"
    base = {"account_name": "A9", "title": "SWE", "owner_email": "a@pursuit.org"}
    r, _ = _get({
        DEAL_CLOSES: [{"oid": oid, "to_stage": "closed_won", "at": ago(1), **base}],
        DEAL_ENTRIES: [
            {"oid": oid, "stage": "reviewing_builders", "at": ago(3), **base},
            {"oid": oid, "stage": "builder_submitted", "at": ago(2), **base},
            # a win in the entries list never counts on its own: closes come
            # only from the sticky-close query
            {"oid": oid, "stage": "closed_won", "at": ago(1), **base},
        ],
    })
    rows = _rows(r.json()["data"])
    assert rows[("pipeline", "builder_submitted")]["moved_in"] == 1
    assert rows[("pipeline", "closed_won")]["moved_in"] == 1


def test_filters_reach_every_query():
    _, conn = _get({}, owner="Avni@Pursuit.org", deal_type="ft,unset")
    for needle in (CONTACTS_NOW, CONTACT_STAMPS, DEALS_NOW, DEAL_ENTRIES, DEAL_CLOSES):
        args = next(c[2] for c in conn.calls if needle in c[1])
        assert args[0] == "avni@pursuit.org", needle
    deal_args = next(c[2] for c in conn.calls if DEALS_NOW in c[1])
    assert deal_args[1] == ["ft", "unset"]


def test_targets_pending_until_migration_then_prorated():
    r, _ = _get({})
    d = r.json()["data"]
    assert d["targets_available"] is False
    assert all(row["target"] is None for b in d["bands"] for row in b["rows"])

    class Pool:
        async def fetchval(self, q, *a):
            if "pg_get_constraintdef" in q:
                return "CHECK ((section = ANY (ARRAY['outreach'::text, 'pipeline'::text, 'stage'::text])))"
            return True

        async def fetch(self, q, *a):
            if "jobs_team_member" in q:
                return [{"email": "a@pursuit.org"}]
            return [{"section": "stage", "metric": "call_booked", "owner_email": None,
                     "period_start": None, "value": 5, "team_mode": None}]
    asyncio.run(store.refresh(Pool(), force=True))
    from_14 = (NOW - timedelta(days=13)).date().isoformat()
    r, _ = _get({}, period_from=from_14)
    d = r.json()["data"]
    rows = _rows(d)
    assert d["targets_available"] is True
    assert rows[("outreach", "call_booked")]["target_weekly"] == 5
    assert rows[("outreach", "call_booked")]["target"] == 10.0   # two weeks
    assert rows[("outreach", "revisit")]["targetable"] is False


def test_stage_rows_do_not_leak_into_outreach_team_targets():
    class Pool:
        async def fetchval(self, q, *a):
            return None

        async def fetch(self, q, *a):
            if "jobs_team_member" in q:
                return [{"email": "a@pursuit.org"}]
            return [{"section": "stage", "metric": "call_booked", "owner_email": None,
                     "period_start": None, "value": 5, "team_mode": None}]
    asyncio.run(store.refresh(Pool(), force=True))
    assert store.team_mode("call_booked") is None
    assert store.stage_targets_available() is False


def test_bad_period_is_a_400():
    r, _ = _get({}, period_from="2026-10-08", period_to="2026-10-01")
    assert r.status_code == 400
    r, _ = _get({}, period_from="nope")
    assert r.status_code == 400
