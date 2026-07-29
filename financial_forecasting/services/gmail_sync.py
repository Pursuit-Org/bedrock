"""Sync Gmail threads for a single staff member into bedrock.activity.

For each staff email:
  1. Build impersonated DWD credentials
  2. Read watermark → compute 'after:' date
  3. Search threads (skip internal @pursuit.org-only threads)
  4. Resolve participant emails → public.contacts + sf_contact_link
  5. Fetch full message bodies + download attachments → GCS
  6. Upsert bedrock.activity (ON CONFLICT source + source_thread_id)
  7. Update sync_watermark

Requires GOOGLE_SERVICE_ACCOUNT_JSON env var (see google_dwd.py).
Attachments stored in GCS bucket: bedrock-email-content
"""

import asyncio
import base64
import json
import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Any

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from services.google_dwd import get_dwd_credentials, GMAIL_SCOPES
from services.org_domains import is_internal_email

logger = logging.getLogger(__name__)

GCS_BUCKET = "bedrock-email-content"
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024  # skip attachments > 25 MB

AUTOMATED_SENDER_DOMAINS = {
    "zoom.us", "zoomgov.com",
    "fireflies.ai",
    "otter.ai",
    "loom.com",
    "whereby.com",
    "webex.com",
    "gotomeeting.com",
    "calendly.com",
    "hubspotlinks.com",
    "chilipiper.com",
    "savvycal.com",
    "linkedin.com", "linkedin.co.uk",
    "twitter.com", "x.com",
    "facebook.com", "facebookmail.com",
    "instagram.com",
    "docusign.com", "docusign.net",
    "hellosign.com",
    "pandadoc.com",
    "slack.com", "slackb.com",
    "asana.com",
    "monday.com",
    "notion.so",
    "airtable.com",
    "jira.atlassian.com",
    "github.com", "githubusercontent.com",
}


def _is_automated_sender(from_header: str) -> bool:
    if not from_header:
        return False
    addr = from_header.lower()
    if "<" in addr:
        addr = addr.split("<")[-1].strip("> ")
    local = addr.split("@")[0] if "@" in addr else addr
    if any(pat in local for pat in ("noreply", "no-reply", "donotreply", "do-not-reply",
                                    "notification", "automated", "mailer", "bounce",
                                    "postmaster", "newsletter", "support+", "alert")):
        return True
    domain = addr.split("@")[-1] if "@" in addr else ""
    return domain in AUTOMATED_SENDER_DOMAINS


def _build_gmail_service(staff_email: str):
    creds = get_dwd_credentials(staff_email, GMAIL_SCOPES)
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def _get_gcs_client():
    """Build a GCS client from the DWD service account JSON."""
    from google.cloud import storage
    from google.oauth2 import service_account as sa
    key_json = base64.b64decode(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])
    info = json.loads(key_json)
    creds = sa.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/devstorage.read_write"]
    )
    return storage.Client(credentials=creds, project=info.get("project_id"))


_gcs_client = None


def _gcs() -> Any:
    global _gcs_client
    if _gcs_client is None:
        _gcs_client = _get_gcs_client()
    return _gcs_client


def _parse_body(payload: dict) -> tuple[str, str]:
    """Recursively extract text/plain and text/html from a MIME payload."""
    body_text = ""
    body_html = ""
    mime_type = payload.get("mimeType", "")

    if mime_type == "text/plain":
        data = payload.get("body", {}).get("data", "")
        if data:
            body_text = base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
    elif mime_type == "text/html":
        data = payload.get("body", {}).get("data", "")
        if data:
            body_html = base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
    elif "parts" in payload:
        for part in payload["parts"]:
            t, h = _parse_body(part)
            body_text += t
            body_html += h

    return body_text, body_html


def _parse_attachment_meta(payload: dict, results: list | None = None) -> list[dict]:
    """Recursively collect attachment metadata from a MIME payload."""
    if results is None:
        results = []
    filename = payload.get("filename", "")
    body = payload.get("body", {})
    attachment_id = body.get("attachmentId")
    if filename and attachment_id:
        results.append({
            "filename": filename,
            "mime_type": payload.get("mimeType", "application/octet-stream"),
            "size_bytes": body.get("size", 0),
            "attachment_id": attachment_id,
        })
    for part in payload.get("parts", []):
        _parse_attachment_meta(part, results)
    return results


