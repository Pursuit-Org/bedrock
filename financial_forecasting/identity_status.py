"""Canonical human account status checks, without permission provisioning."""
from fastapi import HTTPException


def reject_inactive_identity(row) -> None:
    if row and row.get("is_active") is False:
        raise HTTPException(403, "Account is inactive")


async def require_active_identity(email: str, conn=None) -> None:
    if not isinstance(email, str) or email.count("@") != 1 or any(c.isspace() for c in email) or not all(email.split("@")):
        raise HTTPException(401, "Authenticated email required")
    # Missing first-login identities remain eligible for provisioning;
    # a false row wins if old case-variant identities coexist.
    query = (
        "SELECT COALESCE(bool_and(COALESCE(is_active, true)), true) AS is_active "
        "FROM public.org_users WHERE LOWER(email) = LOWER($1)"
    )
    try:
        if conn is not None:
            row = await conn.fetchrow(query, email)
        else:
            from db import get_pool
            async with get_pool().acquire(timeout=10) as owned_conn:
                row = await owned_conn.fetchrow(query, email)
    except Exception:
        raise HTTPException(503, "Cannot verify account status — try again later")
    if not row or (row.get("is_active") is not True and row.get("is_active") is not False):
        raise HTTPException(503, "Cannot verify account status — try again later")
    reject_inactive_identity(row)
