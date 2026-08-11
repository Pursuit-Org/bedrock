"""Permission Profiles, User Roles & Opportunity Locking API."""

import json
import uuid
import logging
from typing import Optional, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth import require_auth, require_auth_or_internal, decrypt_tokens
from db import get_db
from security import validate_salesforce_id, escape_soql_string

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/permissions", tags=["permissions"])

# All permission keys — used for validation
PERMISSION_KEYS = [
    "view_opportunities", "edit_own_opportunities", "edit_all_opportunities",
    "create_opportunities", "bulk_update_opportunities", "lock_own_opportunities",
    "reassign_opportunities",
    "view_tasks", "edit_own_tasks", "edit_all_tasks", "create_tasks",
    "edit_accounts", "create_accounts", "edit_all_accounts", "reassign_accounts",
    "edit_contacts", "create_contacts",
    "edit_payments", "create_payments",
    "view_projects", "edit_projects",
    "view_revenue_dashboard", "view_cashflow_forecasts",
    "view_sage_invoices_payments", "create_sage_invoices",
    "match_invoices", "manage_payment_schedules", "generate_financial_reports",
    "use_pebble_chat", "use_pebble_research", "pebble_crm_write",
    "trigger_data_sync", "manage_users_roles", "edit_permission_profiles",
    "manage_owner_goals",
]


# ── Helpers ──


def _parse_perms(val) -> dict:
    """Safely parse permissions from JSONB — asyncpg may return str or dict."""
    if isinstance(val, dict):
        return val
    if isinstance(val, str):
        try:
            return json.loads(val)
        except (json.JSONDecodeError, TypeError) as e:
            logger.warning(f"Failed to parse permissions JSONB: {e}")
            return {}
    return {}


async def _ensure_org_user(email: str, name: str, db) -> Optional[Dict[str, Any]]:
    """Ensure a public.org_users row exists for this email. Creates if missing.

    Returns the org_users row dict, or None if the table doesn't exist (local dev).
    """
    try:
        row = await db.fetchrow(
            "SELECT id, sf_user_id, email, display_name AS name, "
            "COALESCE(is_active, true) AS is_active "
            "FROM public.org_users WHERE LOWER(email) = LOWER($1)",
            email,
        )
        if row:
            return dict(row)
        # Create org_users row (e.g. user who authenticated via SF but never via Google)
        row = await db.fetchrow(
            "INSERT INTO public.org_users (id, email, display_name) "
            "VALUES (uuid_generate_v4(), $1, $2) "
            "ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email "
            "RETURNING id, sf_user_id, email, display_name AS name, "
            "COALESCE(is_active, true) AS is_active",
            email, name or "",
        )
        if row:
            logger.info(f"Created public.org_users row for {email}")
            return dict(row)
    except Exception as e:
        logger.warning(f"_ensure_org_user failed for {email}: {e}")
    return None


async def record_bedrock_login(email: str, name: str, db) -> None:
    """Provision (if needed) an org_users row + user_config row and stamp
    user_config.last_login_at = now().

    Called from the Google OAuth callback so every successful login both
    creates the rows (no longer waiting on a permission check) and refreshes
    last_login_at — which the Users tab uses to distinguish people who have
    actually logged into Bedrock from rows created via SF sync only.
    """
    try:
        org = await _ensure_org_user(email, name, db)
        if not org or not org.get("id"):
            return
        org_user_id = org["id"]
        await db.execute(
            "INSERT INTO bedrock.user_config (org_user_id, last_login_at) "
            "VALUES ($1, now()) "
            "ON CONFLICT (org_user_id) DO UPDATE "
            "SET last_login_at = now(), updated_at = now()",
            org_user_id,
        )
    except Exception as e:
        logger.warning(f"record_bedrock_login failed for {email}: {e}")


