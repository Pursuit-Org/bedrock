"""PRO-98: what counts as Jobs outreach, pinned against real data.

The fixture is an anonymized production export of every candidate event in
Mon 9/21 - Wed 9/30 (New York) for every Pursuit sender, plus the earliest
earlier event per (account, sender) on the accounts that window touched. See
scripts/export_outreach_fixture.py. No database, no network.

Two sets of numbers are pinned:
  * the 9/30 audit's method (team-sent, nothing else removed), which gives
    exactly the audit's 48 outreach / 39 direct email on its rolling week, so
    the fixture provably is the data the audit counted;
  * the rules decided 10/6 (cross-mailbox copies once, Google Calendar notices
    out), which is what Bedrock now shows.
"""
import json
from datetime import datetime
from pathlib import Path

import pytest

from services import outreach_counting as oc
from tests.jobs_fakes import FakeConn

FIXTURE = Path(__file__).parent / "fixtures" / "outreach_2026_09_21.json"

# The Jobs team as at the audit (D7): Avni, Damon, Devika. Not the live table,
# which changed on 10/5.
TEAM = ["avni@pursuit.org", "damon.kornhauser@pursuit.org", "devika@pursuit.org"]

# The audit's week, Wed 9/23 - Tue 9/29, counted (as the audit did) on UTC days.
ROLLING_UTC = (datetime.fromisoformat("2026-09-23T00:00:00+00:00"),
               datetime.fromisoformat("2026-09-30T00:00:00+00:00"))
# The same days on New York time, which is what Bedrock uses now (D8).
ROLLING_NY = (datetime.fromisoformat("2026-09-23T04:00:00+00:00"),
              datetime.fromisoformat("2026-09-30T04:00:00+00:00"))
# The calendar week D8 asks to pin: Mon 9/21 - Sun 9/27, New York.
CALENDAR_WEEK = (datetime.fromisoformat("2026-09-21T04:00:00+00:00"),
                 datetime.fromisoformat("2026-09-28T04:00:00+00:00"))


@pytest.fixture(scope="module")
def events():
    fx = json.loads(FIXTURE.read_text())
    cols = fx["columns"]
    out = []
    for r in fx["rows"]:
        row = dict(zip(cols, r))
        row["ts"] = datetime.fromisoformat(row["ts"])
        out.append(oc.Event.from_row(row))
    return out


def _audit_method(events, window):
    """What the 9/30 audit counted: every team-sent event, nothing else removed."""
    start, end = window
    return [e for e in events if e.sender in TEAM and start <= e.ts < end and e.is_send]


def _pins(events, window):
    start, end = window
    counted = oc.attribute(events, TEAM)
    win = oc.in_window(counted, start, end)
    prior = [e for e in counted if e.ts < start]
    c = oc.count(win)
    return c.outreach, c.direct_email, len(oc.activated_accounts(win, prior))


# ── the audit reproduces ─────────────────────────────────────────────────────

def test_audit_method_reproduces_the_audits_48_and_39(events):
    sends = _audit_method(events, ROLLING_UTC)
    assert len(sends) == 48
    assert sum(e.kind == "email" for e in sends) == 39
    # The 9 that aren't email: 1 LinkedIn, 1 text, 7 facilitated intros.
    assert sorted(e.kind for e in sends if e.kind != "email") == ["intro"] * 7 + ["linkedin", "text"]


def test_no_email_is_attributed_to_a_mailbox_owner(events):
    """The bug: a reply landing in Avni's inbox counted as Avni's outreach.
    Every candidate email's sender is who wrote it, so mail from colleagues in
    a team mailbox (Erica, Kanika, Nick) is in the fixture and never counted."""
    counted = oc.attribute(events, TEAM)
    assert {e.sender for e in counted} <= set(TEAM)
    others = {e.sender for e in events if e.sender not in TEAM}
    assert {"nick@pursuit.org", "kwame@pursuit.org"} <= others


# ── the rules decided 10/6 ───────────────────────────────────────────────────

def test_rolling_week_pins(events):
    # 48 / 39 less 3 cross-mailbox copies and 9 Google Calendar notices.
    assert _pins(events, ROLLING_UTC) == (36, 27, 16)


def test_rolling_week_on_new_york_days(events):
    assert _pins(events, ROLLING_NY) == (33, 24, 14)


def test_calendar_week_pins(events):
    """D8: a week is Monday to Sunday, New York time."""
    assert _pins(events, CALENDAR_WEEK) == (56, 46, 15)


def _distinct(events):
    return oc.distinct(events)


