# Financial Forecasting — Developer Setup Guide

## Overview

This app bridges Salesforce (grant pipeline) and Sage Intacct (accounting) to provide forecasting, cash flow projections, and data sync. The backend is FastAPI (Python), the frontend is React + TypeScript + Material-UI.

> **Fiscal Year Convention:** Pursuit's fiscal year follows the calendar year (January 1 – December 31). This is reflected in `GoalTracker.tsx`'s `getFYBounds()` and the `DateRangeSelector`'s "Current FY" preset.

> **⚠️ `DATABASE_URL` is required in every environment, including local dev.**
> Bedrock does NOT fall back to a local Postgres default. If `DATABASE_URL` is unset or empty at startup, `init_db()` logs a clear error, sets db status to `disconnected`, and leaves the pool `None` — every DB-backed route then returns `503`. This is intentional: running against a wrong-DB target produced an incident on 2026-04-17 where a dev session silently wrote goals to local Postgres while teammates read from the shared DB. Set `DATABASE_URL` explicitly in your `.env` (to the shared staging DB for local dev, or to the production DB for deploys). See `tasks/notes-2026-04-17-jac-review.md` for the precedent and `tasks/mvp-launch-sprint.md` item B1 for the full root-cause analysis.

## Architecture: How Auth Works

There are **two auth layers** — this is important to understand before you start:

| Layer | Purpose | How it works |
|-------|---------|--------------|
| **Google OAuth (frontend)** | User login to the dashboard | Users sign in with Google, get a JWT session token |
| **Salesforce OAuth (per-user)** | Connect a user's SF account | User clicks "Connect Salesforce" in Settings, does OAuth flow |
| **Salesforce service account (backend)** | Backend API calls (SOQL queries, sync, forecasting) | Uses username + password + security token via `simple-salesforce` |

The backend service account is the problem — it's tied to a personal account and requires a security token that resets frequently. **We recommend migrating this to JWT Bearer flow** (see "Recommended: JWT Bearer Migration" below).

---

## Quick Start (Current Setup)

### 1. Clone and install

Use Python 3.11 or newer for this backend and Pebble. The standalone root MCP
client supports Python 3.10+. Bootstrap pip's patched certificate store in each
new or existing environment before installing application dependencies; updating
application `certifi` alone does not update pip's vendored copy.

```bash
# Backend
cd financial_forecasting &&
(test -d .venv || python3.11 -m venv .venv) &&
source .venv/bin/activate &&
python -c 'import sys; sys.exit("Python 3.11+ required; recreate .venv" if sys.version_info < (3, 11) else 0)' &&
bash ../scripts/bootstrap-pip.sh python &&
python -m pip install -r requirements.txt
```

After the backend installation succeeds, install the frontend from the same directory:

```bash
# Frontend
cd frontend && npm install
```