async def get_user_permissions(email: str, db) -> Dict[str, Any]:
    """Get resolved permissions for a user. Auto-provisions if needed.

    Reads from public.org_users (canonical identity) + bedrock.user_config
    (app-specific permission profile). Auto-creates user_config with default
    profile on first Bedrock visit.
    """
    try:
        row = await db.fetchrow(
            "SELECT ou.id, ou.sf_user_id, ou.email, ou.display_name AS name, "
            "COALESCE(ou.is_active, true) AS is_active, "
            "uc.profile_id, "
            "pp.permissions, pp.name AS profile_name "
            "FROM public.org_users ou "
            "LEFT JOIN bedrock.user_config uc ON uc.org_user_id = ou.id "
            "LEFT JOIN bedrock.permission_profile pp ON pp.id = uc.profile_id "
            "WHERE LOWER(ou.email) = LOWER($1)",
            email,
        )
    except Exception:
        # Fallback for local dev without public.org_users
        row = None

    if row:
        result = dict(row)
        result["org_user_id"] = result["id"]  # canonical — org_users.id IS the user id
        if result.get("profile_id") is not None:
            # User has user_config — resolve permissions
            perms = _parse_perms(result.get("permissions"))
            if result.get("profile_name") == "Admin":
                for key in PERMISSION_KEYS:
                    perms.setdefault(key, True)
            result["permissions"] = perms
            return result
        # User exists in org_users but has no user_config — auto-provision
        config_count = await db.fetchval("SELECT COUNT(*) FROM bedrock.user_config")
        if config_count == 0:
            profile = await db.fetchrow(
                "SELECT id, permissions, name FROM bedrock.permission_profile WHERE name = 'Admin'"
            )
            if profile:
                logger.info(f"Bootstrap: first user {email} auto-assigned Admin profile")
        else:
            profile = await db.fetchrow(
                "SELECT id, permissions, name FROM bedrock.permission_profile WHERE is_default = true"
            )
        profile_id = profile["id"] if profile else None
        await db.execute(
            "INSERT INTO bedrock.user_config (org_user_id, profile_id) VALUES ($1, $2) "
            "ON CONFLICT (org_user_id) DO NOTHING",
            result["id"], profile_id,
        )
        perms = _parse_perms(profile["permissions"]) if profile else {}
        if profile and profile["name"] == "Admin":
            for key in PERMISSION_KEYS:
                perms.setdefault(key, True)
        result["permissions"] = perms
        result["profile_name"] = profile["name"] if profile else None
        result["profile_id"] = profile_id
        return result

    # No org_users row — create one and provision
    org_user = await _ensure_org_user(email, "", db)
    if not org_user:
        # Can't create org_users (local dev) — return minimal permissions
        return {"id": None, "email": email, "permissions": {}, "profile_name": None,
                "sf_user_id": None, "is_active": True, "name": "", "org_user_id": None}

    config_count = await db.fetchval("SELECT COUNT(*) FROM bedrock.user_config")
    if config_count == 0:
        profile = await db.fetchrow(
            "SELECT id, permissions, name FROM bedrock.permission_profile WHERE name = 'Admin'"
        )
        if profile:
            logger.info(f"Bootstrap: first user {email} auto-assigned Admin profile")
    else:
        profile = await db.fetchrow(
            "SELECT id, permissions, name FROM bedrock.permission_profile WHERE is_default = true"
        )
    profile_id = profile["id"] if profile else None
    await db.execute(
        "INSERT INTO bedrock.user_config (org_user_id, profile_id) VALUES ($1, $2) "
        "ON CONFLICT (org_user_id) DO NOTHING",
        org_user["id"], profile_id,
    )
    result = dict(org_user)
    result["org_user_id"] = result["id"]
    perms = _parse_perms(profile["permissions"]) if profile else {}
    if profile and profile["name"] == "Admin":
        for key in PERMISSION_KEYS:
            perms.setdefault(key, True)
    result["permissions"] = perms
    result["profile_name"] = profile["name"] if profile else None
    result["profile_id"] = profile_id
    return result


async def require_admin(user=Depends(require_auth), db=Depends(get_db)):
    """Require the user to have manage_users_roles permission."""
    user_data = await get_user_permissions(user.get("email", ""), db)
    perms = user_data.get("permissions") or {}
    if not perms.get("manage_users_roles", False):
        raise HTTPException(403, "Admin access required")
    return user


