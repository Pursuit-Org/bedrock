#!/usr/bin/env python3
"""Grant Relationship Managers free owner editing (Aug 2026 decision).

RM profile gains: reassign_opportunities, edit_all_accounts, reassign_accounts.
Admin profile gains the two new account keys (it bypasses anyway — this keeps
the Settings permission matrix truthful). Idempotent.
"""
import asyncio, asyncpg, re, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
url = [re.match(r"DATABASE_URL=(.+)", l.strip()).group(1).strip().strip('"').strip("'")
       for l in open(os.path.join(HERE, "..", ".env")) if l.startswith("DATABASE_URL=")][0]

GRANTS = [
    ("Relationship Manager", {"reassign_opportunities": True, "edit_all_accounts": True, "reassign_accounts": True}),
    ("Admin", {"edit_all_accounts": True, "reassign_accounts": True}),
]


async def main():
    conn = await asyncpg.connect(url)
    for name, updates in GRANTS:
        row = await conn.fetchrow("SELECT permissions FROM bedrock.permission_profile WHERE name=$1", name)
        perms = json.loads(row["permissions"]) if isinstance(row["permissions"], str) else dict(row["permissions"])
        perms.update(updates)
        await conn.execute(
            "UPDATE bedrock.permission_profile SET permissions=$1, updated_at=now() WHERE name=$2",
            json.dumps(perms), name)
        print(f"{name} → {updates}")
    r = await conn.fetchrow("SELECT permissions FROM bedrock.permission_profile WHERE name='Relationship Manager'")
    perms = json.loads(r["permissions"]) if isinstance(r["permissions"], str) else r["permissions"]
    print("RM verified:", {k: perms.get(k) for k in
          ("edit_all_opportunities", "reassign_opportunities", "edit_all_accounts", "reassign_accounts")})
    await conn.close()

asyncio.run(main())
