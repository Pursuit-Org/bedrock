"""PRO-110: the Thursday Pipeline view, slow but active, and lost reasons.

No database: the rules are tested directly and the routes through FakeConn.
  * An opportunity is active, stalled (D3: 4 weeks) or slow but active (the
    owner's mark, until its check-again date; after it, stalled again if
    still quiet).
  * Closed Lost needs a reason (12 of 88 had none on 10/20).
  * GET /api/jobs/opportunities/thursday: full-time by default, every list
    and number from one set.
"""
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from services import jobs_metrics as jm
from tests.jobs_fakes import FakeConn, make_jobs_client

NOW = datetime.now(timezone.utc)
TODAY = datetime.now(jm.NY).date()
UUID1 = "11111111-1111-1111-1111-111111111111"
SLOW_COL = ("bedrock", "jobs_opportunity", "slow_reason")


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _ago(days):
    return NOW - timedelta(days=days)


# ── the state rule ───────────────────────────────────────────────────────────

def test_four_weeks_without_movement_is_stalled():
    assert jm.opportunity_state(_ago(3), None, None, NOW) == ("active", False)
    assert jm.opportunity_state(_ago(29), None, None, NOW) == ("stalled", False)
    assert jm.opportunity_state(None, None, None, NOW) == ("stalled", False)


def test_slow_but_active_holds_until_its_check_again_date():
    later = TODAY + timedelta(days=10)
    assert jm.opportunity_state(_ago(60), "Enterprise cycle", later, NOW) == ("slow", False)
    # The date itself still counts as slow.
    assert jm.opportunity_state(_ago(60), "Enterprise cycle", TODAY, NOW) == ("slow", False)
    # Marked, but active anyway: the mark wins until the date.
    assert jm.opportunity_state(_ago(1), "Enterprise cycle", later, NOW) == ("slow", False)


def test_a_lapsed_mark_is_stalled_again_if_still_quiet():
    passed = TODAY - timedelta(days=1)
    assert jm.opportunity_state(_ago(60), "Enterprise cycle", passed, NOW) == ("stalled", True)
    # Something happened since: active, with the lapsed mark still shown.
    assert jm.opportunity_state(_ago(2), "Enterprise cycle", passed, NOW) == ("active", True)


def test_the_sql_twin_reads_the_check_again_date_in_new_york():
    sql = jm.slow_open_sql("o", "now()")
    assert "o.slow_reason IS NOT NULL" in sql and "o.slow_check_again >=" in sql
    assert "America/New_York" in sql


# ── slow but active on PATCH ─────────────────────────────────────────────────

def _opp_row(**ov):
    row = {"id": UUID1, "account_id": None, "account_name": "Acme", "stage": "active_in_discussions",
           "deal_type": "ft", "title": "Eng", "owner_email": "a@p.org", "relationship_owner": None,
           "closed_at": None, "closed_lost_reason": None}
    row.update(ov)
    return row


def _patch(conn, body):
    return make_jobs_client(conn).patch(f"/api/jobs/opportunities/{UUID1}", json=body)


def _update_sql(conn):
    return next(c for c in conn.calls if c[0] == "execute" and "UPDATE bedrock.jobs_opportunity SET" in c[1])


def test_slow_needs_its_migration_and_says_which():
    conn = FakeConn(rows={"FROM bedrock.jobs_opportunity WHERE id=$1": _opp_row()})
    r = _patch(conn, {"slow_reason": "Enterprise cycle", "slow_check_again": str(TODAY)})
    assert r.status_code == 409
    assert "2026-10-20-opportunity-slow-but-active.sql" in r.text


def test_marking_slow_stores_reason_date_and_who(monkeypatch):
    from routes import jobs
    monkeypatch.setitem(jobs._COLUMN_CACHE, SLOW_COL, True)
    conn = FakeConn(rows={"FROM bedrock.jobs_opportunity WHERE id=$1": _opp_row()})
    later = TODAY + timedelta(days=14)
    r = _patch(conn, {"slow_reason": "  Next headcount cycle in November ", "slow_check_again": str(later)})
    assert r.status_code == 200, r.text
    _, q, args = _update_sql(conn)
    for col in ("slow_reason", "slow_check_again", "slow_marked_by", "slow_marked_at"):
        assert f"{col} = $" in q
    assert args[0] == "Next headcount cycle in November" and args[1] == later
    assert args[2] == "tester@pursuit.org" and args[3] is not None


def test_clearing_slow_clears_all_four(monkeypatch):
    from routes import jobs
    monkeypatch.setitem(jobs._COLUMN_CACHE, SLOW_COL, True)
    conn = FakeConn(rows={"FROM bedrock.jobs_opportunity WHERE id=$1": _opp_row()})
    r = _patch(conn, {"slow_reason": None, "slow_check_again": None})
    assert r.status_code == 200, r.text
    assert _update_sql(conn)[2][:4] == (None, None, None, None)


