"""Copy LinkedIn headshots into GCS before their signed URLs expire.

WHY THIS EXISTS: LinkedIn's CDN hands back a SIGNED url — `?e=<unix>&v=beta&t=<sig>`
— which was 21 days from issue across the whole 2026-08-06 sample. Storing that
URL and calling it done is the exact mistake already sitting in
public.companies.logo_url, whose Clearbit pointers routes/account_enrichment.py
describes as "often-dead". A headshot is only ours once the bytes are.

Reads bedrock.contact_enrichment rows that have an avatar_url and no
avatar_gcs_uri, oldest expiry first, and writes avatar_gcs_uri back.

    python3 scripts/rehost_contact_avatars.py --dry-run
    python3 scripts/rehost_contact_avatars.py

PRIVACY: these are photographs of identifiable people, pulled from profiles that
did not opt into our CRM. Objects are written PRIVATE — no public-read ACL, no
signed URL minted here. The API serves them the same way it serves any other
protected asset. Do not "simplify" this by making the prefix public.

Idempotent, resumable, and free — no paid API is involved; the headshot arrived
with the $0.05 profile call that scripts/enrich_linkedin_profiles.py already made.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import asyncpg
import httpx
from dotenv import load_dotenv
from google.cloud import storage
from google.cloud.exceptions import GoogleCloudError

# Same bucket and namespacing convention as services/gcs_intake.py, which notes
# that Bedrock uploads live under their own prefix so the two products never
# collide on an object path.
DEFAULT_BUCKET = os.getenv("GCS_INTAKE_BUCKET", "builder-attendance-photos")
DEFAULT_PREFIX = os.getenv("GCS_AVATAR_PREFIX", "bedrock-contact-headshots")
DEFAULT_PROJECT = os.getenv("GCS_PROJECT", "pursuit-ops")

# LinkedIn's CDN serves JPEG. Anything else is a redirect to an error page or a
# placeholder, and is not worth storing under a name that claims to be a person.
ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}
# The extension is derived from what the CDN actually served, never assumed.
# LinkedIn serves mostly JPEG but not always — 2 of the first 21 came back PNG,
# and naming those .jpg leaves an object whose filename contradicts its bytes.
EXTENSIONS = {"image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp"}
MAX_BYTES = 8 * 1024 * 1024

SELECT_PENDING = """
    SELECT contact_id, linkedin_slug, avatar_url, avatar_expires_at
    FROM bedrock.contact_enrichment
    WHERE avatar_url IS NOT NULL AND avatar_gcs_uri IS NULL
    -- NULLS FIRST is deliberate: a row whose expiry could not be parsed is the
    -- one we know least about, so it goes to the front rather than the back.
    ORDER BY avatar_expires_at ASC NULLS FIRST
"""


def object_name(contact_id: int, slug: str, content_type: str) -> str:
    """Stable per contact, so a re-host overwrites rather than accumulating.

    Keyed on contact_id (not the slug alone) because slugs are rotated by their
    owners — see scripts/repair_rotated_linkedin_urls.py — and a rotated slug
    would otherwise orphan the old object and silently double storage.
    """
    safe = "".join(ch for ch in (slug or "") if ch.isalnum() or ch in "-_")[:80]
    ext = EXTENSIONS.get(content_type, "jpg")
    return f"{DEFAULT_PREFIX}/{contact_id}_{safe or 'profile'}.{ext}"


async def fetch_image(client: httpx.AsyncClient, url: str) -> tuple[bytes | None, str]:
    try:
        r = await client.get(url, timeout=30, follow_redirects=True)
    except httpx.HTTPError as exc:
        return None, f"fetch failed: {type(exc).__name__}"
    if r.status_code != 200:
        # 403 here almost always means the signature already expired.
        return None, f"HTTP {r.status_code}"
    ctype = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype not in ALLOWED_CONTENT_TYPES:
        return None, f"unexpected content-type {ctype!r}"
    if len(r.content) > MAX_BYTES:
        return None, f"too large ({len(r.content)} bytes)"
    if not r.content:
        return None, "empty body"
    return r.content, ctype


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL not set", file=sys.stderr)
        return 1

    conn = await asyncpg.connect(dsn)
    try:
        rows = await conn.fetch(SELECT_PENDING)
        if args.limit:
            rows = rows[: args.limit]

        now = datetime.now(timezone.utc)
        expired = [r for r in rows if r["avatar_expires_at"] and r["avatar_expires_at"] <= now]
        print(f"pending headshots: {len(rows)}")
        print(f"bucket: gs://{DEFAULT_BUCKET}/{DEFAULT_PREFIX}/")
        if expired:
            # Say it plainly rather than letting them show up as generic failures.
            print(f"WARNING: {len(expired)} already past their signed expiry — these will "
                  f"almost certainly 403. They need a re-scrape, not a re-host.")
        if rows:
            soonest = min((r["avatar_expires_at"] for r in rows if r["avatar_expires_at"]), default=None)
            if soonest:
                print(f"soonest expiry: {soonest:%Y-%m-%d} ({(soonest - now).days} days)")
        if args.dry_run:
            print("\n--dry-run: nothing fetched, nothing uploaded.")
            for r in rows[:10]:
                # Extension shown as .<ext> because it is only known once the CDN
                # responds — the dry run cannot promise jpg.
                print(f"  {r['contact_id']:>7}  "
                      f"{object_name(r['contact_id'], r['linkedin_slug'], '')[:-4]}.<ext>")
            return 0
        if not rows:
            return 0

        client_gcs = storage.Client(project=DEFAULT_PROJECT)
        bucket = client_gcs.bucket(DEFAULT_BUCKET)
        sem = asyncio.Semaphore(args.concurrency)
        # See enrich_linkedin_profiles.py: one asyncpg connection cannot take
        # concurrent statements. Downloads and uploads fan out; the write does not.
        write_lock = asyncio.Lock()
        ok = failed = 0

        async def one(http: httpx.AsyncClient, row) -> None:
            nonlocal ok, failed
            async with sem:
                data, detail = await fetch_image(http, row["avatar_url"])
            if data is None:
                failed += 1
                print(f"  skip {row['contact_id']}: {detail}")
                return
            # `detail` carries the served content-type on success.
            name = object_name(row["contact_id"], row["linkedin_slug"], detail)
            try:
                blob = bucket.blob(name)
                # Blocking client call, kept off the event loop.
                await asyncio.to_thread(blob.upload_from_string, data, content_type=detail)
            except GoogleCloudError as exc:
                failed += 1
                print(f"  skip {row['contact_id']}: upload failed {type(exc).__name__}")
                return
            async with write_lock:
                await conn.execute(
                    "UPDATE bedrock.contact_enrichment "
                    "SET avatar_gcs_uri = $2, avatar_rehosted_at = now() WHERE contact_id = $1",
                    row["contact_id"], f"gs://{DEFAULT_BUCKET}/{name}",
                )
            ok += 1

        async with httpx.AsyncClient() as http:
            batch: list = []
            for row in rows:
                batch.append(asyncio.create_task(one(http, row)))
                if len(batch) >= args.concurrency * 4:
                    await asyncio.gather(*batch)
                    batch = []
                    print(f"  {ok + failed}/{len(rows)}  stored {ok}  failed {failed}", flush=True)
            if batch:
                await asyncio.gather(*batch)

        print(f"\nstored {ok} headshots, {failed} failed")
        print("Objects are PRIVATE. Serve them through the API, not by making the prefix public.")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
