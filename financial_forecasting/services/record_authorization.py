"""Shared record ownership and opportunity mutation authorization."""
from typing import Any, Dict, Optional
from fastapi import HTTPException
from security import escape_soql_string


async def enforce_record_ownership(
    salesforce,
    sobject: str,
    record_id: str,
    user: Dict[str, Any],
    edit_all_perm: Optional[str] = None,
    ownership_error: Optional[str] = None,
) -> None:
    """Raise HTTPException(403/404) unless `user` may mutate `record_id` on `sobject`.

    Generalized 2026-04-21 (PR #169) from the Opp-only helper shipped in PR #163
    so Account/Contact/Opportunity write endpoints share one ownership path.
    Payment write endpoints pass `sobject="Opportunity"` + the parent Opp's Id
    (resolved upstream) + `edit_all_perm="edit_all_opportunities"` — identical
    behavior to the prior helper.

    Bypass order (first match wins — no SF query):
      1. Service callers (`is_service=True`). check_permission_or_internal
         sets this without populating _permissions / _app_user, so the
         service-account branch MUST come first. Load-bearing for Pebble
         CRM-write against Account/Contact/Payment endpoints that use
         check_permission_or_internal; unreachable no-op for any future
         caller still gated on check_permission.
      2. Admin (`manage_users_roles`).
      3. Per-resource "edit-all" permission when the caller opts in
         (e.g. `edit_all_opportunities` for Opportunity and Payment).
         Account + Contact have no edit-all key in PERMISSION_KEYS
         (routes/permissions.py:19-34), so their callers pass `None` and
         get admin-only bypass.

    Otherwise: SOQL `SELECT OwnerId FROM {sobject} WHERE Id = '{safe_id}'`
    and compare against the caller's `sf_user_id`. 404 if the record is
    absent; 403 on OwnerId mismatch or when the user isn't linked to a
    Salesforce user (can't evaluate ownership — deny, safer than permit).
    """
    # 1. Service-account bypass — check_permission_or_internal sets is_service
    #    without populating _permissions / _app_user, so guard first.
    if user.get("is_service"):
        return
    perms = user.get("_permissions", {})
    # 2. Admin bypass (manage_users_roles).
    if perms.get("manage_users_roles", False):
        return
    # 3. Per-resource edit-all bypass (caller opt-in).
    if edit_all_perm and perms.get(edit_all_perm, False):
        return
    sf_user_id = (user.get("_app_user") or {}).get("sf_user_id")
    if not sf_user_id:
        raise HTTPException(
            status_code=403,
            detail=f"Cannot verify {sobject.lower()} ownership — user is not linked to a Salesforce user",
        )
    safe_id = escape_soql_string(record_id)
    result = await salesforce.query(
        f"SELECT OwnerId FROM {sobject} WHERE Id = '{safe_id}' LIMIT 1"
    )
    records = result.get("records", [])
    if not records:
        raise HTTPException(status_code=404, detail=f"{sobject} not found")
    if records[0].get("OwnerId") != sf_user_id:
        raise HTTPException(
            status_code=403,
            detail=ownership_error or f"You can only modify {sobject.lower()}s you own",
        )


async def enforce_opportunity_mutation(salesforce, opportunity_id: str, user: dict, db, updates: Optional[dict] = None) -> None:
    """Apply lock, current ownership and reassignment policy after a route's capability check."""
    perms = user.get("_permissions") or {}
    sf_user_id = (user.get("_app_user") or {}).get("sf_user_id")
    is_admin = perms.get("manage_users_roles", False)
    lock = await db.fetchrow(
        "SELECT locked_by FROM bedrock.opportunity_lock WHERE sf_opportunity_id = $1", opportunity_id
    )
    if lock and not is_admin and (not sf_user_id or lock["locked_by"] != sf_user_id):
        raise HTTPException(403, "This opportunity is locked by its owner")
    try:
        await enforce_record_ownership(
            salesforce, "Opportunity", opportunity_id, user, "edit_all_opportunities",
            ownership_error="You can only edit opportunities you own",
        )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, "Cannot verify opportunity ownership — try again later")
    if updates and any(key.casefold() == "ownerid" for key in updates) and not is_admin and not perms.get("reassign_opportunities", False):
        raise HTTPException(403, "You don't have permission to reassign opportunities")