def test_cross_mailbox_copies_count_once(events):
    sends = _audit_method(events, ROLLING_UTC)
    assert len(sends) - len(_distinct(sends)) == 3


def test_calendar_notices_are_not_outreach(events):
    # Counted after dedup: one of the copies above is a notice sent twice.
    notices = [e for e in _distinct(_audit_method(events, ROLLING_UTC))
               if oc.is_calendar_notice(e.subject)]
    assert len(notices) == 9
    assert not set(notices) & set(oc.attribute(events, TEAM))


def test_new_and_ongoing_split_adds_up(events):
    start, end = ROLLING_UTC
    counted = oc.attribute(events, TEAM)
    win = oc.in_window(counted, start, end)
    act = oc.activated_accounts(win, [e for e in counted if e.ts < start])
    split = oc.split_new(win, act)
    assert sum(split.values()) == len(win)
    assert split["new"] >= len(act)    # every activated account came with at least one event


def test_fixture_holds_each_event_once(events):
    """Each fixture row is a whole event. An event cut into one row per
    account reads as copies of itself, dedup keeps one, and the other accounts
    lose their history: the first export did that and pinned 20 accounts
    activated where the data says 15."""
    keys = [(e.kind, e.sender, e.ts, e.activity_id, e.intro_id, e.contact_id) for e in events]
    assert len(keys) == len(set(keys))


def test_reference_sql_applies_the_same_rules():
    """The dictionary's stand-alone query (PRO-97) must use this module's rule
    lists, not a copy that drifts. Its numbers were checked against the pins
    above on production (see reference_sql)."""
    sql = oc.reference_sql()
    assert all(p in sql for p in oc.AUTOREPLY_SUBJECTS + oc.AUTOREPLY_SENDERS)
    assert "appointment (booked|canceled|cancelled|rescheduled)" in sql
    assert "d.activity_id::text < c.activity_id::text" in sql and "first_activity" in sql
    assert "logged_by" not in sql.split("UNION ALL")[0]


# ── the rules, case by case ──────────────────────────────────────────────────

T0 = datetime.fromisoformat("2026-09-24T15:00:00+00:00")


def _ev(**kw):
    base = dict(kind="email", ts=T0, sender="avni@pursuit.org", activity_id="a1",
                contact_id=1, source="gmail-sync")
    base.update(kw)
    return oc.Event(**base)


def test_same_send_in_two_mailboxes_is_one():
    a = _ev(activity_id="a1")
    b = _ev(activity_id="a2")                      # same message, another mailbox
    assert len(oc.attribute([a, b], TEAM)) == 1


def test_copies_linked_to_different_contacts_are_one_when_they_share_a_recipient():
    """19 such groups since June: one message to several people, each mailbox's
    copy linked to a different one of them."""
    a = _ev(activity_id="a1", contact_id=1, recipients=("jo@acme.com", "al@acme.com"))
    b = _ev(activity_id="a2", contact_id=2, recipients=("AL@acme.com",))
    assert len(oc.attribute([a, b], TEAM)) == 1


def test_two_call_booked_moves_in_the_same_second_are_two():
    a = _ev(kind="call_booked", source="stage", activity_id=None, contact_id=1)
    b = _ev(kind="call_booked", source="stage", activity_id=None, contact_id=2)
    assert len(oc.attribute([a, b], TEAM)) == 2


def test_two_sends_in_the_same_second_to_different_people_are_two():
    a = _ev(activity_id="a1", contact_id=1)
    b = _ev(activity_id="a2", contact_id=2)
    assert len(oc.attribute([a, b], TEAM)) == 2


def test_two_hand_logged_emails_are_two_even_on_the_same_day():
    a = _ev(activity_id="m1", source="manual")
    b = _ev(activity_id="m2", source="manual")
    assert len(oc.attribute([a, b], TEAM)) == 2


@pytest.mark.parametrize("subject", [
    "Appointment booked: 20 min w/ Damon",
    "Updated invitation with note: DF/Mizuho Midpoint Meetings",
    "Invitation: Pursuit / Acme @ Tue Oct 6",
    "Accepted: Pursuit / Acme",
    "Automatic reply: Following up",
])
def test_automatic_mail_is_not_outreach(subject):
    assert oc.attribute([_ev(subject=subject)], TEAM) == []


@pytest.mark.parametrize("subject", [
    "Re: Invitation to our hiring event",       # a person, writing about an invitation
    "Following up - Acme <> Pursuit",
    None,
])
def test_people_writing_are_outreach(subject):
    assert len(oc.attribute([_ev(subject=subject)], TEAM)) == 1


