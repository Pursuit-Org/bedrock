"""Classify staff activity (email + calendar) as jobs-related, so outreach
metrics count only employer-placement work — for ANY staff member, not just the
core jobs team.

Design (validated on a 160-item review set, see JOBS_REVIEW_PLAN.md):
  * Judge by INTENT / value-exchange, NOT the counterpart's org type — a company,
    college, funder, or personal LinkedIn contact can all be a potential employer.
  * A curated staff-function map (bedrock.staff_function) is a SOFT prior used only
    to break ties on vague first-touch intros; explicit content always overrides.
  * Calendar invites are content-thin, so they borrow context from recent activity
    with the same attendees.
  * "AI Jobs Institute" / AIJI / JACX is Pursuit's own building — contains "jobs"
    but is real-estate/ops, so it's guarded out.

Verdict (jobs | not_jobs | unclear) + reason + confidence is stored on the row;
the outreach metric filters jobs_relevance='jobs'. Runs in the nightly sync over
newly-synced rows, and once as a backfill.
"""
from __future__ import annotations
import asyncio, json, logging, os, re
from typing import Any, Optional

logger = logging.getLogger(__name__)

MODEL = "claude-haiku-4-5-20251001"
INTERNAL = ("pursuit.org", "pursuit.com")
_MAX_CONCURRENCY = 8

SYSTEM = """You classify staff activity at Pursuit, a nonprofit that trains adults \
("builders"/"fellows") in software/AI and then helps get them HIRED.

Label "jobs" when the PURPOSE of this activity is getting Pursuit builders hired — REGARDLESS \
of who the other party is. A company, a college, a foundation, or a personal LinkedIn \
connection can ALL be a potential employer. Do NOT exclude anyone by their organization type.

Judge by INTENT / the value exchange, not identity:
JOBS — Pursuit is:
- offering/introducing its builders/fellows as talent or candidates to be hired
- probing the other side's hiring needs (open roles, headcount, "are you hiring", team growth)
- coordinating interviews, assessments, trials, offers, start dates, placement logistics
- making a first-touch intro whose evident aim is exploring whether they'd hire builders

NOT jobs — the purpose is something else:
- money TO Pursuit: grants, gifts, sponsorship, donations, investment, funding the program (fundraising/development)
- the program itself: curriculum, cohorts, students, mentorship, build days, admissions/info sessions
- "Bond" (Pursuit's income-share financing / repayment / collections)
- "AI Jobs Institute" / AIJI / JACX — this is Pursuit's OWN building/facility (real estate, lease, line of credit, site visits, space planning, construction vendors). It contains the word "jobs" but is NOT about placing builders — NOT jobs.
- Pursuit hiring its OWN staff/employees: any interview, recruiting, or offer for a role AT Pursuit. Builder-placement interviews name the EMPLOYER (e.g. "Acture Interview: Brandon Jackson"); Pursuit's own hiring reads like "Pursuit Interview, <role title>, <candidate>" or "New <role> Candidate". If PURSUIT is the hiring party, it is NOT jobs.
- INTERNAL coordination among Pursuit staff (pipeline reviews, debriefs, prep, team syncs) — even if it's about jobs or a named employer
- ops / finance / HR / events / galas / newsletters / OOO / auto-replies

Jobs outreach is directed at the EMPLOYER (the hiring company). Activity directed at the
BUILDER themselves is NOT jobs outreach:
- coaching, interview prep, resume review WITH the builder, 1:1s, check-ins, or progress chats
  with a Pursuit builder/fellow (our learner) about their own job search is internal support, NOT jobs.
- NOTE: fellows/builders also have @pursuit.org email addresses, so a meeting/1:1 with a builder
  can look "internal" — that's fine, it's still not employer outreach. If the counterpart is the
  builder (a person we train), not a company that might hire, it is NOT jobs.

The SAME organization can appear for jobs AND fundraising AND program — judge THIS message's purpose.
Staff often WON'T say "jobs" — infer intent from what they are asking for or offering.

A "sender function" is given as a SOFT prior, used ONLY to break ties on vague first-touch/intro
messages (a development officer's vague "let's connect" leans fundraising; the employment team's
leans hiring). Explicit content ALWAYS overrides it: a fundraiser doing clear hiring outreach is
"jobs"; the employment team asking for a grant is "not_jobs".

For CALENDAR meetings the invite is often just a title — use the "Recent activity with these
attendees" block to infer the meeting's purpose when the invite itself is thin.

Return ONLY JSON: {"label":"jobs"|"not_jobs"|"unclear","confidence":0.0-1.0,"reason":"<=14 words"}
Use "unclear" only when neither content nor the prior resolves it (bare title / generic intro, no cues)."""

