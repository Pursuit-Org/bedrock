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


def _contact(cid, stage, entered_days, owner="a@pursuit.org", estimated=False):
    return {"contact_id": cid, "name": f"C{cid}", "company": f"Co{cid}", "owner": owner,
            "stage": stage, "entered_stage": ago(entered_days), "entered_estimated": estimated}


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


def test_time_in_stage_from_last_edit_is_flagged_as_a_floor():
    r, conn = _get({CONTACTS_NOW: [_contact(1, "revisit", 72, estimated=True), _contact(2, "call_booked", 3)]})
    assert r.status_code == 200, r.text
    by_id = {m["id"]: m for m in r.json()["data"]["members"] if m["band"] == "outreach"}
    assert by_id["1"]["days"] == 72 and by_id["1"]["days_floor"] is True
    assert by_id["2"]["days_floor"] is False
    sql = next(c[1] for c in conn.calls if CONTACTS_NOW in c[1])
    assert "IS NULL AS entered_estimated" in sql


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
    # Every stage can carry a target since 2026-10-13; this one has none set.
    assert rows[("outreach", "revisit")]["targetable"] is True
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
                     "period_start": None, "value": 2, "team_mode": None},
                    {"section": "outreach", "metric": "call_discovery", "owner_email": "a@pursuit.org",
                     "period_start": None, "value": 5, "team_mode": None},
                    {"section": "outreach", "metric": "call_discovery", "owner_email": None,
                     "period_start": None, "value": None, "team_mode": "sum"},
                    {"section": "outreach", "metric": "total_calls", "owner_email": "a@pursuit.org",
                     "period_start": None, "value": 9, "team_mode": None}]
    asyncio.run(store.refresh(Pool(), force=True))
    r, _ = _get({})
    d = r.json()["data"]
    conv = _rows(d)[("outreach", "converted_to_opportunity")]
    # Stage targets are still pending, but this one is live today.
    assert d["targets_available"] is False
    assert conv["target_weekly"] == 4 and conv["target_source"] == "outreach"
    assert conv["target_source_label"] == "Opportunities converted"
    # Discovery calls is an activity target: it sits on the logged-calls row
    # (summed team line here), not on the Discovery call stage row.
    assert _rows(d)[("outreach", "call_booked")]["target"] is None
    dc = _rows(d)[("outreach", "discovery_calls_logged")]
    assert dc["target_weekly"] == 5 and dc["target_source_label"] == "Discovery calls"
    # Nothing else borrows: sends and booked calls measure events, not stage entries.
    assert _rows(d)[("outreach", "scheduling")]["target"] is None
    assert _rows(d)[("outreach", "initial_outreach")]["target"] is None
    r, _ = _get({}, owner="a@pursuit.org")
    rows = _rows(r.json()["data"])
    assert rows[("outreach", "converted_to_opportunity")]["target_weekly"] == 2
    assert rows[("outreach", "discovery_calls_logged")]["target_weekly"] == 5


ACTIVITY = "FROM ev WHERE ts >="
CONTACTS_NOW_STAGE = "FROM bedrock.jobs_contact_membership WHERE contact_id = ANY"
DEALS_NOW_STAGE = "FROM bedrock.jobs_opportunity WHERE deleted_at IS NULL AND id = ANY"


