# Pebble — Prospect Research Pipeline

Pebble powers prospect research for Bedrock. Integration #9.

## Quick Start

Use Python 3.11 or newer for the patched FastAPI/Starlette stack.
Bootstrap pip's patched certificate store before installing dependencies.

```bash
# From repo root
(test -d pebble/.venv || python3.11 -m venv pebble/.venv) &&
source pebble/.venv/bin/activate &&
python -c 'import sys; sys.exit("Python 3.11+ required; recreate pebble/.venv" if sys.version_info < (3, 11) else 0)' &&
bash scripts/bootstrap-pip.sh python &&
python -m pip install -r pebble/requirements.txt
```

After installation succeeds, configure and start Pebble:

```bash
cp pebble/.env.example pebble/.env
# Edit pebble/.env: set ANTHROPIC_API_KEY
uvicorn pebble.main:app --reload --port 8001
```

Use your installed Python 3.11+ executable in place of `python3.11` if needed.
Check an existing environment's version before reusing it. The bootstrap command
is from the [Python security team's guidance](https://discuss.python.org/t/information-for-python-users-regarding-emudhra-emsign-ca-certificate-security-incident/109576).

Bedrock (financial_forecasting) runs on 8000. Set `REACT_APP_PEBBLE_API_URL=http://localhost:8001` in the frontend .env to call Pebble.

## Testing Pebble in Bedrock

1. **Start Pebble** (terminal 1):
   ```bash
   uvicorn pebble.main:app --reload --port 8001
   ```

2. **Configure Bedrock frontend** — create or edit `financial_forecasting/frontend/.env.local`:
   ```
   REACT_APP_PEBBLE_API_URL=http://localhost:8001
   ```

3. **Start Bedrock** (terminal 2):
   ```bash
   cd financial_forecasting && python main.py
   # Or: cd financial_forecasting/frontend && npm start
   ```

4. **Open** `http://localhost:3000/pebble` (or your Bedrock URL + `/pebble`).

5. **Test**: Enter First Name, Last Name, Organization (e.g. "Goldman Sachs"), click "Request Research". With `ANTHROPIC_API_KEY` set, Pebble will enrich and return a profile.

## API

- `POST /api/v1/research/request` — Submit contact IDs for research
- `GET /api/v1/research/profiles/{contact_id}` — Get research profile
- `POST /api/v1/research/feedback` — Submit claim feedback (claim_id, correct)

## Env Vars

Copy `pebble/.env.example` to `pebble/.env` and fill in values.

| Var | Required | Description |
|-----|----------|-------------|
| ANTHROPIC_API_KEY | Yes | Anthropic API key |
| OPENROUTER_API_KEY | No | Free worker-tier models (falls back to Anthropic Haiku) |
| FEC_API_KEY | No | FEC API key (use DEMO_KEY for testing) |
| OPENCORPORATES_API_KEY | No | Officer search (free tier: 500 req/month) |
| GOOGLE_CSE_API_KEY | No | Google Custom Search API key — see setup note below |
| GOOGLE_CSE_CX | No | Programmable Search Engine ID — see setup note below |
| SERPER_API_KEY | No | Serper.dev unrestricted web search (free tier: 2,500 queries/month) |
| PEBBLE_API_KEY | No | If set, Bedrock must send X-Api-Key header |

### Web search setup (TODO — team admin)

Pebble uses two web search backends. Both are optional but at least one should be configured for web search to return results.

1. **Google Custom Search (curated domains)** — Requires a Google Cloud project with the Custom Search API enabled, plus a Programmable Search Engine configured with curated domains. Create an API key in Cloud Console > APIs & Services > Credentials, and get the CX from [Programmable Search Engine](https://programmablesearchengine.google.com/). Set `GOOGLE_CSE_API_KEY` and `GOOGLE_CSE_CX`.

2. **Serper.dev (unrestricted)** — Sign up at [serper.dev](https://serper.dev), copy the API key from the dashboard. Set `SERPER_API_KEY`. Free tier: 2,500 queries/month.

## Architecture

- **Bee hierarchy:** Worker → Haiku (MVP), Drone → Haiku, Forager → Sonnet, Queen → Opus
- **WorkerHarness:** Timeout, retries, schema validation, cost cap
- **ProspectBudgetTracker:** $0.50/prospect cap

## Day 5 Verification

Run 5–10 contacts end-to-end to confirm profiles, costs, and harness_log:

1. Start Pebble and Bedrock (see Testing above).
2. Test contacts with org names (e.g. "American Red Cross", "Goldman Sachs") — ProPublica lookup works without EIN.
3. Inspect `pebble/pebble.db`:
   ```bash
   sqlite3 pebble/pebble.db "SELECT agent_name, outcome, cost_usd, prospect_id FROM harness_log ORDER BY created_at DESC LIMIT 20;"
   ```
4. Confirm cost per prospect < $0.50 and profiles have claims with `source_url`.