def _upload_attachment(service, message_id: str, att: dict, staff_email: str, thread_id: str) -> str | None:
    """Download attachment from Gmail and upload to GCS. Returns GCS public path or None."""
    if att["size_bytes"] > MAX_ATTACHMENT_BYTES:
        logger.debug("skipping large attachment %s (%d bytes)", att["filename"], att["size_bytes"])
        return None
    try:
        result = service.users().messages().attachments().get(
            userId="me", messageId=message_id, id=att["attachment_id"]
        ).execute()
        data = base64.urlsafe_b64decode(result.get("data", "") + "==")
    except HttpError as e:
        logger.warning("attachment download failed %s/%s: %s", message_id, att["filename"], e)
        return None

    blob_path = f"{staff_email}/{thread_id}/{message_id}/{att['filename']}"
    try:
        bucket = _gcs().bucket(GCS_BUCKET)
        blob = bucket.blob(blob_path)
        blob.upload_from_string(data, content_type=att["mime_type"])
        return f"gs://{GCS_BUCKET}/{blob_path}"
    except Exception as e:
        logger.warning("GCS upload failed for %s: %s", blob_path, e)
        return None


async def _get_watermark(conn, staff_email: str) -> datetime | None:
    row = await conn.fetchrow(
        "SELECT last_synced_at FROM bedrock.sync_watermark "
        "WHERE staff_email = $1 AND source = 'gmail'",
        staff_email,
    )
    return row["last_synced_at"] if row else None


async def _set_watermark(conn, staff_email: str, count: int) -> None:
    await conn.execute(
        """
        INSERT INTO bedrock.sync_watermark (staff_email, source, last_synced_at, last_run_count)
        VALUES ($1, 'gmail', now(), $2)
        ON CONFLICT (staff_email, source) DO UPDATE
          SET last_synced_at = now(), last_run_count = $2
        """,
        staff_email,
        count,
    )


async def _resolve_emails_to_contacts(
    conn, emails: list[str]
) -> tuple[list[str], str | None]:
    if not emails:
        return [], None

    external = [e.lower() for e in emails if not is_internal_email(e)]
    if not external:
        return [], None

    rows = await conn.fetch(
        """
        SELECT scl.sf_contact_id, scl.sf_account_id
        FROM public.contacts c
        JOIN bedrock.sf_contact_link scl ON scl.public_contact_id = c.contact_id
        WHERE lower(c.email) = ANY($1::text[])
          AND scl.public_contact_id IS NOT NULL
        """,
        external,
    )
    contact_ids = [r["sf_contact_id"] for r in rows]
    account_id = next((r["sf_account_id"] for r in rows if r["sf_account_id"]), None)

    if account_id is None:
        domains = list({e.split("@")[-1] for e in external if "@" in e})
        if domains:
            domain_row = await conn.fetchrow(
                "SELECT sf_account_id FROM bedrock.account_email_domain WHERE domain = ANY($1::text[]) LIMIT 1",
                domains,
            )
            if domain_row:
                account_id = domain_row["sf_account_id"]

    return contact_ids, account_id


SKIP_LABELS = {"CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"}

# Calendar workflow and OOO auto-replies — auto-generated by Gmail/Google Calendar.
SKIP_SUBJECT_PREFIXES = (
    "accepted: ",
    "declined: ",
    "tentatively accepted: ",
    "invitation: ",
    "updated invitation: ",
    "automatic reply: ",
    "auto-reply: ",
    "auto reply: ",
)