def test_conversion_is_the_share_of_net_new_now_further_along():
    d1, d2, d3 = (f"0000000{i}-0000-0000-0000-000000000000" for i in (1, 2, 3))
    hist = lambda cid, to: {"contact_id": cid, "from_stage": "assigned", "to_stage": to, "changed_at": ago(2),
                            "name": f"C{cid}", "company": "Co", "owner": "a@pursuit.org"}
    deal = lambda oid, stage: {"oid": oid, "from_stage": None, "stage": stage, "at": ago(2),
                               "account_name": "A", "title": "SWE", "owner_email": "a@pursuit.org"}
    r, conn = _get({
        CONTACT_HISTORY: [hist(1, "initial_outreach"), hist(2, "initial_outreach"), hist(3, "initial_outreach"),
                          hist(4, "call_booked")],
        # now: 1 booked a call (on), 2 still in outreach, 3 is Not a fit (an exit, not progress),
        # 4 converted (on)
        CONTACTS_NOW_STAGE: [{"contact_id": 1, "stage": "call_booked"}, {"contact_id": 2, "stage": "initial_outreach"},
                             {"contact_id": 3, "stage": "not_a_fit"}, {"contact_id": 4, "stage": "converted_to_opportunity"}],
        DEAL_ENTRIES: [deal(d1, "active_in_discussions"), deal(d2, "active_in_discussions"), deal(d3, "active_in_discussions")],
        DEALS_NOW_STAGE: [{"id": d1, "stage": "closed_won"}, {"id": d2, "stage": "closed_lost"},
                          {"id": d3, "stage": "ask_submitted"}],
    })
    d = r.json()["data"]
    rows = _rows(d)
    assert rows[("outreach", "initial_outreach")]["conversion"] == {"on": 1, "of": 3}
    assert rows[("outreach", "call_booked")]["conversion"] == {"on": 1, "of": 1}
    assert rows[("pipeline", "active_in_discussions")]["conversion"] == {"on": 2, "of": 3}
    # Exits, summaries and activity rows carry none.
    for k in [("outreach", "not_a_fit"), ("outreach", "contact_closed"), ("pipeline", "closed_won"),
              ("outreach", "outreach_sent")]:
        assert rows[k]["conversion"] is None, k
    now = {m["id"]: (m["now"], m["advanced"]) for m in d["moved"] if m["stage"] == "initial_outreach"}
    assert now == {"1": ("call_booked", True), "2": ("initial_outreach", False), "3": ("not_a_fit", False)}


def _act(metric, cid, n_this, n_prev=0, at_days=2):
    return {"metric": metric, "contact_id": cid, "n_this": n_this, "n_prev": n_prev,
            "last_at": ago(at_days) if n_this else None}


def test_activity_rows_sit_under_their_stages_and_count_events():
    conn = FakeConn(
        vals={"information_schema.columns": 1},
        lists={
            ACTIVITY: [
                _act("direct_email_sent", 7, 3, n_prev=1),
                _act("linkedin_message_sent", 7, 1),
                _act("text_sent", 8, 2),
                _act("facilitated_intro_sent", None, 1),   # no linked contact
                _act("call_discovery", 7, 2, n_prev=1),
                _act("call_general", 9, 1, n_prev=2),
            ],
            # A logged discovery call no longer adds to the stage row: only the move.
            CONTACT_HISTORY: [
                {"contact_id": 8, "from_stage": "initial_outreach", "to_stage": "call_booked", "changed_at": ago(3),
                 "name": "C8", "company": "Co8", "owner": "a@pursuit.org"}],
        })
    c = make_jobs_client(conn)
    d = c.get(f"/api/jobs/stage-flow?period_from={P_FROM}&period_to={P_TO}").json()["data"]
    keys = [r["key"] for r in d["bands"][0]["rows"]]
    assert keys[:8] == ["total_pool", "target_set", "assigned", "initial_outreach", "outreach_sent", "scheduling",
                        "call_booked", "discovery_calls_logged"]
    assert ("outreach", "calls_logged") not in _rows(d)
    rows = _rows(d)
    assert rows[("outreach", "call_booked")]["moved_in"] == 1
    sent = rows[("outreach", "outreach_sent")]
    assert sent["kind"] == "activity" and sent["parent"] == "initial_outreach" and sent["in_now"] is None
    assert sent["moved_in"] == 7 and sent["prev_moved_in"] == 1 and sent["unlinked"] == 1
    assert {b["label"]: b["n"] for b in sent["breakdown"]} == {"Email": 3, "LinkedIn": 1, "Text": 2, "Intro": 1}
    disc = rows[("outreach", "discovery_calls_logged")]
    assert disc["moved_in"] == 2 and disc["breakdown"] is None and disc["available"] is True
    # The drill: one entry per contact touched, with how many touches.
    drill = {(a["row"], a["id"]): a["n"] for a in d["activity"]}
    assert drill == {("outreach_sent", "7"): 4, ("outreach_sent", "8"): 2,
                     ("discovery_calls_logged", "7"): 2}
    # Activity rows stay out of the band's pool and the summary rows.
    assert rows[("outreach", "contact_closed")]["children"] == ["converted_to_opportunity", "revisit", "not_a_fit"]