_TIER_PRIOR = {
    "jobs": "Employer-partnerships / jobs team — primary role is placing builders. On a vague or first-touch intro with no clear ask, lean JOBS.",
    "pbd":  "Program & development (PBD) — primary role is fundraising / partnerships / program, NOT jobs. On a vague or first-touch intro with no clear ask, lean NOT-jobs.",
    "both": "Leadership / cross-functional — does BOTH jobs and non-jobs work. Give NO lean; decide purely from the message content.",
}
_NO_PRIOR = "not characterized — give NO lean; decide purely from content"


def _strip_html(s: Optional[str]) -> str:
    return re.sub(r"<[^>]+>", " ", s or "").replace("&nbsp;", " ").strip()


async def _load_function_map(conn) -> dict[str, str]:
    """email(lower) -> tier prior text. Falls back to empty if table absent."""
    try:
        rows = await conn.fetch("SELECT lower(email) email, tier FROM bedrock.staff_function")
        return {r["email"]: r["tier"] for r in rows}
    except Exception as e:
        logger.warning("staff_function map unavailable (%s); classifying without prior", e)
        return {}


async def _load_intro_contact_ids(conn) -> set[int]:
    """Contacts we've requested an introduction to — any intro_request, any
    status. An intro request is an explicit jobs-outreach signal, so activity
    with these contacts is jobs-relevant regardless of what the text looks like."""
    try:
        rows = await conn.fetch("SELECT DISTINCT contact_id FROM bedrock.intro_request WHERE contact_id IS NOT NULL")
        return {r["contact_id"] for r in rows}
    except Exception as e:
        logger.warning("intro_request unavailable (%s); skipping intro-request signal", e)
        return set()


async def _load_builder_emails(conn) -> set[str]:
    """Lowercased builder/fellow emails (primary + backup). Used to detect when a
    counterpart is one of our learners (coaching, not employer outreach)."""
    try:
        rows = await conn.fetch("SELECT bedrock.builder_emails() AS e")
        return {r["e"].lower() for r in rows if r["e"]}
    except Exception as e:
        logger.warning("builder_emails() unavailable (%s); skipping builder-counterpart detection", e)
        return set()


def _prior_for(email_field: Optional[str], fmap: dict[str, str]) -> str:
    """Match any known staff email that appears in the from/attendee field."""
    hay = (email_field or "").lower()
    for email, tier in fmap.items():
        if email and email in hay:
            return _TIER_PRIOR.get(tier, _NO_PRIOR)
    return _NO_PRIOR


async def _meeting_history(conn, activity_id, ext_domains: list[str]) -> str:
    """Recent activity with the same external attendees — context for thin invites."""
    if not ext_domains:
        return "No external attendees (internal-only meeting)."
    like = " OR ".join(
        f"(email_from ILIKE '%'||${i+2}||'%' OR email_to::text ILIKE '%'||${i+2}||'%' "
        f"OR meeting_attendees::text ILIKE '%'||${i+2}||'%')"
        for i in range(len(ext_domains)))
    rows = await conn.fetch(
        f"""SELECT type, subject, activity_date::date d FROM bedrock.activity
            WHERE deleted_at IS NULL AND id <> $1 AND coalesce(subject,'') <> '' AND ({like})
            ORDER BY activity_date DESC LIMIT 8""",
        activity_id, *ext_domains)
    if not rows:
        return "No prior activity found with these attendees."
    lines = "\n  ".join(f"{r['d']} [{r['type']}] {(r['subject'] or '')[:70]}" for r in rows)
    return "Recent activity with these attendees (use to infer purpose when the invite is thin):\n  " + lines


def _builder_note(counterpart_emails, bset: set[str]) -> str:
    """If any counterpart is a known Pursuit builder/fellow, flag it — the activity
    is likely coaching/support with the learner, not employer outreach."""
    if not bset:
        return ""
    hits = sorted({e for e in counterpart_emails if e and e.lower() in bset})
    if not hits:
        return ""
    return ("\nNOTE: counterpart is a Pursuit BUILDER/FELLOW (our learner): "
            + ", ".join(hits)
            + " — this is coaching/support WITH the builder, not employer outreach. Lean NOT jobs "
              "unless an actual employer is also involved.")


