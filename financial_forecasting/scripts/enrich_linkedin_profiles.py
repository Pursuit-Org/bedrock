"""Re-enrich My Network contacts' job title and employer from live LinkedIn.

WHY: the network's current_title / current_company come from a LinkedIn CSV
import that is never refreshed. Measured 2026-08-06 against live profiles on a
random 30-contact sample (28 resolved): 61% of titles and 50% of employers had
changed — 64% wrong in at least one field.

WHAT IT WRITES: bedrock.contact_enrichment only. public.contacts is NEVER
touched by this script. Promotion into contacts is a separate reviewed step —
see the migration header for why (company_id would otherwise point at the
previous employer's firmographics).

PROVIDER — why LinkedPanda at $0.05 and not the $0.003 endpoint:
The cheap "LinkedIn Search & Extract" capability (cap_vEqZu1pjZuOuFTUUccO4O)
was measured on 17 profiles first. It returns `position: null` and
`experience: null` on every one — it can give you the EMPLOYER but never the
TITLE, which is half of what this job exists to fix. It also resolved only 9 of
17 calls (6 fell into a BrightData async snapshot with no exposed poll endpoint,
1 private profile) and bills for the misses, so its effective cost per usable
employer-only record is ~$0.006. LinkedPanda resolved 28 of 30 in ~2s each and
returns title, company, company DOMAIN, location and full job history.

TARGET SET: the P1/P2 priority bands, plus jobs-tagged contacts, in that order.
The band expression is IMPORTED from routes.jobs rather than restated here —
a re-derived copy of that CASE is exactly the drift that produced two silent
banding bugs on 2026-08-05.

    python3 scripts/enrich_linkedin_profiles.py --dry-run
    python3 scripts/enrich_linkedin_profiles.py --max-spend 100

KNOWN LIMIT, worth stating plainly: the target set is chosen using the STALE
title, because current_title is what _seniority_case reads. A contact whose
stored title is "Account Manager" but who is now a VP will not be in P1/P2
today, so this run cannot reach them. Widening the scope is the only fix; the
band-first run is a proof of the pipeline, not full coverage.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from decimal import Decimal
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routes.jobs import _net_priority_case, _PORTCO_EXISTS  # noqa: E402

CAPABILITY_ID = "cap_4gc9BpJ2zU9coibgGBu4h"
PROFILE_URL = "https://api.linkedpanda.com/agent/v1/profiles/{slug}"
SOURCE = "linkedpanda"
# Observed price. --max-pay is set from this so a silent price rise aborts the
# call rather than quietly draining the wallet at the new rate.
UNIT_COST = Decimal("0.05")

# Nested blocks worth keeping out of the raw blob's 50-350KB. Job history is the
# point of keeping raw at all (it answers "where were they when we last spoke");
# skills, recommendations and picture sets are not.
RAW_KEEP_NESTED = ("experience", "education", "currentPositions")
RAW_SKIP_PREFIX = ("profilePictures", "coverPictures", "profileActions", "profileLocales")


def build_target_sql(portco: bool, stale_days: int) -> str:
    """Contacts to enrich, most valuable first.

    Order is P1, then jobs-tagged, then P2 — so a run that exhausts its budget
    stops having spent it on the rows staff actually work, not on whatever the
    contact_id sequence happened to surface first.
    """
    priority = _net_priority_case(_PORTCO_EXISTS if portco else None)
    return f"""
        WITH net AS (
            SELECT DISTINCT ON (c.contact_id)
                   c.contact_id, c.current_title, c.current_company, c.is_jobs_contact,
                   regexp_replace(c.linkedin_url,
                       '^https?://(www\\.)?linkedin\\.com/in/([^/?#]+).*$', '\\2') AS slug,
                   ({priority}) AS priority
            FROM public.staff_contact_relationships r
            JOIN public.contacts c ON c.contact_id = r.contact_id
            LEFT JOIN public.companies co ON co.company_id = c.company_id
            WHERE coalesce(c.contact_stage, '') <> 'merged'
              AND c.linkedin_url ~ '^https?://(www\\.)?linkedin\\.com/in/'
        )
        SELECT n.contact_id, n.slug, n.current_title, n.current_company, n.priority
        FROM net n
        LEFT JOIN bedrock.contact_enrichment e ON e.contact_id = n.contact_id
        WHERE (n.priority IS NOT NULL OR n.is_jobs_contact = true)
          -- Don't re-pay for a profile scraped recently, and don't re-pay for one
          -- that came back 404 — a dead slug stays dead until the URL is repaired.
          AND (e.contact_id IS NULL
               OR (e.status = 'ok' AND e.enriched_at < now() - make_interval(days => {stale_days})))
        ORDER BY CASE WHEN n.priority = 'P1' THEN 0
                      WHEN n.is_jobs_contact THEN 1
                      WHEN n.priority = 'P2' THEN 2
                      ELSE 3 END,
                 n.contact_id
    """


def prune_raw(body: dict) -> dict:
    """Keep the scalars and the job history; drop the picture sets and skill lists."""
    out = {}
    for k, v in body.items():
        if k.startswith(RAW_SKIP_PREFIX):
            continue
        if isinstance(v, (list, dict)):
            if k in RAW_KEEP_NESTED:
                out[k] = v
            continue
        out[k] = v
    return out


async def fetch_profile(slug: str, sem: asyncio.Semaphore) -> dict:
    """One paid call. Returns {status, cost, body|error}.

    Never raises: a failed profile must not abort a 2,000-row run, and it still
    has to be recorded because it was still billed.
    """
    async with sem:
        proc = await asyncio.create_subprocess_exec(
            "zero", "fetch", PROFILE_URL.format(slug=slug),
            "--capability", CAPABILITY_ID,
            "--max-pay", str(UNIT_COST),
            "--json",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=120)
        except asyncio.TimeoutError:
            proc.kill()
            return {"status": "error", "cost": Decimal(0), "error": "timeout after 120s"}

    line = next((ln for ln in out.decode().splitlines() if ln.lstrip().startswith("{")), None)
    if not line:
        return {"status": "error", "cost": Decimal(0),
                "error": (err.decode() or "no JSON on stdout")[:400]}
    try:
        env = json.loads(line)
    except json.JSONDecodeError as exc:
        return {"status": "error", "cost": Decimal(0), "error": f"unparseable: {exc}"}

    # Charged even on a 404, so the cost is read from the envelope, never assumed.
    cost = Decimal(str((env.get("payment") or {}).get("amount") or 0))
    body = env.get("body")
    if env.get("status") == 404:
        return {"status": "not_found", "cost": cost, "error": "LinkedIn profile not found"}
    if not env.get("ok") or not isinstance(body, dict) or not body.get("linkedinId"):
        detail = json.dumps(body)[:400] if body else f"HTTP {env.get('status')}"
        return {"status": "error", "cost": cost, "error": detail}
    return {"status": "ok", "cost": cost, "body": body}


UPSERT = """
INSERT INTO bedrock.contact_enrichment (
    contact_id, linkedin_slug, live_title, live_company, live_company_domain,
    live_company_linkedin_url, headline, live_location, connections_count,
    followers_count, open_to_work, prior_title, prior_company,
    source, status, error_detail, cost_usd, raw, enriched_at, review_state
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now(),'pending')
ON CONFLICT (contact_id) DO UPDATE SET
    linkedin_slug = EXCLUDED.linkedin_slug,
    live_title = EXCLUDED.live_title,
    live_company = EXCLUDED.live_company,
    live_company_domain = EXCLUDED.live_company_domain,
    live_company_linkedin_url = EXCLUDED.live_company_linkedin_url,
    headline = EXCLUDED.headline,
    live_location = EXCLUDED.live_location,
    connections_count = EXCLUDED.connections_count,
    followers_count = EXCLUDED.followers_count,
    open_to_work = EXCLUDED.open_to_work,
    prior_title = EXCLUDED.prior_title,
    prior_company = EXCLUDED.prior_company,
    source = EXCLUDED.source,
    status = EXCLUDED.status,
    error_detail = EXCLUDED.error_detail,
    cost_usd = EXCLUDED.cost_usd,
    raw = EXCLUDED.raw,
    enriched_at = now(),
    -- A re-scrape is new evidence, so it re-enters the queue. Rows already
    -- promoted into contacts stay promoted; re-queuing them would ask a
    -- reviewer to re-approve a decision they already made.
    review_state = CASE WHEN bedrock.contact_enrichment.review_state = 'promoted'
                        THEN 'promoted' ELSE 'pending' END