def test_activity_rows_follow_the_sender_and_the_settings_outreach_targets():
    class Pool:
        async def fetchval(self, q, *a):
            return None if "pg_get_constraintdef" in q else True

        async def fetch(self, q, *a):
            if "jobs_team_member" in q:
                return [{"email": "a@pursuit.org"}]
            return [{"section": "outreach", "metric": "total_outreach_activity", "owner_email": "a@pursuit.org",
                     "period_start": None, "value": 25, "team_mode": None},
                    {"section": "outreach", "metric": "total_outreach_activity", "owner_email": None,
                     "period_start": None, "value": None, "team_mode": "sum"},
                    {"section": "outreach", "metric": "call_discovery", "owner_email": "a@pursuit.org",
                     "period_start": None, "value": 5, "team_mode": None}]
    asyncio.run(store.refresh(Pool(), force=True))
    from_14 = (NOW - timedelta(days=13)).date().isoformat()
    r, conn = _get({ACTIVITY: [_act("direct_email_sent", 7, 30)]}, owner="a@pursuit.org", period_from=from_14)
    rows = _rows(r.json()["data"])
    sent = rows[("outreach", "outreach_sent")]
    assert sent["target_weekly"] == 25 and sent["target"] == 50.0 and sent["delta"] == -20.0
    assert sent["target_source_label"] == "Outreach activity"
    assert rows[("outreach", "discovery_calls_logged")]["target_weekly"] == 5
    # The person is the sender, as on Outreach's Viewing filter.
    q = next(c[1] for c in conn.calls if ACTIVITY in c[1])
    assert "from_email ILIKE '%a@pursuit.org%'" in q and "logged_by ILIKE '%a@pursuit.org%'" in q
    # The Discovery call stage row no longer borrows the Discovery calls target.
    assert rows[("outreach", "call_booked")]["target"] is None


def test_discovery_activity_row_is_pending_without_the_call_kind_column(monkeypatch):
    from routes import jobs
    # The probe caches a True; reset it so this run sees the column missing.
    monkeypatch.setitem(jobs._COLUMN_CACHE, ("bedrock", "activity", "call_kind"), False)
    r, _ = _get({ACTIVITY: [_act("call_general", 7, 2)]})
    rows = _rows(r.json()["data"])
    assert rows[("outreach", "discovery_calls_logged")]["available"] is False
    assert rows[("outreach", "outreach_sent")]["available"] is True


def test_contact_owner_comes_from_the_contact_record_first():
    _, conn = _get({}, owner="kwame@pursuit.org")
    for needle in (CONTACTS_NOW, CONTACT_STAMPS):
        q = next(c[1] for c in conn.calls if needle in c[1])
        assert "COALESCE(c.owner_email, m.owner_email)" in q, needle


# ── ids filters behind the drill workbench ────────────────────────────────────

def test_contacts_list_filters_to_ids_and_ignores_scope():
    conn = FakeConn()
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/contacts?ids=24819,15083&limit=5000")
    assert r.status_code == 200, r.text
    q, args = next((x[1], x[2]) for x in conn.calls if "c.contact_id = ANY(" in x[1])
    assert [24819, 15083] in [list(a) if isinstance(a, list) else a for a in args]
    # The drill asks for exact people, so the jobs-prospect scope doesn't narrow it.
    assert "c.is_jobs_contact = true" not in q
    assert c.get("/api/jobs/contacts?ids=1,abc").status_code == 400