@pytest.mark.parametrize("body, says", [
    ({"slow_reason": " ", "slow_check_again": str(TODAY)}, "needs a reason"),
    ({"slow_reason": "Enterprise", "slow_check_again": None}, "date to check again"),
    ({"slow_reason": "Enterprise", "slow_check_again": str(TODAY - timedelta(days=1))}, "in the past"),
])
def test_slow_needs_a_reason_and_a_date_not_in_the_past(monkeypatch, body, says):
    from routes import jobs
    monkeypatch.setitem(jobs._COLUMN_CACHE, SLOW_COL, True)
    conn = FakeConn(rows={"FROM bedrock.jobs_opportunity WHERE id=$1": _opp_row()})
    r = _patch(conn, body)
    assert r.status_code == 400 and says in r.text
    assert not conn.executed("UPDATE bedrock.jobs_opportunity")


def test_slow_mark_rule_directly():
    from routes.jobs import _slow_mark
    assert _slow_mark(None, None) is None
    with pytest.raises(HTTPException):
        _slow_mark("Enterprise", None)


# ── Closed Lost needs a reason ───────────────────────────────────────────────

def test_closing_lost_without_a_reason_is_refused():
    conn = FakeConn(rows={"FROM bedrock.jobs_opportunity WHERE id=$1": _opp_row()})
    r = _patch(conn, {"stage": "closed_lost"})
    assert r.status_code == 400 and "needs a reason" in r.text
    assert not conn.executed("UPDATE bedrock.jobs_opportunity")


def test_closing_lost_with_its_reason_in_the_same_save():
    conn = FakeConn(rows={"FROM bedrock.jobs_opportunity WHERE id=$1": _opp_row()})
    r = _patch(conn, {"stage": "closed_lost", "closed_lost_reason": "role_cancelled",
                      "closed_lost_note": "Hiring freeze"})
    assert r.status_code == 200, r.text
    q = _update_sql(conn)[1]
    assert "stage = $" in q and "closed_lost_reason = $" in q
    assert conn.executed("INSERT INTO bedrock.jobs_stage_history")


def test_clearing_the_reason_on_a_lost_opportunity_is_refused():
    conn = FakeConn(rows={"FROM bedrock.jobs_opportunity WHERE id=$1":
                          _opp_row(stage="closed_lost", closed_lost_reason="budget")})
    r = _patch(conn, {"closed_lost_reason": None})
    assert r.status_code == 400


def test_an_old_lost_opportunity_without_a_reason_can_still_be_edited():
    # 12 lost opportunities have no reason; editing their priority mustn't fail.
    conn = FakeConn(rows={"FROM bedrock.jobs_opportunity WHERE id=$1": _opp_row(stage="closed_lost")})
    assert _patch(conn, {"priority": 3}).status_code == 200


def test_an_unknown_lost_reason_is_refused():
    conn = FakeConn(rows={"FROM bedrock.jobs_opportunity WHERE id=$1": _opp_row()})
    r = _patch(conn, {"stage": "closed_lost", "closed_lost_reason": "vibes"})
    assert r.status_code == 400 and "Unknown lost reason" in r.text


def test_creating_an_opportunity_already_lost_needs_a_reason():
    c = make_jobs_client(FakeConn())
    r = c.post("/api/jobs/opportunities", json={
        "account_id": "x", "account_name": "Acme", "stage": "closed_lost",
        "target_close_date": "2026-12-15", "sf_contact_ids": ["pub:5"]})
    assert r.status_code == 400 and "needs a reason" in r.text


# ── GET /opportunities/thursday ──────────────────────────────────────────────

def _open(id_, account, *, moved_days, priority=None, slow=None, check_again=None, title="Analyst",
          deal_type="ft", touch_days=None):
    created = _ago(120)
    return {
        "id": id_, "account_name": account, "stage": "active_in_discussions", "deal_type": deal_type,
        "segment": None, "owner_email": "avni@pursuit.org", "priority": priority, "created_at": created,
        "slow_reason": slow, "slow_check_again": check_again,
        "title": title, "relationship_owner": None, "slow_marked_by": "avni@pursuit.org" if slow else None,
        "slow_marked_at": _ago(5) if slow else None,
        "touch_type": "email" if touch_days is not None else None,
        "touch_by": "avni@pursuit.org" if touch_days is not None else None,
        "entered_stage": created, "stage_from_created": True, "last_stage_change": None,
        "last_touch": None if touch_days is None else _ago(touch_days),
        "last_movement": _ago(moved_days),
    }


def _closed(id_, account, reason=None, days=1):
    return {"id": id_, "account_name": account, "stage": "closed_lost", "owner_email": "a@p.org",
            "deal_type": "ft", "closed_lost_reason": reason, "at": _ago(days)}


