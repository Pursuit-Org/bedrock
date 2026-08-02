"""Local visual preview of the Jobs > Intro requests zone. No database needed.

Mounts the REAL routes/jobs_intro.py router and serves it sample rows, so what
the browser renders comes from the actual code path rather than fixture JSON.

    MODE=after   (default) builder lookup succeeds — bedrock.builder_by_id
    MODE=before  builder lookup returns nothing, which is exactly what
                 public.users does for bedrock_user under RLS: no row, so
                 trim(coalesce(NULL,'') || ' ' || coalesce(NULL,'')) => ''

MODE=before is the interesting one. On `main` that empty string renders as a
bare "from — (builder)" — the reported bug. On this branch the same empty
lookup renders "from Builder #428", because the fallback chain
(name → email → id) makes a blank label unreachable. To see the actual "—",
check out main first:

    git stash && git checkout main

Usage (two terminals, from the repo root):

    cd financial_forecasting
    python3 scripts/preview_intro_requests.py          # backend on :8000

    cd financial_forecasting/frontend-v2
    npm install && npm run dev                         # frontend on :4200

Then open http://localhost:4200/jobs and scroll to "Intro requests".

The rows below are made up — they mirror the shape of real Sputnik asks
without putting learner data in the repo.
"""
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Run from anywhere: put financial_forecasting/ on the path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

MODE = os.environ.get("MODE", "after")
NOW = datetime.now(timezone.utc)

STAFF_ROW = {
    "id": "239f08c7-4e45-4539-8c41-2302bb35de67",
    "contact_id": 1001, "connector_staff_id": 4,
    "requested_by_email": "jordan.reyes@example.org",
    "specific_ask": "industry_advice",
    "context": "Sample staff→staff ask. Would you be open to introducing one of "
               "our builders for a 20-minute coffee chat?",
    "status": "pending", "response_note": None, "responded_at": None,
    "created_at": NOW - timedelta(days=4),
    "contact_name": "Dana Whitfield", "contact_company": "Northwind",
    "contact_title": "Engineering Manager",
    "connector_name": "Sam Okafor", "connector_email": "sam.okafor@example.org",
    "requested_by_name": "Jordan Reyes",
}

BUILDER_ROW = {
    "intro_request_id": 15, "contact_id": 1002,
    "contact_name": "Priya Raman", "contact_company": "Lumen Labs",
    "contact_title": "Director of Product Engineering",
    "specific_ask": "industry_advice",
    "request_context": "Sample builder ask. Their background bridging product "
                       "strategy and technical architecture is exactly the path "
                       "I am trying to grow into.",
    "status": "pending", "staff_response_notes": None, "responded_at": None,
    "created_at": NOW - timedelta(days=38),
    "builder_id": 428,
    # The whole bug in two fields. Under RLS the join matches nothing, and
    # trim() over coalesce'd NULLs yields '' rather than NULL.
    "builder_name": "Alex Mensah" if MODE == "after" else "",
    "builder_email": "alex.mensah@example.org" if MODE == "after" else None,
    "builder_cohort": "March 2026 L1+" if MODE == "after" else None,
}


class StubConn:
    """Substring-dispatch stand-in for an asyncpg connection."""

    async def fetchval(self, q, *a):
        if "SELECT staff_user_id FROM bedrock.staff_user_id_map" in q:
            return 4
        return None

    async def fetch(self, q, *a):
        if "FROM public.intro_requests ir" in q:
            return [BUILDER_ROW]
        if "FROM bedrock.intro_request ir" in q:
            return [STAFF_ROW]
        return []

    async def fetchrow(self, q, *a):
        return None

    async def execute(self, q, *a):
        return "OK"


app = FastAPI(title="intro-requests preview")

from auth import require_auth  # noqa: E402
from db import get_db  # noqa: E402
from routes.jobs_intro import router as intro_router  # noqa: E402

app.include_router(intro_router)
app.dependency_overrides[require_auth] = lambda: {"email": "sam.okafor@example.org"}
app.dependency_overrides[get_db] = lambda: StubConn()


@app.get("/auth/me")
async def me():
    return {"email": "sam.okafor@example.org", "name": "Sam Okafor", "sub": "sam",
            "salesforce_connected": False, "google_connected": True,
            "slack_configured": True}


@app.api_route("/{path:path}",
               methods=["GET", "POST", "PATCH", "PUT", "DELETE"])
async def catch_all(path: str):
    """Every other zone on the Jobs page renders from an empty result."""
    return JSONResponse({"success": True, "data": []})


if __name__ == "__main__":
    print(f"\n  intro-requests preview — MODE={MODE}")
    print("  backend  http://127.0.0.1:8000")
    print("  now run: cd frontend-v2 && npm run dev  →  http://localhost:4200/jobs\n")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")