def test_opportunities_list_filters_to_ids():
    conn = FakeConn()
    c = make_jobs_client(conn)
    oid = "00000009-0000-0000-0000-000000000000"
    r = c.get(f"/api/jobs/opportunities?ids={oid}&limit=500")
    assert r.status_code == 200, r.text
    args = next(x[2] for x in conn.calls if "o.id = ANY(" in x[1])
    assert any(isinstance(a, list) and str(a[0]) == oid for a in args)
    assert c.get("/api/jobs/opportunities?ids=not-a-uuid").status_code == 400


def test_role_type_filters_the_pipeline_band_by_its_live_roles():
    _, conn = _get({}, role_type="committed,none")
    for needle in (DEALS_NOW, DEAL_ENTRIES, DEAL_CLOSES):
        q = next(c[1] for c in conn.calls if needle in c[1])
        assert "r.commitment = 'committed'" in q and "NOT EXISTS (SELECT 1 FROM bedrock.jobs_role r" in q, needle
        assert "IS DISTINCT FROM 'committed'" not in q
    # Contacts carry no roles: untouched.
    q = next(c[1] for c in conn.calls if CONTACTS_NOW in c[1])
    assert "jobs_role" not in q
    # No filter by default.
    _, conn = _get({})
    assert all("jobs_role r WHERE r.opportunity_id" not in c[1] for c in conn.calls)
    r, _ = _get({}, role_type="bogus")
    assert r.status_code == 400


def test_contact_closed_counts_each_contact_once_like_its_drill():
    # Converted AND moved to Revisit in the same week: two entries, one contact.
    r, _ = _get({
        CONTACT_STAMPS: [{"contact_id": 5, "name": "C5", "company": "Co", "owner": "a@pursuit.org",
                          "assigned_at": None, "first_outreach_at": None, "converted_at": ago(3)}],
        CONTACT_HISTORY: [{"contact_id": 5, "from_stage": "converted_to_opportunity", "to_stage": "revisit",
                           "changed_at": ago(1), "name": "C5", "company": "Co", "owner": "a@pursuit.org"}],
    })
    rows = _rows(r.json()["data"])
    assert rows[("outreach", "converted_to_opportunity")]["moved_in"] == 1
    assert rows[("outreach", "revisit")]["moved_in"] == 1
    assert rows[("outreach", "contact_closed")]["moved_in"] == 1


def test_a_retired_on_hold_close_counts_as_closed_lost():
    r, _ = _get({DEAL_CLOSES: [{"oid": "00000009-0000-0000-0000-000000000000", "from_stage": "ask_submitted",
                                "to_stage": "on_hold_not_interested", "at": ago(2), "account_name": "A",
                                "title": "SWE", "owner_email": "a@pursuit.org"}]})
    rows = _rows(r.json()["data"])
    assert rows[("pipeline", "closed_lost")]["moved_in"] == 1
    assert rows[("pipeline", "closed")]["moved_in"] == 1


CATALOG = "FROM bedrock.contact_tag_catalog WHERE active"


def test_campaign_filters_contacts_by_tag_and_deals_through_their_contacts():
    cat = [{"slug": "operation_35_lt"}, {"slug": "operation_35_staff"}, {"slug": "board"}]
    conn = FakeConn(vals={"information_schema.columns": 1}, lists={CATALOG: cat})
    c = make_jobs_client(conn)
    r = c.get(f"/api/jobs/stage-flow?period_from={P_FROM}&period_to={P_TO}&campaign=operation_35")
    assert r.status_code == 200
    arr = "ARRAY['operation_35_lt','operation_35_staff']::text[]"
    for needle in (CONTACTS_NOW, CONTACT_STAMPS, CONTACT_HISTORY):
        q = next(x[1] for x in conn.calls if needle in x[1])
        assert f"c.tags && {arr}" in q and "'board'" not in q, needle
    for needle in (DEALS_NOW, DEAL_ENTRIES, DEAL_CLOSES):
        q = next(x[1] for x in conn.calls if needle in x[1])
        assert "FROM public.contacts cc" in q and f"cc.tags && {arr}" in q, needle
    q = next(x[1] for x in conn.calls if ACTIVITY in x[1])
    assert f"contact_id IN (SELECT contact_id FROM public.contacts WHERE tags && {arr})" in q
    assert r.json()["data"]["filters"]["campaign"] == "operation_35"


