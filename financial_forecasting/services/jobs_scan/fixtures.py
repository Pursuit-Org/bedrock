"""Temporary fixture data for the Job Scan tab, used before the migration lands.

Enabled with JOBS_SCAN_FIXTURES=1. Lets a local Bedrock render a populated
Job Scan tab while bedrock.scraped_job_posting does not exist yet, so the UI can
be reviewed without waiting on schema review.

Every row is a REAL live posting found by running the scanner against that
company's actual ATS board on 2026-07-30, with real warm-contact counts and
names from public.contacts. Fit is null throughout because the LLM scoring pass
is not built — this is what the queue genuinely looks like after a scan.

DELETE THIS FILE once the migration is applied. It is read-only: with fixtures
on, the promotion endpoints refuse rather than pretending to write.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

_NOW = datetime.now(timezone.utc)


def _row(idx, company, key, platform, title, location, lo, hi, src, warm, remote=False):
    return {
        "id": f"fixture-{idx:02d}",
        "account_key": key,
        "company": company,
        "platform": platform,
        "slug": key.split(" ")[0],
        "external_job_id": str(9000 + idx),
        "title": title,
        "location": location,
        "is_remote": remote or "remote" in location.lower(),
        "url": None,
        "salary_min": lo,
        "salary_max": hi,
        "comp_source": src,
        "score": None,
        "classification": None,
        "matched_family": None,
        "reasoning": None,
        "criteria_version": "builder_wide:v1",
        "liveness": "live",
        "first_seen_at": (_NOW - timedelta(hours=6 + idx)).isoformat(),
        "last_seen_at": _NOW.isoformat(),
        "closed_at": None,
        "posted_at": None,
        "triage_state": "new",
        "triaged_by": None,
        "triaged_at": None,
        "promoted_posting_id": None,
        "opportunity_id": None,
        "relationship": "warm_partner" if len(warm) > 1 else "monitored",
        "tier": "priority",
        "warm_contact_count": len(warm),
        "warm_contacts": warm,
    }


_ANGI = ["Amit Gulati", "Christine Li", "Danielle Hall"]
_ATTN = ["Brian Long", "Jesse Greenberg", "Leo Kim"]
_BLOCK = ["Brian Michel", "John Rodriguez"]
_ALET = ["Madina Farid", "Margaret Bowani"]
_APPL = ["Adam Foroughi", "Adam Smith", "Alexis Swanson"]
_A16Z = ["David Haber", "Megan Holston-Alexander"]

FIXTURE_RESULTS = [
    _row(1, "Angi", "angi", "ashby", "Business Development Associate",
         "Remote - United States", 45000, 75000, "jd_regex", _ANGI),
    _row(2, "Angi", "angi", "ashby", "Recruiting Coordinator",
         "Remote - United States", 50000, 75000, "jd_regex", _ANGI),
    _row(3, "Angi", "angi", "ashby", "Inside Sales Representative",
         "Remote - United States", 40000, 78000, "jd_regex", _ANGI),
    _row(4, "Angi", "angi", "ashby", "IT Risk & Compliance Analyst",
         "Remote - United States", 85000, 115000, "jd_regex", _ANGI),
    _row(5, "Attentive", "attentive", "greenhouse", "Program Coordinator",
         "United States", 46000, 65000, "jd_regex", _ATTN),
    _row(6, "Attentive", "attentive", "greenhouse", "Support Engineer",
         "United States", 70000, 80000, "jd_regex", _ATTN),
    _row(7, "Attentive", "attentive", "greenhouse", "Sales Development Representative",
         "United States", 75000, 75000, "jd_regex", _ATTN),
    _row(8, "Attentive", "attentive", "greenhouse", "Account Executive I, Mid-Market",
         "United States", 80000, 90000, "jd_regex", _ATTN),
    _row(9, "Attentive", "attentive", "greenhouse", "Strategy & Operations Associate",
         "United States", 100000, 125000, "jd_regex", _ATTN),
    _row(10, "Block (formerly Square)", "block", "greenhouse",
         "Business Development Rep Associate, New York",
         "New York, NY, United States", 79000, 79000, "jd_regex", _BLOCK),
    _row(11, "Block (formerly Square)", "block", "greenhouse",
         "Business Development Rep Associate",
         "Atlanta, GA, United States", 79000, 79000, "jd_regex", _BLOCK),
    _row(12, "Alethea", "alethea", "greenhouse", "Analyst",
         "Washington, DC or New York", 60000, 100000, "jd_regex", _ALET),
    _row(13, "AppLovin", "applovin", "greenhouse", "Business Development Associate",
         "New York", 105000, 155000, "jd_regex", _APPL),
    _row(14, "AppLovin", "applovin", "greenhouse", "Agency Partnerships Associate",
         "Los Angeles/Santa Monica; New York", 105000, 156000, "jd_regex", _APPL),
    _row(15, "Andreessen Horowitz (a16z)", "andreessen horowitz (a16z)", "greenhouse",
         "Contractor, GTM Coordinator", "Menlo Park, California", None, None, None, _A16Z),
]

FIXTURE_SUMMARY = {
    "by_state": {"new": len(FIXTURE_RESULTS)},
    "boards": {
        "total": 50, "verified": 44, "stale": 5, "failing": 0,
        "last_scan_at": _NOW.isoformat(),
    },
    "new_this_week": len(FIXTURE_RESULTS),
}


def filter_results(state=None, platform=None, has_warm_contact=None, q=None,
                   limit=100, offset=0):
    """Apply the same filters the real endpoint supports, in memory."""
    rows = list(FIXTURE_RESULTS)
    if state:
        rows = [r for r in rows if r["triage_state"] == state]
    if platform:
        rows = [r for r in rows if r["platform"] == platform]
    if has_warm_contact is True:
        rows = [r for r in rows if r["warm_contact_count"] > 0]
    elif has_warm_contact is False:
        rows = [r for r in rows if r["warm_contact_count"] == 0]
    if q:
        needle = q.lower()
        rows = [r for r in rows
                if needle in (r["title"] or "").lower()
                or needle in (r["company"] or "").lower()]
    return rows[offset:offset + limit]
