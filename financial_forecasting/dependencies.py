"""Shared FastAPI dependency functions.

Separated from main.py to avoid circular imports when route files
need to inject services via Depends().
"""

import asyncio
import logging
from typing import Any, Dict

from fastapi import HTTPException, Request

from mcp_client import UnifiedMCPClient
from data_sync import DataSyncService

logger = logging.getLogger(__name__)

# Service singletons — populated by main.py startup_event()
_services: Dict[str, Any] = {}

# Shared sync lock — used by background_sync_task, /api/sync/trigger,
# and /api/activities/sync/trigger to prevent concurrent syncs.
_sync_lock = asyncio.Lock()


class _PerRequestMCPClient(UnifiedMCPClient):
    """Request-scoped wrapper that overrides the Salesforce slot with a
    per-request service built from the caller's ``sf_tokens`` cookie.

    Fixes the singleton race where concurrent requests from different users
    would mutate ``base.services["salesforce"]`` in place and leak
    ``sf_client`` references across threads — User A's in-flight SOQL
    could execute against User B's session after a cookie swap, because
    ``SalesforceMCPService`` CRUD methods capture ``self`` (not
    ``self.sf_client`` by value) in the ``run_in_executor`` lambda.

    Intentionally does NOT call ``super().__init__()`` — that would reset
    the base class's services/clients/connected dicts. Instead we
    shallow-copy the base's three state containers at wrap time so any
    mutation a route handler might perform on ``self.services``,
    ``self.clients``, or ``self._connected_services`` stays request-scoped
    and never leaks back to the base singleton.

    The ``MCPClient`` and ``SalesforceMCPService`` instances inside those
    containers are still shared references — the isolation guarantee is at
    the container level (dict/list), not at the object level. For the SF
    slot specifically we swap in a per-request ``SalesforceMCPService``
    below, so SF CRUD on a wrapper touches no objects shared with the base
    singleton.

    All ``@property`` accessors on ``UnifiedMCPClient`` (``.salesforce``,
    ``.connected_services``, ``.get_service``, the other typed accessors)
    work unchanged because they read from the instance attributes this
    ``__init__`` populates.
    """

    def __init__(
        self,
        base: UnifiedMCPClient,
        sf_service: Any,  # SalesforceMCPService — kept Any to avoid a top-level import
    ) -> None:
        # All three containers are shallow-copied so no mutation via the
        # wrapper leaks back to the base singleton. The contained objects
        # (MCPClient instances, other service instances) are shared refs —
        # that's intentional, because a route handler shouldn't be
        # mutating those anyway; sharing is cheap and keeps behavior
        # transparent.
        self.clients = dict(base.clients)
        self.services = dict(base.services)
        self.services["salesforce"] = sf_service
        self._connected_services = list(base._connected_services)
        if "salesforce" not in self._connected_services:
            self._connected_services.append("salesforce")


def require_sf_mcp_client(request: Request) -> UnifiedMCPClient:
    """Like get_mcp_client, but raises 401 if the caller has no valid
    ``sf_tokens`` cookie.  Use on any route that reads or writes Salesforce
    data on behalf of a user — ensures the service-account fallback is never
    silently used for user-initiated requests.
    """
    sf_cookie = request.cookies.get("sf_tokens") if request else None
    if not sf_cookie:
        raise HTTPException(
            status_code=401,
            detail={
                "error": "sf_auth_required",
                "message": "Connect your Salesforce account in Settings to access this data.",
            },
        )
    try:
        from auth import decrypt_tokens
        tokens = decrypt_tokens(sf_cookie)
        if not (tokens and tokens.get("access_token") and tokens.get("instance_url")):
            raise HTTPException(
                status_code=401,
                detail={
                    "error": "sf_auth_required",
                    "message": "Salesforce session expired — reconnect in Settings.",
                },
            )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=401,
            detail={
                "error": "sf_auth_required",
                "message": "Salesforce authentication failed — reconnect in Settings.",
            },
        )
    client = get_mcp_client(request)
    if not isinstance(client, _PerRequestMCPClient):
        raise HTTPException(
            status_code=503,
            detail="Cannot initialize your Salesforce session — try again later",
        )
    return client


def get_mcp_client(request: Request = None) -> UnifiedMCPClient:
    """Get MCP client dependency.

    Per-request Salesforce behavior:

    - If the caller presents an ``sf_tokens`` cookie, build a fresh per-
      request ``SalesforceMCPService`` from those (freshly-decrypted)
      tokens and return a ``_PerRequestMCPClient`` wrapper. The base
      singleton is NOT mutated — this eliminates the cross-user race
      where one user's in-flight SOQL could execute under another user's
      session after a concurrent cookie swap.
    - If no cookie is present (or decryption fails), return the base
      client unchanged so the service-account SF wired at startup
      continues to serve internal callers (``forecasting_engine``,
      ``data_sync``, background tasks).
    """
    base = _services.get("mcp_client")
    if not base:
        raise HTTPException(status_code=503, detail="MCP client not initialized")

    sf_cookie = request.cookies.get("sf_tokens") if request else None
    if not sf_cookie:
        return base

    try:
        # Lazy imports: avoid pulling these at module load so tests that
        # stub ``_services["mcp_client"]`` don't need the full SF stack.
        from auth import decrypt_tokens
        from simple_salesforce import Salesforce
        from mcp_client.services.salesforce import SalesforceMCPService

        tokens = decrypt_tokens(sf_cookie)
        if not (tokens and tokens.get("access_token") and tokens.get("instance_url")):
            return base

        instance = tokens["instance_url"].replace("https://", "")
        sf_client = Salesforce(instance=instance, session_id=tokens["access_token"])

        # ``__new__`` skips ``SalesforceMCPService.__init__`` so we bypass
        # its credential-validation path — we're adopting an already-valid
        # session from the cookie, not authenticating via user/pass/OAuth.
        sf_service = SalesforceMCPService.__new__(SalesforceMCPService)
        sf_service.client = None
        sf_service._config = {}
        sf_service._authenticated = True
        sf_service.sf_client = sf_client
        sf_service._reauth_lock = asyncio.Lock()
        sf_service.username = None
        sf_service.password = None
        sf_service.security_token = None
        sf_service.client_id = None
        sf_service.client_secret = None
        sf_service.domain = None

        return _PerRequestMCPClient(base, sf_service)
    except Exception as e:
        logger.debug(f"Could not build per-request SF client: {e}")
        return base


def get_data_sync_service() -> DataSyncService:
    """Get data sync service dependency."""
    svc = _services.get("data_sync_service")
    if not svc:
        raise HTTPException(status_code=503, detail="Data sync service not available")
    return svc
