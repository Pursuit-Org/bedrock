"""Email chains surface by their latest message (2026-10-20).

Covers the thread headline summary, Gmail thread parsing, the sync upsert /
cross-mailbox dedup, the feed's per-message payload, and the message index's
recipient handling. The last-activity SQL itself runs against Postgres and is
checked there; its Python wrappers are covered here.
"""

import base64
import json
import os
import sys
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import gmail_sync  # noqa: E402
from services.gmail_sync import summarize_thread_messages, _extract_thread_meta  # noqa: E402
from services.email_message_index import _recipients  # noqa: E402
from services.last_activity import last_activity_for_accounts, last_activity_for_contacts  # noqa: E402
from routes.activities import _strip_quoted_history, _thread_messages_for_response  # noqa: E402

ERICA = "Erica Wong <ericawong@pursuit.org>"
AVERY = "Avery Landrum <Avery.Landrum@dell.org>"
MAILSUITE = "Mailsuite Reminder <reminders@mailsuite.com>"


def _msg(frm, date, mid="m", snippet="", to="", cc="", labels=None, body=""):
    headers = [
        {"name": "From", "value": frm},
        {"name": "Date", "value": date},
        {"name": "Subject", "value": "Pursuit Concept Note Submission"},
    ]
    if to:
        headers.append({"name": "To", "value": to})
    if cc:
        headers.append({"name": "Cc", "value": cc})
    return {
        "id": mid,
        "labelIds": labels or ["INBOX"],
        "snippet": snippet,
        "payload": {
            "mimeType": "text/plain",
            "headers": headers,
            "body": {"data": base64.urlsafe_b64encode(body.encode()).decode()},
        },
    }


def _service_returning(thread):
    service = MagicMock()
    service.users.return_value.threads.return_value.get.return_value.execute.return_value = thread
    return service


# ── summarize_thread_messages ─────────────────────────────────────────────

class TestSummarizeThreadMessages:
    def test_latest_human_message_is_headline(self):
        msgs = [
            {"from": ERICA, "date": "Wed, 16 Sep 2026 14:23:15 -0400"},
            {"from": AVERY, "date": "Mon, 19 Oct 2026 15:35:53 +0000"},
            {"from": ERICA, "date": "Mon, 19 Oct 2026 12:00:54 -0400"},
        ]
        s = summarize_thread_messages(msgs)
        # 12:00:54 -0400 == 16:00:54Z, after Avery's 15:35:53Z
        assert s["last_message_at"] == datetime(2026, 10, 19, 16, 0, 54, tzinfo=timezone.utc)
        assert s["last_message_from"] == ERICA
        assert s["message_count"] == 3

    def test_automated_sender_never_headline_or_counted(self):
        msgs = [
            {"from": ERICA, "date": "Tue, 6 Oct 2026 11:59:08 -0400"},
            {"from": MAILSUITE, "date": "Thu, 08 Oct 2026 16:09:45 +0000"},
        ]
        s = summarize_thread_messages(msgs)
        assert s["last_message_from"] == ERICA
        assert s["message_count"] == 1

    def test_all_automated_falls_back_to_newest(self):
        msgs = [{"from": MAILSUITE, "date": "Thu, 08 Oct 2026 16:09:45 +0000"}]
        s = summarize_thread_messages(msgs)
        assert s["last_message_from"] == MAILSUITE
        assert s["message_count"] == 1

    def test_unparseable_dates_ignored(self):
        s = summarize_thread_messages([{"from": ERICA, "date": "not a date"}])
        assert s["last_message_at"] is None
        assert s["latest"] is None


# ── _extract_thread_meta ──────────────────────────────────────────────────

