"""
Environment variable reference for backend configuration.

There is no `config.py` module — we do NOT store secrets locally in Python
source. App-level credentials come from env vars (os.getenv), per-user
credentials come from OAuth flows at runtime (see routes/auth.py for the
Google + Salesforce OAuth callbacks).

Set the vars below via .env (dev) or Cloud Run env (prod).
"""

# Salesforce - set in env:
# SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET
# SALESFORCE_USERNAME, SALESFORCE_PASSWORD, SALESFORCE_SECURITY_TOKEN
# SALESFORCE_DOMAIN (login or test)

# Sage Intacct - set in env:
# SAGE_COMPANY_ID, SAGE_USER_ID, SAGE_USER_PASSWORD
# SAGE_SENDER_ID, SAGE_SENDER_PASSWORD
# SAGE_ENDPOINT_URL (default: https://api.intacct.com/ia/xml/xmlgw.phtml)

# Access control - set in env:
# ALLOWED_EMAILS=comma,separated,list@domain.com (optional; if unset, all authenticated users allowed)

# Intacct auto-invoicing - set in env (default: false):
# INTACCT_AUTO_INVOICE_ENABLED  (true | false, default false; strict parse — only "true" enables)
#
# When false, sync_opportunity_invoicing and handle_opportunity_stage_change
# skip all Intacct writes. Stays off until the F2 bundle ships:
#   - expanded stage filter via WON_STAGES_SET (multiple win stages, not just Closed Won)
#   - Donorbox exclusion (Campaign.Name = 'Online Donations' OR Name LIKE '%Donorbox%')
#   - RecordType IN ('Grant', 'Donation') filter (exclude ISA + PBC records)
#   - CloseDate date guard (only new deals flow through auto-invoice)
#   - pre-flight Invoice_Status__c backfill on historical records
#   - HITL review queue (finance approves before Intacct writes)
#   - finance onboarding (GL-mapping confirmed, approvers trained)
# See tasks/stage-schema-drift.md §F2.