"""


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-spend", type=Decimal, default=Decimal("100"),
                    help="hard USDC ceiling; the run stops BEFORE a call that would breach it")
    ap.add_argument("--limit", type=int, default=None, help="cap the number of contacts")
    ap.add_argument("--stale-days", type=int, default=90,
                    help="skip contacts enriched successfully within this many days")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true",
                    help="show the target set and projected cost; make no paid calls")
    args = ap.parse_args()

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL not set", file=sys.stderr)
        return 1

    conn = await asyncpg.connect(dsn)
    try:
        if not await conn.fetchval("SELECT to_regclass('bedrock.contact_enrichment') IS NOT NULL"):
            print("bedrock.contact_enrichment does not exist — apply "
                  "db/migrations/2026-08-06-contact-enrichment.sql first", file=sys.stderr)
            return 1
        portco = await conn.fetchval("SELECT to_regclass('bedrock.company_investor') IS NOT NULL")
        targets = await conn.fetch(build_target_sql(portco, args.stale_days))
        if args.limit:
            targets = targets[: args.limit]

        affordable = min(len(targets), int(args.max_spend / UNIT_COST))
        bands: dict[str, int] = {}
        for t in targets[:affordable]:
            bands[t["priority"] or "jobs-tagged"] = bands.get(t["priority"] or "jobs-tagged", 0) + 1

        print(f"portfolio table present: {portco}")
        print(f"eligible contacts:       {len(targets)}")
        print(f"within --max-spend {args.max_spend}: {affordable}"
              f"  (~${affordable * UNIT_COST:.2f} at ${UNIT_COST}/profile)")
        print(f"by band: {bands}")
        if affordable < len(targets):
            # Never let a budget stop read as full coverage.
            print(f"NOTE: {len(targets) - affordable} eligible contacts will NOT be enriched "
                  f"— the spend cap stops the run first.")
        if args.dry_run:
            print("\n--dry-run: no calls made, nothing written.")
            for t in targets[: min(10, affordable)]:
                print(f"  [{t['priority'] or 'jobs'}] {t['contact_id']:>6} {t['slug'][:40]:<42}"
                      f" {(t['current_title'] or '')[:34]:<36} @ {(t['current_company'] or '')[:28]}")
            return 0

        spent = Decimal(0)
        counts = {"ok": 0, "not_found": 0, "error": 0}
        changed = 0
        sem = asyncio.Semaphore(args.concurrency)

        async def one(row) -> None:
            nonlocal spent, changed
            res = await fetch_profile(row["slug"], sem)
            spent += res["cost"]
            counts[res["status"]] += 1
            b = res.get("body") or {}
            await conn.execute(
                UPSERT, row["contact_id"], row["slug"],
                b.get("title"), b.get("companyName"), b.get("companyDomain"),
                b.get("companyLinkedinUrl"), b.get("headline"), b.get("location"),
                b.get("connectionsCount"), b.get("followerCount"), b.get("openToWork"),
                row["current_title"], row["current_company"],
                SOURCE, res["status"], res.get("error"), res["cost"],
                json.dumps(prune_raw(b)) if b else None,
            )
            if res["status"] == "ok":
                t_chg = (b.get("title") or "").strip().lower() != (row["current_title"] or "").strip().lower()
                c_chg = (b.get("companyName") or "").strip().lower() != (row["current_company"] or "").strip().lower()
                if t_chg or c_chg:
                    changed += 1

        batch: list = []
        for row in targets[:affordable]:
            # Re-checked per row, not just up front: the provider is billed per
            # call and a price change mid-run must stop the run, not overshoot.
            if spent + UNIT_COST > args.max_spend:
                print(f"\nspend cap reached at ${spent} — stopping.")
                break
            batch.append(asyncio.create_task(one(row)))
            if len(batch) >= args.concurrency * 4:
                await asyncio.gather(*batch)
                batch = []
                done = sum(counts.values())
                print(f"  {done}/{affordable}  spent ${spent}  changed {changed}", flush=True)
        if batch:
            await asyncio.gather(*batch)

        total = sum(counts.values())
        print(f"\nenriched {total} contacts — ok {counts['ok']}, "
              f"not_found {counts['not_found']}, error {counts['error']}")
        print(f"spent ${spent}")
        if counts["ok"]:
            print(f"{changed} of {counts['ok']} resolved profiles differ from what we hold "
                  f"({100 * changed / counts['ok']:.0f}%) — all queued as review_state='pending'.")
        print("\npublic.contacts was NOT modified. Review the queue with:")
        print("  SELECT contact_id, prior_title, live_title, prior_company, live_company")
        print("  FROM bedrock.contact_enrichment")
        print("  WHERE review_state='pending' AND (title_changed OR company_changed);")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
