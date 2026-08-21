"""PostgreSQL connection pool for the Projects backend."""

import asyncio
import os
import logging
from pathlib import Path
from urllib.parse import urlparse

import asyncpg
from fastapi import HTTPException

logger = logging.getLogger(__name__)

_pool: asyncpg.Pool | None = None
_db_init_status: str = "not_started"

DB_DIR = Path(__file__).parent / "db"


def _log_connection_target(url: str) -> None:
    """Log the database connection target with password masked."""
    try:
        parsed = urlparse(url)
        masked = f"{parsed.scheme}://{parsed.username}:****@{parsed.hostname}:{parsed.port}{parsed.path}"
        logger.info(f"Connecting to: {masked}")
    except Exception:
        logger.info("Connecting to PostgreSQL (URL parse failed)")


async def init_db() -> None:
    """Create connection pool and run init.sql if tables don't exist.

    Pool creation and schema initialization are independent — if the pool
    connects but init.sql fails (permissions, already-applied DDL, etc.),
    the pool stays alive for queries.
    """
    global _pool, _db_init_status
    # DATABASE_URL is required in every environment. The prior localhost
    # fallback (`postgresql://bedrock@localhost:5432/bedrock`) caused a P0
    # data-drift incident on 2026-04-17: a dev session without DATABASE_URL
    # silently wrote to a local Postgres while teammates read from the shared
    # DB, producing goal-data that never reached production. Fail fast instead.
    # See tasks/notes-2026-04-17-jac-review.md and tasks/mvp-launch-sprint.md
    # item B1.
    DATABASE_URL = (os.getenv("DATABASE_URL") or "").strip()
    if not DATABASE_URL:
        logger.error(
            "DATABASE_URL is not set. Bedrock refuses to start without an "
            "explicit database URL to prevent silent writes to the wrong DB. "
            "Set DATABASE_URL in your environment (or .env) and restart. "
            "For local dev see DEV_SETUP_GUIDE.md."
        )
        _pool = None
        _db_init_status = "disconnected"
        return

    _log_connection_target(DATABASE_URL)

    # Step 1: Create connection pool.
    # Wrap in wait_for so an unreachable host (e.g. VPN down, remote DB
    # not accessible from dev laptop) fails in 10 s instead of waiting
    # for the OS TCP timeout (~75 s), which would stall the entire startup.
    try:
        _pool = await asyncio.wait_for(
            asyncpg.create_pool(
                DATABASE_URL,
                min_size=2,
                max_size=10,
                # Kill queries that hang >30 s — prevents pool exhaustion when a
                # single DB call blocks all 10 connections indefinitely.
                command_timeout=30,
            ),
            timeout=10,
        )
        logger.info("PostgreSQL pool created")
    except asyncio.TimeoutError:
        logger.warning(
            "PostgreSQL pool creation timed out (10 s) — DB unreachable, "
            "starting without DB (account statuses will be SF-only)"
        )
        _pool = None
        _db_init_status = "disconnected"
        return
    except Exception as e:
        logger.error(f"PostgreSQL pool creation failed: {e}")
        _pool = None
        _db_init_status = "disconnected"
        return

    # Step 2: Run schema init (pool stays alive even if this fails)
    try:
        init_sql = DB_DIR / "init.sql"
        if init_sql.exists():
            async with _pool.acquire() as conn:
                await conn.execute(init_sql.read_text())
            logger.info("Database schema initialized")
    except Exception as e:
        logger.warning(f"Schema init failed (pool kept alive): {e}")
        _db_init_status = "init_failed"

    # Step 3: Run seed data (idempotent — ON CONFLICT DO NOTHING)
    try:
        seed_sql = DB_DIR / "seed.sql"
        if seed_sql.exists():
            async with _pool.acquire() as conn:
                await conn.execute(seed_sql.read_text())
            logger.info("Seed data applied")
    except Exception as e:
        logger.warning(f"Seed data failed (pool kept alive): {e}")

    if _db_init_status != "init_failed":
        _db_init_status = "connected"

    # Step 4: Health check — verify public.org_users has the columns Bedrock
    # depends on for Phase B-2 (lazy auto-link in routes/permissions.py).
    # Non-fatal: logs a clear warning if the platform schema is missing or
    # doesn't have the expected columns. Local-dev databases without the
    # learning platform schema will see this warning, which is expected.
    try:
        async with _pool.acquire() as conn:
            row = await conn.fetchrow("""
                SELECT
                    bool_or(column_name = 'id') AS has_id,
                    bool_or(column_name = 'email') AS has_email,
                    bool_or(column_name = 'display_name') AS has_display_name,
                    bool_or(column_name = 'google_id') AS has_google_id
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'org_users'
            """)
            if row is None or not row["has_id"]:
                logger.warning(
                    "public.org_users not found — Bedrock identity unification (Phase B) "
                    "will be inactive. Local-dev DBs without the learning platform schema "
                    "can ignore this; production should investigate."
                )
            else:
                missing = [
                    col for col, present in (
                        ("id", row["has_id"]),
                        ("email", row["has_email"]),
                        ("display_name", row["has_display_name"]),
                        ("google_id", row["has_google_id"]),
                    ) if not present
                ]
                if missing:
                    logger.warning(
                        f"public.org_users exists but is missing expected column(s): {missing}. "
                        "Phase B-2 lazy auto-link may not work correctly. "
                        "Coordinate with the platform team."
                    )
                else:
                    logger.info("public.org_users schema OK — Phase B identity unification active")
    except Exception as e:
        logger.warning(f"public.org_users health check failed (continuing): {e}")


async def close_db() -> None:
    """Shut down the connection pool."""
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
        logger.info("PostgreSQL pool closed")


def get_pool() -> asyncpg.Pool:
    """Return the connection pool (for services that need direct access)."""
    if _pool is None:
        raise HTTPException(status_code=503, detail="Database not available — check server logs")
    return _pool


async def get_db() -> asyncpg.Connection:
    """FastAPI dependency — yields a connection from the pool."""
    if _pool is None:
        raise HTTPException(status_code=503, detail="Database not available — check server logs")
    # 10-second acquire timeout: if all 10 pool connections are busy we
    # return 503 immediately rather than queuing requests forever.
    try:
        async with _pool.acquire(timeout=10) as conn:
            yield conn
    except asyncpg.exceptions.TooManyConnectionsError:
        raise HTTPException(status_code=503, detail="Database connection pool exhausted — try again shortly")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database connection pool exhausted — try again shortly")


def get_db_status() -> str:
    """Return current database connection status for health reporting."""
    return _db_init_status