# System-level keys that only admins can toggle (escalation guard)
SYSTEM_KEYS = frozenset([
    "manage_users_roles", "edit_permission_profiles",
    "trigger_data_sync", "pebble_crm_write",
])


async def require_profile_editor(user=Depends(require_auth), db=Depends(get_db)):
    """Require edit_permission_profiles OR manage_users_roles."""
    user_data = await get_user_permissions(user.get("email", ""), db)
    perms = user_data.get("permissions") or {}
    if not (perms.get("edit_permission_profiles") or perms.get("manage_users_roles")):
        raise HTTPException(403, "Permission denied: edit_permission_profiles")
    user["_permissions"] = perms
    user["_app_user"] = user_data
    return user


def check_permission(permission_key: str):
    """FastAPI dependency factory — checks a specific permission."""
    async def _check(user=Depends(require_auth), db=Depends(get_db)):
        email = user.get("email", "")
        user_data = await get_user_permissions(email, db)
        perms = user_data.get("permissions") or {}
        if not perms.get(permission_key, False):
            raise HTTPException(403, f"Permission denied: {permission_key}")
        # Attach resolved permissions and user data to the user dict
        user["_permissions"] = perms
        user["_app_user"] = user_data
        return user
    return _check


def check_permission_or_internal(permission_key: str):
    """Like check_permission but also accepts internal API key (service-to-service).

    Used for endpoints that Pebble calls via X-Internal-Key header.
    Service accounts bypass the per-user permission check.
    User-initiated requests (JWT) still go through full permission resolution.
    """
    async def _check(user=Depends(require_auth_or_internal), db=Depends(get_db)):
        # Service accounts (internal API key) bypass permission checks
        if user.get("is_service"):
            return user
        email = user.get("email", "")
        user_data = await get_user_permissions(email, db)
        perms = user_data.get("permissions") or {}
        if not perms.get(permission_key, False):
            raise HTTPException(403, f"Permission denied: {permission_key}")
        user["_permissions"] = perms
        user["_app_user"] = user_data
        return user
    return _check


async def resolve_task_lock(task_id: str, user: dict, db, salesforce) -> dict:
    """Fetch task from Salesforce, check if its opportunity is locked, return decision.

    Queries Salesforce for the task's WhatId and OwnerId, then checks the
    opportunity_lock table. Fails closed (503) if Salesforce is unreachable.
    """
    try:
        safe_id = escape_soql_string(task_id)
        result = await salesforce.query(
            f"SELECT WhatId, OwnerId FROM Task WHERE Id = '{safe_id}'"
        )
    except Exception as e:
        logger.error(f"Cannot verify task lock status — Salesforce query failed: {e}")
        raise HTTPException(503, "Cannot verify lock status — try again later")

    records = result.get("records", [])
    what_id = records[0].get("WhatId") if records else None
    task_owner_id = records[0].get("OwnerId") if records else None

    if what_id:
        lock = await db.fetchrow(
            "SELECT locked_by FROM bedrock.opportunity_lock WHERE sf_opportunity_id = $1", what_id
        )
        if lock:
            perms = user.get("_permissions", {})
            sf_user_id = (user.get("_app_user") or {}).get("sf_user_id")
            return {
                "what_id": what_id,
                "task_owner_id": task_owner_id,
                "is_locked": True,
                "is_lock_owner": lock["locked_by"] == sf_user_id,
                "is_admin": perms.get("manage_users_roles", False),
                "is_task_owner": task_owner_id == sf_user_id,
            }

    return {
        "what_id": what_id,
        "task_owner_id": task_owner_id,
        "is_locked": False,
        "is_lock_owner": False,
        "is_admin": False,
        "is_task_owner": False,
    }


# ── My Permissions ──