class ThursdayConn(FakeConn):
    """Splits the closed-in-window queries by stage and window start, which a
    substring can't tell apart: [win_start, ref) for the week, the lookback
    for lost reasons."""
    def __init__(self, open_rows, *, won=(), lost_week=(), lost_lookback=(), moves=(),
                 new=(), notes=(), accounts=()):
        super().__init__(lists={
            "opp_last AS (": list(open_rows),
            "FROM bedrock.jobs_comment": list(notes),
            "open_keys AS (": list(accounts),
            "h.from_stage, h.to_stage": list(moves),
            "ORDER BY o.created_at DESC": list(new),
        })
        self._won, self._lost_week, self._lost_lookback = list(won), list(lost_week), list(lost_lookback)

    async def fetch(self, query, *args, timeout=None):
        if "last_change" in query:
            self.calls.append(("fetch", query, args))
            if args[4] == "closed_won":
                return self._won
            week = (args[2] - args[3]).days <= 31
            return self._lost_week if week else self._lost_lookback
        return await super().fetch(query, *args)


A, B, C, D, E = (f"{c * 8}-{c * 4}-{c * 4}-{c * 4}-{c * 12}" for c in "abcde")


def _get(conn, qs=""):
    r = make_jobs_client(conn).get(f"/api/jobs/opportunities/thursday{qs}")
    assert r.status_code == 200, r.text
    return r.json()["data"]


def test_every_open_opportunity_is_active_stalled_or_slow():
    later, passed = TODAY + timedelta(days=20), TODAY - timedelta(days=3)
    rows = [
        _open(A, "Burbio", moved_days=2, touch_days=2),
        _open(B, "Newmark", moved_days=52),
        _open(C, "Newmark", moved_days=35, title="Résumés"),
        _open(D, "Intuit", moved_days=33, slow="Next headcount cycle in November", check_again=later),
        _open(E, "Pharma Logistics", moved_days=40, slow="Enterprise", check_again=passed),
    ]
    d = _get(ThursdayConn(rows))
    assert {k: d["summary"][k] for k in ("open", "active", "stalled", "slow")} == {
        "open": 5, "active": 1, "stalled": 3, "slow": 1}
    # Longest without movement first; the lapsed mark is stalled and says so.
    assert [o["account"] for o in d["stalled"]] == ["Newmark", "Pharma Logistics", "Newmark"]
    lapsed = next(o for o in d["stalled"] if o["account"] == "Pharma Logistics")
    assert lapsed["slow"]["lapsed"] is True and lapsed["slow"]["reason"] == "Enterprise"
    assert [o["account"] for o in d["slow"]] == ["Intuit"]
    assert d["slow"][0]["slow"]["check_again"] == later.isoformat()
    # The numbers and their lists are one set.
    assert d["definitions"]["stalled"]["value"] == len(d["stalled"])
    assert d["definitions"]["slow"]["value"] == len(d["slow"])
    assert d["definitions"]["active"]["value"] == 1
    active = next(o for o in d["opportunities"] if o["state"] == "active")
    assert active["last_activity"] == {"at": active["last_activity"]["at"], "type": "email",
                                       "by": "avni@pursuit.org"}


def test_full_time_by_default_and_the_toggle():
    conn = ThursdayConn([])
    d = _get(conn)
    assert d["deal_type"] == "ft"
    open_q = next(c for c in conn.calls if "opp_last AS (" in c[1])
    assert open_q[2][1] == ["ft"]
    conn = ThursdayConn([])
    _get(conn, "?deal_type=pt_contract")
    assert next(c for c in conn.calls if "opp_last AS (" in c[1])[2][1] == ["pt_contract"]
    conn = ThursdayConn([])
    _get(conn, "?deal_type=all")
    assert next(c for c in conn.calls if "opp_last AS (" in c[1])[2][1] is None
    r = make_jobs_client(ThursdayConn([])).get("/api/jobs/opportunities/thursday?deal_type=capstone")
    assert r.status_code == 400


def test_the_default_window_is_this_calendar_week():
    d = _get(ThursdayConn([]))
    monday, sunday = jm.meeting_week("thursday")
    assert d["window"] == {"start": monday.isoformat(), "end": sunday.isoformat()}
    r = make_jobs_client(ThursdayConn([])).get("/api/jobs/opportunities/thursday?start=2026-10-12")
    assert r.status_code == 400


def test_priority_is_p1_first_with_where_it_stands():
    rows = [_open(A, "RXR", moved_days=3, priority=3), _open(B, "JPMC", moved_days=10, priority=5),
            _open(C, "Crux", moved_days=1)]
    notes = [{"parent_id": B, "content": "Thursday works, who else should join?",
              "author_email": "devika@pursuit.org", "created_at": _ago(2)}]
    d = _get(ThursdayConn(rows, notes=notes))
    assert [o["account"] for o in d["priority"]] == ["JPMC", "RXR"]  # stored 5 = P1
    assert d["priority"][0]["latest_note"]["text"].startswith("Thursday works")
    assert d["priority"][1]["latest_note"] is None


