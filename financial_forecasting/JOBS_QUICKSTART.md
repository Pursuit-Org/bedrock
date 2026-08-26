# Jobs Pipeline — Quickstart (from a blank machine)

This is the **zero-to-running** guide for new devs (Avni & Damon). It assumes
nothing is installed yet. The same content lives in the shared Google Doc Jac
sent — this is the in-repo copy. Once you're running, read `JOBS_ONBOARDING.md`
(setup + data-model walkthrough) and `JOBS_HANDOFF.md` (data model + API reference).

## Get these from Jac first

1. You're added to the GitHub repo `Pursuit-Org/bedrock` (confirm you can see it
   at github.com/Pursuit-Org/bedrock).
2. Your laptop's IP is whitelisted on the database — run `curl ifconfig.me` in a
   terminal and send Jac the result.
3. The `DATABASE_URL` value for your `.env` — Jac sends it securely.

## Step 1 — Install an AI coding assistant and open it (by hand)

The rest is driven by an AI assistant, but you have to install and open it yourself
first (it can't run until it exists):

- **Easiest — Cursor:** install from cursor.com, open it, then open its terminal
  (**Terminal → New Terminal**) and the AI chat (**Cmd+L**).
- **Or Claude Code:** install from claude.com/claude-code, open the macOS Terminal
  app, and run `claude`.

## Step 2 — Paste this prompt into the AI chat and follow along

```
I'm a developer joining the Pursuit "bedrock" project to work on the Jobs Pipeline
tool. I'm starting from a fresh Mac — nothing is set up. Walk me through everything
step by step, run the commands for me where you can, explain what each does so I
learn, and verify each step works before moving to the next.

1. Check whether I have git, node (v20+), python3, and the GitHub CLI (gh). Install
   anything missing using Homebrew (install Homebrew first if I don't have it).
2. Log me into GitHub: run `gh auth login` and walk me through the browser steps
   (I already have access to the Pursuit-Org/bedrock repo).
3. Make a projects folder and clone the repo into it:
      mkdir -p ~/dev && cd ~/dev
      git clone https://github.com/Pursuit-Org/bedrock.git
      cd bedrock
4. Switch to the branch we work on (NOT main):
      git checkout feat/jobs-pipeline && git pull
5. Read financial_forecasting/JOBS_ONBOARDING.md (start here) and
   financial_forecasting/JOBS_HANDOFF.md (the data model + API). Summarize the
   data model back to me so I understand it.
6. Backend setup, in the financial_forecasting/ folder: create a .env file — ask me
   for the DATABASE_URL value (Jac sent it) and generate JWT_SECRET_KEY by running
   `openssl rand -hex 32`. Then run: pip install -r requirements.txt
7. Frontend setup: cd frontend-v2 && npm install
8. Start the app: ./dev.sh   (backend on :8000, frontend on :4200). Open
   http://localhost:4200, log in with my @pursuit.org Google account, go to /jobs.
9. If pages show errors about the database (503s), my laptop's IP isn't whitelisted
   yet — have me run `curl ifconfig.me` and send the result to Jac, then retry.
10. If I change code and it doesn't show up after restarting, check for a leftover
    process on port 8000 (`lsof -ti :8000 | xargs kill -9`) and re-run ./dev.sh.
11. Once /jobs loads, give me a guided tour of the three tabs (Performance /
    Opportunities / Prospects) and the key files: pages/jobs/JobsLeadership.tsx,
    components/jobs/JobsFunnels.tsx, services/jobs.ts, routes/jobs.py.

Diagnose and fix any failure before continuing — don't skip verification.
```

**Stuck on something the AI can't resolve?** Ping Jac — your contact for data,
endpoints, and access.