@router.get("/me")
async def get_my_permissions(request: Request, user=Depends(require_auth), db=Depends(get_db)):
    """Get the current user's resolved permissions.

    Also backfills sf_user_id on org_users if missing (from SF OAuth cookie).
    """
    email = user.get("email", "")
    user_data = await get_user_permissions(email, db)
    uid = user_data.get("id")
    if uid:
        updates = {}
        # Backfill display_name from auth JWT
        auth_name = user.get("name", "")
        if not user_data.get("name") and auth_name:
            updates["display_name"] = auth_name
        # Backfill sf_user_id from Salesforce OAuth cookie
        if not user_data.get("sf_user_id"):
            sf_cookie = request.cookies.get("sf_tokens")
            if sf_cookie:
                tokens = decrypt_tokens(sf_cookie)
                if tokens and tokens.get("user_id"):
                    updates["sf_user_id"] = tokens["user_id"]
        # Apply backfill updates to org_users
        if updates:
            try:
                sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
                vals = [uid] + list(updates.values())
                await db.execute(f"UPDATE public.org_users SET {sets}, updated_at = now() WHERE id = $1", *vals)
                # Map display_name back to name for the response
                if "display_name" in updates:
                    user_data["name"] = updates["display_name"]
                if "sf_user_id" in updates:
                    user_data["sf_user_id"] = updates["sf_user_id"]
            except Exception as e:
                logger.debug(f"Could not backfill org_users fields for {email}: {e}")

    perms = user_data.get("permissions") or {}
    return {
        "success": True,
        "data": {
            "user_id": str(user_data.get("id", "")),
            "email": user_data.get("email"),
            "name": user_data.get("name"),
            "sf_user_id": user_data.get("sf_user_id"),
            "profile_name": user_data.get("profile_name"),
            "is_active": user_data.get("is_active", True),
            "org_user_id": str(uid) if uid else None,
            "permissions": {k: perms.get(k, False) for k in PERMISSION_KEYS},
        },
    }


# ── Identity audit (Phase B-4 of Claim 3) ──


@router.get("/admin/identity-audit")
async def identity_audit(user=Depends(require_admin), db=Depends(get_db)):
    """Audit staff identity health: org_users with/without Bedrock user_config.

    Returns:
        - summary: total org_users, provisioned (have user_config), unprovisioned
        - unprovisioned: org_users rows without a user_config entry
    """
    try:
        rows = await db.fetch("""
            SELECT
                ou.id,
                ou.email,
                ou.display_name AS name,
                COALESCE(ou.is_active, true) AS is_active,
                ou.sf_user_id,
                uc.profile_id,
                pp.name AS profile_name
            FROM public.org_users ou
            LEFT JOIN bedrock.user_config uc ON uc.org_user_id = ou.id
            LEFT JOIN bedrock.permission_profile pp ON pp.id = uc.profile_id
            ORDER BY (uc.org_user_id IS NULL) DESC, ou.email
        """)
    except Exception as e:
        logger.warning(f"identity_audit: query failed: {e}")
        return {"success": True, "data": {"summary": {"total": 0, "provisioned": 0, "unprovisioned": 0}, "unprovisioned": []}}

    def _serialize(r):
        d = dict(r)
        if d.get("id") is not None:
            d["id"] = str(d["id"])
        if d.get("profile_id") is not None:
            d["profile_id"] = str(d["profile_id"])
        return d

    serialized = [_serialize(r) for r in rows]
    provisioned = [r for r in serialized if r.get("profile_id") is not None]
    unprovisioned = [r for r in serialized if r.get("profile_id") is None]

    return {
        "success": True,
        "data": {
            "summary": {
                "total": len(serialized),
                "provisioned": len(provisioned),
                "unprovisioned": len(unprovisioned),
            },
            "unprovisioned": unprovisioned,
        },
    }


# ── Internal (service-to-service) ──


@router.get("/internal/{email}")
async def internal_get_permissions(
    email: str, user=Depends(require_auth_or_internal), db=Depends(get_db)
):
    """Internal endpoint for Pebble to check user permissions.

    Protected by X-Internal-Key (service-to-service auth).
    User-initiated requests (JWT) also work for debugging.
    """
    user_data = await get_user_permissions(email, db)
    perms = user_data.get("permissions") or {}
    return {"email": email, "permissions": {k: perms.get(k, False) for k in PERMISSION_KEYS}}


# ── Profile CRUD ──


class ProfileCreate(BaseModel):
    name: str
    description: str = ""
    is_default: bool = False
    permissions: Dict[str, bool] = {}


class ProfileUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_default: Optional[bool] = None
    permissions: Optional[Dict[str, bool]] = None


@router.get("/profiles")
async def list_profiles(user=Depends(require_auth), db=Depends(get_db)):
    """List all permission profiles."""
    rows = await db.fetch(
        "SELECT id, name, description, is_default, permissions, created_at "
        "FROM bedrock.permission_profile ORDER BY name"
    )
    return {"success": True, "data": [dict(r) for r in rows]}


@router.get("/profiles/{profile_id}")
async def get_profile(profile_id: str, user=Depends(require_auth), db=Depends(get_db)):
    """Get a single permission profile."""
    pid = uuid.UUID(profile_id)
    row = await db.fetchrow("SELECT * FROM bedrock.permission_profile WHERE id = $1", pid)
    if not row:
        raise HTTPException(404, "Profile not found")
    return {"success": True, "data": dict(row)}


@router.post("/profiles")
async def create_profile(body: ProfileCreate, user=Depends(require_admin), db=Depends(get_db)):
    """Create a new permission profile."""
    # Validate permission keys
    clean_perms = {k: body.permissions.get(k, False) for k in PERMISSION_KEYS}
    # If setting as default, unset other defaults
    if body.is_default:
        await db.execute("UPDATE bedrock.permission_profile SET is_default = false WHERE is_default = true")
    row = await db.fetchrow(
        "INSERT INTO bedrock.permission_profile (name, description, is_default, permissions) "
        "VALUES ($1, $2, $3, $4) RETURNING *",
        body.name, body.description, body.is_default, clean_perms,
    )
    return {"success": True, "data": dict(row)}


@router.put("/profiles/{profile_id}")
async def update_profile(
    profile_id: str, body: ProfileUpdate, user=Depends(require_profile_editor), db=Depends(get_db)
):
    """Update a permission profile. Admins can edit all keys; profile editors cannot toggle system keys."""
    pid = uuid.UUID(profile_id)
    existing = await db.fetchrow("SELECT * FROM bedrock.permission_profile WHERE id = $1", pid)
    if not existing:
        raise HTTPException(404, "Profile not found")
    updates = {}
    if body.name is not None:
        updates["name"] = body.name
    if body.description is not None:
        updates["description"] = body.description
    if body.is_default is not None:
        if body.is_default:
            await db.execute("UPDATE bedrock.permission_profile SET is_default = false WHERE is_default = true")
        updates["is_default"] = body.is_default
    if body.permissions is not None:
        clean_perms = {k: body.permissions.get(k, False) for k in PERMISSION_KEYS}
        # Escalation guard: non-admins cannot toggle system-level keys.
        # Preserve existing DB values for those keys regardless of what the client sends.
        caller_perms = user.get("_permissions", {})
        if not caller_perms.get("manage_users_roles"):
            existing_perms = _parse_perms(existing["permissions"])
            for key in SYSTEM_KEYS:
                clean_perms[key] = existing_perms.get(key, False)
        updates["permissions"] = clean_perms
    if not updates:
        return {"success": True, "data": dict(existing)}
    sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
    vals = [pid] + list(updates.values())
    await db.execute(f"UPDATE bedrock.permission_profile SET {sets}, updated_at = now() WHERE id = $1", *vals)
    row = await db.fetchrow("SELECT * FROM bedrock.permission_profile WHERE id = $1", pid)
    return {"success": True, "data": dict(row)}


@router.delete("/profiles/{profile_id}")
async def delete_profile(profile_id: str, user=Depends(require_admin), db=Depends(get_db)):
    """Delete a permission profile. Fails if users are assigned to it."""
    pid = uuid.UUID(profile_id)
    count = await db.fetchval("SELECT COUNT(*) FROM bedrock.user_config WHERE profile_id = $1", pid)
    if count > 0:
        raise HTTPException(
            400, f"Cannot delete: {count} user(s) are assigned to this profile. Reassign them first."
        )
    result = await db.execute("DELETE FROM bedrock.permission_profile WHERE id = $1", pid)
    if result == "DELETE 0":
        raise HTTPException(404, "Profile not found")
    return {"success": True, "data": {"message": "Profile deleted"}}