def _extract_thread_meta(service, thread_id: str) -> dict[str, Any] | None:
    """Fetch full thread — bodies, attachment metadata, participants.

    Attachment files are NOT downloaded here; that happens after filtering
    in sync_gmail_for_staff so we don't fetch content for skipped threads.
    """
    try:
        thread = service.users().threads().get(
            userId="me",
            id=thread_id,
            format="full",
        ).execute()
    except HttpError as e:
        logger.warning("gmail thread %s fetch error: %s", thread_id, e)
        return None

    all_labels: set[str] = set()
    for msg in thread.get("messages", []):
        all_labels.update(msg.get("labelIds", []))
    if all_labels & SKIP_LABELS:
        return None

    messages = thread.get("messages", [])
    if not messages:
        return None

    first = messages[0]
    headers = {h["name"].lower(): h["value"] for h in first.get("payload", {}).get("headers", [])}

    # Skip calendar workflow and auto-reply emails
    subject = headers.get("subject", "")
    if subject.lower().startswith(SKIP_SUBJECT_PREFIXES):
        return None

    # Noise email suffixes — distro lists and room resources that can't map to contacts
    _NOISE_EMAIL_SUFFIXES = ("groups.outlook.com", "resource.calendar.google.com")

    # Collect all participant emails across all messages
    all_emails: set[str] = set()
    for msg in messages:
        for h in msg.get("payload", {}).get("headers", []):
            if h["name"].lower() in ("from", "to", "cc"):
                for part in h["value"].split(","):
                    part = part.strip()
                    if "@" in part:
                        email = part.split("<")[-1].strip("> ")
                        if email and not any(email.endswith(sfx) for sfx in _NOISE_EMAIL_SUFFIXES):
                            all_emails.add(email.lower())

    # Parse date from first message
    date_str = headers.get("date", "")
    try:
        from email.utils import parsedate_to_datetime
        date = parsedate_to_datetime(date_str).astimezone(timezone.utc)
    except Exception:
        date = datetime.now(timezone.utc)

    # Build per-message body text and attachment metadata (no downloads yet)
    email_messages = []
    pending_attachments = []  # [{...meta, message_id}] — downloaded later
    all_body_text_parts = []

    for msg in messages:
        payload = msg.get("payload", {})
        msg_headers = {h["name"].lower(): h["value"] for h in payload.get("headers", [])}
        body_text, _ = _parse_body(payload)
        att_meta = _parse_attachment_meta(payload)

        email_messages.append({
            "message_id": msg["id"],
            "from": msg_headers.get("from", ""),
            "date": msg_headers.get("date", ""),
            "body_text": body_text.strip(),
            "attachment_count": len(att_meta),
        })

        if body_text.strip():
            all_body_text_parts.append(body_text.strip())

        for att in att_meta:
            att["message_id"] = msg["id"]
            pending_attachments.append(att)

    return {
        "thread_id": thread_id,
        "subject": headers.get("subject", "(no subject)"),
        "email_from": headers.get("from", ""),
        "all_emails": list(all_emails),
        "snippet": first.get("snippet", "")[:500],
        "date": date,
        "email_body_text": "\n\n---\n\n".join(all_body_text_parts),
        "email_messages": email_messages,
        "pending_attachments": pending_attachments,
    }


