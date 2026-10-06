"""Backfill the per-message email index after it stalled (PRO-98).

The index stopped growing on 2026-09-24: the nightly run's query outlived the
web pool's 30-second limit. The nightly now catches up on its own once the
fixed code is deployed, but this does it in one go, and says how far behind
it was. Read and insert only: nothing existing changes (ON CONFLICT DO NOTHING).

Run after Jac deploys the PRO-98 code, with the app role:

    python -m scripts.backfill_email_message_index            # everything missing
    python -m scripts.backfill_email_message_index --days 30  # threads synced in 30 days
"""
import argparse
import asyncio
import os

from dotenv import load_dotenv


async def main(days) -> None:
    import asyncpg
    from services.email_message_index import index_health, refresh_email_message_index

    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        print("before:", await index_health(conn))
        print("refresh:", await refresh_email_message_index(conn, days_back=days, timeout=1800))
        print("after: ", await index_health(conn))
    finally:
        await conn.close()


if __name__ == "__main__":
    load_dotenv()
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--days", type=int, default=None,
                    help="only threads synced in the last N days (default: all)")
    asyncio.run(main(ap.parse_args().days))