async def _build_prompt(conn, row, fmap: dict[str, str], bset: set[str]) -> str:
    """Assemble the user prompt for one activity row."""
    # Salesforce-logged tasks/events carry no email_from / meeting_attendees, so
    # the email/meeting branches below would build an empty prompt. Judge these
    # from the Subject + Description that SF does provide. They're staff-authored
    # in SF, so there is no actor prior to apply.
    if (row.get("source") == "salesforce") or (
        row["type"] == "email" and not row["email_from"] and not row["email_to"]
    ):
        kind = "EMAIL" if row["type"] == "email" else "MEETING"
        body = _strip_html(row["description"] or row["email_body_text"] or row["email_snippet"] or "")
        return (f"[SALESFORCE-LOGGED {kind}]\nLogged in Salesforce by Pursuit staff — judge the "
                f"purpose from the subject and notes below.\nSubject: {row['subject']}\n\n{body[:3500]}")
    if row["type"] == "email":
        to = [t for t in (row["email_to"] or []) if t]
        ext_to = sorted({t.split("@")[-1].lower() for t in to
                         if not any(t.lower().endswith(d) for d in INTERNAL)})
        who = (f"Recipients include external domains: {', '.join(ext_to)}" if ext_to
               else "INTERNAL EMAIL — all recipients are Pursuit staff" if to
               else "Recipients unknown")
        body = _strip_html(row["email_body_text"] or row["email_snippet"] or "")
        blurb = _builder_note(to, bset)
        return (f"[EMAIL]\nSender function: {_prior_for(row['email_from'], fmap)}\n"
                f"From: {row['email_from']}\n{who}{blurb}\nSubject: {row['subject']}\n\n{body[:3500]}")
    # meeting
    att = row["meeting_attendees"]
    if isinstance(att, str):
        try: att = json.loads(att)
        except Exception: att = []
    emails = [(a.get("email") or "") for a in (att or []) if a.get("email")]
    ext = sorted({e.split("@")[-1].lower() for e in emails
                  if not any(e.lower().endswith(d) for d in INTERNAL)})
    host_prior = _prior_for(json.dumps(att) if att else "", fmap)
    descr = _strip_html(row["description"])
    hist = await _meeting_history(conn, row["id"], ext)
    ctx = f"External attendee domains: {', '.join(ext) if ext else 'none (internal-only meeting)'}"
    blurb = _builder_note(emails, bset)
    return (f"[CALENDAR MEETING]\nHost function: {host_prior}\nSubject: {row['subject']}\n{ctx}{blurb}\n\n"
            f"{descr[:1200]}\n\n{hist}")


async def _noop():
    return None


def _call_model(client, prompt: str) -> dict[str, Any]:
    """Sync Anthropic call — run under asyncio.to_thread."""
    resp = client.messages.create(
        model=MODEL, max_tokens=150, system=SYSTEM,
        messages=[{"role": "user", "content": prompt[:6000]}])
    txt = resp.content[0].text
    m = re.search(r"\{.*\}", txt, re.S)
    if not m:
        return {"label": "unclear", "confidence": 0.0, "reason": "unparseable model output"}
    out = json.loads(m.group(0))
    if out.get("label") not in ("jobs", "not_jobs", "unclear"):
        out = {"label": "unclear", "confidence": 0.0, "reason": "invalid label"}
    return out


