"""PRO-98: the per-message email index stopped on 2026-09-24 and nobody knew.

Its nightly query died at the web pool's 30-second limit with an empty error
message, and the next night's 7-day window could never reach back to the gap.
"""
import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone

import pytest

from services import email_message_index as idx
from tests.jobs_fakes import FakeConn

NOW = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)

THREAD = {"id": "11111111-1111-1111-1111-111111111111", "email_messages": json.dumps([
    {"from": "Avni Nahar <avni@pursuit.org>", "date": "Wed, 23 Sep 2026 10:15:00 -0400",
     "message_id": "m1"},
    {"from": "Jo <jo@acme.com>", "date": "Thu, 24 Sep 2026 09:00:00 -0400", "message_id": "m2"},
    {"from": "", "date": "garbage", "message_id": "m3"},
])}


class TimedConn(FakeConn):
    """Records the timeout each statement ran under."""
    def __init__(self, **kw):
        super().__init__(**kw)
        self.timeouts = []

    async def fetch(self, query, *args, timeout=None):
        self.timeouts.append(timeout)
        return await super().fetch(query, *args)

    async def execute(self, query, *args, timeout=None):
        self.timeouts.append(timeout)
        await super().execute(query, *args)
        return "INSERT 0 2"


@pytest.mark.asyncio
async def test_refresh_runs_under_its_own_timeout_not_the_pools():
    conn = TimedConn(lists={"jsonb_array_length": [THREAD]})
    out = await idx.refresh_email_message_index(conn, days_back=7)
    assert conn.timeouts == [idx.REFRESH_TIMEOUT_SEC, idx.REFRESH_TIMEOUT_SEC]
    assert out == {"threads_scanned": 1, "messages_seen": 2, "inserted": 2, "unparseable": 1}
    _, args = next((c[1], c[2]) for c in conn.calls if c[0] == "execute")
    assert args[2] == ["avni@pursuit.org", "jo@acme.com"]


@pytest.mark.asyncio
async def test_refresh_reads_only_unindexed_threads_and_no_bodies():
    conn = TimedConn(lists={"jsonb_array_length": []})
    await idx.refresh_email_message_index(conn, days_back=7)
    q = conn.queries("fetch")[0]
    assert "jsonb_array_length(a.email_messages) >" in q          # something left to index
    assert "'from', m->>'from', 'date', m->>'date'" in q           # not body_text


@pytest.mark.asyncio
async def test_catch_up_reaches_back_to_when_the_index_last_grew():
    """The 7-day window alone never reaches a 12-day gap."""
    conn = TimedConn(lists={"jsonb_array_length": []})
    await idx.refresh_email_message_index(conn, days_back=7, catch_up=True)
    q = conn.queries("fetch")[0]
    assert "least(now() - ($1 || ' days')::interval" in q
    assert "ORDER BY id DESC LIMIT 1" in q


@pytest.mark.asyncio
async def test_backfill_has_no_window():
    conn = TimedConn(lists={"jsonb_array_length": []})
    await idx.refresh_email_message_index(conn, days_back=None)
    assert "synced_at" not in conn.queries("fetch")[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("indexed_ago,synced_ago,stale", [
    (timedelta(days=12), timedelta(hours=2), True),     # 9/24 → 10/6: what happened
    (timedelta(hours=20), timedelta(hours=1), False),   # a normal night
    (timedelta(days=3), timedelta(days=3), False),      # no new mail: quiet, not stale
])
async def test_index_health(indexed_ago, synced_ago, stale):
    conn = FakeConn(rows={"last_indexed_at": {"last_indexed_at": NOW - indexed_ago,
                                              "last_synced_at": NOW - synced_ago}})
    h = await idx.index_health(conn)
    assert h["stale"] is stale


@pytest.mark.asyncio
async def test_index_health_with_no_data_is_not_stale():
    h = await idx.index_health(FakeConn(rows={"last_indexed_at": {
        "last_indexed_at": None, "last_synced_at": None}}))
    assert h == {"last_indexed_at": None, "last_synced_at": None, "stale": False, "lag_hours": None}


@pytest.mark.asyncio
async def test_sync_names_a_failed_step_and_flags_a_stale_index(monkeypatch, caplog):
    """A timeout's str() is empty: the 10/3 log read "email message index
    failed: " and nothing else. The sync now logs the error's repr, and says
    in so many words when the index has fallen behind."""
    import services.activity_classifier as cls
    import services.builder_match as bm
    import services.calendar_sync as cal
    import services.candidate_pipeline as cp
    import services.domain_enrichment as de
    import services.gmail_sync as gm
    import services.google_dwd as dwd
    import services.jobs_activity_link as link
    from services.interaction_sync import run_interaction_sync

    async def ok(*a, **k):
        return {}

    async def timeout(*a, **k):
        raise asyncio.TimeoutError()

    async def stale(*a, **k):
        return {"stale": True, "last_indexed_at": "2026-09-24T09:16:59+00:00",
                "last_synced_at": "2026-10-06T10:34:45+00:00", "lag_hours": 289.3}

    monkeypatch.setattr(dwd, "is_dwd_configured", lambda: True)
    for mod, name in [(gm, "sync_gmail_for_staff"), (cal, "sync_calendar_for_staff"),
                      (de, "auto_enrich_domains"), (link, "relink_jobs_prospect_activity"),
                      (link, "auto_flag_jobs_prospects"), (link, "auto_advance_outreached"),
                      (cp, "resolve_and_queue_candidates"), (bm, "sweep_builder_candidates"),
                      (cls, "classify_new_activity")]:
        monkeypatch.setattr(mod, name, ok)
    monkeypatch.setattr(idx, "refresh_email_message_index", timeout)
    monkeypatch.setattr(idx, "index_health", stale)

    conn = FakeConn(lists={"sync_staff": [{"email": "avni@pursuit.org"}]})
    with caplog.at_level(logging.ERROR):
        out = await run_interaction_sync(conn)
    assert "email message index failed: TimeoutError()" in caplog.text
    assert "EMAIL MESSAGE INDEX STALE" in caplog.text
    assert out["email_index"]["stale"] is True


@pytest.mark.asyncio
async def test_sync_pool_falls_back_to_the_app_pool_without_a_database_url(monkeypatch):
    from services.interaction_sync import sync_pool
    monkeypatch.delenv("DATABASE_URL", raising=False)
    sentinel = object()
    async with sync_pool(fallback=sentinel) as pool:
        assert pool is sentinel
