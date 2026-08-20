"""Data synchronization service for keeping Salesforce and Sage Intacct data in sync."""

import asyncio
import logging
import os
from typing import Any, Dict, List, Optional, Set
from datetime import datetime, date, timedelta, timezone
from decimal import Decimal

from models import (
    SalesforceOpportunity, SalesforceAccount, IntacctCustomer, IntacctInvoice,
    OpportunityInvoiceMapping, OpportunityStage
)

logger = logging.getLogger(__name__)


def _intacct_auto_invoice_enabled() -> bool:
    """Kill switch for Sage Intacct auto-invoicing. Default: disabled.

    When False (default), sync_opportunity_invoicing and
    handle_opportunity_stage_change short-circuit without writing to Intacct.
    Flip to True via env only after the F2 bundle ships (expanded stage filter
    + Donorbox exclusion + RecordType filter + date guard + pre-flight
    cleanup + HITL review + finance onboarding — see
    tasks/f1-stage-buckets-plan.md §5.3).

    Strict parse: only literal "true" (case-insensitive after strip) enables.
    "1", "yes", "TRUE" before lower — all fail-safe to False.

    Read at call time (not a module constant) so tests can flip the value
    with monkeypatch.setenv("INTACCT_AUTO_INVOICE_ENABLED", "true").
    """
    return os.getenv("INTACCT_AUTO_INVOICE_ENABLED", "false").strip().lower() == "true"