class TestExtractThreadMeta:
    def test_one_categorized_reply_does_not_drop_thread(self):
        thread = {"messages": [
            _msg(ERICA, "Wed, 16 Sep 2026 14:23:15 -0400", "m1"),
            _msg(AVERY, "Tue, 22 Sep 2026 15:11:26 +0000", "m2", labels=["CATEGORY_UPDATES"]),
        ]}
        meta = _extract_thread_meta(_service_returning(thread), "t1")
        assert meta is not None
        assert meta["message_count"] == 2

    def test_fully_categorized_thread_dropped(self):
        thread = {"messages": [
            _msg(ERICA, "Wed, 16 Sep 2026 14:23:15 -0400", "m1", labels=["CATEGORY_PROMOTIONS"]),
        ]}
        assert _extract_thread_meta(_service_returning(thread), "t1") is None

    def test_identity_from_first_message_headline_from_latest(self):
        thread = {"messages": [
            _msg(ERICA, "Wed, 16 Sep 2026 14:23:15 -0400", "m1", snippet="Avery, hope you're well"),
            _msg(AVERY, "Mon, 19 Oct 2026 15:35:53 +0000", "m2", snippet="Thanks Erica!"),
            _msg(MAILSUITE, "Tue, 20 Oct 2026 09:00:00 +0000", "m3", snippet="Reminder"),
        ]}
        meta = _extract_thread_meta(_service_returning(thread), "t1")
        assert meta["email_from"] == ERICA
        assert meta["date"] == datetime(2026, 9, 16, 18, 23, 15, tzinfo=timezone.utc)
        assert meta["snippet"] == "Thanks Erica!"
        assert meta["last_message_from"] == AVERY
        assert meta["last_message_at"] == datetime(2026, 10, 19, 15, 35, 53, tzinfo=timezone.utc)
        assert meta["message_count"] == 2

    def test_per_message_recipients_parsed(self):
        thread = {"messages": [
            _msg(ERICA, "Wed, 16 Sep 2026 14:23:15 -0400", "m1",
                 to='"Landrum, Avery" <Avery.Landrum@dell.org>',
                 cc="Nick <nick@pursuit.org>, roy.shamir@dell.org"),
        ]}
        meta = _extract_thread_meta(_service_returning(thread), "t1")
        m = meta["email_messages"][0]
        assert m["to"] == ["avery.landrum@dell.org"]
        assert m["cc"] == ["nick@pursuit.org", "roy.shamir@dell.org"]
        # Quoted display name with a comma no longer yields a bogus participant.
        assert set(meta["all_emails"]) == {
            "ericawong@pursuit.org", "avery.landrum@dell.org", "nick@pursuit.org", "roy.shamir@dell.org",
        }


# ── sync loop: upsert + cross-mailbox dedup + watermark ───────────────────

def _sync_fixture(monkeypatch, meta, dup_row=None, list_error=False):
    from googleapiclient.errors import HttpError

    service = MagicMock()
    lst = service.users.return_value.threads.return_value.list.return_value
    if list_error:
        lst.execute.side_effect = HttpError(MagicMock(status=500), b"boom")
    else:
        lst.execute.return_value = {"threads": [{"id": meta["thread_id"]}]}
    monkeypatch.setattr(gmail_sync, "_build_gmail_service", lambda _e: service)
    monkeypatch.setattr(gmail_sync, "_extract_thread_meta", lambda _s, _t: meta)
    monkeypatch.setattr(gmail_sync, "_resolve_emails_to_contacts",
                        AsyncMock(return_value=(["003Pa00001ANmNVIA1"], "0011U00000Dnw0bQAB")))
    monkeypatch.setattr(gmail_sync, "_get_watermark", AsyncMock(return_value=None))
    set_wm = AsyncMock()
    monkeypatch.setattr(gmail_sync, "_set_watermark", set_wm)
    import services.google_dwd as dwd
    monkeypatch.setattr(dwd, "is_dwd_configured", lambda: True)

    conn = MagicMock()
    conn.fetchrow = AsyncMock(return_value=dup_row)
    conn.execute = AsyncMock()
    return conn, set_wm


def _meta(count=3):
    return {
        "thread_id": "t1",
        "subject": "Pursuit Concept Note Submission",
        "email_from": ERICA,
        "all_emails": ["ericawong@pursuit.org", "avery.landrum@dell.org"],
        "snippet": "latest",
        "date": datetime(2026, 9, 16, 18, 23, 15, tzinfo=timezone.utc),
        "last_message_at": datetime(2026, 10, 19, 16, 0, 54, tzinfo=timezone.utc),
        "last_message_from": ERICA,
        "message_count": count,
        "email_body_text": "body",
        "email_messages": [{"message_id": "m1"}],
        "pending_attachments": [],
    }