def test_a_calendar_meeting_is_activity_but_not_outreach():
    c = oc.count(oc.attribute([_ev(kind="meeting", source="calendar-sync", subject="Invitation: x")], TEAM))
    assert (c.outreach, c.calls) == (0, 1)


def test_call_booked_activates_an_account_but_is_not_volume():
    """D17: a meeting Nick sets up enters at Call Booked, and counts."""
    cb = _ev(kind="call_booked", source="stage", companies=("acme",))
    c = oc.count([cb])
    assert (c.outreach, c.calls) == (0, 0)
    assert list(oc.activated_accounts([cb], [])) == ["acme"]


def test_an_account_worked_before_is_not_activated_again():
    earlier = _ev(ts=datetime.fromisoformat("2026-08-01T15:00:00+00:00"), companies=("acme",))
    now = _ev(companies=("acme", "globex"), activity_id="a9")
    assert list(oc.activated_accounts([now], [earlier])) == ["globex"]


def test_metric_names_match_the_activity_pipeline_rows():
    assert _ev().metric() == "direct_email_sent"
    assert _ev(kind="intro").metric() == "facilitated_intro_sent"
    assert _ev(kind="call", call_kind="discovery").metric() == "call_discovery"
    assert _ev(kind="call").metric() == "call_general"
    assert _ev(kind="call_booked").metric() is None


def test_placeholder_subject_shows_the_note():
    assert oc.display_subject("Email — avni@pursuit.org", "Asked about Q4 roles") == "Asked about Q4 roles"
    assert oc.display_subject("Linkedin — damon.kornhauser@pursuit.org", None) == "Logged by hand"
    assert oc.display_subject("Re: roles", "x") == "Re: roles"


# ── the SQL ──────────────────────────────────────────────────────────────────

def test_events_sql_never_attributes_email_to_the_mailbox():
    """logged_by is the mailbox an email was synced from. It may only name who
    did a hand-logged touch, a calendar's owner, or a manual email's author."""
    sql = oc.events_sql()
    email_parts = sql.split("UNION ALL")[:2]           # per-message, then thread
    assert "aem.from_email = ANY" in email_parts[0]
    assert "logged_by" not in email_parts[0]
    assert "CASE WHEN a.source = 'manual' THEN a.logged_by END" in email_parts[1]
    assert "ILIKE" not in sql                          # exact sender matches only


@pytest.mark.asyncio
async def test_events_sql_runs_with_its_parameters_through_fakeconn():
    conn = FakeConn(lists={"activity_email_message aem": [
        {"kind": "email", "ts": T0, "sender": "avni@pursuit.org", "activity_id": "a1",
         "intro_id": None, "contact_id": 1, "contact_ids": [1], "companies": ["acme"],
         "subject": "Hello", "email_from": "avni@pursuit.org", "source": "gmail-sync",
         "call_kind": None}]})
    rows = await conn.fetch(oc.events_sql(), ROLLING_NY[0], ROLLING_NY[1], TEAM)
    assert oc.count(oc.attribute(rows, TEAM)).direct_email == 1


# ── the routes ───────────────────────────────────────────────────────────────

from datetime import date, timedelta  # noqa: E402

from tests.jobs_fakes import EVENTS, PRIOR_EVENTS, event_row, make_jobs_client  # noqa: E402


@pytest.fixture
def _clear_overrides():
    from main import app
    yield
    app.dependency_overrides.clear()


def test_weeks_are_monday_to_sunday_new_york():
    from routes.jobs import _outreach_windows, _NY
    this_start, this_end, last_start, last_end = _outreach_windows("week", None, None)
    assert this_start.tzinfo is _NY and this_start.weekday() == 0
    assert (this_start.hour, this_start.minute) == (0, 0)
    assert this_end - this_start == timedelta(days=7)
    assert last_end == this_start
    assert this_end.date() <= datetime.now(_NY).date()       # a completed week


def test_custom_dates_are_new_york_days():
    """2026-09-23 means midnight in New York (04:00 UTC), not UTC midnight."""
    from routes.jobs import _outreach_windows
    s, e, ls, le = _outreach_windows("week", "2026-09-23", "2026-09-29")
    assert (s, e) == ROLLING_NY
    assert le == s and (s - ls) == timedelta(days=7)


# The conversions count (a membership stamp, not an event) is its own query.
NO_CONVERSIONS = "m.converted_at IS NOT NULL"


def _last_week(hours=1):
    from routes.jobs import _outreach_windows
    s, _, ls, _ = _outreach_windows("week", None, None)
    return s + timedelta(hours=hours), ls + timedelta(hours=hours)