def test_no_campaign_means_no_campaign_predicate_and_unknown_is_a_400():
    _, conn = _get({})
    assert all("FROM public.contacts cc" not in x[1] and "c.tags &&" not in x[1] for x in conn.calls)
    r, _ = _get({CATALOG: [{"slug": "board"}]}, campaign="nope")
    assert r.status_code == 400


POOL = "WHERE c.is_jobs_contact"


def test_total_contact_pool_leads_outreach_and_stays_out_of_the_band_total():
    conn = FakeConn(vals={POOL: 7745}, lists={CONTACTS_NOW: [_contact(1, "assigned", 3)]})
    d = make_jobs_client(conn).get(f"/api/jobs/stage-flow?period_from={P_FROM}&period_to={P_TO}").json()["data"]
    pool = d["bands"][0]["rows"][0]
    assert pool["key"] == "total_pool" and pool["kind"] == "universe"
    assert pool["in_now"] == {"total": 7745, "cells": None}
    # Not a stage: no movement, no target.
    assert pool["moved_in"] == 0 and pool["targetable"] is False
    # The Since column is gone (Kwame 2026-10-23).
    assert "since" not in d and all("since" not in r for b in d["bands"] for r in b["rows"])
    assert _rows(d)[("outreach", "contact_closed")]["label"] == "Contact Outcome"


def test_total_contact_pool_follows_the_owner_and_the_campaign():
    conn = FakeConn(vals={POOL: 449}, lists={CATALOG: [{"slug": "board"}, {"slug": "operation_35_lt"}]})
    make_jobs_client(conn).get(f"/api/jobs/stage-flow?period_from={P_FROM}&period_to={P_TO}"
                               "&owner=a@pursuit.org&campaign=board,operation_35")
    call = next(x for x in conn.calls if POOL in x[1])
    assert "c.tags && ARRAY['board','operation_35_lt']::text[]" in call[1]
    assert "a@pursuit.org" in call[2]


TS_PROBE = "to_regclass('bedrock.jobs_target_set')"
TS_ROWS = "FROM bedrock.jobs_target_set t"


@pytest.fixture
def _no_target_cache():
    from routes import jobs
    jobs._TABLE_SEEN.discard("jobs_target_set")
    yield
    jobs._TABLE_SEEN.discard("jobs_target_set")


def test_target_set_sits_under_the_pool_split_processed_and_outstanding(_no_target_cache):
    conn = FakeConn(vals={TS_PROBE: True, POOL: 7745},
                    lists={TS_ROWS: [{"contact_id": 3, "processed": True, "stage": "not_a_fit"},
                                     {"contact_id": 4, "processed": True, "stage": "on_hold"},
                                     {"contact_id": 1, "processed": False, "stage": None},
                                     {"contact_id": 2, "processed": False, "stage": None}]})
    d = make_jobs_client(conn).get(f"/api/jobs/stage-flow?period_from={P_FROM}&period_to={P_TO}").json()["data"]
    rows = d["bands"][0]["rows"]
    assert [r["key"] for r in rows[:2]] == ["total_pool", "target_set"]
    ts = rows[1]
    assert ts["kind"] == "universe" and ts["available"] is True and ts["depth"] == 0
    assert ts["in_now"] == {"total": 4, "cells": None}
    assert ts["target_set"] == {"processed": ["3", "4"], "outstanding": ["1", "2"],
                                # Retired on_hold reads as Revisit.
                                "by_stage": {"not_a_fit": ["3"], "revisit": ["4"]}}
    # Processed = any membership stage at all; the universe filters still apply.
    q = next(x[1] for x in conn.calls if TS_ROWS in x[1])
    assert "LEFT JOIN bedrock.jobs_contact_membership m" in q and "m.contact_id IS NOT NULL" in q


