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
    assert [b["unit"] for b in d["bands"]] == ["contacts", "opportunities"]
    assert rows[("outreach", "call_booked")]["in_now"] == {"total": 2, "cells": [1, 1, 0, 0, 0]}
    assert rows[("outreach", "initial_outreach")]["in_now"]["cells"] == [0, 0, 0, 0, 1]
    assert rows[("pipeline", "builder_interviewing")]["in_now"]["cells"] == [0, 0, 0, 1, 0]
    assert rows[("pipeline", "builder_submitted")]["in_now"]["total"] == 1
    # Every stage gets a row, empty or not.
    assert rows[("pipeline", "offer_contracting")]["in_now"]["total"] == 0
    # Closed Won and Lost are movement-only; the contact outcomes carry a Pool.
    assert rows[("pipeline", "closed_won")]["in_now"] is None
    assert rows[("outreach", "not_a_fit")]["in_now"]["total"] == 0
    # Engaging sits right after Initial Opportunity.
    keys = [r["key"] for r in d["bands"][1]["rows"]]
    assert keys[:3] == ["active_in_discussions", "engaging", "ask_submitted"]
    assert d["bands"][1]["rows"][0]["label"] == "Initial Opportunity"
    # The Owner filter and tab list the Jobs team (the fallback team here).
    assert d["team"] == store.team_emails() and len(d["team"]) > 0
    # Each count is a slice of `members`, so the drill matches the number.
    cb = [m for m in d["members"] if m["band"] == "outreach" and m["stage"] == "call_booked"]
    assert len(cb) == 2 and {m["bucket"] for m in cb} == {0, 1}


def test_contact_closed_sums_its_three_paths():
    r, _ = _get({
        CONTACTS_NOW: [_contact(1, "converted_to_opportunity", 3), _contact(2, "not_a_fit", 40),
                       # legacy on_hold reads as Revisit
                       _contact(3, "on_hold", 10)],
        CONTACT_HISTORY: [
            {"contact_id": 4, "from_stage": "call_booked", "to_stage": "not_a_fit", "changed_at": ago(1),
             "name": "C4", "company": "Co4", "owner": "a@pursuit.org"},
            {"contact_id": 5, "from_stage": "call_booked", "to_stage": "revisit", "changed_at": ago(1),
             "name": "C5", "company": "Co5", "owner": "a@pursuit.org"},
        ],
    })
    d = r.json()["data"]
    rows = _rows(d)
    closed = rows[("outreach", "contact_closed")]
    assert closed["children"] == ["converted_to_opportunity", "revisit", "not_a_fit"]
    assert closed["in_now"]["total"] == 3 and closed["moved_in"] == 2
    assert closed["targetable"] is False
    assert rows[("outreach", "revisit")]["in_now"]["total"] == 1 and rows[("outreach", "revisit")]["depth"] == 1
    # Each move says where it came from, so the drawer can show the paths.
    assert {m["from"] for m in d["moved"] if m["band"] == "outreach"} == {"call_booked"}


def test_engaging_reads_pending_until_its_migration():
    old = "CHECK ((stage = ANY (ARRAY['active_in_discussions'::text, 'ask_submitted'::text, 'closed_won'::text])))"
    conn = FakeConn(vals={"pg_get_constraintdef": old})
    c = make_jobs_client(conn)
    r = c.get(f"/api/jobs/stage-flow?period_from={P_FROM}&period_to={P_TO}")
    rows = _rows(r.json()["data"])
    assert rows[("pipeline", "engaging")]["available"] is False
    assert rows[("pipeline", "ask_submitted")]["available"] is True