async def sync_gmail_for_staff(
    conn,
    staff_email: str,
    days_back: int = 90,
    override_since: datetime | None = None,
    override_until: datetime | None = None,
) -> dict:
    """Sync Gmail threads for one staff member. Returns summary dict.

    override_since / override_until bypass the watermark for historical backfills.
    When both are set, the watermark is not read or written.
    """
    from services.google_dwd import is_dwd_configured

    if not is_dwd_configured():
        return {"skipped": True, "reason": "DWD not configured"}

    service = _build_gmail_service(staff_email)

    backfill_mode = override_since is not None or override_until is not None
    if backfill_mode:
        since = override_since or (datetime.now(timezone.utc) - timedelta(days=days_back))
    else:
        watermark = await _get_watermark(conn, staff_email)
        since = watermark if watermark else datetime.now(timezone.utc) - timedelta(days=days_back)

    date_str = since.strftime("%Y/%m/%d")
    # Capture BOTH received and sent mail. `in:inbox` alone missed pure outbound
    # (cold outreach that never got a reply lives only in Sent), so the jobs
    # team's outbound never reached bedrock.activity. Internal @pursuit-only
    # threads are still dropped downstream (see all_external filter), and
    # message-id dedup prevents an inbox+sent thread from double-inserting.
    query = f"after:{date_str} (in:inbox OR in:sent)"
    if override_until:
        query += f" before:{override_until.strftime('%Y/%m/%d')}"

    upserted = 0
    errors = 0
    page_token = None

    while True:
        try:
            kwargs: dict[str, Any] = {"userId": "me", "q": query, "maxResults": 100}
            if page_token:
                kwargs["pageToken"] = page_token
            result = service.users().threads().list(**kwargs).execute()
        except HttpError as e:
            logger.error("gmail list threads error for %s: %s", staff_email, e)
            errors += 1
            break

        threads = result.get("threads", [])
        for t in threads:
            meta = _extract_thread_meta(service, t["id"])
            if not meta:
                continue

            if _is_automated_sender(meta["email_from"]):
                continue

            all_external = [e for e in meta["all_emails"] if not is_internal_email(e)]
            if not all_external:
                continue

            real_external = [e for e in all_external if not _is_automated_sender(e)]
            if not real_external:
                continue

            # Download attachments now (after filtering — only for kept threads)
            attachments_out = []
            for att in meta.get("pending_attachments", []):
                gcs_url = _upload_attachment(
                    service, att["message_id"], att, staff_email, meta["thread_id"]
                )
                attachments_out.append({
                    "filename": att["filename"],
                    "mime_type": att["mime_type"],
                    "size_bytes": att["size_bytes"],
                    "message_id": att["message_id"],
                    "gcs_url": gcs_url,
                })

            contact_ids, account_id = await _resolve_emails_to_contacts(conn, real_external)

            # Cross-mailbox dedup: Gmail thread_id is per-mailbox, so the same
            # email synced from two staff inboxes carries different thread_ids and
            # the ON CONFLICT (source, source_thread_id) below never fires —
            # yielding one row per recipient mailbox. Guard on the email's stable
            # identity: subject + exact send timestamp + sender + recipient set
            # (sorted, since Gmail orders recipients differently per mailbox).
            # Body is deliberately EXCLUDED — per-mailbox copies of the same email
            # have cosmetically-different body_text (quoted history), so matching
            # on body would let the duplicates through. If an equivalent row
            # already exists from another thread/mailbox, skip.
            dup_id = await conn.fetchval(
                """
                SELECT id FROM bedrock.activity
                WHERE deleted_at IS NULL
                  AND source IN ('gmail-sync','calendar-sync')
                  AND source_thread_id IS DISTINCT FROM $3
                  AND subject IS NOT DISTINCT FROM $1
                  AND activity_date IS NOT DISTINCT FROM $2
                  AND email_from IS NOT DISTINCT FROM $4
                  AND array_to_string((SELECT array_agg(e ORDER BY e) FROM unnest(coalesce(email_to, ARRAY[]::text[])) e), ',')
                    = array_to_string((SELECT array_agg(e ORDER BY e) FROM unnest($5::text[]) e), ',')
                LIMIT 1
                """,
                meta["subject"], meta["date"], meta["thread_id"],
                meta["email_from"], real_external,
            )
            if dup_id is not None:
                upserted += 1
                continue

            # Deadlock-retry: the upsert races the live app's own writes to
            # bedrock.activity (seen ~1 per few thousand threads on the
            # historical backfill). Deadlocks are transient — retry once.
            for upsert_attempt in range(2):
              try:
                await conn.execute(
                    """
                    INSERT INTO bedrock.activity (
                        type, subject, activity_date,
                        source, source_thread_id,
                        email_from, email_to, email_snippet,
                        email_body_text, email_messages, attachments,
                        contact_ids, account_id,
                        logged_by
                    ) VALUES (
                        'email', $1, $2,
                        'gmail-sync', $3,
                        $4, $5, $6,
                        $7, $8, $9,
                        $10, $11,
                        $12
                    )
                    ON CONFLICT (source, source_thread_id)
                    WHERE source_thread_id IS NOT NULL
                    DO UPDATE SET
                        subject          = EXCLUDED.subject,
                        email_snippet    = EXCLUDED.email_snippet,
                        email_body_text  = EXCLUDED.email_body_text,
                        email_messages   = EXCLUDED.email_messages,
                        attachments      = EXCLUDED.attachments,
                        contact_ids      = EXCLUDED.contact_ids,
                        account_id       = COALESCE(EXCLUDED.account_id, bedrock.activity.account_id),
                        synced_at        = now()
                    """,
                    meta["subject"],
                    meta["date"],
                    meta["thread_id"],
                    meta["email_from"],
                    real_external,
                    meta["snippet"],
                    meta["email_body_text"] or None,
                    json.dumps(meta["email_messages"]) if meta["email_messages"] else None,
                    json.dumps(attachments_out) if attachments_out else None,
                    contact_ids,
                    account_id,
                    staff_email,
                )
                upserted += 1
                break
              except Exception as e:
                if upsert_attempt == 0 and "deadlock" in str(e).lower():
                    await asyncio.sleep(0.5)
                    continue
                logger.warning("activity upsert failed for thread %s: %s", meta["thread_id"], e)
                errors += 1
                break

        page_token = result.get("nextPageToken")
        if not page_token:
            break

    if not backfill_mode:
        await _set_watermark(conn, staff_email, upserted)
    logger.info("gmail sync %s: upserted=%d errors=%d", staff_email, upserted, errors)
    return {"staff_email": staff_email, "upserted": upserted, "errors": errors}
