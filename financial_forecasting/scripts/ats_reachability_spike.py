"""Spike: can we reach public ATS job-board endpoints, and how many of our warm
companies actually resolve to one?

This answers the single open question blocking the jobs-scan design: the three
"free public JSON endpoint" ATS platforms (Greenhouse, Ashby, Lever) are
documented as unauthenticated, but we have not verified them from our own
egress, and we do not know what share of *our* warm companies run on them.

Read-only. Issues SELECTs against the DB and GETs against public endpoints.
Writes nothing but a local CSV report.

Usage:
    export DATABASE_URL=$(gcloud secrets versions access latest \
        --secret=jobs-dev-database-url --project=pursuit-ops)
    python3 scripts/ats_reachability_spike.py                # full warm list
    python3 scripts/ats_reachability_spike.py --limit 40     # quick sample
    python3 scripts/ats_reachability_spike.py --smoke        # no DB, 6 known slugs

Interpreting the output:
  * "unreachable" on every platform  -> our egress is blocked (proxy/bot wall),
    not a slug problem. Re-run from a different network before concluding
    anything about coverage.
  * resolved_with_jobs               -> usable board, ready to scan.
  * resolved_empty                   -> HTTP 200 but zero postings. Ambiguous:
    either a genuinely empty board or a stale slug after an ATS migration
    (a real failure mode -- the old board returns [] rather than a 404).
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

try:
    import httpx
except ImportError:
    sys.exit("httpx required. pip install httpx")

# Warm tags that define "a company we have a relationship with". Kept in sync
# with the tags in bedrock.contact_tag_catalog.
WARM_TAGS = (
    "other_hiring_partner",
    "prior_commit_partner",
    "board",
    "opboard",
    "ciso_council",
    "volunteer_current",
    "alumni_ai_native",
    "tristate_smb_leaders",
)

# Free-mail and our own domains never identify an employer.
NON_CORPORATE_DOMAINS = {
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
    "aol.com", "me.com", "msn.com", "comcast.net", "verizon.net",
    "protonmail.com", "live.com", "pursuit.org", "c4q.nyc",
}

# Legal/─corporate suffixes to strip before slugifying a display name.
_LEGAL_SUFFIX = re.compile(
    r"\b(inc|llc|ltd|limited|corp|corporation|co|company|group|holdings|"
    r"partners|foundation|the|plc|lp|llp|sa|nv|gmbh)\b",
    re.IGNORECASE,
)

# Concurrency: polite but not slow. These are public endpoints; keep it modest.
MAX_CONCURRENT = 12
TIMEOUT_SECONDS = 20

SMOKE_SLUGS = [
    ("Stripe", "stripe.com"),
    ("Ramp", "ramp.com"),
    ("Airtable", "airtable.com"),
    ("Braze", "braze.com"),
    ("Etsy", "etsy.com"),
    ("Cloudflare", "cloudflare.com"),
]


@dataclass
class Company:
    name: str
    domain: str
    contacts: int = 0
    tags: str = ""


@dataclass
class Probe:
    company: str
    platform: str
    slug: str
    outcome: str  # resolved_with_jobs | resolved_empty | not_found | unreachable
    job_count: int = 0
    http_status: int = 0
    detail: str = ""


@dataclass
class Report:
    probes: list[Probe] = field(default_factory=list)

    def add(self, p: Probe) -> None:
        self.probes.append(p)


# ---------------------------------------------------------------------------
# Slug candidate generation
# ---------------------------------------------------------------------------
def slug_candidates(company: Company) -> list[str]:
    """Generate ordered, deduped slug guesses for a company.

    Domain root first -- it is the single best predictor (redcanary.com ->
    'redcanary'). Then normalized display-name variants.
    """
    out: list[str] = []

    def push(s: str) -> None:
        s = s.strip("-").strip()
        if s and s not in out:
            out.append(s)

    # 1. Domain root, minus public suffix and any www/subdomain.
    if company.domain:
        host = company.domain.lower().strip()
        parts = [p for p in host.split(".") if p not in ("www",)]
        if len(parts) >= 2:
            # us.hsbc.com -> hsbc ; gethealthie.com -> gethealthie
            push(parts[-2])
        if len(parts) >= 3:
            push(parts[0])  # subdomain sometimes IS the brand

    # 2. Display name variants.
    name = company.name.lower()
    name = re.sub(r"\(.*?\)", " ", name)          # drop parentheticals
    name = re.sub(r"[^a-z0-9\s-]", " ", name)     # drop punctuation
    stripped = _LEGAL_SUFFIX.sub(" ", name)

    for variant in (stripped, name):
        tokens = variant.split()
        if not tokens:
            continue
        push("".join(tokens))
        push("-".join(tokens))
        if len(tokens) > 1:
            push(tokens[0])  # first word alone, e.g. "Braze Inc" -> braze

    return out[:4]  # cap the fan-out; 4 guesses x 3 platforms is plenty


# ---------------------------------------------------------------------------
# Platform fetchers. Each returns (outcome, job_count, status, detail).
# ---------------------------------------------------------------------------
async def _get(client: httpx.AsyncClient, url: str) -> tuple[int, object, str]:
    try:
        r = await client.get(url)
    except httpx.HTTPError as e:
        return 0, None, f"{type(e).__name__}: {str(e)[:120]}"
    if r.status_code != 200:
        return r.status_code, None, ""
    try:
        return 200, r.json(), ""
    except ValueError:
        return 200, None, "non-JSON body"


async def probe_greenhouse(client, slug: str):
    status, data, detail = await _get(
        client,
        f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=false",
    )
    if status == 0:
        return "unreachable", 0, 0, detail
    if status == 404:
        return "not_found", 0, 404, ""
    if status != 200 or not isinstance(data, dict):
        return ("unreachable" if status in (403, 429, 503) else "not_found"), 0, status, detail
    jobs = data.get("jobs") or []
    return ("resolved_with_jobs" if jobs else "resolved_empty"), len(jobs), 200, ""


async def probe_ashby(client, slug: str):
    status, data, detail = await _get(
        client, f"https://api.ashbyhq.com/posting-api/job-board/{slug}"
    )
    if status == 0:
        return "unreachable", 0, 0, detail
    # Ashby returns 404 for unknown boards, sometimes 400.
    if status in (400, 404):
        return "not_found", 0, status, ""
    if status != 200 or not isinstance(data, dict):
        return ("unreachable" if status in (403, 429, 503) else "not_found"), 0, status, detail
    jobs = data.get("jobs") or []
    return ("resolved_with_jobs" if jobs else "resolved_empty"), len(jobs), 200, ""


async def probe_lever(client, slug: str):
    status, data, detail = await _get(
        client, f"https://api.lever.co/v0/postings/{slug}?mode=json"
    )
    if status == 0:
        return "unreachable", 0, 0, detail
    if status in (400, 404):
        return "not_found", 0, status, ""
    if status != 200 or not isinstance(data, list):
        return ("unreachable" if status in (403, 429, 503) else "not_found"), 0, status, detail
    return ("resolved_with_jobs" if data else "resolved_empty"), len(data), 200, ""


PLATFORMS = {
    "greenhouse": probe_greenhouse,
    "ashby": probe_ashby,
    "lever": probe_lever,
}


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
async def probe_company(
    client: httpx.AsyncClient,
    sem: asyncio.Semaphore,
    company: Company,
    platforms: list[str],
    report: Report,
) -> None:
    """Probe every (slug, platform) pair for one company.

    Stops early on the first resolved_with_jobs -- that is the answer; further
    guesses would only add noise and load.
    """
    for slug in slug_candidates(company):
        for platform in platforms:
            async with sem:
                outcome, count, status, detail = await PLATFORMS[platform](client, slug)
            # Only record informative results; skip the sea of not_founds.
            if outcome != "not_found":
                report.add(Probe(company.name, platform, slug, outcome,
                                 count, status, detail))
            if outcome == "resolved_with_jobs":
                return
    # Nothing resolved -- record one explicit miss so the company appears in the CSV.
    if not any(p.company == company.name for p in report.probes):
        report.add(Probe(company.name, "-", "-", "not_found"))


def load_warm_companies(limit: int | None) -> list[Company]:
    """Read the warm-company seed straight from the DB. SELECT only.

    Derives the employer domain from each warm contact's work email, which
    resolves ~5x more companies than joining current_company to companies.name.
    """
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL not set (or use --smoke to skip the DB)")
    try:
        import psycopg2
    except ImportError:
        sys.exit("psycopg2 required for DB mode. pip install psycopg2-binary")

    sql = """
        SELECT min(trim(c.current_company)) AS name,
               lower(split_part(c.email, '@', 2)) AS domain,
               count(*) AS contacts,
               string_agg(DISTINCT t, '|') AS tags
        FROM public.contacts c, unnest(c.tags) AS t
        WHERE t = ANY(%s)
          AND c.current_company IS NOT NULL AND trim(c.current_company) <> ''
          AND c.email LIKE '%%@%%'
        GROUP BY lower(trim(c.current_company)),
                 lower(split_part(c.email, '@', 2))
        HAVING lower(split_part(c.email, '@', 2)) <> ALL(%s)
        ORDER BY count(*) DESC, 1
    """
    conn = psycopg2.connect(url)
    try:
        with conn.cursor() as cur:
            cur.execute(sql, (list(WARM_TAGS), list(NON_CORPORATE_DOMAINS)))
            rows = cur.fetchall()
    finally:
        conn.close()

    companies = [Company(name=r[0], domain=r[1], contacts=r[2], tags=r[3])
                 for r in rows]

    # One row per company: keep the domain backed by the most contacts. Warm
    # contacts carry stale employers (a contact who left Uber still has an old
    # address), so the same company legitimately shows up under several domains.
    best: dict[str, Company] = {}
    for c in companies:
        key = c.name.lower()
        if key not in best or c.contacts > best[key].contacts:
            best[key] = c
    deduped = sorted(best.values(), key=lambda c: (-c.contacts, c.name))
    return deduped[:limit] if limit else deduped


def summarize(report: Report, companies: list[Company], out_path: Path) -> int:
    by_company: dict[str, list[Probe]] = {}
    for p in report.probes:
        by_company.setdefault(p.company, []).append(p)

    resolved, empty_only, missed, blocked = [], [], [], []
    for c in companies:
        probes = by_company.get(c.name, [])
        if any(p.outcome == "resolved_with_jobs" for p in probes):
            resolved.append(c.name)
        elif any(p.outcome == "resolved_empty" for p in probes):
            empty_only.append(c.name)
        elif any(p.outcome == "unreachable" for p in probes):
            # Never actually reached -- NOT evidence that the company has no
            # board. Counting these as misses would understate coverage on a
            # partially-blocked run, which is how a silent cap becomes a wrong
            # conclusion.
            blocked.append(c.name)
        else:
            missed.append(c.name)

    unreachable = [p for p in report.probes if p.outcome == "unreachable"]
    total_probes = len(report.probes)
    n = len(companies) or 1

    with out_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["company", "platform", "slug", "outcome", "job_count",
                    "http_status", "detail"])
        for p in sorted(report.probes, key=lambda p: (p.company, p.platform)):
            w.writerow([p.company, p.platform, p.slug, p.outcome,
                        p.job_count, p.http_status, p.detail])

    print("\n" + "=" * 68)
    print("  ATS reachability spike")
    print("=" * 68)

    if unreachable and not resolved:
        print("\n  !! VERDICT: EGRESS BLOCKED, NOT A COVERAGE RESULT.")
        print("     Every informative probe failed to connect or was refused.")
        print("     Coverage numbers below are meaningless. Re-run from a")
        print("     different network before drawing any conclusion.")
        codes = Counter(p.http_status for p in unreachable)
        print(f"     status codes seen: {dict(codes)}")
        sample = unreachable[0]
        if sample.detail:
            print(f"     example: {sample.detail}")
    else:
        print("\n  VERDICT: endpoints are reachable. Coverage is real.")

    # Coverage is only meaningful over companies we actually reached.
    reachable = len(companies) - len(blocked)
    denom = reachable or 1

    print(f"\n  Companies probed:        {len(companies)}")
    print(f"  Resolved (live board):   {len(resolved)}  "
          f"({100*len(resolved)/denom:.0f}% of reached)")
    print(f"  Resolved but empty:      {len(empty_only)}  "
          f"(stale slug or genuinely no openings)")
    print(f"  No board found:          {len(missed)}  "
          f"({100*len(missed)/denom:.0f}% of reached)")
    if blocked:
        print(f"  NEVER REACHED:           {len(blocked)}  "
              f"(excluded from coverage -- not counted as misses)")
    print(f"  Informative probes:      {total_probes}")

    platform_hits = Counter(
        p.platform for p in report.probes if p.outcome == "resolved_with_jobs"
    )
    if platform_hits:
        print("\n  Resolved by platform:")
        for plat, cnt in platform_hits.most_common():
            print(f"    {plat:<12} {cnt}")

    postings = sum(p.job_count for p in report.probes
                   if p.outcome == "resolved_with_jobs")
    print(f"\n  Total live postings visible: {postings}")

    if resolved:
        print("\n  Sample resolved:")
        for name in resolved[:10]:
            hit = next(p for p in by_company[name]
                       if p.outcome == "resolved_with_jobs")
            print(f"    {name:<34} {hit.platform}/{hit.slug}  "
                  f"{hit.job_count} jobs")

    print(f"\n  Full report: {out_path}\n")
    return 0 if (resolved or not unreachable) else 1


async def main_async(args) -> int:
    if args.smoke:
        companies = [Company(name=n, domain=d) for n, d in SMOKE_SLUGS]
        print(f"Smoke mode: {len(companies)} known companies, no DB.")
    else:
        companies = load_warm_companies(args.limit)
        print(f"Loaded {len(companies)} warm companies from the DB.")

    platforms = args.platforms.split(",")
    for p in platforms:
        if p not in PLATFORMS:
            sys.exit(f"unknown platform {p!r}; choose from {list(PLATFORMS)}")

    sem = asyncio.Semaphore(MAX_CONCURRENT)
    report = Report()
    # A browser-ish UA: some ATS edges refuse obviously-scripted clients, and we
    # want to test the endpoint, not our User-Agent string.
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
        ),
        "Accept": "application/json",
    }
    async with httpx.AsyncClient(
        timeout=TIMEOUT_SECONDS, follow_redirects=True, headers=headers
    ) as client:
        await asyncio.gather(*[
            probe_company(client, sem, c, platforms, report) for c in companies
        ])

    out = Path(args.out)
    return summarize(report, companies, out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, help="probe only the top N companies")
    ap.add_argument("--smoke", action="store_true",
                    help="skip the DB; probe 6 known companies")
    ap.add_argument("--platforms", default="greenhouse,ashby,lever")
    ap.add_argument("--out", default="ats_spike_report.csv")
    return asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