def test_contacts_moved_in_dedupes_stamp_and_history():
    r, _ = _get({
        CONTACT_STAMPS: [{"contact_id": 1, "name": "C1", "company": "Co1", "owner": "a@pursuit.org",
                          "assigned_at": ago(30), "first_outreach_at": ago(2), "converted_at": None}],
        CONTACT_HISTORY: [
            # same entry the stamp already counted
            {"contact_id": 1, "from_stage": "assigned", "to_stage": "initial_outreach", "changed_at": ago(2),
             "name": "C1", "company": "Co1", "owner": "a@pursuit.org"},
            {"contact_id": 1, "from_stage": "initial_outreach", "to_stage": "call_booked", "changed_at": ago(1),
             "name": "C1", "company": "Co1", "owner": "a@pursuit.org"},
            # legacy on_hold reads as Revisit
            {"contact_id": 2, "from_stage": "call_booked", "to_stage": "on_hold", "changed_at": ago(1),
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
        DEAL_CLOSES: [{"oid": oid, "from_stage": "builder_submitted", "to_stage": "closed_won", "at": ago(1), **base}],
        DEAL_ENTRIES: [
            {"oid": oid, "from_stage": "active_in_discussions", "stage": "reviewing_builders", "at": ago(3), **base},
            {"oid": oid, "from_stage": "reviewing_builders", "stage": "builder_submitted", "at": ago(2), **base},
            # a win in the entries list never counts on its own: closes come
            # only from the sticky-close query
            {"oid": oid, "from_stage": "builder_submitted", "stage": "closed_won", "at": ago(1), **base},
        ],
    })
    rows = _rows(r.json()["data"])
    assert rows[("pipeline", "builder_submitted")]["moved_in"] == 1
    assert rows[("pipeline", "closed_won")]["moved_in"] == 1
    # Closed sums Won and Lost, each indented beneath it; none carries a Pool.
    closed = rows[("pipeline", "closed")]
    assert closed["children"] == ["closed_won", "closed_lost"] and closed["moved_in"] == 1
    assert closed["in_now"] is None and closed["targetable"] is False
    assert rows[("pipeline", "closed_won")]["depth"] == 1 and rows[("pipeline", "closed_won")]["targetable"] is True


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
            return [
                {"section": "stage", "metric": "call_booked", "owner_email": None,
                 "period_start": None, "value": 5, "team_mode": "set"},
                {"section": "stage", "metric": "call_booked", "owner_email": "a@pursuit.org",
                 "period_start": None, "value": 3, "team_mode": None},
                # summed team line: the team's people carry it
                {"section": "stage", "metric": "closed_won", "owner_email": None,
                 "period_start": None, "value": None, "team_mode": "sum"},
                {"section": "stage", "metric": "closed_won", "owner_email": "a@pursuit.org",
                 "period_start": None, "value": 1, "team_mode": None},
            ]
    asyncio.run(store.refresh(Pool(), force=True))
    from_14 = (NOW - timedelta(days=13)).date().isoformat()
    r, _ = _get({CONTACT_HISTORY: [
        {"contact_id": 1, "from_stage": "initial_outreach", "to_stage": "call_booked", "changed_at": ago(1),
         "name": "C1", "company": "Co1", "owner": "a@pursuit.org"}]}, period_from=from_14)
    d = r.json()["data"]
    rows = _rows(d)
    assert d["targets_available"] is True and d["target_scope"] == "team"
    cb = rows[("outreach", "call_booked")]
    assert cb["target_weekly"] == 5 and cb["target"] == 10.0   # two weeks
    assert cb["delta"] == -9.0                                  # 1 moved in vs 10
    assert rows[("pipeline", "closed_won")]["target_weekly"] == 1
    assert rows[("outreach", "revisit")]["targetable"] is False
    assert rows[("outreach", "revisit")]["delta"] is None

    # An owner view shows that person's targets, not the team's.
    r, _ = _get({}, owner="a@pursuit.org")
    d = r.json()["data"]
    assert d["target_scope"] == "a@pursuit.org"
    assert _rows(d)[("outreach", "call_booked")]["target_weekly"] == 3
    # Converted borrows the Settings outreach target while it has no stage target.
    # (No outreach target is set in this fixture, so it stays empty.)
    assert _rows(d)[("outreach", "converted_to_opportunity")]["target_source"] is None
    # Someone off the team carries no target rather than the team's.
    r, _ = _get({}, owner="someone@pursuit.org")
    assert _rows(r.json()["data"])[("outreach", "call_booked")]["target_weekly"] is None


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


def test_converted_borrows_the_settings_outreach_target():
    class Pool:
        async def fetchval(self, q, *a):
            return None if "pg_get_constraintdef" in q else True

        async def fetch(self, q, *a):
            if "jobs_team_member" in q:
                return [{"email": "a@pursuit.org"}]
            return [{"section": "outreach", "metric": "converted_opportunities", "owner_email": None,
                     "period_start": None, "value": 4, "team_mode": "set"},
                    {"section": "outreach", "metric": "converted_opportunities", "owner_email": "a@pursuit.org",
                     "period_start": None, "value": 2, "team_mode": None}]
    asyncio.run(store.refresh(Pool(), force=True))
    r, _ = _get({})
    d = r.json()["data"]
    conv = _rows(d)[("outreach", "converted_to_opportunity")]
    # Stage targets are still pending, but this one is live today.
    assert d["targets_available"] is False
    assert conv["target_weekly"] == 4 and conv["target_source"] == "outreach"
    # Nothing else borrows: sends and calls measure events, not stage entries.
    assert _rows(d)[("outreach", "call_booked")]["target"] is None
    r, _ = _get({}, owner="a@pursuit.org")
    assert _rows(r.json()["data"])[("outreach", "converted_to_opportunity")]["target_weekly"] == 2
