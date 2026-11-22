"""First-run setup: the FEAR platform organization and its super admin.

The super admin's password comes from FEAR_SUPERADMIN_PASSWORD, or is
generated and printed once to the server console (fear_backend.log when
started by serve.py). Every other account is created from FEAR Command.
"""

from __future__ import annotations

import os

from . import access, schema_v2, security

PLATFORM_ORG_ID = "ORG-FEAR"
SUPER_ADMIN_USERNAME = os.environ.get("FEAR_SUPERADMIN_USERNAME", "fear-admin")


async def ensure_super_admin() -> None:
    conn = await schema_v2.connect()
    try:
        cur = await conn.execute("SELECT 1 FROM organizations WHERE id=?", (PLATFORM_ORG_ID,))
        if await cur.fetchone() is None:
            await conn.execute("INSERT INTO organizations(id, name, kind, parent_id, verified, created_at) VALUES (?,?,?,NULL,1,?)",
                               (PLATFORM_ORG_ID, "FEAR Platform", "platform", access.now_iso()))
        cur = await conn.execute("SELECT 1 FROM gov_users WHERE role='super_admin'")
        if await cur.fetchone() is None:
            password = os.environ.get("FEAR_SUPERADMIN_PASSWORD") or security.gen_password()
            pw_hash, salt = security.hash_password(password)
            await conn.execute(
                """INSERT INTO gov_users(id, username, pw_hash, pw_salt, display_name, role, org_id, authority, active, created_at)
                   VALUES (?,?,?,?,?,'super_admin',?,NULL,1,?)""",
                (schema_v2.new_id("USR", 3), SUPER_ADMIN_USERNAME, pw_hash, salt, "FEAR Super Admin", PLATFORM_ORG_ID, access.now_iso()))
            if not os.environ.get("FEAR_SUPERADMIN_PASSWORD"):
                print(f"[fear] created super admin '{SUPER_ADMIN_USERNAME}' with password: {password}  "
                      f"(shown once - change it from FEAR Command)", flush=True)
        await conn.commit()
    finally:
        await conn.close()
