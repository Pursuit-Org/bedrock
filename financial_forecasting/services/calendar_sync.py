"""Sync Google Calendar events for a single staff member into bedrock.activity.

For each staff email:
  1. Build impersonated DWD credentials
  2. Read watermark → compute timeMin
  3. Fetch events (90d back to now on first run; watermark to now after)
  4. Filter to events with at least one external (@not pursuit.org) attendee
  5. Resolve attendees → public.contacts + sf_contact_link
  6. Upsert bedrock.activity (ON CONFLICT source + source_thread_id)
  7. Update sync_watermark

source_thread_id for calendar = Google Calendar eventId.
"""

import logging
from datetime import datetime, timezone, timedelta
from typing import Any

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from services.google_dwd import get_dwd_credentials, CALENDAR_SCOPES
from services.org_domains import is_internal_email

logger = logging.getLogger(__name__)


def _build_calendar_service(staff_email: str):
    creds = get_dwd_credentials(staff_email, CALENDAR_SCOPES)
    return build("calendar", "v3", credentials=creds, cache_discovery=False)


async def _get_watermark(conn, staff_email: str) -> datetime | None:
    row = await conn.fetchrow(
        "SELECT last_synced_at FROM bedrock.sync_watermark "
        "WHERE staff_email = $1 AND source = 'calendar'",
        staff_email,
    )
    return row["last_synced_at"] if row else None


async def _set_watermark(conn, staff_email: str, count: int) -> None:
    await conn.execute(
        """
        INSERT INTO bedrock.sync_watermark (staff_email, source, last_synced_at, last_run_count)
        VALUES ($1, 'calendar', now(), $2)
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

    # Domain fallback: if no account resolved via contact, try email domain lookup
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


def _parse_event_datetime(dt_obj: dict) -> datetime:
    """Parse a Google Calendar dateTime or date object into a UTC datetime."""
    if "dateTime" in dt_obj:
        raw = dt_obj["dateTime"]
        try:
            dt = datetime.fromisoformat(raw)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
        except ValueError:
            pass
    if "date" in dt_obj:
        d = datetime.strptime(dt_obj["date"], "%Y-%m-%d")
        return d.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def _event_duration_minutes(start: datetime, end: datetime) -> int:
    delta = end - start
    return max(0, int(delta.total_seconds() / 60))


async def sync_calendar_for_staff(
    conn,
    staff_email: str,
    days_back: int = 90,
    override_since: datetime | None = None,
    override_until: datetime | None = None,
) -> dict:
    """Sync Calendar events for one staff member. Returns summary dict.

    override_since / override_until bypass the watermark for historical backfills.
    """
    from services.google_dwd import is_dwd_configured

    if not is_dwd_configured():
        return {"skipped": True, "reason": "DWD not configured"}

    service = _build_calendar_service(staff_email)

    backfill_mode = override_since is not None or override_until is not None
    now = datetime.now(timezone.utc)
    if backfill_mode:
        time_min = override_since or (now - timedelta(days=days_back))
        time_max = override_until or now
    else:
        watermark = await _get_watermark(conn, staff_email)
        time_min = watermark if watermark else now - timedelta(days=days_back)
        time_max = now  # past meetings only — future events may be cancelled/moved

    upserted = 0
    errors = 0
    page_token = None

    while True:
        try:
            kwargs: dict[str, Any] = {
                "calendarId": "primary",
                "timeMin": time_min.isoformat(),
                "timeMax": time_max.isoformat(),
                "singleEvents": True,
                "orderBy": "startTime",
                "maxResults": 250,
            }
            if page_token:
                kwargs["pageToken"] = page_token
            result = service.events().list(**kwargs).execute()
        except HttpError as e:
            logger.error("calendar list events error for %s: %s", staff_email, e)
            errors += 1
            break

        events = result.get("items", [])
        for event in events:
            # Skip cancelled events
            if event.get("status") == "cancelled":
                continue

            attendees = event.get("attendees", [])
            all_emails = [
                a["email"].lower()
                for a in attendees
                if a.get("email")
                and a.get("responseStatus") != "declined"
                and "resource.calendar.google.com" not in a.get("email", "")
                and "groups.outlook.com" not in a.get("email", "")
            ]
            external_emails = [e for e in all_emails if not is_internal_email(e)]

            # Skip internal-only meetings
            if not external_emails:
                continue

            start_dt = _parse_event_datetime(event.get("start", {}))
            end_dt = _parse_event_datetime(event.get("end", {}))
            duration = _event_duration_minutes(start_dt, end_dt)

            contact_ids, account_id = await _resolve_emails_to_contacts(conn, external_emails)

            attendees_json = [
                {
                    "email": a.get("email", ""),
                    "name": a.get("displayName", ""),
                    "response": a.get("responseStatus", ""),
                }
                for a in attendees
            ]

            try:
                await conn.execute(
                    """
                    INSERT INTO bedrock.activity (
                        type, subject, description, activity_date,
                        source, source_thread_id,
                        meeting_duration_minutes, meeting_attendees, meeting_location,
                        contact_ids, account_id,
                        logged_by
                    ) VALUES (
                        'meeting', $1, $2, $3,
                        'calendar-sync', $4,
                        $5, $6::jsonb, $7,
                        $8, $9,
                        $10
                    )
                    ON CONFLICT (source, source_thread_id)
                    WHERE source_thread_id IS NOT NULL
                    DO UPDATE SET
                        subject                  = EXCLUDED.subject,
                        description              = EXCLUDED.description,
                        meeting_duration_minutes = EXCLUDED.meeting_duration_minutes,
                        meeting_attendees        = EXCLUDED.meeting_attendees,
                        contact_ids              = EXCLUDED.contact_ids,
                        account_id               = COALESCE(EXCLUDED.account_id, bedrock.activity.account_id),
                        synced_at                = now()
                    """,
                    event.get("summary", "(no title)"),
                    event.get("description", ""),
                    start_dt,
                    event["id"],
                    duration,
                    __import__("json").dumps(attendees_json),
                    event.get("location", ""),
                    contact_ids,
                    account_id,
                    staff_email,
                )
                upserted += 1
            except Exception as e:
                logger.warning("activity upsert failed for event %s: %s", event.get("id"), e)
                errors += 1

        page_token = result.get("nextPageToken")
        if not page_token:
            break

    if not backfill_mode:
        await _set_watermark(conn, staff_email, upserted)
    logger.info("calendar sync %s: upserted=%d errors=%d", staff_email, upserted, errors)
    return {"staff_email": staff_email, "upserted": upserted, "errors": errors}