class TestSyncLoop:
    @pytest.mark.asyncio
    async def test_upsert_writes_and_refreshes_recency(self, monkeypatch):
        conn, set_wm = _sync_fixture(monkeypatch, _meta())
        await gmail_sync.sync_gmail_for_staff(conn, "ericawong@pursuit.org")
        sql, *args = conn.execute.call_args.args
        assert "last_message_at   = EXCLUDED.last_message_at" in sql
        assert "message_count     = EXCLUDED.message_count" in sql
        assert args[-3:] == [_meta()["last_message_at"], ERICA, 3]
        set_wm.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_richer_copy_replaces_poorer_duplicate(self, monkeypatch):
        conn, _ = _sync_fixture(monkeypatch, _meta(count=5), dup_row={"id": "dup", "message_count": 2})
        await gmail_sync.sync_gmail_for_staff(conn, "ericawong@pursuit.org")
        sql, *args = conn.execute.call_args.args
        assert sql.strip().startswith("UPDATE bedrock.activity SET")
        assert args[0] == "dup"
        assert args[-1] == 5

    @pytest.mark.asyncio
    async def test_poorer_copy_is_skipped(self, monkeypatch):
        conn, _ = _sync_fixture(monkeypatch, _meta(count=2), dup_row={"id": "dup", "message_count": 5})
        await gmail_sync.sync_gmail_for_staff(conn, "ericawong@pursuit.org")
        conn.execute.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_failed_listing_does_not_advance_watermark(self, monkeypatch):
        conn, set_wm = _sync_fixture(monkeypatch, _meta(), list_error=True)
        result = await gmail_sync.sync_gmail_for_staff(conn, "ericawong@pursuit.org")
        assert result["errors"] == 1
        set_wm.assert_not_awaited()


# ── feed payload ──────────────────────────────────────────────────────────

class TestFeedPayload:
    def test_strips_on_wrote_quote(self):
        body = "Sounds great, talk Monday.\n\nOn Mon, Oct 19, 2026 at 11:35 AM Avery Landrum <\navery@dell.org> wrote:\n> earlier text"
        assert _strip_quoted_history(body) == "Sounds great, talk Monday."

    def test_strips_outlook_header_block(self):
        body = "Thanks!\n\nFrom: Erica Wong <ericawong@pursuit.org>\nSent: Monday\nSubject: x"
        assert _strip_quoted_history(body) == "Thanks!"

    def test_keeps_body_without_quote(self):
        assert _strip_quoted_history("Hi Avery,\nAttached.") == "Hi Avery,\nAttached."

    def test_messages_sorted_capped_newest_kept(self):
        raw = [{"message_id": f"m{i}", "from": ERICA,
                "date": f"Tue, {i + 1:02d} Sep 2026 10:00:00 +0000", "body_text": "x"}
               for i in range(25)]
        out = _thread_messages_for_response(json.dumps(list(reversed(raw))))
        assert len(out) == 20
        assert out[0]["message_id"] == "m5"
        assert out[-1]["message_id"] == "m24"
        assert out[-1]["sent_at"] == "2026-09-25T10:00:00+00:00"

    def test_automated_messages_dropped_unless_all_automated(self):
        raw = [
            {"message_id": "a", "from": ERICA, "date": "Tue, 6 Oct 2026 11:59:08 -0400"},
            {"message_id": "b", "from": MAILSUITE, "date": "Wed, 07 Oct 2026 15:59:09 +0000"},
        ]
        assert [m["message_id"] for m in _thread_messages_for_response(raw)] == ["a"]
        assert [m["message_id"] for m in _thread_messages_for_response(raw[1:])] == ["b"]

    def test_non_list_returns_none(self):
        assert _thread_messages_for_response(None) is None
        assert _thread_messages_for_response("not json") is None


# ── message index + last-activity wrappers ────────────────────────────────

class TestMessageIndexRecipients:
    def test_legacy_message_has_unknown_recipients(self):
        assert _recipients({"from": ERICA}) is None

    def test_recipients_merged_sorted_lowercased(self):
        assert _recipients({"to": ["B@x.org"], "cc": ["a@x.org", "b@x.org"]}) == ["a@x.org", "b@x.org"]

    def test_explicitly_empty_recipients(self):
        assert _recipients({"to": [], "cc": []}) == []


