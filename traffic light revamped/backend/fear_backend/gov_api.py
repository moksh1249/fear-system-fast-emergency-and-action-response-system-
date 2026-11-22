"""/gov - the FEAR Command app's API (Command & Control dashboard, registry
administration, and the emergency driver screen). Every endpoint checks the
caller's role, authority and organization scope here, not in the app."""

from __future__ import annotations

import json

import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

import aiosqlite
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

from . import access, auth_v2, staff, geo, incidents, places, providers, routing, schema_v2, security, sim_bridge
from .access import now_iso
from .live import ensure_engine, hub

router = APIRouter(prefix="/gov", tags=["gov"])
DB = Depends(schema_v2.get_db)
USER = Depends(auth_v2.current_gov_user)

# Which organization kinds an org admin may register beneath their own.
CHILD_KINDS = {
    "health_dept": ("hospital", "ambulance_operator"),
    "fire_dept": ("fire_station",),
    "police_hq": ("police_station",),
    "transport_dept": ("transport_corp",),
    "municipal": (),
}


# ---------------------------------------------------------------------------
# Profile
# ---------------------------------------------------------------------------

async def _driver_row(conn, user_id: str):
    cur = await conn.execute("SELECT * FROM drivers WHERE gov_user_id=?", (user_id,))
    return await cur.fetchone()


async def _active_assignment(conn, driver_id: str):
    cur = await conn.execute(
        """SELECT a.*, v.category, v.plate, v.make_model, v.org_id, v.active AS vehicle_active, v.verified AS vehicle_verified,
                  o.name AS org_name, o.verified AS org_verified
           FROM assignments a JOIN fleet_vehicles v ON v.id = a.vehicle_id JOIN organizations o ON o.id = v.org_id
           WHERE a.driver_id=? AND a.revoked_at IS NULL ORDER BY a.assigned_at DESC LIMIT 1""",
        (driver_id,),
    )
    return await cur.fetchone()


def _profile(user, extra: Optional[dict] = None) -> dict:
    p = {
        "id": user["id"], "username": user["username"], "displayName": user["display_name"], "role": user["role"],
        "authority": user["authority"], "authorityLabel": access.AUTHORITIES.get(user["authority"] or "", None),
        "org": ({"id": user["org_id"], "name": user["org_name"], "kind": user["org_kind"],
                 "kindLabel": access.ORG_KINDS.get(user["org_kind"] or "", ""), "verified": bool(user["org_verified"])}
                if user["org_id"] else None),
        "permissions": {
            "visibleCategories": sorted(access.visible_categories(user)),
            "incidentKinds": sorted(access.visible_incident_kinds(user)),
            "dispatchCategories": sorted(access.dispatch_categories(user)),
            "manageAlerts": access.can_manage_alerts(user),
            "controlSignals": access.can_control_signals(user),
            "verifyCitizenVehicles": access.can_verify_citizen_vehicles(user),
            "manageRegistry": user["role"] in ("super_admin", "org_admin"),
            "viewAudit": user["role"] in ("super_admin", "org_admin"),
            "devOutbox": user["role"] == "super_admin" and providers.DEV_MODE,
        },
    }
    if extra:
        p.update(extra)
    return p


class LoginReq(BaseModel):
    username: str
    password: str


@router.post("/auth/login")
async def login(body: LoginReq, conn: aiosqlite.Connection = DB):
    cur = await conn.execute("SELECT * FROM gov_users WHERE username=?", (body.username.strip(),))
    row = await cur.fetchone()
    if row is None or not security.verify_password(body.password, row["pw_hash"], row["pw_salt"]):
        raise HTTPException(401, "wrong username or password")
    if not row["active"]:
        raise HTTPException(403, "this account has been disabled")
    token = await auth_v2.create_session(conn, "gov", row["id"])
    await access.audit(conn, "gov", row["id"], "login", org_id=row["org_id"])
    user = await auth_v2.load_gov_user(conn, row["id"])
    return {"token": token, "user": _profile(user)}


@router.post("/auth/logout")
async def logout(authorization: Optional[str] = Header(None), conn: aiosqlite.Connection = DB, user=USER):
    tok = auth_v2.bearer(authorization)
    if tok:
        await conn.execute("DELETE FROM sessions WHERE token=?", (tok,))
        await conn.commit()
    return {"ok": True}


@router.get("/me")
async def me(user=USER):
    return _profile(user)


@router.get("/meta")
async def meta(user=USER):
    return {
        **places.meta(),
        "authorities": access.AUTHORITIES, "orgKinds": access.ORG_KINDS, "childKinds": CHILD_KINDS,
        "orgVehicleCategories": access.ORG_VEHICLE_CATEGORIES,
        "vehicleCategories": {k: v[0] for k, v in access.VEHICLE_CATEGORIES.items()},
        "incidentKinds": access.INCIDENT_KINDS, "devMode": providers.DEV_MODE,
    }


@router.get("/places")
async def search_places(q: str = "", lat: Optional[float] = None, lon: Optional[float] = None, user=USER):
    return places.search(q, lat, lon)


# ---------------------------------------------------------------------------
# Organizations and accounts
# ---------------------------------------------------------------------------

async def _scope(conn, user) -> Optional[set]:
    """None = everything (super admin); else the set of org ids the user administers."""
    if user["role"] == "super_admin":
        return None
    if user["role"] == "org_admin":
        return await access.org_subtree(conn, user["org_id"])
    raise HTTPException(403, "registry access needs an administrator account")


def _in_scope(scope: Optional[set], org_id: str) -> bool:
    return scope is None or org_id in scope


@router.get("/orgs")
async def list_orgs(conn: aiosqlite.Connection = DB, user=USER):
    if user["role"] == "operator":
        cur = await conn.execute("SELECT id, name, kind FROM organizations ORDER BY name")
        return [dict(r) for r in await cur.fetchall()]
    scope = await _scope(conn, user)
    cur = await conn.execute("SELECT * FROM organizations ORDER BY name")
    out = []
    for r in await cur.fetchall():
        if _in_scope(scope, r["id"]):
            out.append({**dict(r), "kindLabel": access.ORG_KINDS.get(r["kind"], r["kind"]), "verified": bool(r["verified"])})
    return out