The bootstrap URL and hash come from the [Python security team's emSign incident guidance](https://discuss.python.org/t/information-for-python-users-regarding-emudhra-emsign-ca-certificate-security-incident/109576).
The shared helper preserves pip 26.2.2 or newer; older versions receive the hash-pinned wheel.
Use your installed Python 3.11+ executable in place of `python3.11` if needed.
The `.venv` path matches `dev.sh`; if it already exists, activate it and check its
Python version before the bootstrap. Recreate unsupported environments separately.

### 2. Create your `.env` file

Copy `env.production.template` to `financial_forecasting/.env` and fill in values. Use these env var names (they match `config.py`):

```env
# --- Google OAuth (dashboard login) ---
GOOGLE_CLIENT_ID=<ask team>
GOOGLE_CLIENT_SECRET=<ask team>
GOOGLE_REDIRECT_URI=http://localhost:8000/auth/google/callback

# --- JWT Session (required) ---
# Generate with: openssl rand -hex 32
JWT_SECRET_KEY=<paste output of openssl rand -hex 32>

# --- Salesforce (backend service account) ---
SALESFORCE_USERNAME=<salesforce username>
SALESFORCE_PASSWORD=<salesforce password>
SALESFORCE_SECURITY_TOKEN=<salesforce security token>
SALESFORCE_CLIENT_ID=<connected app consumer key>
SALESFORCE_CLIENT_SECRET=<connected app consumer secret>
SALESFORCE_DOMAIN=login

# --- Sage Intacct ---
SAGE_COMPANY_ID=pursuit
SAGE_USER_ID=pursuit-dev
SAGE_USER_PASSWORD=<ask team>
SAGE_SENDER_ID=pursuit
SAGE_SENDER_PASSWORD=<ask team>

# --- Optional integrations ---
ANTHROPIC_API_KEY=<ask team>
FIREFLIES_API_KEY=<ask team>
SLACK_BOT_TOKEN=<ask team>

# --- Optional for local dev (only set if frontend isn't on port 3000) ---
# FRONTEND_URL defaults to http://localhost:3000 (matches `npm start`).
# Override here if you run the frontend on a non-default port, otherwise
# Google-OAuth login redirects land on the wrong URL.
# FRONTEND_URL=http://localhost:4000
```

### 3. Run

```bash
# Terminal 1 - Backend
cd financial_forecasting
python main.py
# Or: ./start_server.sh
# Runs on http://localhost:8000

# Terminal 2 - Frontend
cd financial_forecasting/frontend && npm start
# Runs on http://localhost:3000
```

### 4. Get a Salesforce Security Token (if using current auth)

1. Log into Salesforce
2. Click your avatar > **Settings**
3. Search "Reset My Security Token" in the sidebar
4. Click **Reset Security Token** — it gets emailed to you
5. Add it to your `.env` as `SALESFORCE_SECURITY_TOKEN`

Note: This token resets every time your password changes or you log in from a new IP.

---

## Production Checklist

Before deploying to production:

- [ ] **JWT_SECRET_KEY**: Set and at least 32 chars. Generate with `openssl rand -hex 32`. The app fails to start if missing in production.
- [ ] **ENVIRONMENT=production**: Required to enable strict env-var validation (see "Environment Modes" below).
- [ ] **ALLOWED_EMAILS**: Recommended. Comma-separated list of allowed login emails.
- [ ] **FRONTEND_URL**: Must start with `https` for production. Used for OAuth redirect.
- [ ] **GOOGLE_REDIRECT_URI**: Must match your production backend URL + `/auth/google/callback`. See [OAUTH_SETUP.md](OAUTH_SETUP.md) for Cloud Console steps.

---

## Security Notes

- **No dev bypass**: The frontend `REACT_APP_DEV_BYPASS` branch was removed. All environments — including local dev — require real Google OAuth login. If you can't log in locally, check your Google OAuth credentials in `.env`.
- **Debug endpoint**: `/debug/config` requires authentication in production.
- **Calendar**: Only the PBD shared calendar is accessible. Personal calendars are blocked.

### Environment Modes

The backend uses an explicit `ENVIRONMENT` variable to decide how strict to be about missing credentials:

| `ENVIRONMENT=` | Behavior on missing required env var |
|----------------|--------------------------------------|
| `development` (default) | Logs a warning, app continues |
| `staging` | Logs a warning, app continues |
| `production` | **Refuses to start.** Lists every missing/weak var in the error. |

If `ENVIRONMENT` is unset, the app falls back to a heuristic: if `FRONTEND_URL` starts with `https`, treat as production; otherwise development. The explicit var always wins.

**Required vars in production:** `JWT_SECRET_KEY` (≥32 chars, not a template placeholder), `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FRONTEND_URL`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`. If `SAGE_ENABLED=true`, then `SAGE_COMPANY_ID`, `SAGE_USER_ID`, `SAGE_USER_PASSWORD`, `SAGE_SENDER_ID`, `SAGE_SENDER_PASSWORD` are also required. The canonical list lives in `env_validator.py`.

**Local dev tip:** leave `ENVIRONMENT` unset (or set `ENVIRONMENT=development`) so missing vars only warn. You don't need every credential to run the app locally.

### Pre-commit hook against committing `.env` files

Run once after cloning to install a guard that blocks any commit containing a `.env` file:

```bash
bash scripts/install-git-hooks.sh
```

The hook is content-blind and pattern-based — it just refuses to commit files matching `.env` or `.env.<anything>` (with `.env.example` and `.env.template` allowed). If you ever absolutely need to bypass it, `git commit --no-verify` will work, but think twice first.

---

## Recommended: Migrate to JWT Bearer Flow

The current backend auth uses a personal username + password + security token. This is fragile. JWT Bearer flow eliminates passwords entirely — the backend authenticates with a certificate.

See the full migration steps in the original DEV_SETUP_GUIDE (JWT Bearer section). Summary: generate a certificate, configure Salesforce Connected App for "Use digital signatures", pre-authorize the integration user, update `.env` to use `SF_PRIVATE_KEY_PATH` instead of password/token.

---

## PBD Calendar

**PBD_CALENDAR_ID** must be set in `.env` for the Priorities page calendar to show events. If unset, the backend uses a hardcoded default. The frontend fallback in `Priorities.tsx` must match the backend default. Override only when using a different shared calendar.

---

## Common Issues

| Issue | Fix |
|-------|-----|
| `SalesforceAuthenticationFailed` | Security token is wrong or expired. Reset it in Salesforce Settings. |
| `INVALID_SESSION_ID` | Token expired mid-session. Restart the backend. |
| Frontend can't reach backend | Check `REACT_APP_API_URL` is set to `http://localhost:8000` |
| Google OAuth redirect fails | Ensure `GOOGLE_REDIRECT_URI` matches Google Cloud Console |
| Calendar empty / "needs re-auth" | Log out and sign in again to refresh Google tokens |
| Sage Intacct connection fails | Verify `SAGE_SENDER_PASSWORD` is correct |

---

## Project Structure (Key Files)

```
financial_forecasting/
├── main.py                   # FastAPI backend (port 8000) - entry point + route registration
├── config.py                 # Credential configuration (reads SALESFORCE_*, SAGE_*)
├── .env                      # Environment variables (DO NOT COMMIT)
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── contexts/AuthContext.tsx
│   │   ├── services/api.ts
│   │   └── pages/             # Priorities, Dashboard, Pipeline, Settings, etc.
│   └── package.json
├── start_server.sh           # Start backend with Slack check
└── Dockerfile                # Container build (uses main:app)
```
