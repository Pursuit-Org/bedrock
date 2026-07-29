"""Pre-flight check: DWD access + volume for every enabled sync_staff mailbox.

For each mailbox, impersonate via DWD and call Gmail getProfile (1 quota
unit) — reports OK + total message count, or the failure. Run before a big
historical backfill so inaccessible (deleted/suspended) accounts surface
now, not hours into the sweep.

Run from financial_forecasting/:
    python -m scripts.check_mailbox_access
"""
import asyncio
import os
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

from googleapiclient.discovery import build

from services.google_dwd import get_dwd_credentials, GMAIL_SCOPES


def _check(email: str) -> tuple[str, str]:
    try:
        creds = get_dwd_credentials(email, GMAIL_SCOPES)
        svc = build("gmail", "v1", credentials=creds, cache_discovery=False)
        prof = svc.users().getProfile(userId="me").execute()
        return "OK", f"{prof.get('messagesTotal', '?')} messages"
    except Exception as e:
        return "FAIL", repr(e)[:140]


async def main() -> None:
    import asyncpg
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        rows = await conn.fetch(
            "SELECT email FROM bedrock.sync_staff WHERE enabled = true ORDER BY email")
    finally:
        await conn.close()
    emails = [r["email"] for r in rows]

    results = await asyncio.gather(
        *(asyncio.to_thread(_check, e) for e in emails))
    fails = 0
    for email, (status, detail) in zip(emails, results):
        print(f"{status:4}  {email:35} {detail}")
        if status == "FAIL":
            fails += 1
    print(f"\n{len(emails) - fails}/{len(emails)} mailboxes accessible")


if __name__ == "__main__":
    asyncio.run(main())