def test_this_week_counts_moves_asks_won_and_lost():
    moves = [
        {"id": A, "account_name": "JPMC", "owner_email": "d@p.org", "deal_type": "ft",
         "from_stage": "active_in_discussions", "to_stage": "ask_submitted", "at": _ago(1), "actor": "d@p.org"},
        # A retired name folded into the stage it already was: not a move.
        {"id": B, "account_name": "RXR", "owner_email": "d@p.org", "deal_type": "ft",
         "from_stage": "reviewing_builders", "to_stage": "builder_submitted", "at": _ago(1), "actor": "d@p.org"},
    ]
    d = _get(ThursdayConn([], moves=moves, won=[_closed(C, "LoanCore") | {"stage": "closed_won"}],
                          lost_week=[_closed(D, "Vertech")]))
    w = d["week"]
    assert [m["account"] for m in w["moves"]] == ["JPMC"]
    assert [a["account"] for a in w["asks"]] == ["JPMC"]
    assert [x["account"] for x in w["won"]] == ["LoanCore"]
    assert w["lost"][0]["detail"] == "Reason: No reason given"
    assert d["definitions"]["asks"]["value"] == 1 and d["definitions"]["moves"]["value"] == 1


def test_lost_reasons_group_with_no_reason_last():
    lost = [_closed(A, "X", "role_cancelled", 20), _closed(B, "Y", "role_cancelled", 50),
            _closed(C, "Z", None, 90), _closed(D, "W", "budget", 100)]
    d = _get(ThursdayConn([], lost_lookback=lost))
    assert [(g["label"], g["count"]) for g in d["lost_reasons"]] == [
        ("Role cancelled", 2), ("No budget", 1), ("No reason given", 1)]
    assert d["definitions"]["lost_reasons"]["value"] == 4


def test_accounts_roll_up_and_stall_after_six_quiet_weeks():
    rows = [_open(A, "Newmark", moved_days=50), _open(B, "Newmark", moved_days=45),
            _open(C, "Burbio", moved_days=2)]
    accounts = [{"k": "newmark", "last_touch": _ago(52), "last_move": _ago(45)},
                {"k": "burbio", "last_touch": _ago(2), "last_move": None}]
    conn = ThursdayConn(rows, accounts=accounts)
    d = _get(conn)
    assert {a["account"]: a["state"] for a in d["accounts"]} == {"Newmark": "stalled", "Burbio": "active"}
    assert [a["account"] for a in d["stalled_accounts"]] == ["Newmark"]
    assert len(d["stalled_accounts"][0]["opportunity_ids"]) == 2
    q = next(c for c in conn.calls if "open_keys AS (" in c[1])
    assert "account_touches" in q[1] and sorted(q[2][1]) == ["burbio", "newmark"]


def test_overview_stalled_leaves_out_slow_but_active():
    from tests.test_jobs_opps_overview import OverviewConn, _set_row
    rows = [_set_row(A, "Quiet", created_days=60, moved_days=60),
            _set_row(B, "Marked", created_days=60, moved_days=60)
            | {"slow_reason": "Enterprise", "slow_check_again": TODAY + timedelta(days=7)}]
    d = make_jobs_client(OverviewConn(rows)).get("/api/jobs/opportunities/overview").json()["data"]
    assert d["summary"]["stalled"] == 1
    assert [r["account"] for r in d["drills"]["stalled"]] == ["Quiet"]


def test_the_dictionary_queries_are_the_rules():
    from routes.jobs import OPPORTUNITY_STAGES_ACTIVE_ANY
    from scripts import import_jobs_dictionary as imp
    cuts = {c["key"]: c for c in next(c for c in imp.load_drafts()["concepts"]
                                      if c["bedrock_key"] == "employer_pipeline")["cuts"]}
    state = jm.dictionary_opportunity_state_sql(OPPORTUNITY_STAGES_ACTIVE_ANY).strip()
    assert cuts["opportunities_active"]["sql_query"] == state
    assert cuts["opportunities_slow"]["sql_query"] == state
    assert cuts["opportunity_stage_moves"]["sql_query"] == jm.dictionary_stage_moves_sql().strip()
    assert cuts["lost_reasons"]["sql_query"] == jm.dictionary_lost_reasons_sql().strip()
    assert (cuts["stalled_opportunity_accounts"]["sql_query"]
            == jm.dictionary_stalled_opportunity_accounts_sql(OPPORTUNITY_STAGES_ACTIVE_ANY).strip())
    assert "slow_check_again" in cuts["stalled_opportunities"]["sql_query"]