# ── User Management ──


@router.get("/users")
async def list_users(
    include_never_logged_in: bool = False,
    user=Depends(require_admin),
    db=Depends(get_db),
):
    """List Bedrock users with their permission profiles.

    Default (`include_never_logged_in=false`) returns only users with a
    non-null `last_login_at` — i.e. people who have actually signed into
    Bedrock at least once. Pass `?include_never_logged_in=true` to also
    show rows provisioned via SF sync but never logged in (useful for
    pre-assigning permissions).
    """
    where_clause = "" if include_never_logged_in else "WHERE uc.last_login_at IS NOT NULL "
    rows = await db.fetch(
        "SELECT ou.id, ou.sf_user_id, ou.email, ou.display_name AS name, "
        "COALESCE(ou.is_active, true) AS is_active, uc.last_login_at, "
        "uc.profile_id, pp.name AS profile_name "
        "FROM public.org_users ou "
        "LEFT JOIN bedrock.user_config uc ON uc.org_user_id = ou.id "
        "LEFT JOIN bedrock.permission_profile pp ON pp.id = uc.profile_id "
        f"{where_clause}"
        "ORDER BY ou.display_name, ou.email"
    )
    return {"success": True, "data": [dict(r) for r in rows]}


class UserUpdate(BaseModel):
    profile_id: Optional[str] = None
    sf_user_id: Optional[str] = None
    name: Optional[str] = None
    is_active: Optional[bool] = None


@router.put("/users/{user_id}")
async def update_user(user_id: str, body: UserUpdate, user=Depends(require_admin), db=Depends(get_db)):
    """Update a user's profile, SF user ID, name, or active status.

    Uses LEFT JOIN + UPSERT so admins can assign a profile even to a
    user that has no bedrock.user_config row yet (e.g. provisioned via
    SF sync but never logged into Bedrock).
    """
    uid = uuid.UUID(user_id)
    existing = await db.fetchrow(
        "SELECT ou.id, ou.sf_user_id, ou.email, ou.display_name AS name, "
        "COALESCE(ou.is_active, true) AS is_active, uc.profile_id "
        "FROM public.org_users ou "
        "LEFT JOIN bedrock.user_config uc ON uc.org_user_id = ou.id "
        "WHERE ou.id = $1", uid
    )
    if not existing:
        raise HTTPException(404, "User not found")

    # Split updates between org_users and user_config
    org_updates = {}
    config_profile_id = None
    if body.sf_user_id is not None:
        org_updates["sf_user_id"] = body.sf_user_id
    if body.name is not None:
        org_updates["display_name"] = body.name
    if body.is_active is not None:
        org_updates["is_active"] = body.is_active
    if body.profile_id is not None:
        config_profile_id = uuid.UUID(body.profile_id)

    if not org_updates and config_profile_id is None:
        return {"success": True, "data": dict(existing)}

    if org_updates:
        try:
            sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(org_updates))
            vals = [uid] + list(org_updates.values())
            await db.execute(f"UPDATE public.org_users SET {sets}, updated_at = now() WHERE id = $1", *vals)
        except Exception as e:
            logger.warning(f"Failed to update org_users for {uid}: {e}")
            raise HTTPException(500, "Failed to update user identity fields")

    if config_profile_id is not None:
        # UPSERT — works whether or not the user already has a user_config row.
        await db.execute(
            "INSERT INTO bedrock.user_config (org_user_id, profile_id) "
            "VALUES ($1, $2) "
            "ON CONFLICT (org_user_id) DO UPDATE "
            "SET profile_id = EXCLUDED.profile_id, updated_at = now()",
            uid, config_profile_id,
        )

    row = await db.fetchrow(
        "SELECT ou.id, ou.sf_user_id, ou.email, ou.display_name AS name, "
        "COALESCE(ou.is_active, true) AS is_active, uc.profile_id, "
        "pp.name AS profile_name "
        "FROM public.org_users ou "
        "LEFT JOIN bedrock.user_config uc ON uc.org_user_id = ou.id "
        "LEFT JOIN bedrock.permission_profile pp ON pp.id = uc.profile_id "
        "WHERE ou.id = $1", uid
    )
    return {"success": True, "data": dict(row)}