async def classify_new_activity(conn, limit: Optional[int] = None,
                                reclassify: bool = False) -> dict[str, Any]:
    """Classify staff-authored email + meeting rows lacking a verdict (or all, if
    reclassify=True). Writes jobs_relevance{,_reason,_confidence,_model,_at}.
    Returns counts. Safe to run repeatedly (idempotent on jobs_relevance IS NULL)."""
    key = os.getenv("ANTHROPIC_API_KEY")
    if not key:
        logger.error("ANTHROPIC_API_KEY not set — skipping jobs-relevance classification")
        return {"error": "no_api_key", "classified": 0}
    try:
        import anthropic
    except ImportError:
        logger.error("anthropic SDK not installed — skipping classification")
        return {"error": "no_sdk", "classified": 0}
    client = anthropic.Anthropic(api_key=key)
    fmap = await _load_function_map(conn)
    bset = await _load_builder_emails(conn)
    intro_set = await _load_intro_contact_ids(conn)

    where_new = "" if reclassify else "AND a.jobs_relevance IS NULL"
    lim = f"LIMIT {int(limit)}" if limit else ""
    rows = await conn.fetch(f"""
        WITH staff_email AS (
            -- Staff roster for author matching: app-login users (org_users)
            -- UNION the interaction-sync roster (sync_staff + aliases).
            -- sync_staff carries staff who never logged into Bedrock and
            -- FORMER employees whose mailboxes we sync historically —
            -- org_users alone silently skipped 21 of 44 synced mailboxes,
            -- leaving their sent mail unclassified (dropped by the outreach
            -- gate). Disabled sync_staff rows are included on purpose: a
            -- departed author's historical mail should still classify.
            SELECT lower(email) AS email FROM public.org_users WHERE is_active
            UNION
            SELECT lower(email) FROM bedrock.sync_staff
            UNION
            SELECT lower(a) FROM bedrock.sync_staff, LATERAL unnest(aliases) AS a
        )
        SELECT a.id, a.type, a.source, a.subject, a.email_from, a.email_to, a.email_snippet,
               a.email_body_text, coalesce(a.description,'') AS description, a.meeting_attendees,
               a.participant_public_contact_id
        FROM bedrock.activity a
        WHERE a.deleted_at IS NULL AND a.type IN ('email','meeting') {where_new}
          AND (
            -- Salesforce-logged tasks/events are authored by Pursuit staff in SF and
            -- carry no email_from/attendees, so the staff actor match below can't
            -- see them; include them explicitly or they stay NULL forever and get
            -- dropped by the outreach gate (jobs_relevance='jobs').
            a.source = 'salesforce'
            OR
            (a.type='email' AND EXISTS (SELECT 1 FROM staff_email s
                 WHERE a.email_from ILIKE '%'||s.email||'%'))
            OR
            (a.type='meeting' AND a.meeting_attendees IS NOT NULL AND EXISTS (
                 SELECT 1 FROM staff_email s
                 WHERE a.meeting_attendees::text ILIKE '%'||s.email||'%'))
          )
        ORDER BY a.activity_date DESC {lim}""")
    if not rows:
        return {"classified": 0, "counts": {}}

    sem = asyncio.Semaphore(_MAX_CONCURRENCY)
    counts = {"jobs": 0, "not_jobs": 0, "unclear": 0}

    async def _model(prompt):
        # One retry on a transient API error so a hiccup doesn't strand the row at
        # NULL (which the outreach gate silently drops). A row that still fails is
        # left NULL on purpose — the next sync re-selects NULL rows and retries.
        async with sem:
            for attempt in range(2):
                try:
                    return await asyncio.to_thread(_call_model, client, prompt)
                except Exception:
                    if attempt == 0:
                        await asyncio.sleep(1.5)
                        continue
                    raise

    # A single asyncpg connection can't run concurrent operations, so DB work
    # (prompt-building reads + result writes) stays serial; only the model calls
    # — the slow part — run concurrently, per chunk.
    CHUNK = 100
    for i in range(0, len(rows), CHUNK):
        chunk = rows[i:i + CHUNK]
        prompts = []
        forced: dict = {}                        # row id -> verdict (skip the model)
        for row in chunk:                       # serial DB reads (meeting history)
            # An intro request for this contact is an explicit jobs signal —
            # tag it 'jobs' deterministically and don't spend a model call.
            if row["participant_public_contact_id"] in intro_set:
                forced[row["id"]] = {"label": "jobs", "confidence": 1.0,
                                     "reason": "intro request exists for this contact"}
                prompts.append(None)
                continue
            try:
                prompts.append(await _build_prompt(conn, row, fmap, bset))
            except Exception as e:
                logger.warning("prompt build failed for %s: %s", row["id"], e)
                prompts.append(None)
        verdicts = await asyncio.gather(         # concurrent model calls, no DB
            *[_model(p) if p else _noop() for p in prompts], return_exceptions=True)
        for row, out in zip(chunk, verdicts):    # serial DB writes
            out = forced.get(row["id"], out)     # intro-request override wins
            if not isinstance(out, dict):
                if isinstance(out, Exception):
                    logger.warning("classify call failed for %s: %s", row["id"], out)
                continue
            label = out["label"]
            model_tag = "rule:intro_request" if row["id"] in forced else MODEL
            await conn.execute(
                """UPDATE bedrock.activity
                   SET jobs_relevance=$2, jobs_relevance_reason=$3, jobs_relevance_confidence=$4,
                       jobs_relevance_model=$5, jobs_relevance_at=now()
                   WHERE id=$1""",
                row["id"], label, (out.get("reason") or "")[:300],
                float(out.get("confidence") or 0.0), model_tag)
            counts[label] = counts.get(label, 0) + 1
        logger.info("jobs-relevance: %d/%d classified", min(i + CHUNK, len(rows)), len(rows))

    total = sum(counts.values())
    logger.info("jobs-relevance classification done: %d rows -> %s", total, counts)
    return {"classified": total, "counts": counts}