class OrgReq(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    kind: str
    parent_id: Optional[str] = None


@router.post("/orgs")
async def create_org(body: OrgReq, conn: aiosqlite.Connection = DB, user=USER):
    if body.kind not in access.ORG_KINDS or body.kind == "platform":
        raise HTTPException(400, "unknown organization kind")
    scope = await _scope(conn, user)
    if user["role"] == "org_admin":
        if not body.parent_id or body.parent_id not in scope:
            raise HTTPException(403, "you can only register organizations beneath your own")
        cur = await conn.execute("SELECT kind FROM organizations WHERE id=?", (body.parent_id,))
        parent = await cur.fetchone()
        if parent is None or body.kind not in CHILD_KINDS.get(parent["kind"], ()):
            raise HTTPException(403, "that kind of organization can't be registered under this one")
    org_id = schema_v2.new_id("ORG", 3)
    # Organizations registered by FEAR's own admin are verified; ones registered
    # by a department wait for FEAR to verify them before their vehicles get priority.
    verified = 1 if user["role"] == "super_admin" else 0
    await conn.execute("INSERT INTO organizations(id, name, kind, parent_id, verified, created_at) VALUES (?,?,?,?,?,?)",
                       (org_id, body.name.strip(), body.kind, body.parent_id, verified, now_iso()))
    await access.audit(conn, "gov", user["id"], "org.create", "organization", org_id, org_id)
    hub.bump()
    return {"id": org_id, "verified": bool(verified)}


class VerifyReq(BaseModel):
    verified: bool


@router.post("/orgs/{org_id}/verify")
async def verify_org(org_id: str, body: VerifyReq, conn: aiosqlite.Connection = DB, user=USER):
    auth_v2.require_roles(user, "super_admin")
    await conn.execute("UPDATE organizations SET verified=? WHERE id=?", (int(body.verified), org_id))
    await access.audit(conn, "gov", user["id"], "org.verify" if body.verified else "org.unverify", "organization", org_id, org_id)
    cur = await conn.execute("SELECT id FROM fleet_vehicles WHERE org_id=?", (org_id,))
    for r in await cur.fetchall():
        await hub.refresh_unit(conn, r["id"])
    hub.bump()
    return {"ok": True}


@router.get("/users")
async def list_users(conn: aiosqlite.Connection = DB, user=USER):
    scope = await _scope(conn, user)
    cur = await conn.execute(
        """SELECT g.*, o.name AS org_name
           FROM gov_users g LEFT JOIN organizations o ON o.id = g.org_id
           WHERE g.role != 'driver' AND g.deleted_at IS NULL ORDER BY g.created_at""")
    out = []
    for r in await cur.fetchall():
        if scope is None or (r["org_id"] and r["org_id"] in scope and r["role"] == "org_admin"):
            out.append({k: r[k] for k in ("id", "username", "display_name", "role", "org_id", "authority", "created_at", "org_name")}
                       | {"active": bool(r["active"]), "authorityLabel": access.AUTHORITIES.get(r["authority"] or "", None),
                          "canRemove": await staff.can_remove_user(conn, user, r)})
    return out


@router.delete("/users/{user_id}")
async def remove_user(user_id: str, conn: aiosqlite.Connection = DB, user=USER):
    """Removes an employee account (a driver or an organization admin) down
    the organization tree - see staff.py."""
    target = await auth_v2.load_gov_user(conn, user_id)
    if not await staff.can_remove_user(conn, user, target):
        raise HTTPException(403, "you can only remove staff in organizations under yours")
    await staff.remove_user(conn, user["id"], target)
    return {"ok": True}


class UserReq(BaseModel):
    display_name: str = Field(min_length=2, max_length=200)
    role: Literal["org_admin", "operator"]
    org_id: Optional[str] = None
    authority: Optional[str] = None
    username: Optional[str] = Field(default=None, min_length=3, max_length=64)


async def _new_login(conn, prefix: str, wanted: Optional[str]) -> tuple[str, str, str, str]:
    username = (wanted or "").strip().lower() or security.gen_username(prefix)
    cur = await conn.execute("SELECT 1 FROM gov_users WHERE username=?", (username,))
    if await cur.fetchone():
        raise HTTPException(409, "that username is taken")
    password = security.gen_password()
    pw_hash, salt = security.hash_password(password)
    return username, password, pw_hash, salt


@router.post("/users")
async def create_user(body: UserReq, conn: aiosqlite.Connection = DB, user=USER):
    scope = await _scope(conn, user)
    if body.role == "operator":
        auth_v2.require_roles(user, "super_admin")
        if body.authority not in access.AUTHORITIES:
            raise HTTPException(400, "an operator needs an authority")
    else:
        if not body.org_id or not _in_scope(scope, body.org_id):
            raise HTTPException(403, "you can't add administrators to that organization")
    username, password, pw_hash, salt = await _new_login(conn, "ops-" if body.role == "operator" else "adm-", body.username)
    uid = schema_v2.new_id("USR", 3)
    await conn.execute(
        """INSERT INTO gov_users(id, username, pw_hash, pw_salt, display_name, role, org_id, authority, active, created_at)
           VALUES (?,?,?,?,?,?,?,?,1,?)""",
        (uid, username, pw_hash, salt, body.display_name.strip(), body.role, body.org_id,
         body.authority if body.role == "operator" else None, now_iso()))
    await access.audit(conn, "gov", user["id"], f"user.create.{body.role}", "gov_user", uid, body.org_id)
    return {"id": uid, "username": username, "password": password}


class ActiveReq(BaseModel):
    active: bool


@router.patch("/users/{user_id}")
async def set_user_active(user_id: str, body: ActiveReq, conn: aiosqlite.Connection = DB, user=USER):
    scope = await _scope(conn, user)
    target = await auth_v2.load_gov_user(conn, user_id)
    if target is None or target["role"] in ("super_admin",) or (scope is not None and target["org_id"] not in scope):
        raise HTTPException(404, "account not found")
    await conn.execute("UPDATE gov_users SET active=? WHERE id=?", (int(body.active), user_id))
    if not body.active:
        await conn.execute("DELETE FROM sessions WHERE subject_type='gov' AND subject_id=?", (user_id,))
    await access.audit(conn, "gov", user["id"], "user.enable" if body.active else "user.disable", "gov_user", user_id, target["org_id"])
    if target["role"] == "driver":
        cur = await conn.execute("SELECT vehicle_id FROM duty WHERE driver_id=(SELECT id FROM drivers WHERE gov_user_id=?)", (user_id,))
        for r in await cur.fetchall():
            await hub.refresh_unit(conn, r["vehicle_id"])
    return {"ok": True}


@router.post("/users/{user_id}/reset-password")
async def reset_password(user_id: str, conn: aiosqlite.Connection = DB, user=USER):
    scope = await _scope(conn, user)
    target = await auth_v2.load_gov_user(conn, user_id)
    if target is None or target["role"] == "super_admin" or (scope is not None and target["org_id"] not in scope):
        raise HTTPException(404, "account not found")
    password = security.gen_password()
    pw_hash, salt = security.hash_password(password)
    await conn.execute("UPDATE gov_users SET pw_hash=?, pw_salt=? WHERE id=?", (pw_hash, salt, user_id))
    await conn.execute("DELETE FROM sessions WHERE subject_type='gov' AND subject_id=?", (user_id,))
    await access.audit(conn, "gov", user["id"], "user.reset_password", "gov_user", user_id, target["org_id"])
    return {"username": target["username"], "password": password}


# ---------------------------------------------------------------------------
# Fleet registry
# ---------------------------------------------------------------------------

@router.get("/vehicles")
async def list_vehicles(conn: aiosqlite.Connection = DB, user=USER):
    scope = await _scope(conn, user)
    cur = await conn.execute(
        """SELECT v.*, o.name AS org_name, o.verified AS org_verified,
                  (SELECT a.driver_id FROM assignments a WHERE a.vehicle_id=v.id AND a.revoked_at IS NULL) AS driver_id
           FROM fleet_vehicles v JOIN organizations o ON o.id=v.org_id WHERE v.deleted_at IS NULL ORDER BY v.created_at DESC""")
    out = []
    for r in await cur.fetchall():
        if not _in_scope(scope, r["org_id"]):
            continue
        u = hub.units.get(r["id"])
        d = {k: r[k] for k in ("id", "org_id", "org_name", "category", "plate", "make_model", "created_at")}
        d.update({"active": bool(r["active"]), "verified": bool(r["verified"]), "orgVerified": bool(r["org_verified"]),
                  "categoryLabel": access.VEHICLE_CATEGORIES[r["category"]][0],
                  "status": hub.unit_status(u) if u else "off_duty", "authorized": bool(u and u.authorized),
                  "canRemove": await staff.can_remove_vehicle(conn, user, r["org_id"])})
        # The assigned driver's id is only meaningful inside the employing organization.
        if user["role"] == "org_admin":
            d["driver_id"] = r["driver_id"]
        out.append(d)
    return out


class VehicleReq(BaseModel):
    org_id: str
    category: str
    plate: str = Field(min_length=2, max_length=40)
    make_model: Optional[str] = Field(default=None, max_length=120)


@router.post("/vehicles")
async def create_vehicle(body: VehicleReq, conn: aiosqlite.Connection = DB, user=USER):
    scope = await _scope(conn, user)
    if not _in_scope(scope, body.org_id):
        raise HTTPException(403, "not your organization")
    cur = await conn.execute("SELECT kind FROM organizations WHERE id=?", (body.org_id,))
    org = await cur.fetchone()
    if org is None:
        raise HTTPException(404, "organization not found")
    if body.category not in access.ORG_VEHICLE_CATEGORIES.get(org["kind"], ()):
        raise HTTPException(400, f"a {access.ORG_KINDS[org['kind']].lower()} can't register a {body.category} vehicle")
    prefix = access.VEHICLE_CATEGORIES[body.category][1]
    for _ in range(20):
        vid = f"FEAR-{prefix}-{secrets.randbelow(9000) + 1000}"
        cur = await conn.execute("SELECT 1 FROM fleet_vehicles WHERE id=?", (vid,))
        if await cur.fetchone() is None:
            break
    else:
        raise HTTPException(500, "could not allocate a vehicle id")
    await conn.execute(
        "INSERT INTO fleet_vehicles(id, org_id, category, plate, make_model, verified, active, created_at) VALUES (?,?,?,?,?,1,1,?)",
        (vid, body.org_id, body.category, body.plate.strip().upper(), body.make_model, now_iso()))
    await access.audit(conn, "gov", user["id"], "vehicle.create", "vehicle", vid, body.org_id)
    await hub.refresh_unit(conn, vid)
    hub.bump()
    return {"id": vid}


@router.patch("/vehicles/{vehicle_id}")
async def set_vehicle_active(vehicle_id: str, body: ActiveReq, conn: aiosqlite.Connection = DB, user=USER):
    scope = await _scope(conn, user)
    cur = await conn.execute("SELECT org_id FROM fleet_vehicles WHERE id=?", (vehicle_id,))
    v = await cur.fetchone()
    if v is None or not _in_scope(scope, v["org_id"]):
        raise HTTPException(404, "vehicle not found")
    await conn.execute("UPDATE fleet_vehicles SET active=? WHERE id=?", (int(body.active), vehicle_id))
    await access.audit(conn, "gov", user["id"], "vehicle.enable" if body.active else "vehicle.disable", "vehicle", vehicle_id, v["org_id"])
    await hub.refresh_unit(conn, vehicle_id)
    hub.bump()
    return {"ok": True}


@router.delete("/vehicles/{vehicle_id}")
async def remove_vehicle(vehicle_id: str, conn: aiosqlite.Connection = DB, user=USER):
    """Removes a vehicle down the organization tree - see staff.py."""
    cur = await conn.execute("SELECT org_id FROM fleet_vehicles WHERE id=? AND deleted_at IS NULL", (vehicle_id,))
    v = await cur.fetchone()
    if v is None or not await staff.can_remove_vehicle(conn, user, v["org_id"]):
        raise HTTPException(403, "you can only remove vehicles of organizations under yours")
    await staff.remove_vehicle(conn, user["id"], vehicle_id, v["org_id"])
    return {"ok": True}


@router.get("/drivers")
async def list_drivers(conn: aiosqlite.Connection = DB, user=USER):
    # Driver identity is the employing organization's - not even FEAR's own admin reads it.
    auth_v2.require_roles(user, "org_admin")
    scope = await _scope(conn, user)
    cur = await conn.execute(
        """SELECT d.*, g.username, g.active, g.role, g.deleted_at, g.id AS gid, o.name AS org_name,
                  (SELECT a.vehicle_id FROM assignments a WHERE a.driver_id=d.id AND a.revoked_at IS NULL) AS vehicle_id
           FROM drivers d JOIN gov_users g ON g.id=d.gov_user_id JOIN organizations o ON o.id=d.org_id
           WHERE g.deleted_at IS NULL ORDER BY d.full_name""")
    out = []
    for r in await cur.fetchall():
        if r["org_id"] in scope:
            target = {"id": r["gid"], "role": "driver", "org_id": r["org_id"], "deleted_at": None}
            out.append({k: r[k] for k in r.keys() if k not in ("gid", "role", "deleted_at")}
                       | {"active": bool(r["active"]), "canRemove": await staff.can_remove_user(conn, user, target)})
    await access.audit(conn, "gov", user["id"], "drivers.list", org_id=user["org_id"])
    return out


class DriverReq(BaseModel):
    org_id: str
    full_name: str = Field(min_length=2, max_length=200)
    phone: str = Field(min_length=6, max_length=20)
    licence_no: str = Field(min_length=4, max_length=40)
    address: Optional[str] = Field(default=None, max_length=400)
    username: Optional[str] = Field(default=None, min_length=3, max_length=64)


@router.post("/drivers")
async def create_driver(body: DriverReq, conn: aiosqlite.Connection = DB, user=USER):
    auth_v2.require_roles(user, "org_admin")
    scope = await _scope(conn, user)
    if body.org_id not in scope:
        raise HTTPException(403, "not your organization")
    username, password, pw_hash, salt = await _new_login(conn, "drv-", body.username)
    uid, did = schema_v2.new_id("USR", 3), schema_v2.new_id("DRV", 3)
    await conn.execute(
        """INSERT INTO gov_users(id, username, pw_hash, pw_salt, display_name, role, org_id, authority, active, created_at)
           VALUES (?,?,?,?,?,'driver',?,NULL,1,?)""",
        (uid, username, pw_hash, salt, body.full_name.strip(), body.org_id, now_iso()))
    await conn.execute(
        "INSERT INTO drivers(id, gov_user_id, org_id, full_name, phone, licence_no, address, created_at) VALUES (?,?,?,?,?,?,?,?)",
        (did, uid, body.org_id, body.full_name.strip(), body.phone.strip(), body.licence_no.strip().upper(), body.address, now_iso()))
    await access.audit(conn, "gov", user["id"], "driver.create", "driver", did, body.org_id)
    return {"driverId": did, "username": username, "password": password}


class AssignReq(BaseModel):
    vehicle_id: str
    driver_id: str


@router.post("/assignments")
async def assign(body: AssignReq, conn: aiosqlite.Connection = DB, user=USER):
    auth_v2.require_roles(user, "org_admin")
    scope = await _scope(conn, user)
    cur = await conn.execute("SELECT org_id FROM fleet_vehicles WHERE id=?", (body.vehicle_id,))
    v = await cur.fetchone()
    cur = await conn.execute("SELECT org_id FROM drivers WHERE id=?", (body.driver_id,))
    d = await cur.fetchone()
    if v is None or d is None or v["org_id"] not in scope or d["org_id"] not in scope:
        raise HTTPException(404, "vehicle or driver not found in your organization")
    unit = hub.units.get(body.vehicle_id)
    if unit and unit.on_duty:
        raise HTTPException(409, "the vehicle is on duty - its driver must go off duty first")
    now = now_iso()
    # One driver per vehicle and one vehicle per driver at a time.
    await conn.execute("UPDATE assignments SET revoked_at=? WHERE revoked_at IS NULL AND (vehicle_id=? OR driver_id=?)",
                       (now, body.vehicle_id, body.driver_id))
    aid = schema_v2.new_id("ASG", 3)
    await conn.execute("INSERT INTO assignments(id, vehicle_id, driver_id, assigned_by, assigned_at) VALUES (?,?,?,?,?)",
                       (aid, body.vehicle_id, body.driver_id, user["id"], now))
    await access.audit(conn, "gov", user["id"], "assignment.create", "vehicle", body.vehicle_id, v["org_id"])
    await hub.refresh_unit(conn, body.vehicle_id)
    hub.bump()
    return {"id": aid}


@router.post("/assignments/revoke")
async def revoke(body: AssignReq, conn: aiosqlite.Connection = DB, user=USER):
    auth_v2.require_roles(user, "org_admin")
    scope = await _scope(conn, user)
    cur = await conn.execute("SELECT org_id FROM fleet_vehicles WHERE id=?", (body.vehicle_id,))
    v = await cur.fetchone()
    if v is None or v["org_id"] not in scope:
        raise HTTPException(404, "vehicle not found")
    await conn.execute("UPDATE assignments SET revoked_at=? WHERE vehicle_id=? AND driver_id=? AND revoked_at IS NULL",
                       (now_iso(), body.vehicle_id, body.driver_id))
    # Revoking takes effect immediately, mid-shift included.
    await conn.execute("UPDATE duty SET on_duty=0, updated_at=? WHERE vehicle_id=? AND driver_id=?",
                       (now_iso(), body.vehicle_id, body.driver_id))
    await access.audit(conn, "gov", user["id"], "assignment.revoke", "vehicle", body.vehicle_id, v["org_id"])
    await hub.refresh_unit(conn, body.vehicle_id)
    await hub.remove_from_engine(body.vehicle_id)
    hub.bump()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Driver screen
# ---------------------------------------------------------------------------

async def _driver_ctx(conn, user):
    auth_v2.require_roles(user, "driver")
    d = await _driver_row(conn, user["id"])
    if d is None:
        raise HTTPException(403, "no driver record")
    a = await _active_assignment(conn, d["id"])
    return d, a


@router.get("/driver/me")
async def driver_me(conn: aiosqlite.Connection = DB, user=USER):
    d, a = await _driver_ctx(conn, user)
    vehicle = None
    if a is not None:
        vehicle = {"id": a["vehicle_id"], "category": a["category"],
                   "categoryLabel": access.VEHICLE_CATEGORIES[a["category"]][0], "plate": a["plate"],
                   "makeModel": a["make_model"], "orgName": a["org_name"],
                   "orgVerified": bool(a["org_verified"]), "active": bool(a["vehicle_active"]),
                   "emergencyCapable": a["category"] in access.EMERGENCY_CATEGORIES}
    return {"profile": _profile(user), "driver": {"id": d["id"], "fullName": d["full_name"]}, "vehicle": vehicle,
            "state": driver_state(a["vehicle_id"]) if a else None}


def driver_state(vehicle_id: str) -> Optional[dict]:
    u = hub.units.get(vehicle_id)
    if u is None:
        return None
    task = None
    if u.task:
        t = u.task
        task = {"unitId": t["id"], "incidentId": t["incident_id"], "status": t["status"],
                "statusLabel": incidents.UNIT_LABELS[t["status"]], "kind": t["incident_kind"],
                "kindLabel": access.INCIDENT_KINDS.get(t["incident_kind"], t["incident_kind"]),
                "place": t["incident_place"], "description": t["incident_description"],
                "incidentLat": t["incident_lat"], "incidentLon": t["incident_lon"],
                "destKind": t["dest_kind"], "destName": t["dest_name"], "destLat": t["dest_lat"], "destLon": t["dest_lon"],
                "assignedAt": t["assigned_at"]}
    return {
        "vehicleId": u.vehicle_id, "onDuty": u.on_duty, "authorized": u.authorized,
        "priorityRequested": u.priority_requested, "emergency": u.emergency_active, "status": hub.unit_status(u),
        "lat": u.lat, "lon": u.lon, "stale": u.stale, "task": task,
        "route": ({"points": hub.corridor(u, 1e9), "durationSec": u.route["durationSec"],
                   "distanceM": u.route["distanceM"], "steps": u.route.get("steps") or []} if u.route else None),
        "etaSec": hub.eta_sec(u), "signalsAhead": hub.signals_on_route(u),
        "engine": {"connected": hub.engine.connected, "simMode": hub.engine.sim_mode, "signalMode": hub.engine.signal_mode},
    }


class DutyReq(BaseModel):
    on_duty: bool


@router.post("/driver/duty")
async def driver_duty(body: DutyReq, conn: aiosqlite.Connection = DB, user=USER):
    d, a = await _driver_ctx(conn, user)
    if a is None:
        raise HTTPException(409, "you have no vehicle assigned - ask your organization's administrator")
    vid = a["vehicle_id"]
    unit = hub.units.get(vid)
    if not body.on_duty and unit and unit.task is not None:
        raise HTTPException(409, "finish or hand back your current task before going off duty")
    await conn.execute(
        """INSERT INTO duty(vehicle_id, driver_id, on_duty, priority_requested, updated_at) VALUES (?,?,?,1,?)
           ON CONFLICT(vehicle_id) DO UPDATE SET driver_id=excluded.driver_id, on_duty=excluded.on_duty, updated_at=excluded.updated_at""",
        (vid, d["id"], int(body.on_duty), now_iso()))
    await access.audit(conn, "gov", user["id"], "duty.on" if body.on_duty else "duty.off", "vehicle", vid, a["org_id"])
    unit = await hub.refresh_unit(conn, vid)
    if not body.on_duty:
        await hub.remove_from_engine(vid)
    else:
        await ensure_engine()
    hub.bump()
    return {"ok": True, "authorized": bool(unit and unit.authorized)}


class FixReq(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    heading_deg: Optional[float] = None
    speed_kmh: Optional[float] = Field(default=None, ge=0, le=300)
    accuracy_m: Optional[float] = Field(default=None, ge=0)
    demo: bool = False


@router.post("/driver/location")
async def driver_location(body: FixReq, conn: aiosqlite.Connection = DB, user=USER):
    d, a = await _driver_ctx(conn, user)
    if a is None:
        raise HTTPException(409, "no vehicle assigned")
    unit = hub.units.get(a["vehicle_id"])
    if unit is None or not unit.on_duty or unit.driver_id != d["id"]:
        raise HTTPException(409, "go on duty first")
    heading = body.heading_deg % 360.0 if body.heading_deg is not None else None
    forwarded = await hub.on_fix(conn, unit, body.lat, body.lon, heading, body.speed_kmh, body.accuracy_m, body.demo)
    return {"ok": True, "forwardedToEngine": forwarded, "emergency": unit.emergency_active}


class TaskStatusReq(BaseModel):
    status: Literal["en_route", "declined", "on_scene", "transporting", "completed"]
    hospital_id: Optional[str] = None


@router.post("/driver/task/{unit_id}/status")
async def driver_task_status(unit_id: str, body: TaskStatusReq, conn: aiosqlite.Connection = DB, user=USER):
    d, a = await _driver_ctx(conn, user)
    cur = await conn.execute("SELECT vehicle_id FROM incident_units WHERE id=?", (unit_id,))
    iu = await cur.fetchone()
    if iu is None or a is None or iu["vehicle_id"] != a["vehicle_id"]:
        raise HTTPException(404, "task not found")
    hospital = None
    if body.hospital_id:
        hospital = next((p for p in places.receiving_hospitals(0, 0, 1000) if p["id"] == body.hospital_id), None)
        if hospital is None:
            raise HTTPException(404, "hospital not found")
    res = await incidents.set_unit_status(conn, unit_id, body.status, user["id"], hospital)
    unit = hub.units.get(a["vehicle_id"])
    if unit:
        await hub.forward_to_engine(unit)
    return res


@router.get("/driver/hospitals")
async def driver_hospitals(conn: aiosqlite.Connection = DB, user=USER):
    d, a = await _driver_ctx(conn, user)
    unit = hub.units.get(a["vehicle_id"]) if a else None
    lat, lon = (unit.task["incident_lat"], unit.task["incident_lon"]) if unit and unit.task else (unit.lat, unit.lon) if unit and unit.has_fix else (0, 0)
    out = []
    for p in places.receiving_hospitals(lat, lon, 6):
        out.append({**p, "distanceM": round(geo.distance_m(lat, lon, p["lat"], p["lon"]))})
    return out


class PriorityReq(BaseModel):
    enabled: bool


@router.post("/driver/priority")
async def driver_priority(body: PriorityReq, conn: aiosqlite.Connection = DB, user=USER):
    d, a = await _driver_ctx(conn, user)
    if a is None:
        raise HTTPException(409, "no vehicle assigned")
    await conn.execute("UPDATE duty SET priority_requested=?, updated_at=? WHERE vehicle_id=?",
                       (int(body.enabled), now_iso(), a["vehicle_id"]))
    await access.audit(conn, "gov", user["id"], "priority.on" if body.enabled else "priority.off", "vehicle", a["vehicle_id"], a["org_id"])
    unit = await hub.refresh_unit(conn, a["vehicle_id"])
    if unit:
        await hub.forward_to_engine(unit)
    return {"ok": True, "emergency": bool(unit and unit.emergency_active)}


# ---------------------------------------------------------------------------
# Command: units, incidents, dispatch
# ---------------------------------------------------------------------------

async def visible_units(conn, user) -> list:
    if user["role"] == "org_admin":
        scope = await access.org_subtree(conn, user["org_id"])
        return [u for u in hub.units.values() if u.org_id in scope]
    cats = access.visible_categories(user)
    return [u for u in hub.units.values() if u.category in cats]


@router.get("/units")
async def list_units(conn: aiosqlite.Connection = DB, user=USER):
    return [hub.unit_public_view(u) for u in await visible_units(conn, user)]


class ReasonReq(BaseModel):
    reason: str = Field(min_length=10, max_length=500)


@router.post("/units/{vehicle_id}/driver")
async def reveal_driver(vehicle_id: str, body: ReasonReq, conn: aiosqlite.Connection = DB, user=USER):
    """Break-glass: the identity of whoever is driving an authorized vehicle
    right now. Needs a stated reason, is limited to the vehicle's own
    organization or the authority that oversees its category, and is
    written to the audit log the vehicle's organization can read."""
    unit = hub.units.get(vehicle_id)
    if unit is None:
        raise HTTPException(404, "vehicle not found")
    allowed = False
    if user["role"] == "org_admin":
        allowed = unit.org_id in await access.org_subtree(conn, user["org_id"])
    elif user["role"] == "operator":
        allowed = unit.category in access.AUTHORITY_DISPATCH.get(user["authority"], set())
    if not allowed:
        raise HTTPException(403, "only the vehicle's organization or its overseeing authority can request this")
    driver_id = unit.driver_id
    if driver_id is None:
        cur = await conn.execute("SELECT driver_id FROM assignments WHERE vehicle_id=? AND revoked_at IS NULL", (vehicle_id,))
        r = await cur.fetchone()
        driver_id = r["driver_id"] if r else None
    if driver_id is None:
        raise HTTPException(404, "no driver assigned")
    cur = await conn.execute("SELECT full_name, phone, licence_no FROM drivers WHERE id=?", (driver_id,))
    d = await cur.fetchone()
    await access.audit(conn, "gov", user["id"], "driver.identity_reveal", "vehicle", vehicle_id, unit.org_id, body.reason)
    return {"fullName": d["full_name"], "phone": d["phone"], "licenceNo": d["licence_no"], "audited": True}


def _require_command(user) -> None:
    if user["role"] not in ("super_admin", "operator"):
        raise HTTPException(403, "Command access needed")


@router.get("/incidents")
async def list_incidents(status: str = "open", limit: int = Query(200, le=1000),
                         conn: aiosqlite.Connection = DB, user=USER):
    _require_command(user)
    kinds = access.visible_incident_kinds(user)
    if not kinds:
        return []
    statuses = {"open": incidents.OPEN_INCIDENT, "closed": ("closed", "rejected", "cancelled")}.get(status)
    q = f"SELECT * FROM incidents WHERE kind IN ({','.join('?' * len(kinds))})"
    args: list = list(kinds)
    if statuses:
        q += f" AND status IN ({','.join('?' * len(statuses))})"
        args += list(statuses)
    q += " ORDER BY created_at DESC LIMIT ?"
    args.append(limit)
    cur = await conn.execute(q, args)
    rows = await cur.fetchall()
    out = []
    for r in rows:
        s = incidents.summary(r)
        cur = await conn.execute("SELECT status, COUNT(*) AS n FROM incident_units WHERE incident_id=? GROUP BY status", (r["id"],))
        s["units"] = {u["status"]: u["n"] for u in await cur.fetchall()}
        out.append(s)
    return out


async def _visible_incident(conn, user, incident_id: str):
    _require_command(user)
    inc = await incidents.get(conn, incident_id)
    if inc["kind"] not in access.visible_incident_kinds(user):
        raise HTTPException(404, "incident not found")
    return inc


@router.get("/incidents/{incident_id}")
async def incident_detail(incident_id: str, conn: aiosqlite.Connection = DB, user=USER):
    inc = await _visible_incident(conn, user, incident_id)
    cur = await conn.execute("SELECT at, actor, text, public FROM incident_events WHERE incident_id=? ORDER BY id", (incident_id,))
    events = [dict(r) for r in await cur.fetchall()]
    units = []
    for u in await incidents.units_of(conn, incident_id):
        units.append({"unitId": u["id"], "vehicleId": u["vehicle_id"], "category": u["category"], "plate": u["plate"],
                      "orgName": u["org_name"], "status": u["status"], "statusLabel": incidents.UNIT_LABELS[u["status"]],
                      "destKind": u["dest_kind"], "destName": u["dest_name"], "assignedAt": u["assigned_at"],
                      "acceptedAt": u["accepted_at"], "onSceneAt": u["on_scene_at"], "completedAt": u["completed_at"],
                      "canRecall": access.can_dispatch(user, u["category"]) and u["status"] in incidents.ACTIVE_UNIT,
                      **incidents.unit_live(u["vehicle_id"])})
    cur = await conn.execute("SELECT sharing_active FROM incident_contacts WHERE incident_id=?", (incident_id,))
    contact = await cur.fetchone()
    try:
        interview = json.loads(inc["interview"]) if inc["interview"] else None
    except (ValueError, TypeError):
        interview = None
    return {**incidents.summary(inc), "events": events, "units": units, "interview": interview,
            "needs": access.SOS_NEEDS.get(inc["kind"], {}),
            "hasCallerContact": bool(contact and contact["sharing_active"]),
            "canViewCallerContact": bool(contact and contact["sharing_active"]) and access.can_handle_incident(user, inc["kind"]),
            "canVerify": inc["status"] == "reported" and access.can_handle_incident(user, inc["kind"]),
            "canClose": inc["status"] in incidents.OPEN_INCIDENT and (access.can_handle_incident(user, inc["kind"]) or user["role"] == "super_admin"),
            "dispatchCategories": sorted(access.dispatch_categories(user))}


class IncidentReq(BaseModel):
    kind: str
    lat: float
    lon: float
    description: Optional[str] = Field(default=None, max_length=1000)
    severity: Literal["low", "normal", "high", "critical"] = "normal"


@router.post("/incidents")
async def create_incident(body: IncidentReq, conn: aiosqlite.Connection = DB, user=USER):
    _require_command(user)
    if body.kind not in access.visible_incident_kinds(user):
        raise HTTPException(403, "your authority doesn't handle this kind of incident")
    inc_id = await incidents.create(conn, kind=body.kind, source="command", lat=body.lat, lon=body.lon,
                                    description=body.description, severity=body.severity, created_by=user["id"])
    # Command's own choice is the floor; the description's key terms may raise it.
    from . import triage

    await conn.execute("UPDATE incidents SET severity_score=? WHERE id=?",
                       ({"low": 1, "normal": 2, "high": 3, "critical": 4}[body.severity], inc_id))
    await incidents.mark_responded(conn, inc_id, user)
    await triage.store(conn, inc_id, triage.merge(triage.rules(body.description or "", body.kind, "command"), None, body.description or ""))
    await conn.commit()
    triage.schedule_ai(inc_id)
    await access.audit(conn, "gov", user["id"], "incident.create", "incident", inc_id)
    return {"id": inc_id}


class VerifyReportReq(BaseModel):
    accept: bool
    note: Optional[str] = Field(default=None, max_length=500)
    alert: bool = False   # also warn the public around it
    alert_radius_m: float = Field(default=500, ge=50, le=5000)


@router.post("/incidents/{incident_id}/verify")
async def verify_report(incident_id: str, body: VerifyReportReq, conn: aiosqlite.Connection = DB, user=USER):
    inc = await _visible_incident(conn, user, incident_id)
    if inc["status"] != "reported" or not access.can_handle_incident(user, inc["kind"]):
        raise HTTPException(409, "nothing to verify")
    await incidents.mark_responded(conn, incident_id, user)
    if not body.accept:
        await incidents.close(conn, incident_id, user["id"], body.note, status="rejected")
        await conn.commit()
        await access.audit(conn, "gov", user["id"], "incident.reject", "incident", incident_id)
        return {"ok": True, "status": "rejected"}
    await conn.execute("UPDATE incidents SET status='open' WHERE id=?", (incident_id,))
    await incidents.event(conn, incident_id, user["id"], "Report verified by Command" + (f": {body.note}" if body.note else ""), public=True)
    if body.alert:
        await _create_alert(conn, user, kind="incident", title=access.INCIDENT_KINDS[inc["kind"]],
                            body=inc["description"] or f"Reported {inc['place']}", lat=inc["lat"], lon=inc["lon"],
                            radius_m=body.alert_radius_m, minutes=120, incident_id=incident_id)
    await conn.commit()
    await access.audit(conn, "gov", user["id"], "incident.verify", "incident", incident_id)
    hub.bump()
    return {"ok": True, "status": "open"}


@router.get("/incidents/{incident_id}/suggest")
async def suggest_units(incident_id: str, category: str, conn: aiosqlite.Connection = DB, user=USER):
    inc = await _visible_incident(conn, user, incident_id)
    if not access.can_dispatch(user, category):
        raise HTTPException(403, "your authority doesn't dispatch this category")
    return await incidents.suggestions(conn, inc, category)


class DispatchReq(BaseModel):
    vehicle_id: str


@router.post("/incidents/{incident_id}/dispatch")
async def dispatch_unit(incident_id: str, body: DispatchReq, conn: aiosqlite.Connection = DB, user=USER):
    await _visible_incident(conn, user, incident_id)
    unit = hub.units.get(body.vehicle_id)
    if unit is None or not access.can_dispatch(user, unit.category):
        raise HTTPException(403, "your authority doesn't dispatch this vehicle")
    await incidents.mark_responded(conn, incident_id, user)
    res = await incidents.dispatch(conn, incident_id, body.vehicle_id, user["id"])
    await access.audit(conn, "gov", user["id"], "incident.dispatch", "vehicle", body.vehicle_id, unit.org_id)
    return res


@router.post("/incidents/{incident_id}/units/{unit_id}/recall")
async def recall_unit(incident_id: str, unit_id: str, conn: aiosqlite.Connection = DB, user=USER):
    await _visible_incident(conn, user, incident_id)
    cur = await conn.execute("SELECT iu.vehicle_id, v.category FROM incident_units iu JOIN fleet_vehicles v ON v.id=iu.vehicle_id WHERE iu.id=? AND iu.incident_id=?",
                             (unit_id, incident_id))
    r = await cur.fetchone()
    if r is None or not access.can_dispatch(user, r["category"]):
        raise HTTPException(403, "your authority doesn't control this unit")
    await incidents.mark_responded(conn, incident_id, user)
    res = await incidents.set_unit_status(conn, unit_id, "recalled", user["id"])
    unit = hub.units.get(r["vehicle_id"])
    if unit:
        await hub.forward_to_engine(unit)
    await access.audit(conn, "gov", user["id"], "incident.recall", "vehicle", r["vehicle_id"])
    return res


class NoteReq(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    public: bool = False


@router.post("/incidents/{incident_id}/note")
async def add_note(incident_id: str, body: NoteReq, conn: aiosqlite.Connection = DB, user=USER):
    await _visible_incident(conn, user, incident_id)
    await incidents.mark_responded(conn, incident_id, user)
    await incidents.event(conn, incident_id, user["display_name"], body.text, public=body.public)
    await conn.commit()
    return {"ok": True}


class CloseReq(BaseModel):
    note: Optional[str] = Field(default=None, max_length=500)


@router.post("/incidents/{incident_id}/close")
async def close_incident(incident_id: str, body: CloseReq, conn: aiosqlite.Connection = DB, user=USER):
    inc = await _visible_incident(conn, user, incident_id)
    if not (access.can_handle_incident(user, inc["kind"]) or user["role"] == "super_admin"):
        raise HTTPException(403, "your authority doesn't handle this incident")
    if inc["status"] not in incidents.OPEN_INCIDENT:
        raise HTTPException(409, "already closed")
    await incidents.mark_responded(conn, incident_id, user)
    await incidents.close(conn, incident_id, user["id"], body.note)
    await conn.commit()
    for u in hub.units.values():
        if u.on_duty and u.has_fix and not u.stale:
            await hub.forward_to_engine(u)  # drops emergency priority for the released units right away
    await access.audit(conn, "gov", user["id"], "incident.close", "incident", incident_id)
    return {"ok": True}


@router.post("/incidents/{incident_id}/caller-contact")
async def caller_contact(incident_id: str, body: ReasonReq, conn: aiosqlite.Connection = DB, user=USER):
    inc = await _visible_incident(conn, user, incident_id)
    if not access.can_handle_incident(user, inc["kind"]):
        raise HTTPException(403, "only the authority handling this incident can contact the caller")
    cur = await conn.execute("SELECT * FROM incident_contacts WHERE incident_id=?", (incident_id,))
    c = await cur.fetchone()
    if c is None or not c["sharing_active"]:
        raise HTTPException(404, "caller contact is not shared (incident closed or none given)")
    await access.audit(conn, "gov", user["id"], "incident.caller_contact", "incident", incident_id, reason=body.reason)
    return {"name": c["name"], "phone": c["phone"], "audited": True}


# ---------------------------------------------------------------------------
# Traffic engine and signals
# ---------------------------------------------------------------------------

@router.get("/engine")
async def engine_status(user=USER):
    e = hub.engine
    return {"connected": e.connected, "simMode": e.sim_mode, "signalMode": e.signal_mode, "simTime": e.sim_time,
            "liveVehicles": e.live_vehicles, "preempted": e.preempted, "canControl": access.can_control_signals(user)}


@router.post("/engine/start")
async def engine_start(conn: aiosqlite.Connection = DB, user=USER):
    _require_command(user)
    res = await ensure_engine(force=True)
    await access.audit(conn, "gov", user["id"], "engine.start")
    return res


class SignalModeReq(BaseModel):
    mode: Literal["default", "emergency", "density"]


@router.post("/engine/signal-mode")
async def set_signal_mode(body: SignalModeReq, conn: aiosqlite.Connection = DB, user=USER):
    if not access.can_control_signals(user):
        raise HTTPException(403, "signal control is City Traffic Command's")
    ok = await sim_bridge.bridge.send_command({"cmd": "setSignalMode", "value": body.mode})
    await access.audit(conn, "gov", user["id"], f"signals.mode.{body.mode}")
    return {"ok": ok}


class SimModeReq(BaseModel):
    mode: Literal["realistic", "simulation"]


@router.post("/engine/sim-mode")
async def set_sim_mode(body: SimModeReq, conn: aiosqlite.Connection = DB, user=USER):
    if not access.can_control_signals(user):
        raise HTTPException(403, "City Traffic Command only")
    ok = await sim_bridge.bridge.send_command({"cmd": "setSimMode", "value": body.mode})
    await access.audit(conn, "gov", user["id"], f"engine.mode.{body.mode}")
    return {"ok": ok}


# ---------------------------------------------------------------------------
# Public alerts
# ---------------------------------------------------------------------------

async def _create_alert(conn, user, *, kind, title, body, lat, lon, radius_m, minutes, incident_id=None) -> str:
    aid = schema_v2.new_id("ALR", 3)
    expires = (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()
    await conn.execute(
        """INSERT INTO public_alerts(id, kind, title, body, lat, lon, radius_m, incident_id, created_by, created_at, expires_at, active)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,1)""",
        (aid, kind, title, body, lat, lon, radius_m, incident_id, user["id"], now_iso(), expires))
    hub.bump()
    return aid


async def active_alerts(conn) -> list:
    cur = await conn.execute("SELECT * FROM public_alerts WHERE active=1 AND expires_at > ? ORDER BY created_at DESC", (now_iso(),))
    return [{"id": r["id"], "kind": r["kind"], "title": r["title"], "body": r["body"], "lat": r["lat"], "lon": r["lon"],
             "radiusM": r["radius_m"], "incidentId": r["incident_id"], "createdAt": r["created_at"],
             "expiresAt": r["expires_at"]} for r in await cur.fetchall()]


@router.get("/alerts")
async def list_alerts(conn: aiosqlite.Connection = DB, user=USER):
    return await active_alerts(conn)


class AlertReq(BaseModel):
    kind: Literal["closure", "diversion", "advisory"]
    title: str = Field(min_length=3, max_length=120)
    body: Optional[str] = Field(default=None, max_length=1000)
    lat: float
    lon: float
    radius_m: float = Field(ge=50, le=10000)
    minutes: int = Field(default=120, ge=5, le=60 * 24 * 7)


@router.post("/alerts")
async def create_alert(body: AlertReq, conn: aiosqlite.Connection = DB, user=USER):
    if not access.can_manage_alerts(user):
        raise HTTPException(403, "your authority can't publish public alerts")
    aid = await _create_alert(conn, user, kind=body.kind, title=body.title, body=body.body, lat=body.lat, lon=body.lon,
                              radius_m=body.radius_m, minutes=body.minutes)
    await conn.commit()
    await access.audit(conn, "gov", user["id"], "alert.create", "alert", aid)
    return {"id": aid}


@router.post("/alerts/{alert_id}/end")
async def end_alert(alert_id: str, conn: aiosqlite.Connection = DB, user=USER):
    if not access.can_manage_alerts(user):
        raise HTTPException(403, "your authority can't manage public alerts")
    await conn.execute("UPDATE public_alerts SET active=0 WHERE id=?", (alert_id,))
    await access.audit(conn, "gov", user["id"], "alert.end", "alert", alert_id)
    hub.bump()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Citizen vehicle verification (RTO / VAHAN stand-in)
# ---------------------------------------------------------------------------

@router.get("/verification/citizen-vehicles")
async def citizen_vehicle_queue(status: str = "pending", conn: aiosqlite.Connection = DB, user=USER):
    if not access.can_verify_citizen_vehicles(user):
        raise HTTPException(403, "RTO verification only")
    cur = await conn.execute(
        """SELECT cv.*, c.name AS owner_name FROM citizen_vehicles cv JOIN citizens c ON c.id=cv.citizen_id
           WHERE (?='all' OR cv.rto_status=?) ORDER BY cv.created_at""", (status, status))
    return [dict(r) for r in await cur.fetchall()]


class ReviewReq(BaseModel):
    decision: Literal["verified", "rejected"]
    note: Optional[str] = Field(default=None, max_length=300)


@router.post("/verification/citizen-vehicles/{cv_id}")
async def review_citizen_vehicle(cv_id: str, body: ReviewReq, conn: aiosqlite.Connection = DB, user=USER):
    if not access.can_verify_citizen_vehicles(user):
        raise HTTPException(403, "RTO verification only")
    cur = await conn.execute("UPDATE citizen_vehicles SET rto_status=?, reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?",
                             (body.decision, user["id"], now_iso(), body.note, cv_id))
    if cur.rowcount == 0:
        raise HTTPException(404, "not found")
    await access.audit(conn, "gov", user["id"], f"citizen_vehicle.{body.decision}", "citizen_vehicle", cv_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Analytics, audit, dev outbox
# ---------------------------------------------------------------------------

@router.get("/analytics")
async def analytics(days: int = Query(7, ge=1, le=365), conn: aiosqlite.Connection = DB, user=USER):
    _require_command(user)
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    kinds = access.visible_incident_kinds(user) if user["authority"] != "analytics" else set(access.INCIDENT_KINDS)
    cur = await conn.execute("SELECT kind, status, source, created_at FROM incidents WHERE created_at >= ?", (since,))
    rows = [r for r in await cur.fetchall() if r["kind"] in kinds]
    by_kind, by_status, by_source = {}, {}, {}
    for r in rows:
        by_kind[r["kind"]] = by_kind.get(r["kind"], 0) + 1
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
        by_source[r["source"]] = by_source.get(r["source"], 0) + 1
    cur = await conn.execute(
        """SELECT v.category, iu.assigned_at, iu.accepted_at, iu.on_scene_at, iu.completed_at, iu.transport_at
           FROM incident_units iu JOIN fleet_vehicles v ON v.id=iu.vehicle_id WHERE iu.assigned_at >= ?""", (since,))
    resp: dict = {}

    def secs(a, b):
        return (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds()

    for r in await cur.fetchall():
        s = resp.setdefault(r["category"], {"dispatched": 0, "accept": [], "toScene": [], "transport": []})
        s["dispatched"] += 1
        if r["accepted_at"]:
            s["accept"].append(secs(r["assigned_at"], r["accepted_at"]))
        if r["on_scene_at"]:
            s["toScene"].append(secs(r["assigned_at"], r["on_scene_at"]))
        if r["transport_at"] and r["completed_at"]:
            s["transport"].append(secs(r["transport_at"], r["completed_at"]))
    avg = lambda xs: round(sum(xs) / len(xs)) if xs else None  # noqa: E731
    response = {c: {"dispatched": s["dispatched"], "avgAcceptSec": avg(s["accept"]), "avgToSceneSec": avg(s["toScene"]),
                    "avgTransportSec": avg(s["transport"])} for c, s in resp.items()}
    fleet: dict = {}
    for u in hub.units.values():
        f = fleet.setdefault(u.category, {"registered": 0, "onDuty": 0, "busy": 0, "emergency": 0})
        f["registered"] += 1
        f["onDuty"] += int(u.on_duty)
        f["busy"] += int(u.task is not None)
        f["emergency"] += int(u.emergency_active)
    return {"days": days, "incidents": {"total": len(rows), "byKind": by_kind, "byStatus": by_status, "bySource": by_source},
            "response": response, "fleet": fleet,
            "engine": {"connected": hub.engine.connected, "preemptedJunctions": len(hub.engine.preempted)}}


@router.get("/audit")
async def audit_log(limit: int = Query(300, le=2000), conn: aiosqlite.Connection = DB, user=USER):
    scope = await _scope(conn, user)
    cur = await conn.execute(
        """SELECT a.*, g.username AS actor_username FROM audit_log a LEFT JOIN gov_users g ON g.id=a.actor_id
           ORDER BY a.id DESC LIMIT ?""", (limit * 4 if scope is not None else limit,))
    rows = [dict(r) for r in await cur.fetchall()]
    if scope is not None:
        rows = [r for r in rows if r["org_id"] in scope][:limit]
    return rows


@router.get("/dev/outbox")
async def dev_outbox(conn: aiosqlite.Connection = DB, user=USER):
    auth_v2.require_roles(user, "super_admin")
    if not providers.DEV_MODE:
        raise HTTPException(404, "not in dev mode")
    cur = await conn.execute("SELECT * FROM dev_outbox ORDER BY id DESC LIMIT 50")
    return [dict(r) for r in await cur.fetchall()]


@router.post("/route")
async def route(body: dict, user=USER):
    try:
        res = await routing.route(float(body["from_lat"]), float(body["from_lon"]), float(body["to_lat"]), float(body["to_lon"]))
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "from_lat/from_lon/to_lat/to_lon required")
    return res or {"found": False}
