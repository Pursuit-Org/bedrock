"""Smoke test: DWD impersonation + Gmail thread listing for one mailbox/year.

Run from financial_forecasting/:
    python -m scripts.smoke_test_dwd --staff jukay@pursuit.org --year 2016
"""
import argparse
import os
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

from googleapiclient.discovery import build

from services.google_dwd import is_dwd_configured, get_dwd_credentials, GMAIL_SCOPES


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--staff", default="jukay@pursuit.org")
    ap.add_argument("--year", type=int, default=2016)
    args = ap.parse_args()

    print("dwd configured:", is_dwd_configured())
    creds = get_dwd_credentials(args.staff, GMAIL_SCOPES)
    svc = build("gmail", "v1", credentials=creds, cache_discovery=False)
    q = f"after:{args.year}/01/01 before:{args.year + 1}/01/01 (in:inbox OR in:sent)"
    res = svc.users().threads().list(userId="me", q=q, maxResults=5).execute()
    print(f"{args.staff} {args.year}: sample threads={len(res.get('threads', []))} "
          f"estimate={res.get('resultSizeEstimate')}")


if __name__ == "__main__":
    main()