class TestLastActivityWrappers:
    @pytest.mark.asyncio
    async def test_contacts_flattens_email_pairs(self):
        conn = MagicMock()
        at = datetime(2026, 10, 19, tzinfo=timezone.utc)
        conn.fetchval = AsyncMock(return_value=2)  # migration applied
        conn.fetch = AsyncMock(return_value=[{"sfid": "003A", "last_at": at}, {"sfid": "003B", "last_at": None}])
        out = await last_activity_for_contacts(conn, [("003A", ["a@x.org", None, "b@x.org"]), ("003B", [None]), (None, ["z@x.org"])])
        _, sfids, emails = conn.fetch.call_args.args
        assert sfids == ["003A", "003A", "003B"]
        assert emails == ["a@x.org", "b@x.org", None]
        assert out == {"003A": at}

    @pytest.mark.asyncio
    async def test_empty_inputs_skip_query(self):
        conn = MagicMock()
        conn.fetch = AsyncMock()
        assert await last_activity_for_contacts(conn, []) == {}
        assert await last_activity_for_accounts(conn, [None, ""]) == {}
        conn.fetch.assert_not_awaited()


class TestBeforeMigration:
    @pytest.fixture(autouse=True)
    def _schema_missing(self, monkeypatch):
        import services.last_activity as la
        monkeypatch.setattr(la, "_schema_ready", False)

    @pytest.mark.asyncio
    async def test_last_activity_sql_drops_new_columns(self):
        conn = MagicMock()
        conn.fetchval = AsyncMock(return_value=0)
        conn.fetch = AsyncMock(return_value=[])
        await last_activity_for_accounts(conn, ["001A"])
        await last_activity_for_contacts(conn, [("003A", ["a@x.org"])])
        for call in conn.fetch.call_args_list:
            sql = call.args[0]
            assert "is_automated" not in sql
            assert "recipient_emails" not in sql
            assert "last_message_at" not in sql

    @pytest.mark.asyncio
    async def test_feed_cte_derives_recency_from_message_index(self):
        from routes.activities import _dedup_cte
        conn = MagicMock()
        conn.fetchval = AsyncMock(return_value=0)
        cte = await _dedup_cte(conn, "deleted_at IS NULL")
        assert "max(m.sent_at)" in cte and "AS last_message_at" in cte
        assert "message_count DESC" not in cte

    @pytest.mark.asyncio
    async def test_feed_cte_uses_columns_once_migrated(self):
        from routes.activities import _dedup_cte
        conn = MagicMock()
        conn.fetchval = AsyncMock(return_value=2)
        cte = await _dedup_cte(conn, "deleted_at IS NULL")
        assert "max(m.sent_at)" not in cte
        assert "message_count DESC NULLS LAST" in cte


def test_row_to_dict_derives_recency_when_columns_empty():
    from routes.activities import _row_to_dict
    msgs = [
        {"message_id": "a", "from": ERICA, "date": "Wed, 16 Sep 2026 14:23:15 -0400"},
        {"message_id": "b", "from": AVERY, "date": "Mon, 19 Oct 2026 15:35:53 +0000"},
        {"message_id": "c", "from": MAILSUITE, "date": "Tue, 20 Oct 2026 09:00:00 +0000"},
    ]
    d = _row_to_dict({"id": "x", "email_messages": json.dumps(msgs), "last_message_at": None})
    assert d["last_message_at"] == "2026-10-19T15:35:53+00:00"
    assert d["message_count"] == 2
    assert d["last_message_from"] == AVERY


def test_row_to_dict_prefers_newer_stored_messages_over_stale_column():
    from routes.activities import _row_to_dict
    msgs = [{"message_id": "b", "from": AVERY, "date": "Mon, 19 Oct 2026 15:35:53 +0000"}]
    stale = datetime(2026, 10, 14, 19, 52, 45, tzinfo=timezone.utc)
    d = _row_to_dict({"id": "x", "email_messages": json.dumps(msgs), "last_message_at": stale, "message_count": 1})
    assert d["last_message_at"] == "2026-10-19T15:35:53+00:00"
    newer = datetime(2026, 10, 21, tzinfo=timezone.utc)
    d = _row_to_dict({"id": "x", "email_messages": json.dumps(msgs), "last_message_at": newer, "message_count": 1})
    assert d["last_message_at"] == newer.isoformat()

