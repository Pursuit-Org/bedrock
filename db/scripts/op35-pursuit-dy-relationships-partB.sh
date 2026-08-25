#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Operation 35 — Pursuit, PART B: put the same 16 contacts into the jobs
# pipeline.
#
# Why this isn't in the SQL script: jobs_dev / jobs_team hold SELECT only on
# bedrock.jobs_contact_membership and bedrock.jobs_membership_stage_history.
# The app's backend connects as bedrock_user, so the endpoint below is the
# supported path — and it is the app's own _flag_contacts code, which writes
# the membership, the stage-history row and is_jobs_contact together.
#
# Semantics (routes/jobs.py:6318, _flag_contacts with stage=None):
#   * contacts with NO membership enter at stage 'assigned'
#   * contacts that ALREADY have a membership keep their stage — no downgrade.
#     My Chang stays 'converted_to_opportunity', Greg Levin 'initial_outreach'.
#   * idempotent: re-running changes nothing for contacts already in.
#
# Usage:
#   ./db/scripts/op35-pursuit-dy-relationships-partB.sh          # dry run
#   ./db/scripts/op35-pursuit-dy-relationships-partB.sh --apply  # do it
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Keep identical to :ids in op35-pursuit-dy-relationships.sql
CONTACT_IDS='[882,2210,7169,16563,16711,22827,34154,34424,34665,34776,35409,36976,42712,45526,37729,45230]'

API="${API:-http://localhost:8000}"
: "${TOKEN:?Set TOKEN first. From financial_forecasting/ run:
  python3 -c \"from auth import create_access_token; print(create_access_token({'email':'kwame@pursuit.org','role':'admin'}))\"
then: export TOKEN=<that value>}"

if [[ "${1:-}" != "--apply" ]]; then
    echo "DRY RUN — would POST to ${API}/api/jobs/contacts/flag-jobs"
    echo "contact_ids: ${CONTACT_IDS}"
    echo
    echo "Current pipeline state for these contacts:"
    curl -sS -H "Authorization: Bearer ${TOKEN}" \
        "${API}/api/jobs/my-network?scope=mine&limit=1" >/dev/null \
        || { echo "Could not reach ${API} — is the backend running?"; exit 1; }
    echo "  backend reachable. Re-run with --apply to flag them."
    exit 0
fi

echo "Flagging $(echo "${CONTACT_IDS}" | tr -cd ',' | wc -c | tr -d ' ')+1 contacts for jobs..."
curl -sS -X POST "${API}/api/jobs/contacts/flag-jobs" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"contact_ids\": ${CONTACT_IDS},
         \"activation_reason\": \"manual\",
         \"note\": \"Operation 35 - Pursuit. Sourced from DY Pursuit Network review, 2026-08-24.\"}"
echo
echo "Done. Verify with the query in the part A script's AFTER block."