class DataSyncService:
    """Service for synchronizing data between Salesforce and Sage Intacct."""

    def __init__(self, mcp_client, db_pool=None):
        self.mcp_client = mcp_client
        self.db_pool = db_pool
        self.sync_history = []
        self.customer_mappings = {}  # Salesforce Account ID -> Intacct Customer ID
        self.opportunity_mappings = {}  # Opportunity ID -> Invoice mappings
        
    def _intacct_available(self) -> bool:
        """Check if Sage Intacct service is connected."""
        return "sage_intacct" in self.mcp_client.connected_services

    def _salesforce_available(self) -> bool:
        """Check if Salesforce service is connected."""
        return "salesforce" in self.mcp_client.connected_services

    async def sync_activities(self, *, force_full: bool = False):
        """Sync SF Tasks + Events into bedrock.activity table."""
        if self.db_pool is None:
            logger.debug("Skipping activity sync — no database pool")
            return
        if not self._salesforce_available():
            logger.debug("Skipping activity sync — Salesforce not connected")
            return

        logger.info("Starting activity sync (SF Tasks + Events)...")
        salesforce = self.mcp_client.services["salesforce"]
        upserted = 0
        skipped_deleted = 0
        errors = 0

        async with self.db_pool.acquire() as conn:
            # Get watermark for incremental sync. force_full=True ignores
            # the watermark and re-fetches everything — used after a
            # classifier change to re-stamp existing rows.
            watermark_clause = ""
            if not force_full:
                watermark = await conn.fetchval(
                    "SELECT MAX(sf_last_modified) FROM bedrock.activity WHERE source = 'salesforce'"
                )
                if watermark:
                    # Format for SOQL: YYYY-MM-DDTHH:MM:SSZ (Salesforce canonical format)
                    utc_wm = watermark.astimezone(timezone.utc)
                    watermark_str = utc_wm.strftime("%Y-%m-%dT%H:%M:%SZ")
                    watermark_clause = f" WHERE LastModifiedDate > {watermark_str}"
            else:
                logger.info("Activity sync: force_full=True — ignoring watermark")

            # SOQL: SF Tasks
            task_soql = f"""
            SELECT Id, Subject, Status, Priority, ActivityDate, Description,
                   OwnerId, Owner.Name, WhoId, Who.Name, WhatId, What.Name,
                   Type, TaskSubtype, CreatedById, CreatedBy.Name,
                   CreatedDate, LastModifiedDate, IsClosed,
                   CallType, CallDurationInSeconds
            FROM Task
            {watermark_clause}
            ORDER BY LastModifiedDate ASC
            """

            # SOQL: SF Events
            event_soql = f"""
            SELECT Id, Subject, Description, StartDateTime, EndDateTime,
                   OwnerId, Owner.Name, WhoId, Who.Name, WhatId, What.Name,
                   Type, Location, DurationInMinutes, IsAllDayEvent,
                   CreatedById, CreatedBy.Name, CreatedDate, LastModifiedDate
            FROM Event
            {watermark_clause}
            ORDER BY LastModifiedDate ASC
            """

            # Fetch both
            try:
                task_result = await salesforce.query_all(task_soql)
                tasks = task_result.get("records", [])
            except Exception as e:
                logger.error(f"Failed to query SF Tasks: {e}")
                tasks = []

            try:
                event_result = await salesforce.query_all(event_soql)
                events = event_result.get("records", [])
            except Exception as e:
                logger.error(f"Failed to query SF Events: {e}")
                events = []

            logger.info(f"Activity sync: fetched {len(tasks)} Tasks, {len(events)} Events from Salesforce")

            # Map and upsert Tasks
            for task in tasks:
                try:
                    row = self._map_sf_task(task)
                    result = await self._upsert_activity(conn, row)
                    if result == "upserted":
                        upserted += 1
                    elif result == "skipped_deleted":
                        skipped_deleted += 1
                except Exception as e:
                    errors += 1
                    logger.warning(f"Failed to sync Task {task.get('Id', '?')}: {e}")

            # Map and upsert Events
            for event in events:
                try:
                    row = self._map_sf_event(event)
                    result = await self._upsert_activity(conn, row)
                    if result == "upserted":
                        upserted += 1
                    elif result == "skipped_deleted":
                        skipped_deleted += 1
                except Exception as e:
                    errors += 1
                    logger.warning(f"Failed to sync Event {event.get('Id', '?')}: {e}")

        summary = (
            f"Activity sync complete: {upserted} upserted, "
            f"{skipped_deleted} skipped (soft-deleted), {errors} errors"
        )
        logger.info(summary)

        # Jobs-relevance classification for the SF email/meeting rows just synced.
        # These carry no email_from/attendees, so without this they stay NULL and
        # the outreach gate (jobs_relevance='jobs') silently drops them. Idempotent
        # (only NULL verdicts) and bounded so a large backlog can't blow up the sync
        # — the newest NULL rows go first and nightly re-runs drain the rest.
        try:
            from services.activity_classifier import classify_new_activity
            async with self.db_pool.acquire() as cls_conn:
                cls = await classify_new_activity(cls_conn, limit=1500)
            logger.info("Activity sync: jobs-relevance classified %s", cls)
        except Exception as e:
            logger.warning("Activity sync: jobs-relevance classification skipped: %s", e)

        self.sync_history.append({
            "timestamp": datetime.now(),
            "type": "activity_sync",
            "status": "completed" if errors == 0 else "completed_with_errors",
            "details": summary,
            "upserted": upserted,
            "skipped_deleted": skipped_deleted,
            "errors": errors,
        })

        # Retry any manually-logged calls that failed to reach SF on the first attempt.
        await self.sync_pending_call_activities()

    async def sync_pending_call_activities(self):
        """Push locally-saved call activities (sf_sync_status='pending') to Salesforce.

        Called at the end of every sync cycle. On success stamps sf_id and flips
        status to 'synced'. On repeated failure leaves status as 'pending' until
        a human investigates or the backend reconnects to Salesforce.
        """
        if self.db_pool is None or not self._salesforce_available():
            return
        salesforce = self.mcp_client.services["salesforce"]
        async with self.db_pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, subject, description, activity_date,
                       account_id, opportunity_id, contact_ids
                FROM bedrock.activity
                WHERE sf_sync_status = 'pending'
                  AND source = 'manual'
                  AND type = 'call'
                  AND deleted_at IS NULL
                LIMIT 50
                """
            )
            if not rows:
                return
            logger.info("Pending call sync: retrying %d rows", len(rows))
            for row in rows:
                try:
                    sf_fields = {
                        "Subject": row["subject"],
                        "Status": "Completed",
                        "TaskSubtype": "Call",
                        "WhatId": row["opportunity_id"] or row["account_id"],
                    }
                    if row["activity_date"]:
                        sf_fields["ActivityDate"] = row["activity_date"].date().isoformat()
                    if row["description"]:
                        sf_fields["Description"] = row["description"]
                    contact_ids = row["contact_ids"] or []
                    if contact_ids:
                        sf_fields["WhoId"] = contact_ids[0]
                    result = await salesforce.create_record("Task", sf_fields)
                    sf_id = result.get("id") or result.get("Id")
                    if sf_id:
                        await conn.execute(
                            """
                            UPDATE bedrock.activity
                            SET sf_id=$1, sf_task_id=$1, sf_sync_status='synced', synced_at=now()
                            WHERE id=$2
                            """,
                            sf_id, row["id"],
                        )
                        logger.info("Pending call %s synced to SF Task %s", row["id"], sf_id)
                except Exception as e:
                    logger.warning("Failed to sync pending call %s to SF: %s", row["id"], e)

    @staticmethod
    def _parse_sf_datetime(value) -> Optional[datetime]:
        """Parse a Salesforce date/datetime string to a timezone-aware Python datetime.

        Salesforce returns:
          - Date fields: "2026-03-15"
          - DateTime fields: "2026-03-15T14:30:00.000+0000"
        asyncpg requires timezone-aware Python datetime objects for TIMESTAMPTZ columns.
        """
        if value is None:
            return None
        if isinstance(value, datetime):
            if value.tzinfo is None:
                return value.replace(tzinfo=timezone.utc)
            return value
        if isinstance(value, date) and not isinstance(value, datetime):
            return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
        try:
            dt = datetime.fromisoformat(str(value))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            pass
        # Fallback: date-only string "2026-03-15" → midnight UTC
        try:
            d = date.fromisoformat(str(value))
            return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
        except ValueError:
            logger.warning(f"Could not parse Salesforce datetime: {value!r}")
            return None

    def _map_sf_task(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """Map a Salesforce Task record to activity column values.

        Type detection order (most specific wins):
          1. TaskSubtype = "Email"            → email
          2. TaskSubtype = "Call" or Type = "Call"  → call
          3. TaskSubtype includes "meeting" / Type matches a meeting label
                                              → meeting
          4. anything else                    → note

        Pursuit logs many meetings as Tasks (not Events), with
        Type = "Meeting" and a free-form Subject. Without this
        classification rule those rows came through as "note", so
        meetings effectively disappeared from the activity timeline.

        Email-from-sync subject extraction: SF Tasks created by the
        Salesforce Inbox / Outlook Connector come in with Subject="true"
        and the actual email subject + body packed into Description as::

            To: a@x.com; b@y.com
            CC: c@z.com
            BCC:
            Attachment: --none--

            Subject: <real subject>
            Body:
            <body>

        We parse those out so the timeline shows the real subject + a
        clean body instead of "true".
        """
        subtype = (task.get("TaskSubtype") or "").lower()
        sf_type_field = (task.get("Type") or "").lower()

        if subtype == "email":
            activity_type = "email"
        elif subtype == "call" or sf_type_field == "call":
            activity_type = "call"
        elif (
            "meeting" in subtype
            or sf_type_field in {
                "meeting",
                "in-person meeting",
                "in person meeting",
                "virtual meeting",
                "zoom meeting",
                "site visit",
            }
        ):
            activity_type = "meeting"
        else:
            activity_type = "note"

        raw_subject = task.get("Subject") or ""
        raw_desc = task.get("Description") or ""
        subject, description = self._unpack_synced_email(
            raw_subject, raw_desc, activity_type,
        )

        # Route WhatId to opportunity or account
        opportunity_id = None
        account_id = None
        what_id = task.get("WhatId") or ""
        if what_id.startswith("006"):
            opportunity_id = what_id
        elif what_id.startswith("001"):
            account_id = what_id

        # Route WhoId to contact_ids
        contact_ids = []
        who_id = task.get("WhoId") or ""
        if who_id.startswith("003"):
            contact_ids = [who_id]

        # Call duration → meeting_duration_minutes (in seconds from SF)
        call_duration_sec = task.get("CallDurationInSeconds")
        duration_min = (call_duration_sec // 60) if call_duration_sec else None

        return {
            "sf_id": task["Id"],
            "sf_type": "Task",
            "type": activity_type,
            "subject": subject or "(No subject)",
            "description": description,
            "activity_date": self._parse_sf_datetime(task.get("ActivityDate") or task.get("CreatedDate")),
            "opportunity_id": opportunity_id,
            "account_id": account_id,
            "contact_ids": contact_ids,
            "source": "salesforce",
            "owner_id": task.get("OwnerId"),
            "logged_by": task.get("CreatedById"),
            "sf_last_modified": self._parse_sf_datetime(task.get("LastModifiedDate")),
            "meeting_duration_minutes": duration_min,
        }

    @staticmethod
    def _unpack_synced_email(
        raw_subject: str, raw_desc: str, activity_type: str,
    ) -> tuple[str, Optional[str]]:
        """Pull the real Subject + Body out of a Salesforce-Inbox-synced
        email Task, where Subject="true" and Description packs the whole
        email payload as plain text. No-op for everything else.

        Returns (subject, description) — falls back to the raw values
        if the expected pattern isn't found, so non-email Tasks keep
        their original Subject/Description verbatim.
        """
        is_synced_email = (
            activity_type == "email"
            and raw_subject.strip().lower() == "true"
            and raw_desc
        )
        if not is_synced_email:
            return raw_subject, raw_desc or None

        # Find the embedded "Subject:" header — it always sits between the
        # To/CC/BCC/Attachment block and the "Body:" marker.
        import re as _re
        subj_match = _re.search(
            r"^Subject:\s*(.+?)\s*$", raw_desc, _re.MULTILINE,
        )
        body_match = _re.search(r"\nBody:\s*\n(.*)", raw_desc, _re.DOTALL)

        new_subject = subj_match.group(1).strip() if subj_match else "(No subject)"
        new_body = body_match.group(1).strip() if body_match else raw_desc
        return new_subject, new_body or None

    def _map_sf_event(self, event: Dict[str, Any]) -> Dict[str, Any]:
        """Map a Salesforce Event record to activity column values."""
        is_all_day = event.get("IsAllDayEvent", False)
        activity_type = "calendar-event" if is_all_day else "meeting"

        # Route WhatId
        opportunity_id = None
        account_id = None
        what_id = event.get("WhatId") or ""
        if what_id.startswith("006"):
            opportunity_id = what_id
        elif what_id.startswith("001"):
            account_id = what_id

        # Route WhoId
        contact_ids = []
        who_id = event.get("WhoId") or ""
        if who_id.startswith("003"):
            contact_ids = [who_id]

        return {
            "sf_id": event["Id"],
            "sf_type": "Event",
            "type": activity_type,
            "subject": event.get("Subject") or "(No subject)",
            "description": event.get("Description"),
            "activity_date": self._parse_sf_datetime(event.get("StartDateTime") or event.get("CreatedDate")),
            "opportunity_id": opportunity_id,
            "account_id": account_id,
            "contact_ids": contact_ids,
            "source": "salesforce",
            "owner_id": event.get("OwnerId"),
            "logged_by": event.get("CreatedById"),
            "sf_last_modified": self._parse_sf_datetime(event.get("LastModifiedDate")),
            "meeting_duration_minutes": event.get("DurationInMinutes"),
            "meeting_location": event.get("Location"),
        }

    async def _upsert_activity(self, conn, row: Dict[str, Any]) -> str:
        """Upsert a single activity row. Returns 'upserted' or 'skipped_deleted'."""
        result = await conn.execute("""
            INSERT INTO bedrock.activity (
                sf_id, sf_type, type, subject, description, activity_date,
                opportunity_id, account_id, contact_ids, source,
                owner_id, logged_by, sf_last_modified, synced_at,
                meeting_duration_minutes, meeting_location
            ) VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10,
                $11, $12, $13, now(),
                $14, $15
            )
            ON CONFLICT (sf_id) DO UPDATE SET
                type = EXCLUDED.type,
                subject = EXCLUDED.subject,
                description = EXCLUDED.description,
                activity_date = EXCLUDED.activity_date,
                opportunity_id = EXCLUDED.opportunity_id,
                account_id = EXCLUDED.account_id,
                contact_ids = EXCLUDED.contact_ids,
                owner_id = EXCLUDED.owner_id,
                logged_by = EXCLUDED.logged_by,
                sf_last_modified = EXCLUDED.sf_last_modified,
                synced_at = now(),
                meeting_duration_minutes = EXCLUDED.meeting_duration_minutes,
                meeting_location = EXCLUDED.meeting_location
            WHERE bedrock.activity.deleted_at IS NULL
        """,
            row["sf_id"],
            row["sf_type"],
            row["type"],
            row["subject"],
            row.get("description"),
            row["activity_date"],
            row.get("opportunity_id"),
            row.get("account_id"),
            row.get("contact_ids", []),
            row["source"],
            row.get("owner_id"),
            row.get("logged_by"),
            row.get("sf_last_modified"),
            row.get("meeting_duration_minutes"),
            row.get("meeting_location"),
        )
        # asyncpg returns 'INSERT 0 1' or 'INSERT 0 0' (0 means ON CONFLICT skipped)
        if result and result.endswith("0 0"):
            return "skipped_deleted"
        return "upserted"

    async def sync_all_data(self):
        """Perform complete data synchronization."""

        # Activities sync (SF → PostgreSQL, independent of Intacct)
        if self.db_pool:
            try:
                await self.sync_activities()
            except Exception as e:
                logger.error(f"Activity sync failed (continuing): {e}")
                self.sync_history.append({
                    "timestamp": datetime.now(),
                    "type": "activity_sync",
                    "status": "failed",
                    "error": str(e),
                })

        if not self._intacct_available():
            logger.info("Skipping data sync — Sage Intacct not connected")
            return

        logger.info("Starting complete data synchronization...")

        try:
            # Sync customer/account mappings first
            await self.sync_customer_mappings()

            # Sync opportunities that need invoicing
            await self.sync_opportunity_invoicing()

            # Update payment status for existing invoices
            await self.update_payment_statuses()
            
            # Record sync completion
            self.sync_history.append({
                "timestamp": datetime.now(),
                "type": "full_sync",
                "status": "completed",
                "details": "Complete data synchronization finished successfully"
            })
            
            logger.info("Complete data synchronization finished successfully")
            
        except Exception as e:
            logger.error(f"Error during complete data sync: {e}")
            self.sync_history.append({
                "timestamp": datetime.now(),
                "type": "full_sync",
                "status": "failed",
                "error": str(e)
            })
            raise

    async def sync_salesforce_data(self):
        """Sync only Salesforce-related data."""
        logger.info("Starting Salesforce data sync...")
        
        try:
            await self.sync_customer_mappings()
            await self.sync_opportunity_invoicing()
            
            self.sync_history.append({
                "timestamp": datetime.now(),
                "type": "salesforce_sync",
                "status": "completed"
            })
            
            logger.info("Salesforce data sync completed")
            
        except Exception as e:
            logger.error(f"Error during Salesforce sync: {e}")
            raise

    async def sync_intacct_data(self):
        """Sync only Sage Intacct-related data."""
        logger.info("Starting Sage Intacct data sync...")
        
        try:
            await self.update_payment_statuses()
            await self.sync_customer_data_to_salesforce()
            
            self.sync_history.append({
                "timestamp": datetime.now(),
                "type": "intacct_sync",
                "status": "completed"
            })
            
            logger.info("Sage Intacct data sync completed")
            
        except Exception as e:
            logger.error(f"Error during Intacct sync: {e}")
            raise

    async def sync_customer_mappings(self):
        """Synchronize customer mappings between Salesforce Accounts and Intacct Customers."""
        if not self._intacct_available():
            logger.debug("Skipping customer mappings — Sage Intacct not connected")
            return

        logger.info("Syncing customer mappings...")

        try:
            # Get Salesforce accounts
            salesforce = self.mcp_client.services["salesforce"]
            accounts_query = """
            SELECT Id, Name, BillingStreet, BillingCity, BillingState, 
                   BillingPostalCode, BillingCountry, Phone, Website,
                   Intacct_Customer_ID__c
            FROM Account
            WHERE Type IN ('Customer', 'Prospect')
            ORDER BY Name
            LIMIT 1000
            """
            
            accounts_result = await salesforce.query(accounts_query)
            accounts = accounts_result.get("records", [])
            
            # Get Intacct customers
            intacct = self.mcp_client.services["sage_intacct"]
            customers_result = await intacct.get_customers(limit=1000)
            
            if not customers_result.get("success"):
                logger.warning("Failed to retrieve Intacct customers")
                return
            
            intacct_customers = customers_result.get("data", [])
            if not isinstance(intacct_customers, list):
                intacct_customers = [intacct_customers] if intacct_customers else []
            
            # Create mapping dictionaries for efficient lookup
            intacct_by_name = {
                customer.get("NAME", "").lower(): customer 
                for customer in intacct_customers
            }
            
            # Process each Salesforce account
            updates_needed = []
            new_customers_needed = []
            
            for account in accounts:
                account_id = account["Id"]
                account_name = account["Name"]
                existing_intacct_id = account.get("Intacct_Customer_ID__c")
                
                if existing_intacct_id:
                    # Mapping already exists
                    self.customer_mappings[account_id] = existing_intacct_id
                    continue
                
                # Try to find matching Intacct customer by name
                matching_customer = intacct_by_name.get(account_name.lower())
                
                if matching_customer:
                    # Found a match - update Salesforce with the mapping
                    intacct_customer_id = matching_customer.get("CUSTOMERID")
                    self.customer_mappings[account_id] = intacct_customer_id
                    
                    updates_needed.append({
                        "account_id": account_id,
                        "intacct_customer_id": intacct_customer_id
                    })
                else:
                    # No match found - may need to create new customer in Intacct
                    new_customers_needed.append(account)
            
            # Update Salesforce with found mappings
            for update in updates_needed:
                try:
                    await salesforce.update_record(
                        "Account",
                        update["account_id"],
                        {"Intacct_Customer_ID__c": update["intacct_customer_id"]}
                    )
                    logger.info(f"Updated Account {update['account_id']} with Intacct Customer ID {update['intacct_customer_id']}")
                except Exception as e:
                    logger.warning(f"Failed to update Account {update['account_id']}: {e}")
            
            # Create new customers in Intacct for unmatched accounts
            for account in new_customers_needed[:10]:  # Limit to 10 new customers per sync
                try:
                    new_customer_id = await self.create_intacct_customer_from_account(account)
                    if new_customer_id:
                        self.customer_mappings[account["Id"]] = new_customer_id
                        
                        # Update Salesforce with new mapping
                        await salesforce.update_record(
                            "Account",
                            account["Id"],
                            {"Intacct_Customer_ID__c": new_customer_id}
                        )
                        
                        logger.info(f"Created new Intacct customer {new_customer_id} for Account {account['Id']}")
                        
                except Exception as e:
                    logger.warning(f"Failed to create Intacct customer for Account {account['Id']}: {e}")
            
            logger.info(f"Customer mapping sync completed. Mapped {len(self.customer_mappings)} customers.")
            
        except Exception as e:
            logger.error(f"Error syncing customer mappings: {e}")
            raise

    async def create_intacct_customer_from_account(self, account: Dict[str, Any]) -> Optional[str]:
        """Create a new customer in Intacct from a Salesforce account."""
        try:
            intacct = self.mcp_client.services["sage_intacct"]
            
            # Prepare customer data
            customer_data = {
                "customer_id": f"SF_{account['Id'][:8]}",  # Use part of Salesforce ID
                "name": account["Name"],
                "display_contact": account["Name"],
                "company_name": account["Name"],
                "print_as": account["Name"],
                # Add address fields if available
                "address": {
                    "street": account.get("BillingStreet", ""),
                    "city": account.get("BillingCity", ""),
                    "state": account.get("BillingState", ""),
                    "zip": account.get("BillingPostalCode", ""),
                    "country": account.get("BillingCountry", "")
                },
                "phone": account.get("Phone", ""),
                "website": account.get("Website", "")
            }
            
            # Create customer in Intacct
            # Note: This would need to be implemented in the Intacct service
            # For now, return a placeholder ID
            return customer_data["customer_id"]
            
        except Exception as e:
            logger.error(f"Error creating Intacct customer: {e}")
            return None

    async def sync_opportunity_invoicing(self):
        """Sync opportunities that are ready for invoicing."""
        if not _intacct_auto_invoice_enabled():
            logger.info(
                "Skipping opportunity invoicing — INTACCT_AUTO_INVOICE_ENABLED=false "
                "(F2 bundle not yet shipped — see tasks/f1-stage-buckets-plan.md)"
            )
            return
        if not self._intacct_available():
            logger.debug("Skipping opportunity invoicing — Sage Intacct not connected")
            return

        logger.info("Syncing opportunity invoicing...")
        
        try:
            # Get opportunities that are Closed Won but not yet invoiced
            salesforce = self.mcp_client.services["salesforce"]
            
            ready_for_invoice_query = """
            SELECT Id, AccountId, Account.Name, Name, Amount, CloseDate, 
                   StageName, Payment_Terms__c, Contract_Start_Date__c,
                   Invoice_Status__c, Intacct_Invoice_ID__c
            FROM Opportunity
            WHERE StageName = 'Closed Won'
            AND (Invoice_Status__c = null OR Invoice_Status__c = 'Pending')
            AND Amount > 0
            ORDER BY CloseDate DESC
            LIMIT 100
            """
            
            result = await salesforce.query(ready_for_invoice_query)
            opportunities = result.get("records", [])
            
            logger.info(f"Found {len(opportunities)} opportunities ready for invoicing")
            
            for opp in opportunities:
                try:
                    await self.process_opportunity_for_invoicing(opp)
                except Exception as e:
                    logger.warning(f"Failed to process opportunity {opp['Id']} for invoicing: {e}")
                    continue
            
            logger.info("Opportunity invoicing sync completed")
            
        except Exception as e:
            logger.error(f"Error syncing opportunity invoicing: {e}")
            raise

    async def process_opportunity_for_invoicing(self, opportunity: Dict[str, Any]):
        """Process a single opportunity for invoicing."""
        try:
            opp_id = opportunity["Id"]
            account_id = opportunity["AccountId"]
            account_name = opportunity.get("Account", {}).get("Name", "Unknown")
            amount = Decimal(str(opportunity.get("Amount", 0)))
            
            # Check if we have a customer mapping
            intacct_customer_id = self.customer_mappings.get(account_id)
            if not intacct_customer_id:
                # Try to get it from the account record
                salesforce = self.mcp_client.services["salesforce"]
                account_result = await salesforce.get_record("Account", account_id)
                intacct_customer_id = account_result.get("Intacct_Customer_ID__c")
                
                if intacct_customer_id:
                    self.customer_mappings[account_id] = intacct_customer_id
                else:
                    logger.warning(f"No Intacct customer mapping found for Account {account_id}")
                    return
            
            # Prepare invoice data
            invoice_data = {
                "customer_id": intacct_customer_id,
                "date_created": datetime.now().strftime("%m/%d/%Y"),
                "line_items": [
                    {
                        "account_label": "Sales",
                        "amount": float(amount),
                        "description": f"Invoice for opportunity: {opportunity['Name']}"
                    }
                ]
            }
            
            # Create invoice in Intacct
            intacct = self.mcp_client.services["sage_intacct"]
            invoice_result = await intacct.create_invoice(invoice_data)
            
            if invoice_result.get("success"):
                invoice_id = invoice_result.get("data", {}).get("RECORDNO")
                
                # Update opportunity in Salesforce
                salesforce = self.mcp_client.services["salesforce"]
                await salesforce.update_record(
                    "Opportunity",
                    opp_id,
                    {
                        "Invoice_Status__c": "Invoiced",
                        "Intacct_Invoice_ID__c": invoice_id,
                        "Invoice_Date__c": datetime.now().strftime("%Y-%m-%d")
                    }
                )
                
                # Store mapping
                self.opportunity_mappings[opp_id] = {
                    "invoice_id": invoice_id,
                    "status": "invoiced",
                    "created_date": datetime.now()
                }
                
                logger.info(f"Successfully created invoice {invoice_id} for opportunity {opp_id}")
                
            else:
                logger.error(f"Failed to create invoice for opportunity {opp_id}: {invoice_result.get('errors', 'Unknown error')}")
                
                # Update opportunity with error status
                await salesforce.update_record(
                    "Opportunity",
                    opp_id,
                    {"Invoice_Status__c": "Error"}
                )
                
        except Exception as e:
            logger.error(f"Error processing opportunity {opportunity.get('Id', 'unknown')} for invoicing: {e}")
            raise

    async def update_payment_statuses(self):
        """Update payment statuses from Intacct back to Salesforce."""
        if not self._intacct_available():
            logger.debug("Skipping payment status sync — Sage Intacct not connected")
            return

        logger.info("Updating payment statuses...")
        
        try:
            # Get recent payments from Intacct
            intacct = self.mcp_client.services["sage_intacct"]
            payments_result = await intacct.get_payments(limit=500)
            
            if not payments_result.get("success"):
                logger.warning("Failed to retrieve payments from Intacct")
                return
            
            payments = payments_result.get("data", [])
            if not isinstance(payments, list):
                payments = [payments] if payments else []
            
            # Get invoices to match payments
            invoices_result = await intacct.get_invoices(limit=1000)
            invoices = invoices_result.get("data", []) if invoices_result.get("success") else []
            if not isinstance(invoices, list):
                invoices = [invoices] if invoices else []
            
            # Create invoice lookup by record number
            invoice_lookup = {
                invoice.get("RECORDNO"): invoice 
                for invoice in invoices
            }
            
            # Get opportunities that have been invoiced
            salesforce = self.mcp_client.services["salesforce"]
            invoiced_opps_query = """
            SELECT Id, Name, Amount, Intacct_Invoice_ID__c, Payment_Status__c,
                   Payment_Date__c, Payment_Amount__c
            FROM Opportunity
            WHERE Intacct_Invoice_ID__c != null
            AND Payment_Status__c != 'Paid'
            LIMIT 500
            """
            
            opps_result = await salesforce.query(invoiced_opps_query)
            opportunities = opps_result.get("records", [])
            
            # Process each opportunity
            updates_needed = []
            
            for opp in opportunities:
                try:
                    opp_id = opp["Id"]
                    invoice_id = opp.get("Intacct_Invoice_ID__c")
                    
                    if not invoice_id:
                        continue
                    
                    # Find the invoice
                    invoice = invoice_lookup.get(invoice_id)
                    if not invoice:
                        continue
                    
                    # Check invoice status
                    invoice_state = invoice.get("STATE", "")
                    total_amount = Decimal(str(invoice.get("TOTALAMOUNT", 0)))
                    total_paid = Decimal(str(invoice.get("TOTALPAID", 0)))
                    
                    # Determine payment status
                    payment_status = "Pending"
                    payment_date = None
                    payment_amount = None
                    
                    if invoice_state == "Paid" or total_paid >= total_amount:
                        payment_status = "Paid"
                        # Find the most recent payment for this invoice
                        invoice_payments = [
                            p for p in payments 
                            if p.get("CUSTOMERID") == invoice.get("CUSTOMERID")
                        ]
                        
                        if invoice_payments:
                            # Sort by receipt date and get the latest
                            invoice_payments.sort(
                                key=lambda x: x.get("RECEIPTDATE", ""), 
                                reverse=True
                            )
                            latest_payment = invoice_payments[0]
                            payment_date = latest_payment.get("RECEIPTDATE")
                            payment_amount = float(total_paid)
                    
                    elif total_paid > 0:
                        payment_status = "Partial"
                        payment_amount = float(total_paid)
                    
                    # Check if update is needed
                    current_status = opp.get("Payment_Status__c", "")
                    if current_status != payment_status:
                        update_data = {"Payment_Status__c": payment_status}
                        
                        if payment_date:
                            # Parse and format date
                            if isinstance(payment_date, str) and len(payment_date) >= 10:
                                update_data["Payment_Date__c"] = payment_date[:10]
                        
                        if payment_amount is not None:
                            update_data["Payment_Amount__c"] = payment_amount
                        
                        updates_needed.append({
                            "opportunity_id": opp_id,
                            "updates": update_data
                        })
                
                except Exception as e:
                    logger.warning(f"Error processing payment status for opportunity {opp.get('Id', 'unknown')}: {e}")
                    continue
            
            # Apply updates
            for update in updates_needed:
                try:
                    await salesforce.update_record(
                        "Opportunity",
                        update["opportunity_id"],
                        update["updates"]
                    )
                    logger.info(f"Updated payment status for opportunity {update['opportunity_id']}")
                except Exception as e:
                    logger.warning(f"Failed to update opportunity {update['opportunity_id']}: {e}")
            
            logger.info(f"Payment status update completed. Updated {len(updates_needed)} opportunities.")
            
        except Exception as e:
            logger.error(f"Error updating payment statuses: {e}")
            raise

    async def sync_customer_data_to_salesforce(self):
        """Sync customer financial data from Intacct to Salesforce."""
        if not self._intacct_available():
            logger.debug("Skipping customer data sync — Sage Intacct not connected")
            return

        logger.info("Syncing customer financial data to Salesforce...")
        
        try:
            # Get Intacct customers with financial data
            intacct = self.mcp_client.services["sage_intacct"]
            customers_result = await intacct.get_customers(limit=1000)
            
            if not customers_result.get("success"):
                logger.warning("Failed to retrieve customers from Intacct")
                return
            
            customers = customers_result.get("data", [])
            if not isinstance(customers, list):
                customers = [customers] if customers else []
            
            # Get Salesforce accounts that have Intacct mappings
            salesforce = self.mcp_client.services["salesforce"]
            accounts_query = """
            SELECT Id, Name, Intacct_Customer_ID__c, Total_Outstanding__c,
                   Credit_Limit__c, Last_Payment_Date__c
            FROM Account
            WHERE Intacct_Customer_ID__c != null
            LIMIT 1000
            """
            
            accounts_result = await salesforce.query(accounts_query)
            accounts = accounts_result.get("records", [])
            
            # Create lookup by Intacct customer ID
            intacct_lookup = {
                customer.get("CUSTOMERID"): customer 
                for customer in customers
            }
            
            # Process each account
            updates_needed = []
            
            for account in accounts:
                try:
                    account_id = account["Id"]
                    intacct_customer_id = account.get("Intacct_Customer_ID__c")
                    
                    if not intacct_customer_id:
                        continue
                    
                    # Find matching Intacct customer
                    intacct_customer = intacct_lookup.get(intacct_customer_id)
                    if not intacct_customer:
                        continue
                    
                    # Prepare updates
                    update_data = {}
                    
                    # Total outstanding amount
                    total_due = intacct_customer.get("TOTALDUE")
                    if total_due is not None:
                        current_outstanding = account.get("Total_Outstanding__c")
                        if current_outstanding != float(total_due):
                            update_data["Total_Outstanding__c"] = float(total_due)
                    
                    # Credit limit
                    credit_limit = intacct_customer.get("CREDITLIMIT")
                    if credit_limit is not None:
                        current_credit_limit = account.get("Credit_Limit__c")
                        if current_credit_limit != float(credit_limit):
                            update_data["Credit_Limit__c"] = float(credit_limit)
                    
                    # Last modified date as proxy for last payment
                    when_modified = intacct_customer.get("WHENMODIFIED")
                    if when_modified:
                        # Parse and format date
                        if isinstance(when_modified, str) and len(when_modified) >= 10:
                            update_data["Last_Financial_Update__c"] = when_modified[:10]
                    
                    if update_data:
                        updates_needed.append({
                            "account_id": account_id,
                            "updates": update_data
                        })
                
                except Exception as e:
                    logger.warning(f"Error processing customer data for account {account.get('Id', 'unknown')}: {e}")
                    continue
            
            # Apply updates
            for update in updates_needed:
                try:
                    await salesforce.update_record(
                        "Account",
                        update["account_id"],
                        update["updates"]
                    )
                    logger.info(f"Updated financial data for account {update['account_id']}")
                except Exception as e:
                    logger.warning(f"Failed to update account {update['account_id']}: {e}")
            
            logger.info(f"Customer financial data sync completed. Updated {len(updates_needed)} accounts.")
            
        except Exception as e:
            logger.error(f"Error syncing customer data to Salesforce: {e}")
            raise

    async def handle_opportunity_stage_change(self, opportunity_id: str, new_stage: str, old_stage: str):
        """Handle opportunity stage changes for automated invoicing."""
        if not _intacct_auto_invoice_enabled():
            logger.info(
                "Skipping stage-change invoice trigger for %s — "
                "INTACCT_AUTO_INVOICE_ENABLED=false "
                "(F2 bundle not yet shipped — see tasks/f1-stage-buckets-plan.md)",
                opportunity_id,
            )
            return
        try:
            logger.info(f"Handling stage change for opportunity {opportunity_id}: {old_stage} -> {new_stage}")
            
            # Check if this stage change triggers invoicing
            if new_stage == "Closed Won" and old_stage != "Closed Won":
                # Opportunity just closed - trigger invoicing process
                salesforce = self.mcp_client.services["salesforce"]
                
                # Get opportunity details
                opp_result = await salesforce.get_record("Opportunity", opportunity_id)
                
                if opp_result:
                    await self.process_opportunity_for_invoicing(opp_result)
                    logger.info(f"Triggered invoicing for newly closed opportunity {opportunity_id}")
            
        except Exception as e:
            logger.error(f"Error handling opportunity stage change: {e}")

    def get_sync_history(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Get recent sync history."""
        return self.sync_history[-limit:] if self.sync_history else []

    def get_customer_mappings(self) -> Dict[str, str]:
        """Get current customer mappings."""
        return self.customer_mappings.copy()

    def get_opportunity_mappings(self) -> Dict[str, Dict[str, Any]]:
        """Get current opportunity-invoice mappings."""
        return self.opportunity_mappings.copy()

