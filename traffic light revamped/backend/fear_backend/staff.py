"""Removing employee accounts and vehicles, by the organization hierarchy.

Organizations form a tree (Health Department -> District MMG Hospital,
Yashoda Hospital; Police HQ -> Kotwali station...). Who may remove whom:

* FEAR's super admin: any employee account (never another super admin) and
  any vehicle.
* An organization admin: drivers and vehicles in their own organization and
  every organization below it, and the admins of organizations strictly
  below theirs - never a peer admin of their own organization, never anyone
  above, never themselves.
* Command seats (operators) and drivers: nobody.

"Remove" deactivates and erases personal data, it doesn't delete rows: the
sign-in stops on every device at once, the account or vehicle drops out of
every list and the map, and name / phone / address / licence are wiped. Past
incidents keep the vehicle id, so the record of who responded stays intact.
"""

from __future__ import annotations

from typing import Optional

from fastapi import HTTPException

from . import access, security
from .access import now_iso
from .live import hub


async def can_remove_user(conn, actor, target) -> bool:
    if target is None or target["deleted_at"] or target["role"] == "super_admin" or target["id"] == actor["id"]:
        return False
    if actor["role"] == "super_admin":
        return True
    if actor["role"] != "org_admin" or not target["org_id"]:
        return False
    below = await access.org_subtree(conn, actor["org_id"])
    if target["org_id"] not in below:
        return False
    if target["role"] == "driver":
        return True
    # another organization's admin: only if that organization is under mine
    return target["role"] == "org_admin" and target["org_id"] != actor["org_id"]


async def can_remove_vehicle(conn, actor, org_id: str) -> bool:
    if actor["role"] == "super_admin":
        return True
    if actor["role"] != "org_admin":
        return False
    return org_id in await access.org_subtree(conn, actor["org_id"])


async def remove_user(conn, actor_id: str, target, reason: Optional[str] = None) -> None:
    """Deactivate + erase personal data (see module docstring)."""
    uid = target["id"]
    now = now_iso()
    pw_hash, salt = security.hash_password(security.gen_password())
    await conn.execute(
        """UPDATE gov_users SET active=0, deleted_at=?, display_name='Removed account', username=?, pw_hash=?, pw_salt=?
           WHERE id=?""", (now, f"removed-{uid.lower()}", pw_hash, salt, uid))
    await conn.execute("DELETE FROM sessions WHERE subject_type='gov' AND subject_id=?", (uid,))
    await conn.execute("UPDATE enrollments SET expires_at=? WHERE subject_type='gov' AND subject_id=? AND used_at IS NULL", (now, uid))
    cur = await conn.execute("SELECT id FROM drivers WHERE gov_user_id=?", (uid,))
    d = await cur.fetchone()
    vehicles = []
    if d is not None:
        await conn.execute("UPDATE drivers SET full_name='Removed driver', phone='-', licence_no='-', address=NULL WHERE id=?", (d["id"],))
        cur = await conn.execute("SELECT vehicle_id FROM assignments WHERE driver_id=? AND revoked_at IS NULL", (d["id"],))
        vehicles = [r["vehicle_id"] for r in await cur.fetchall()]
        await conn.execute("UPDATE assignments SET revoked_at=? WHERE driver_id=? AND revoked_at IS NULL", (now, d["id"]))
        await conn.execute("UPDATE duty SET on_duty=0, updated_at=? WHERE driver_id=?", (now, d["id"]))
    await access.audit(conn, "gov", actor_id, f"user.remove.{target['role']}", "gov_user", uid, target["org_id"], reason=reason, commit=False)
    await conn.commit()
    for vid in vehicles:
        await hub.refresh_unit(conn, vid)
        await hub.remove_from_engine(vid)
    hub.bump()


async def remove_vehicle(conn, actor_id: str, vehicle_id: str, org_id: str, reason: Optional[str] = None) -> None:
    unit = hub.units.get(vehicle_id)
    if unit is not None and unit.task is not None:
        raise HTTPException(409, "this vehicle is on an incident - recall it first")
    now = now_iso()
    await conn.execute("UPDATE fleet_vehicles SET active=0, deleted_at=? WHERE id=?", (now, vehicle_id))
    await conn.execute("UPDATE assignments SET revoked_at=? WHERE vehicle_id=? AND revoked_at IS NULL", (now, vehicle_id))
    await conn.execute("UPDATE duty SET on_duty=0, updated_at=? WHERE vehicle_id=?", (now, vehicle_id))
    await conn.execute("DELETE FROM fleet_location WHERE vehicle_id=?", (vehicle_id,))
    await access.audit(conn, "gov", actor_id, "vehicle.remove", "vehicle", vehicle_id, org_id, reason=reason, commit=False)
    await conn.commit()
    await hub.remove_from_engine(vehicle_id)
    await hub.refresh_unit(conn, vehicle_id)  # drops it from the live picture
    hub.bump()