# ── Permission Unlock Requests ──


class UnlockRequestCreate(BaseModel):
    profile_id: str
    permission_key: str


class UnlockRequestResolve(BaseModel):
    admin_note: str = ""


@router.post("/unlock-requests")
async def create_unlock_request(
    body: UnlockRequestCreate, user=Depends(require_profile_editor), db=Depends(get_db)
):
    """Create a permission unlock request for a system-level key."""
    if body.permission_key not in SYSTEM_KEYS:
        raise HTTPException(400, f"Key '{body.permission_key}' is not a system-level key")
    # Check for duplicate pending request
    existing = await db.fetchrow(
        "SELECT id FROM bedrock.permission_unlock_request "
        "WHERE profile_id = $1 AND permission_key = $2 AND status = 'pending'",
        uuid.UUID(body.profile_id), body.permission_key,
    )
    if existing:
        raise HTTPException(409, "A pending request already exists for this key")
    row = await db.fetchrow(
        "INSERT INTO bedrock.permission_unlock_request "
        "(profile_id, permission_key, requester_email) "
        "VALUES ($1, $2, $3) RETURNING *",
        uuid.UUID(body.profile_id), body.permission_key, user.get("email"),
    )
    return {"success": True, "data": dict(row)}


@router.get("/unlock-requests")
async def list_unlock_requests(
    request: Request, status: Optional[str] = None,
    user=Depends(require_auth), db=Depends(get_db),
):
    """List unlock requests. Admins see all; profile editors see only their own."""
    user_data = await get_user_permissions(user.get("email", ""), db)
    perms = user_data.get("permissions") or {}

    base_query = (
        "SELECT ur.*, pp.name as profile_name "
        "FROM bedrock.permission_unlock_request ur "
        "LEFT JOIN bedrock.permission_profile pp ON pp.id = ur.profile_id"
    )
    conditions = []
    params: list = []

    if perms.get("manage_users_roles"):
        # Admin: see all requests, optionally filtered by status
        if status:
            conditions.append(f"ur.status = ${len(params) + 1}")
            params.append(status)
    elif perms.get("edit_permission_profiles"):
        # Profile editor: only own requests
        conditions.append(f"ur.requester_email = ${len(params) + 1}")
        params.append(user.get("email"))
        if status:
            conditions.append(f"ur.status = ${len(params) + 1}")
            params.append(status)
    else:
        raise HTTPException(403, "Permission denied")

    if conditions:
        base_query += " WHERE " + " AND ".join(conditions)
    base_query += " ORDER BY ur.created_at DESC"

    rows = await db.fetch(base_query, *params)
    return {"success": True, "data": [dict(r) for r in rows]}


@router.post("/unlock-requests/{request_id}/approve")
async def approve_unlock_request(
    request_id: str, user=Depends(require_admin), db=Depends(get_db)
):
    """Approve an unlock request and auto-toggle the permission on the profile."""
    rid = uuid.UUID(request_id)
    req = await db.fetchrow(
        "SELECT * FROM bedrock.permission_unlock_request WHERE id = $1", rid
    )
    if not req:
        raise HTTPException(404, "Unlock request not found")
    if req["status"] != "pending":
        raise HTTPException(400, f"Request is already {req['status']}")
    # Mark as approved
    await db.execute(
        "UPDATE bedrock.permission_unlock_request "
        "SET status = 'approved', resolved_at = now(), resolved_by = $1 "
        "WHERE id = $2",
        user.get("email"), rid,
    )
    # Auto-toggle: set the permission key to true on the profile
    perm_patch = json.dumps({req["permission_key"]: True})
    await db.execute(
        "UPDATE bedrock.permission_profile "
        "SET permissions = permissions || $1::jsonb, updated_at = now() "
        "WHERE id = $2",
        perm_patch, req["profile_id"],
    )
    updated = await db.fetchrow(
        "SELECT * FROM bedrock.permission_unlock_request WHERE id = $1", rid
    )
    return {"success": True, "data": dict(updated)}