def test_scorecard_counts_the_events_per_window(_clear_overrides):
    this_t, last_t = _last_week()
    conn = FakeConn(rows={NO_CONVERSIONS: {"n0": 0, "n1": 0}}, lists={
        PRIOR_EVENTS: [],
        EVENTS: [
            event_row(ts=this_t, contact_id=1, companies=["acme"]),
            event_row(ts=this_t, activity_id="copy", contact_id=1, companies=["acme"]),  # other mailbox
            event_row(ts=this_t, subject="Appointment booked: 20 min", contact_id=2),
            event_row(kind="linkedin", ts=this_t),
            event_row(kind="call", ts=this_t, call_kind="discovery"),
            event_row(ts=last_t, contact_id=3, companies=["globex"]),
        ]})
    r = make_jobs_client(conn).get("/api/jobs/outreach/scorecard")
    assert r.status_code == 200, r.text
    rows = {x["metric"]: x for x in r.json()["data"]["activity_pipeline"]}
    assert (rows["direct_email_sent"]["this_period"], rows["direct_email_sent"]["last_period"]) == (1, 1)
    assert rows["total_outreach_activity"]["this_period"] == 2       # email + LinkedIn
    assert rows["total_calls"]["this_period"] == 1
    assert rows["accounts_activated"]["this_period"] == 1
    assert rows["total_outreach_activity"]["split"] == {"new": 1, "ongoing": 0, "no_account": 1}


def test_by_owner_reads_once_and_splits_by_sender(_clear_overrides, monkeypatch):
    import routes.jobs as jobs
    monkeypatch.setattr(jobs, "scorecard_owners", lambda: TEAM)
    this_t, _ = _last_week()
    conn = FakeConn(rows={NO_CONVERSIONS: {"n0": 0, "n1": 0}}, lists={EVENTS: [
        event_row(ts=this_t, sender="avni@pursuit.org"),
        event_row(ts=this_t, sender="avni@pursuit.org", contact_id=5),
        event_row(ts=this_t, sender="devika@pursuit.org"),
    ]})
    r = make_jobs_client(conn).get("/api/jobs/outreach/scorecard/by-owner")
    assert r.status_code == 200, r.text
    by = {x["owner"]: x["outreach"]["this_period"] for x in r.json()["data"]["rows"]}
    assert by == {"avni@pursuit.org": 2, "devika@pursuit.org": 1, "damon.kornhauser@pursuit.org": 0}
    assert sum(1 for c in conn.calls if EVENTS in c[1]) == 1


def test_campaign_numbers_use_the_same_activity(_clear_overrides):
    """CMP-06: a campaign counts what Pursuit sent its contacts, per message,
    each send once, no calendar notices; a Call Booked move is not activity."""
    from routes.jobs import _CAMPAIGN_STAGES
    t = datetime.fromisoformat("2026-09-24T15:00:00+00:00")
    conn = FakeConn(
        rows={"WITH camp AS": {"contacts_all": 3, "accounts_all": 2, "in_pipeline": 2,
                               "accounts": 1, "with_email": 2, "st_none": 0,
                               **{f"st_{s}": 0 for s in _CAMPAIGN_STAGES}}},
        lists={
            "contact_tag_catalog": [{"slug": "op35", "label": "Operation 35",
                                     "sort_order": 1, "owner_email": None}],
            "unnest(c.tags)": [{"contact_id": 1, "company": "acme"},
                               {"contact_id": 2, "company": None}],
            "org_users": [{"email": "nick@pursuit.org"}],
            EVENTS: [
                event_row(ts=t, contact_id=1),
                event_row(ts=t, contact_id=1, activity_id="copy"),          # other mailbox
                event_row(ts=t, contact_id=2, subject="Invitation: Pursuit / Acme"),
                event_row(kind="meeting", ts=t, contact_id=2, sender="nick@pursuit.org"),
                event_row(kind="call_booked", ts=t, contact_id=2),
                event_row(ts=t, contact_id=99),                             # not in the campaign
            ],
        })
    r = make_jobs_client(conn).get(
        "/api/jobs/tag-campaigns/op35/stats?date_from=2026-09-21&date_to=2026-09-27")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["totals"]["activated_contacts"] == 2 and d["totals"]["activated_accounts"] == 1
    o = d["outreach"]
    assert (o["emails"], o["calls_booked"], o["total"]) == (1, 1, 2)
    assert sum(b["total"] for b in d["trend"]) == 2