def test_target_set_reads_pending_until_its_migration(_no_target_cache):
    conn = FakeConn(vals={TS_PROBE: False})
    d = make_jobs_client(conn).get(f"/api/jobs/stage-flow?period_from={P_FROM}&period_to={P_TO}").json()["data"]
    ts = _rows(d)[("outreach", "target_set")]
    assert ts["available"] is False and ts["in_now"] is None and ts["target_set"] is None
    assert not any(TS_ROWS in x[1] for x in conn.calls)


def test_bulk_target_set_adds_marks_prospects_and_removes(_no_target_cache):
    conn = FakeConn(vals={TS_PROBE: True, "INSERT INTO bedrock.jobs_target_set": "INSERT 0 2",
                          "DELETE FROM bedrock.jobs_target_set": "DELETE 1"})
    c = make_jobs_client(conn)
    r = c.post("/api/jobs/contacts/bulk-target-set", json={"contact_ids": [5, 6, 5], "value": True})
    assert r.status_code == 200 and r.json()["data"]["updated"] == 2
    ins = conn.executed("INSERT INTO bedrock.jobs_target_set")[0]
    assert ins[2][0] == [5, 6]
    assert conn.executed("SET is_jobs_contact = true")
    r = c.post("/api/jobs/contacts/bulk-target-set", json={"contact_ids": [5], "value": False})
    assert r.json()["data"]["updated"] == 1


def test_bulk_target_set_is_409_before_the_migration(_no_target_cache):
    conn = FakeConn(vals={TS_PROBE: False})
    r = make_jobs_client(conn).post("/api/jobs/contacts/bulk-target-set", json={"contact_ids": [5], "value": True})
    assert r.status_code == 409 and "2026-10-23-jobs-target-set.sql" in r.json()["detail"]


def test_campaign_deals_match_by_tag_or_linked_contact_not_company():
    from routes import jobs
    sql = jobs._campaign_deal_sql(["operation_35_lt"], has_tags=True)
    assert "o.tags && ARRAY['operation_35_lt']::text[]" in sql
    assert "= ANY(o.sf_contact_ids)" in sql
    # A tagged contact merely working at the deal's company no longer counts.
    assert "current_company" not in sql and "account_name" not in sql


def test_directory_names_the_contacts_counted_by_id_alone(_no_target_cache):
    # Target List contacts 1 and 2 have no stage, so no member row carries their
    # name; contact 3 is a member already and stays out of the directory.
    conn = FakeConn(vals={TS_PROBE: True},
                    lists={CONTACTS_NOW: [_contact(3, "not_a_fit", 5)],
                           TS_ROWS: [{"contact_id": 3, "processed": True, "stage": "not_a_fit"},
                                     {"contact_id": 1, "processed": False, "stage": None},
                                     {"contact_id": 2, "processed": False, "stage": None}],
                           "SELECT contact_id, full_name, current_company FROM public.contacts": [
                               {"contact_id": 1, "full_name": "Ada Lovelace", "current_company": "Duckbill"},
                               {"contact_id": 2, "full_name": "Alan Turing", "current_company": None}]})
    d = make_jobs_client(conn).get(f"/api/jobs/stage-flow?period_from={P_FROM}&period_to={P_TO}").json()["data"]
    assert {e["id"]: e["detail"] for e in d["directory"]} == {"1": "Duckbill", "2": None}
    q = next(x for x in conn.calls if "FROM public.contacts WHERE contact_id = ANY" in x[1])
    assert sorted(q[2][0]) == [1, 2]