@router.post("/unlock-requests/{request_id}/reject")
async def reject_unlock_request(
    request_id: str, body: UnlockRequestResolve,
    user=Depends(require_admin), db=Depends(get_db),
):
    """Reject an unlock request with an optional admin note."""
    rid = uuid.UUID(request_id)
    req = await db.fetchrow(
        "SELECT * FROM bedrock.permission_unlock_request WHERE id = $1", rid
    )
    if not req:
        raise HTTPException(404, "Unlock request not found")
    if req["status"] != "pending":
        raise HTTPException(400, f"Request is already {req['status']}")
    await db.execute(
        "UPDATE bedrock.permission_unlock_request "
        "SET status = 'rejected', resolved_at = now(), resolved_by = $1, admin_note = $2 "
        "WHERE id = $3",
        user.get("email"), body.admin_note, rid,
    )
    updated = await db.fetchrow(
        "SELECT * FROM bedrock.permission_unlock_request WHERE id = $1", rid
    )
    return {"success": True, "data": dict(updated)}


# ── Opportunity Lock ──

opp_router = APIRouter(prefix="/api/opportunities", tags=["opportunity-lock"])


@opp_router.get("/locks")
async def get_all_locks(user=Depends(require_auth), db=Depends(get_db)):
    """Get all locked opportunity IDs."""
    rows = await db.fetch("SELECT sf_opportunity_id, locked_by, locked_at FROM bedrock.opportunity_lock")
    return {"success": True, "data": [dict(r) for r in rows]}


class LockRequest(BaseModel):
    """Frontend must pass the opportunity's OwnerId so we can verify ownership."""
    owner_id: str  # The opportunity's OwnerId from Salesforce data


@opp_router.post("/{opportunity_id}/lock")
async def lock_opportunity(
    opportunity_id: str, body: LockRequest, user=Depends(require_auth), db=Depends(get_db)
):
    """Lock an opportunity. Only the actual owner can lock (must have lock_own_opportunities)."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    user_data = await get_user_permissions(user.get("email", ""), db)
    perms = user_data.get("permissions") or {}
    if not perms.get("lock_own_opportunities", False):
        raise HTTPException(403, "You don't have permission to lock opportunities")
    sf_user_id = user_data.get("sf_user_id")
    if not sf_user_id:
        raise HTTPException(400, "Your account is not linked to a Salesforce user. Contact an admin.")
    # Verify the user is the actual owner of this opportunity
    if body.owner_id != sf_user_id:
        raise HTTPException(403, "You can only lock opportunities you own")
    row = await db.fetchrow(
        "INSERT INTO bedrock.opportunity_lock (sf_opportunity_id, locked_by) VALUES ($1, $2) "
        "ON CONFLICT (sf_opportunity_id) DO NOTHING RETURNING *",
        opportunity_id, sf_user_id,
    )
    if not row:
        return {"success": True, "data": None, "message": "Opportunity is already locked"}
    return {"success": True, "data": dict(row)}


@opp_router.delete("/{opportunity_id}/lock")
async def unlock_opportunity(opportunity_id: str, user=Depends(require_auth), db=Depends(get_db)):
    """Unlock an opportunity. Only the owner who locked it or an admin can unlock."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    user_data = await get_user_permissions(user.get("email", ""), db)
    perms = user_data.get("permissions") or {}
    sf_user_id = user_data.get("sf_user_id")
    lock = await db.fetchrow(
        "SELECT * FROM bedrock.opportunity_lock WHERE sf_opportunity_id = $1", opportunity_id
    )
    if not lock:
        raise HTTPException(404, "Opportunity is not locked")
    is_owner = (lock["locked_by"] == sf_user_id)
    is_admin = perms.get("manage_users_roles", False)
    if not is_owner and not is_admin:
        raise HTTPException(403, "Only the owner who locked this or an admin can unlock")
    await db.execute("DELETE FROM bedrock.opportunity_lock WHERE sf_opportunity_id = $1", opportunity_id)
    return {"success": True, "data": {"message": "Opportunity unlocked"}}
