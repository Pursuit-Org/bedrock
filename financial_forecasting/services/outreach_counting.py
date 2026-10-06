"""Jobs activity: what counts, and how it is counted (PRO-98, D17).

One definition behind every outreach number on the Jobs pages: the Activity
Pipeline table, the summary cards, the Owner cut, the trend chart, the activity
log and every drill under them. They used to be separate SQL with separate
mistakes, the worst being that a synced email was attributed to whoever owned
the MAILBOX (`activity.logged_by`), so a reply landing in Avni's inbox counted
as outreach Avni sent. Sep 23-29 read 62 where the team sent 48.

The work is split in two, so the rules can be tested without a database:

  * `events_sql` fetches CANDIDATE events for a time range and a list of
    senders: every synced email message, every hand-logged email, LinkedIn
    message, text and call, every calendar meeting, every facilitated intro,
    and every first move to Call Booked. It applies only what has to run in the
    database to keep the rows few: the date range, the sender list and the
    jobs-relevance verdict.
  * `Event` and the functions below apply the rules: who sent it, automatic
    mail, cross-mailbox duplicates, which metric it is, which accounts it
    reached, whether it activated an account.

Activity (D17, decided 2026-10-02) is an external touch: email, call, meeting,
LinkedIn, text. Comments are not activity. "Touches" is retired as a term.

Who did it is read from the activity itself, never from the mailbox:
  * synced email: the message's own From (`activity_email_message.from_email`),
    one row per message, so a follow-up counts on the day it went out;
  * synced email with nothing indexed yet: the thread row's From;
  * hand-logged rows: whoever logged them (they typed it in, so they did it);
  * calendar meetings: whose calendar it is on;
  * intros: who asked for the intro;
  * Call Booked: who moved the contact there.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable, Mapping, Optional

# Kinds of event. The first four are outreach the team SENT; call and meeting
# are conversations; call_booked is a pipeline move that only matters for
# activation (a meeting Nick sets up enters at Call Booked and counts, D17).
SEND_KINDS = ("email", "linkedin", "text", "intro")
CALL_KINDS = ("call", "meeting")
ALL_KINDS = SEND_KINDS + CALL_KINDS + ("call_booked",)

SEND_METRIC = {
    "email": "direct_email_sent",
    "linkedin": "linkedin_message_sent",
    "text": "text_sent",
    "intro": "facilitated_intro_sent",
}

# Automated replies and bounces: never outreach, whoever's address they carry.
AUTOREPLY_SUBJECTS = (
    "out of office", "automatic reply", "auto-reply", "autoreply", "auto reply",
    "ooo:", "ooo -", "away from", "on vacation", "on leave", "maternity leave",
    "thank you for your message", "thank you for your email", "thank you for contacting",
    "undeliverable", "delivery status notification", "mail delivery", "returned mail",
    # Devika's auto-reply prefixes the original subject: "Slow to Respond Re: …".
    "slow to respond",
)
AUTOREPLY_SENDERS = ("mailer-daemon", "postmaster", "no-reply", "noreply", "donotreply", "do-not-reply")

# Mail Google Calendar sends FROM the organiser's own address: booking
# confirmations, invitations, RSVPs. Nine of the 39 "direct emails" the 9/30
# audit counted for Sep 23-29 were these. They are not outreach. The meeting
# they announce is counted once, as a meeting, from the calendar sync.
_CALENDAR_NOTICE = re.compile(
    r"^\s*(?:"
    r"appointment (?:booked|canceled|cancelled|rescheduled)"
    r"|(?:updated |new )?invitation"
    r"|accepted|declined|tentatively accepted"
    r"|(?:canceled|cancelled) event"
    r")(?: with note)?\s*:",
    re.IGNORECASE,
)

# The subject the jobs tool writes when a hand-logged touch has none:
# "Email — avni@pursuit.org". It names the logger, not the touch.
_PLACEHOLDER_SUBJECT = re.compile(r"^(?:call|text|linkedin|email) — \S+@\S+$", re.IGNORECASE)

_ADDR = re.compile(r"<([^>]+)>")


def bare_address(raw: Optional[str]) -> Optional[str]:
    """'Avni Nahar <avni@pursuit.org>' -> 'avni@pursuit.org'. None when there is
    no address in it."""
    if not raw:
        return None
    m = _ADDR.search(raw)
    addr = (m.group(1) if m else raw).strip().lower()
    return addr if "@" in addr else None


def jobs_relevant_sql(alias: str) -> str:
    """SQL predicate: the row is jobs-related. Synced email and meetings carry
    the classifier's verdict, or a person's override of it; everything typed
    into the jobs tool is jobs work by construction. See
    services/activity_classifier.py."""
    return (f"(coalesce({alias}.jobs_relevance_override, {alias}.jobs_relevance) = 'jobs' "
            f"OR {alias}.type NOT IN ('email','meeting'))")


def not_autoreply_sql(alias: str) -> str:
    """SQL predicate: the row is NOT an automated reply or bounce. For the
    queries that still filter rows in SQL. The rules are AUTOREPLY_SUBJECTS and
    AUTOREPLY_SENDERS above, so the SQL and is_automatic agree."""
    subj = " AND ".join(f"coalesce({alias}.subject,'') NOT ILIKE '%{p}%'" for p in AUTOREPLY_SUBJECTS)
    frm = " AND ".join(f"coalesce({alias}.email_from,'') NOT ILIKE '%{p}%'" for p in AUTOREPLY_SENDERS)
    return f"({subj} AND {frm})"


def is_calendar_notice(subject: Optional[str]) -> bool:
    return bool(subject and _CALENDAR_NOTICE.match(subject))


def is_autoreply(subject: Optional[str], email_from: Optional[str]) -> bool:
    s = (subject or "").lower()
    f = (email_from or "").lower()
    return any(p in s for p in AUTOREPLY_SUBJECTS) or any(p in f for p in AUTOREPLY_SENDERS)


def display_subject(subject: Optional[str], description: Optional[str]) -> Optional[str]:
    """What a person should read as the subject of an activity row. A
    hand-logged touch saved without a subject carries a placeholder that only
    names who logged it, so its note is shown instead."""
    if subject and _PLACEHOLDER_SUBJECT.match(subject.strip()):
        note = (description or "").strip()
        return note[:200] if note else "Logged by hand"
    return subject


@dataclass(frozen=True)
class Event:
    """One piece of activity, attributed to the Pursuit person who did it."""
    kind: str                       # one of ALL_KINDS
    ts: datetime
    sender: Optional[str]           # bare lowercase address of who did it
    activity_id: Optional[str] = None
    intro_id: Optional[str] = None
    contact_id: Optional[int] = None          # the linked contact, if any
    contact_ids: tuple = ()                   # every contact it reached
    companies: tuple = ()                     # every account it reached
    subject: Optional[str] = None
    email_from: Optional[str] = None
    source: Optional[str] = None
    call_kind: Optional[str] = None
    # For display only; no rule reads these.
    recipients: tuple = ()
    snippet: Optional[str] = None
    description: Optional[str] = None

    @classmethod
    def from_row(cls, r: Mapping) -> "Event":
        """Build from an events_sql row (asyncpg Record or dict)."""
        g = r.get if hasattr(r, "get") else (lambda k, d=None: r[k])
        return cls(
            kind=g("kind"), ts=g("ts"),
            sender=(g("sender") or None) and g("sender").strip().lower(),
            activity_id=str(g("activity_id")) if g("activity_id") is not None else None,
            intro_id=str(g("intro_id")) if g("intro_id") is not None else None,
            contact_id=g("contact_id"),
            contact_ids=tuple(g("contact_ids") or ()),
            companies=tuple(g("companies") or ()),
            subject=g("subject"), email_from=g("email_from"),
            source=g("source"), call_kind=g("call_kind"),
            recipients=tuple(g("recipients") or ()),
            snippet=g("snippet"), description=g("description"),
        )

    @property
    def is_send(self) -> bool:
        return self.kind in SEND_KINDS

    @property
    def is_call(self) -> bool:
        return self.kind in CALL_KINDS

    def is_automatic(self) -> bool:
        """Mail a machine sent in the person's name: an out-of-office, a
        bounce, a calendar notice. Only email can be."""
        return self.kind == "email" and (
            is_autoreply(self.subject, self.email_from) or is_calendar_notice(self.subject))

    def dedup_key(self) -> tuple:
        """Identity of the real-world event. The same synced send is stored
        once per mailbox it landed in, and the sync's own guard misses copies
        whose recipient lists differ by mailbox (Devika's 9/23 Renaissance mail
        is in both her mailbox and Kanika's). Same sender, same second, same
        contact is one message. The contact is part of the key because one
        person can send two different mails in the same second (Damon's two
        "Appointment booked" mails on 9/28). Everything else is already unique
        per row: a hand-logged email typed twice is two logs, not a copy."""
        if self.kind == "email" and self.source == "gmail-sync":
            who = self.contact_id if self.contact_id is not None else (
                tuple(sorted(self.contact_ids)) or self.activity_id)
            return ("email", self.sender, self.ts, who)
        return (self.kind, self.activity_id or self.intro_id, self.ts)

    def metric(self, default_call_kind: str = "general") -> Optional[str]:
        """The Activity Pipeline row this event counts in, or None."""
        if self.kind in SEND_METRIC:
            return SEND_METRIC[self.kind]
        if self.kind in CALL_KINDS:
            return f"call_{self.call_kind or default_call_kind}"
        return None


def attribute(rows: Iterable, senders: Optional[Iterable[str]]) -> list[Event]:
    """The rows as counted activity: done by one of `senders` (all senders
    when None), not automatic mail, each real event once. Sorted oldest
    first, so for duplicates the earliest copy is the one kept."""
    allowed = None if senders is None else {s.strip().lower() for s in senders}
    events = sorted((r if isinstance(r, Event) else Event.from_row(r) for r in rows),
                    key=lambda e: (e.ts, e.kind, e.activity_id or e.intro_id or ""))
    seen: set = set()
    out: list[Event] = []
    for e in events:
        if allowed is not None and e.sender not in allowed:
            continue
        if e.is_automatic():
            continue
        k = e.dedup_key()
        if k in seen:
            continue
        seen.add(k)
        out.append(e)
    return out


def in_window(events: Iterable[Event], start: datetime, end: datetime) -> list[Event]:
    return [e for e in events if start <= e.ts < end]


@dataclass
class Counts:
    """Outreach volume for one window."""
    by_metric: dict = field(default_factory=dict)
    outreach: int = 0           # every send: email + LinkedIn + text + intro
    calls: int = 0              # every call and meeting

    @property
    def direct_email(self) -> int:
        return self.by_metric.get("direct_email_sent", 0)


def count(events: Iterable[Event], default_call_kind: str = "general") -> Counts:
    c = Counts()
    for e in events:
        m = e.metric(default_call_kind)
        if m is None:
            continue
        c.by_metric[m] = c.by_metric.get(m, 0) + 1
        if e.is_send:
            c.outreach += 1
        elif e.is_call:
            c.calls += 1
    return c


def touched_accounts(events: Iterable[Event]) -> dict:
    """account -> the earliest event that reached it."""
    first: dict = {}
    for e in events:
        for co in e.companies:
            if co not in first or e.ts < first[co].ts:
                first[co] = e
    return first


def activated_accounts(window_events: Iterable[Event], prior_events: Iterable[Event]) -> dict:
    """Accounts whose first activity ever is in the window (D17), each with the
    event that activated it. `prior_events` is the same scope's attributed
    activity BEFORE the window on the accounts the window touched. Any of it
    means the account was activated earlier."""
    seen_before = {co for e in prior_events for co in e.companies}
    return {co: e for co, e in touched_accounts(window_events).items() if co not in seen_before}


def split_new(events: Iterable[Event], activated: Iterable[str]) -> dict:
    """New vs ongoing activity (Kwame): an event is NEW when it reached an
    account activated in the same window, ONGOING when it reached only
    accounts worked before, and has NO ACCOUNT when the contact has no company
    on file."""
    act = set(activated)
    out = {"new": 0, "ongoing": 0, "no_account": 0}
    for e in events:
        if not e.companies:
            out["no_account"] += 1
        elif act.intersection(e.companies):
            out["new"] += 1
        else:
            out["ongoing"] += 1
    return out


# ── SQL ──────────────────────────────────────────────────────────────────────

def events_sql(*, has_call_kind: bool = True, restrict_companies: bool = False,
               restrict_contacts: bool = False,
               p_start: str = "$1", p_end: str = "$2", p_senders: str = "$3",
               p_companies: str = "$4", p_contacts: str = "$4") -> str:
    """Candidate activity events.

    Parameters: $1 range start (timestamptz or NULL for no lower bound),
    $2 range end (timestamptz or NULL), $3 the senders (lowercase text[]),
    and, with `restrict_companies`, $4 account keys (text[]): only events that
    reached one of those accounts. That is how activation looks back over all
    history without returning all of it. With `restrict_contacts`, $4 is
    contact ids (int[]) instead: only events that reached one of them (a
    campaign's contacts). `p_*` replace the placeholders, for a caller that
    embeds this twice in one statement.

    Rows: kind, ts, sender, activity_id, intro_id, contact_id, contact_ids,
    companies, subject, description, snippet, email_from, source, call_kind,
    recipients.

    Sender matches are exact on a bare address, which is what keeps this cheap:
    the per-message index has (from_email, sent_at), and nothing here is a
    leading-wildcard ILIKE. The rules in this module (Event.is_automatic,
    dedup) run in Python on what comes back.
    """
    jobs = jobs_relevant_sql("a")
    s, e = f"({p_start})::timestamptz", f"({p_end})::timestamptz"
    senders = f"({p_senders})::text[]"
    rng = lambda col: f"({s} IS NULL OR {col} >= {s}) AND ({e} IS NULL OR {col} < {e})"
    thread_sender = ("lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), "
                     "nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END)))")
    kind_col = "a.call_kind" if has_call_kind else "NULL::text"
    recips_email = "coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[])"
    recips_meeting = ("ARRAY(SELECT att->>'email' FROM jsonb_array_elements("
                      "coalesce(a.meeting_attendees, '[]'::jsonb)) att)")
    restrict = (f"WHERE ev.companies && ({p_companies})::text[]" if restrict_companies
                else f"WHERE ev.contact_ids && ({p_contacts})::int[]" if restrict_contacts else "")
    return f"""
    WITH raw AS (
      -- Synced email, one row per message, by the message's own sender.
      SELECT 'email'::text AS kind, aem.sent_at AS ts, lower(aem.from_email) AS sender,
             a.id AS activity_id, NULL::uuid AS intro_id,
             a.participant_public_contact_id AS contact_id, {recips_email} AS recips,
             a.subject, a.description, a.email_snippet AS snippet, a.email_from, a.source,
             NULL::text AS call_kind
      FROM bedrock.activity_email_message aem
      JOIN bedrock.activity a ON a.id = aem.activity_id
      WHERE aem.from_email = ANY({senders}) AND {rng('aem.sent_at')}
        AND a.deleted_at IS NULL AND a.type = 'email' AND {jobs}
      UNION ALL
      -- Email with no indexed messages: hand-logged, Salesforce-sourced, or
      -- synced since the index last ran. The row stands for itself, by its
      -- own sender (never the mailbox it was synced from).
      SELECT 'email', a.activity_date, {thread_sender},
             a.id, NULL::uuid, a.participant_public_contact_id, {recips_email},
             a.subject, a.description, a.email_snippet, a.email_from, a.source, NULL::text
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type = 'email' AND {rng('a.activity_date')}
        AND {thread_sender} = ANY({senders}) AND {jobs}
        AND NOT EXISTS (SELECT 1 FROM bedrock.activity_email_message m WHERE m.activity_id = a.id)
      UNION ALL
      -- Hand-logged LinkedIn, text and calls, and meetings: whoever logged
      -- it, or whose calendar it is on.
      SELECT a.type, a.activity_date, lower(btrim(a.logged_by)),
             a.id, NULL::uuid, a.participant_public_contact_id,
             CASE WHEN a.type = 'meeting' THEN {recips_meeting} ELSE '{{}}'::text[] END,
             a.subject, a.description, NULL::text, a.email_from, a.source,
             CASE WHEN a.type = 'call' THEN {kind_col} END
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type IN ('linkedin', 'text', 'call', 'meeting')
        AND {rng('a.activity_date')} AND lower(btrim(a.logged_by)) = ANY({senders}) AND {jobs}
      UNION ALL
      -- A facilitated intro that was acted on, by who asked for it. Its
      -- subject is the ask (routes.jobs_intro.ASK_LABELS names it).
      SELECT 'intro', coalesce(ir.responded_at, ir.created_at), lower(ir.requested_by_email),
             NULL::uuid, ir.id, ir.contact_id, '{{}}'::text[],
             ir.specific_ask, ir.context, NULL::text, NULL::text, 'intro', NULL::text
      FROM bedrock.intro_request ir
      WHERE ir.status IN ('accepted', 'completed')
        AND lower(ir.requested_by_email) = ANY({senders})
        AND {rng('coalesce(ir.responded_at, ir.created_at)')}
      UNION ALL
      -- The first move to Call Booked, by who moved it. A meeting someone
      -- else set up (Nick) enters here with no outreach behind it.
      SELECT 'call_booked', h.changed_at, lower(h.changed_by),
             NULL::uuid, NULL::uuid, h.contact_id, '{{}}'::text[],
             NULL::text, NULL::text, NULL::text, NULL::text, 'stage', NULL::text
      FROM (SELECT DISTINCT ON (contact_id) contact_id, changed_at, changed_by
              FROM bedrock.jobs_membership_stage_history
             WHERE to_stage = 'call_booked' ORDER BY contact_id, changed_at) h
      WHERE lower(h.changed_by) = ANY({senders}) AND {rng('h.changed_at')}
    ),
    ev AS (
      SELECT r.*, reach.contact_ids, reach.companies
      FROM raw r
      CROSS JOIN LATERAL (
        SELECT coalesce(array_agg(DISTINCT c.contact_id), '{{}}') AS contact_ids,
               coalesce(array_agg(DISTINCT lower(btrim(c.current_company)))
                          FILTER (WHERE btrim(coalesce(c.current_company, '')) <> ''), '{{}}') AS companies
        FROM public.contacts c
        WHERE c.contact_id = r.contact_id
           OR lower(c.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(r.recips) x))
      ) reach
    )
    SELECT ev.kind, ev.ts, ev.sender, ev.activity_id, ev.intro_id, ev.contact_id,
           ev.contact_ids, ev.companies, ev.subject, ev.description, ev.snippet,
           ev.email_from, ev.source, ev.call_kind, ev.recips AS recipients
    FROM ev {restrict}
    """


def reference_sql() -> str:
    """The three headline numbers in SQL alone: outreach, direct email and
    accounts activated for a window. $1 window start, $2 window end, $3 the
    senders (text[]).

    The same candidates as events_sql, with this module's rules written a
    second time, in SQL, so the data dictionary can hold a query that stands
    on its own (PRO-97 stores it as the metric's sql_query) and anyone can
    check Bedrock's number against it. Checked on production 2026-10-06: Wed
    9/23 - Tue 9/29 on UTC days gives 36 / 27 / 16, Mon 9/21 - Sun 9/27 New
    York gives 56 / 46 / 15, the same as the Python rules on the same data
    (tests/test_outreach_counting.py). If a rule changes here, change it there.
    """
    notice = _CALENDAR_NOTICE.pattern.replace("(?:", "(")
    auto_subj = " OR ".join(f"lower(coalesce(e.subject, '')) LIKE '%{p}%'" for p in AUTOREPLY_SUBJECTS)
    auto_from = " OR ".join(f"lower(coalesce(e.email_from, '')) LIKE '%{p}%'" for p in AUTOREPLY_SENDERS)
    candidates = events_sql(p_start="NULL", p_end="$2", p_senders="$3")
    return f"""
    WITH e AS ({candidates}),
    counted AS (               -- automatic mail is not activity
      SELECT * FROM e
      WHERE NOT (e.kind = 'email' AND (e.subject ~* '{notice}' OR {auto_subj} OR {auto_from}))
    ),
    once AS (                  -- a send stored in two mailboxes counts once
      SELECT DISTINCT ON (k) * FROM (
        SELECT c.*, CASE WHEN c.kind = 'email' AND c.source = 'gmail-sync'
                         THEN 'email|' || c.sender || '|' || c.ts::text || '|' ||
                              coalesce(c.contact_id::text,
                                       nullif(array_to_string(c.contact_ids, ','), ''),
                                       c.activity_id::text)
                         ELSE c.kind || '|' || coalesce(c.activity_id::text, c.intro_id::text, '')
                              || '|' || c.ts::text END AS k
        FROM counted c) x
      ORDER BY k, ts
    ),
    first_activity AS (        -- D17: the first activity ever on each account
      SELECT co, min(ts) AS first_ts FROM once, unnest(once.companies) co GROUP BY co
    )
    SELECT
      count(*) FILTER (WHERE kind IN ('email', 'linkedin', 'text', 'intro')
                         AND ts >= $1 AND ts < $2) AS outreach,
      count(*) FILTER (WHERE kind = 'email' AND ts >= $1 AND ts < $2) AS direct_email,
      (SELECT count(*) FROM first_activity WHERE first_ts >= $1 AND first_ts < $2) AS accounts_activated
    FROM once
    """
