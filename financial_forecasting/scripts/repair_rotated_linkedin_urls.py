#!/usr/bin/env python3
"""Repair rotated linkedin_urls from the 2026-02-25 linkedin_import batch.

That batch attached each row's linkedin_url to a different contact (off-by-one
style rotation), so the LinkedIn icon opens the wrong profile. For every
contact whose URL slug clearly does NOT contain their own name:

  - the URL is reassigned to the contact whose name it DOES match
    (strict: both first+last tokens in the slug, unique match, and that
    contact doesn't already hold a URL matching their own name), and
  - the wrong holder gets the URL whose slug matches THEM, if one exists
    in the orphaned pool; otherwise their linkedin_url is cleared (a wrong
    profile link is worse than none).

Unfixable/ambiguous rows are written to ~/Desktop/linkedin_url_repair_log.csv.
Idempotent — a repaired row no longer mismatches.
"""
import csv, os, re, asyncio, asyncpg
from dotenv import load_dotenv

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(HERE, ".env"))
load_dotenv("/Users/jacquelinereverand/dev/build/platform/server/.env", override=False)


def _su_url():
    return f"postgresql://{os.environ['PG_USER']}:{os.environ['PG_PASSWORD']}@{os.environ['PG_HOST']}:{os.environ['PG_PORT']}/{os.environ['PG_DATABASE']}"


def slug_of(url):
    m = re.search(r"linkedin\.com/in/([^/?#]+)", url or "", re.I)
    return (m.group(1).lower() if m else "")


def clean(s):
    return re.sub(r"[^a-z]", "", (s or "").lower())


def tokens(name):
    return [t for t in re.findall(r"[a-z]{2,}", (name or "").lower())]


def slug_matches(s_clean, name):
    toks = tokens(name)
    if len(toks) < 2:
        return False
    return toks[0] in s_clean and toks[-1] in s_clean


def loose_match(s_clean, name):
    return any(t in s_clean for t in tokens(name) if len(t) >= 3)


async def main():
    conn = await asyncpg.connect(_su_url(), statement_cache_size=0)
    all_rows = await conn.fetch("""SELECT contact_id, full_name, linkedin_url FROM contacts
        WHERE coalesce(contact_stage,'') <> 'merged'""")
    with_url = [r for r in all_rows if r["linkedin_url"]]
    # mismatched holders = the rotated set
    mism = [r for r in with_url if slug_of(r["linkedin_url"]) and r["full_name"]
            and not loose_match(clean(slug_of(r["linkedin_url"])), r["full_name"])]
    pool = {r["contact_id"]: r["linkedin_url"] for r in mism}
    print(f"{len(mism)} mismatched URL holders (orphaned URL pool)")

    # index all contacts by whether a slug matches them
    log, reassigned, cleared, kept = [], 0, 0, 0
    # candidate owners for each pooled URL
    for holder in mism:
        url = holder["linkedin_url"]
        s = clean(slug_of(url))
        owners = [c for c in all_rows if c["full_name"] and slug_matches(s, c["full_name"])]
        # prefer owners without a correct URL of their own
        owners = [o for o in owners
                  if not (o["linkedin_url"] and loose_match(clean(slug_of(o["linkedin_url"])), o["full_name"]))]
        if len(owners) == 1:
            owner = owners[0]
            await conn.execute("UPDATE contacts SET linkedin_url=NULL, updated_at=now() WHERE contact_id=$1 AND linkedin_url=$2",
                               holder["contact_id"], url)
            await conn.execute("UPDATE contacts SET linkedin_url=$2, updated_at=now() WHERE contact_id=$1",
                               owner["contact_id"], url)
            reassigned += 1
            log.append([holder["contact_id"], holder["full_name"], url, "reassigned_to", owner["contact_id"], owner["full_name"]])
        else:
            # can't place this URL — clear it from the wrong holder
            await conn.execute("UPDATE contacts SET linkedin_url=NULL, updated_at=now() WHERE contact_id=$1 AND linkedin_url=$2",
                               holder["contact_id"], url)
            cleared += 1
            log.append([holder["contact_id"], holder["full_name"], url,
                        "cleared_ambiguous" if owners else "cleared_no_owner", "", ""])

    # second pass: holders whose rightful URL exists in the pool get it via the
    # reassignment above automatically (they're an owner of some pooled URL).
    out = os.path.expanduser("~/Desktop/linkedin_url_repair_log.csv")
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["holder_id", "holder_name", "url", "action", "new_owner_id", "new_owner_name"])
        w.writerows(log)
    print(f"reassigned {reassigned}, cleared {cleared}; log → {out}")
    await conn.close()

asyncio.run(main())
