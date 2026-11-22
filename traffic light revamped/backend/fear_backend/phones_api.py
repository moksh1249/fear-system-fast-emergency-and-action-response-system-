"""Phone logins by QR code, the server's network addresses, and the public
tunnel switch - the parts of FEAR Command that bring real phones into
realistic mode.

A QR code carries {"fear": 1, "app": "gov"|"public", "servers": [...],
"code": "<one-time code>"}: every address the phone might reach this server
on (Wi-Fi first, then the public tunnel if it's on) plus a single-use
sign-in code valid for 30 minutes. The phone tries the addresses in order,
then trades the code for a normal session at POST /v2/enroll. A "connect"
QR carries no code - it only points the public app at this server; the
person then signs in with their own number.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

import aiosqlite
import segno
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import access, auth_v2, netinfo, schema_v2, security
from .access import now_iso
from .live import hub

router = APIRouter(tags=["phones"])
DB = Depends(schema_v2.get_db)
USER = Depends(auth_v2.current_gov_user)

ENROLL_TTL_MIN = 30


def _hash(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def _qr(payload: dict) -> str:
    text = json.dumps(payload, separators=(",", ":"))
    return segno.make(text, error="m").svg_inline(scale=5, border=2, dark="#0e1a2b", light="#ffffff")


# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

def _network() -> dict:
    return {"lan": netinfo.lan_addresses(), "tunnel": netinfo.tunnel.status(), "servers": netinfo.server_urls()}


@router.get("/gov/network")
async def network(user=USER):
    return {**_network(), "canManage": access.can_manage_network(user)}


class PublicReq(BaseModel):
    enabled: bool


@router.post("/gov/network/public")
async def set_public(body: PublicReq, conn: aiosqlite.Connection = DB, user=USER):
    if not access.can_manage_network(user):
        raise HTTPException(403, "only the control room or FEAR's admin can open the server to the internet")
    st = await netinfo.tunnel.start() if body.enabled else netinfo.tunnel.stop()
    netinfo.set_public_wanted(body.enabled)
    await access.audit(conn, "gov", user["id"], "network.public.on" if body.enabled else "network.public.off", reason=st.get("url"))
    return {**_network(), "canManage": True}


# ---------------------------------------------------------------------------
# Issuing phone logins
# ---------------------------------------------------------------------------

def _require_enroll(user) -> None:
    if not access.can_enroll_phones(user):
        raise HTTPException(403, "your account can't issue phone logins")


async def _allowed_orgs(conn, user) -> list:
    cur = await conn.execute("SELECT * FROM organizations WHERE kind != 'platform' ORDER BY name")
    orgs = [dict(r) for r in await cur.fetchall()]
    if user["role"] == "org_admin":
        scope = await access.org_subtree(conn, user["org_id"])
        orgs = [o for o in orgs if o["id"] in scope]
    out = []
    for o in orgs:
        cats = access.ORG_VEHICLE_CATEGORIES.get(o["kind"], ())
        if cats:
            out.append({"id": o["id"], "name": o["name"], "kind": o["kind"], "verified": bool(o["verified"]),
                        "categories": [{"id": c, "label": access.VEHICLE_CATEGORIES[c][0]} for c in cats]})
    return out


@router.get("/gov/phones/options")
async def phone_options(conn: aiosqlite.Connection = DB, user=USER):
    _require_enroll(user)
    cur = await conn.execute(
        """SELECT v.id, v.category, v.plate, o.name AS org_name, d.full_name FROM fleet_vehicles v
           JOIN organizations o ON o.id = v.org_id
           JOIN assignments a ON a.vehicle_id = v.id AND a.revoked_at IS NULL
           JOIN drivers d ON d.id = a.driver_id WHERE v.deleted_at IS NULL ORDER BY v.category, v.id""")
    vehicles = [dict(r) for r in await cur.fetchall()]
    if user["role"] == "org_admin":
        scope = await access.org_subtree(conn, user["org_id"])
        cur = await conn.execute("SELECT id, org_id FROM fleet_vehicles")
        own = {r["id"] for r in await cur.fetchall() if r["org_id"] in scope}
        vehicles = [v for v in vehicles if v["id"] in own]
    else:
        # Outside the employing organization the driver is not named.
        for v in vehicles:
            v.pop("full_name", None)
    from .public_api import CITIZEN_VEHICLE_TYPES

    return {"orgs": await _allowed_orgs(conn, user), "vehicles": vehicles, "network": _network(),
            "publicVehicleTypes": list(CITIZEN_VEHICLE_TYPES)}


class PhoneReq(BaseModel):
    # Government mode: "driver" (new vehicle + driver) or "existing_driver".
    # Public mode: "citizen" (new FEAR app user with a vehicle) or "connect".
    # Existing accounts, no new account made: "self" (sign my own phone in),
    # "existing_user" (an employee, by username), "existing_citizen" (a FEAR
    # app user, by mobile number).
    kind: Literal["driver", "existing_driver", "citizen", "connect", "self", "existing_user", "existing_citizen"]
    username: Optional[str] = Field(default=None, max_length=64)
    org_id: Optional[str] = None
    category: Optional[str] = None          # government vehicle type: ambulance, firetruck, police, bus, ...
    vehicle_type: Optional[str] = None      # public vehicle type: car, motorcycle, bus, truck, ...
    name: Optional[str] = Field(default=None, max_length=120)
    address: Optional[str] = Field(default=None, max_length=400)
    plate: Optional[str] = Field(default=None, max_length=40)
    vehicle_id: Optional[str] = None
    phone: Optional[str] = Field(default=None, max_length=20)


def _required(**fields) -> None:
    missing = [k.replace("_", " ") for k, v in fields.items() if not (v or "").strip()]
    if missing:
        raise HTTPException(400, "please fill in: " + ", ".join(missing))


async def _issue(conn, user, *, app: str, subject_type: Optional[str], subject_id: Optional[str], label: str,
                 org_id: Optional[str] = None) -> dict:
    # Every QR works on the same Wi-Fi AND anywhere on the internet: the
    # public link is switched on (if it isn't already) before the code is made.
    public = await netinfo.ensure_public()
    if public.get("url") and not netinfo.tunnel_was_on_audited:
        netinfo.tunnel_was_on_audited = True
        await access.audit(conn, "gov", user["id"], "network.public.on", reason=f"for a sign-in QR: {public.get('url')}")
    servers = netinfo.server_urls()
    payload = {"fear": 1, "app": app, "servers": servers}
    eid = schema_v2.new_id("ENR", 3)
    expires = (datetime.now(timezone.utc) + timedelta(minutes=ENROLL_TTL_MIN)).isoformat()
    code = None
    if subject_type is not None:
        code = secrets.token_urlsafe(18)
        payload["code"] = code
    await conn.execute(
        """INSERT INTO enrollments(id, code_hash, app, subject_type, subject_id, label, org_id, created_by, created_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (eid, _hash(code) if code else None, app, subject_type, subject_id, label, org_id, user["id"], now_iso(), expires))
    await conn.commit()
    return {"id": eid, "label": label, "app": app, "expiresAt": expires if code else None, "servers": servers,
            "payload": payload, "qrSvg": _qr(payload),
            "publicLink": public.get("url"), "publicReachable": public.get("reachable", False),
            "publicError": None if public.get("url") else (public.get("error") or "the public link could not be started")}


@router.post("/gov/phones")
async def create_phone_login(body: PhoneReq, conn: aiosqlite.Connection = DB, user=USER):
    if body.kind == "self":
        # Anyone signed in to FEAR Command can sign their own phone in as themselves.
        await access.audit(conn, "gov", user["id"], "phone.self", "gov_user", user["id"], user["org_id"])
        res = await _issue(conn, user, app="gov", subject_type="gov", subject_id=user["id"],
                           label=f"{user['display_name']} ({user['username']}) - own phone", org_id=user["org_id"])
        return {"enrollment": res, "username": user["username"]}

    _require_enroll(user)

    if body.kind == "existing_user":
        cur = await conn.execute("SELECT id FROM gov_users WHERE lower(username)=lower(?) AND deleted_at IS NULL",
                                 ((body.username or "").strip(),))
        r = await cur.fetchone()
        target = await auth_v2.load_gov_user(conn, r["id"]) if r else None
        if target is None or not target["active"]:
            raise HTTPException(404, "no active account with that username")
        if not await _may_sign_in_for(conn, user, target):
            raise HTTPException(403, "you can only sign in phones for staff of your own organization or those below it")
        await access.audit(conn, "gov", user["id"], "phone.existing_user", "gov_user", target["id"], target["org_id"])
        res = await _issue(conn, user, app="gov", subject_type="gov", subject_id=target["id"],
                           label=f"{target['display_name']} ({target['username']})", org_id=target["org_id"])
        return {"enrollment": res, "username": target["username"]}

    if body.kind == "existing_citizen":
        from .public_api import normalize_phone

        if not (user["role"] == "super_admin" or (user["role"] == "operator" and user["authority"] == "iccc")):
            raise HTTPException(403, "FEAR app users are signed in by the control room or FEAR's admin")
        _required(mobile_number=body.phone)
        cur = await conn.execute("SELECT id, name, phone FROM citizens WHERE phone=? AND deleted_at IS NULL", (normalize_phone(body.phone),))
        c = await cur.fetchone()
        if c is None:
            raise HTTPException(404, "no FEAR app account with that mobile number")
        await access.audit(conn, "gov", user["id"], "phone.existing_citizen", "citizen", c["id"])
        res = await _issue(conn, user, app="public", subject_type="citizen", subject_id=c["id"],
                           label=f"{c['name'] or 'FEAR app user'} · {c['phone']}")
        return {"enrollment": res, "citizenId": c["id"], "username": c["phone"]}

    if body.kind == "connect":
        res = await _issue(conn, user, app="public", subject_type=None, subject_id=None, label="Public app - connect to this server")
        return {"enrollment": res}

    if body.kind == "citizen":
        from .public_api import CITIZEN_VEHICLE_TYPES, PLATE_RE, normalize_phone

        _required(name=body.name, mobile_number=body.phone, address=body.address, vehicle_plate=body.plate, vehicle_type=body.vehicle_type)
        phone = normalize_phone(body.phone)
        plate = body.plate.strip().upper()
        if not PLATE_RE.match(plate):
            raise HTTPException(400, "that doesn't look like an Indian registration number (e.g. UP14 AB 1234)")
        if body.vehicle_type not in CITIZEN_VEHICLE_TYPES:
            raise HTTPException(400, "unknown vehicle type")
        cur = await conn.execute("SELECT id FROM citizens WHERE phone=? AND deleted_at IS NULL", (phone,))
        r = await cur.fetchone()
        if r:
            cid = r["id"]
            await conn.execute("UPDATE citizens SET name=?, address=? WHERE id=?", (body.name.strip(), body.address.strip(), cid))
        else:
            cid = schema_v2.new_id("CIT", 4)
            await conn.execute("INSERT INTO citizens(id, phone, name, address, share_traffic, created_at) VALUES (?,?,?,?,1,?)",
                               (cid, phone, body.name.strip(), body.address.strip(), now_iso()))
        cur = await conn.execute("SELECT 1 FROM citizen_vehicles WHERE citizen_id=? AND plate=?", (cid, plate))
        if await cur.fetchone() is None:
            await conn.execute(
                "INSERT INTO citizen_vehicles(id, citizen_id, plate, vehicle_type, rto_status, created_at) VALUES (?,?,?,?,'pending',?)",
                (schema_v2.new_id("CV", 4), cid, plate, body.vehicle_type, now_iso()))
        # A password too, so the person can sign in on any phone by typing
        # their mobile number - no QR needed. Only for an account without one
        # (an existing password is never reset from here); shown once.
        cur = await conn.execute("SELECT pw_hash FROM citizens WHERE id=?", (cid,))
        password = None
        if not (await cur.fetchone())["pw_hash"]:
            password = security.gen_password()
            pw_hash, salt = security.hash_password(password)
            await conn.execute("UPDATE citizens SET pw_hash=?, pw_salt=? WHERE id=?", (pw_hash, salt, cid))
        await access.audit(conn, "gov", user["id"], "phone.citizen", "citizen", cid)
        res = await _issue(conn, user, app="public", subject_type="citizen", subject_id=cid,
                           label=f"{body.name.strip()} · {plate}")
        return {"enrollment": res, "citizenId": cid, "username": phone, "password": password}

    if body.kind == "existing_driver":
        cur = await conn.execute(
            """SELECT v.id, v.org_id, g.id AS user_id, g.username FROM fleet_vehicles v
               JOIN assignments a ON a.vehicle_id=v.id AND a.revoked_at IS NULL
               JOIN drivers d ON d.id=a.driver_id JOIN gov_users g ON g.id=d.gov_user_id WHERE v.id=?""",
            (body.vehicle_id,))
        r = await cur.fetchone()
        if r is None:
            raise HTTPException(404, "that vehicle has no assigned driver")
        if user["role"] == "org_admin" and r["org_id"] not in await access.org_subtree(conn, user["org_id"]):
            raise HTTPException(403, "not your organization's vehicle")
        await access.audit(conn, "gov", user["id"], "phone.driver_existing", "vehicle", r["id"], r["org_id"])
        res = await _issue(conn, user, app="gov", subject_type="gov", subject_id=r["user_id"],
                           label=f"{r['id']} ({r['username']})", org_id=r["org_id"])
        return {"enrollment": res, "vehicleId": r["id"], "username": r["username"]}

    # kind == "driver": a new vehicle + driver + assignment in one go
    from .public_api import normalize_phone

    _required(name=body.name, mobile_number=body.phone, address=body.address, vehicle_plate=body.plate)
    driver_phone = normalize_phone(body.phone)
    orgs = {o["id"]: o for o in await _allowed_orgs(conn, user)}
    org = orgs.get(body.org_id or "")
    if org is None:
        raise HTTPException(400, "pick an organization you can register vehicles for")
    cats = [c["id"] for c in org["categories"]]
    category = body.category or cats[0]
    if category not in cats:
        raise HTTPException(400, f"{org['name']} can't register a {category}")
    name = body.name.strip()
    prefix = access.VEHICLE_CATEGORIES[category][1]
    for _ in range(30):
        vid = f"FEAR-{prefix}-{secrets.randbelow(9000) + 1000}"
        cur = await conn.execute("SELECT 1 FROM fleet_vehicles WHERE id=?", (vid,))
        if await cur.fetchone() is None:
            break
    plate = body.plate.strip().upper()
    username = security.gen_username("drv-")
    password = security.gen_password()
    pw_hash, salt = security.hash_password(password)
    uid, did = schema_v2.new_id("USR", 3), schema_v2.new_id("DRV", 3)
    now = now_iso()
    await conn.execute("INSERT INTO fleet_vehicles(id, org_id, category, plate, make_model, verified, active, created_at) VALUES (?,?,?,?,?,1,1,?)",
                       (vid, org["id"], category, plate, "Phone-tracked vehicle", now))
    await conn.execute("""INSERT INTO gov_users(id, username, pw_hash, pw_salt, display_name, role, org_id, authority, active, created_at)
                          VALUES (?,?,?,?,?,'driver',?,NULL,1,?)""", (uid, username, pw_hash, salt, name, org["id"], now))
    await conn.execute("INSERT INTO drivers(id, gov_user_id, org_id, full_name, phone, licence_no, address, created_at) VALUES (?,?,?,?,?,?,?,?)",
                       (did, uid, org["id"], name, driver_phone, "-", body.address.strip(), now))
    await conn.execute("INSERT INTO assignments(id, vehicle_id, driver_id, assigned_by, assigned_at) VALUES (?,?,?,?,?)",
                       (schema_v2.new_id("ASG", 3), vid, did, user["id"], now))
    await access.audit(conn, "gov", user["id"], "phone.driver_new", "vehicle", vid, org["id"])
    await hub.refresh_unit(conn, vid)
    hub.bump()
    res = await _issue(conn, user, app="gov", subject_type="gov", subject_id=uid, label=f"{vid} · {plate} ({name})", org_id=org["id"])
    return {"enrollment": res, "vehicleId": vid, "username": username, "password": password}


async def _may_sign_in_for(conn, user, target) -> bool:
    """Signing a phone in as an existing employee: FEAR's admin for anyone but
    another super admin; the control room for drivers; an organization admin
    for drivers and admins of their own organization and those below it."""
    if target["role"] == "super_admin":
        return target["id"] == user["id"]
    if user["role"] == "super_admin":
        return True
    if user["role"] == "operator" and user["authority"] == "iccc":
        return target["role"] == "driver"
    if user["role"] == "org_admin" and target["org_id"]:
        return target["role"] in ("driver", "org_admin") and target["org_id"] in await access.org_subtree(conn, user["org_id"])
    return False


@router.get("/gov/phones")
async def list_phone_logins(conn: aiosqlite.Connection = DB, user=USER):
    _require_enroll(user)
    cur = await conn.execute("SELECT * FROM enrollments ORDER BY created_at DESC LIMIT 100")
    rows = [dict(r) for r in await cur.fetchall()]
    if user["role"] == "org_admin":
        scope = await access.org_subtree(conn, user["org_id"])
        rows = [r for r in rows if r["org_id"] in scope]
    now = now_iso()
    out = []
    for r in rows:
        status = "used" if r["used_at"] else ("expired" if r["expires_at"] < now else "waiting")
        if r["subject_type"] is None:
            status = "connect"
        out.append({"id": r["id"], "label": r["label"], "app": r["app"], "status": status,
                    "createdAt": r["created_at"], "usedAt": r["used_at"], "expiresAt": r["expires_at"]})
    return out


# ---------------------------------------------------------------------------
# Redeeming a code on the phone
# ---------------------------------------------------------------------------

class RedeemReq(BaseModel):
    code: str = Field(min_length=10, max_length=100)


@router.post("/v2/enroll")
async def redeem(body: RedeemReq, conn: aiosqlite.Connection = DB):
    cur = await conn.execute("SELECT * FROM enrollments WHERE code_hash=?", (_hash(body.code),))
    e = await cur.fetchone()
    if e is None:
        raise HTTPException(404, "this QR code isn't valid on this server")
    if e["used_at"]:
        raise HTTPException(409, "this QR code was already used - ask Command for a new one")
    if e["expires_at"] < now_iso():
        raise HTTPException(410, "this QR code has expired - ask Command for a new one")
    await conn.execute("UPDATE enrollments SET used_at=? WHERE id=?", (now_iso(), e["id"]))
    await conn.commit()
    if e["subject_type"] == "gov":
        u = await auth_v2.load_gov_user(conn, e["subject_id"])
        if u is None or not u["active"] or u["deleted_at"]:
            raise HTTPException(403, "that account is disabled")
        token = await auth_v2.create_session(conn, "gov", u["id"])
        from .gov_api import _profile

        await access.audit(conn, "gov", u["id"], "login.qr", org_id=u["org_id"])
        return {"app": "gov", "token": token, "user": _profile(u)}
    if e["subject_type"] == "citizen":
        token = await auth_v2.create_session(conn, "citizen", e["subject_id"])
        from .public_api import _me

        return {"app": "public", "token": token, "me": await _me(conn, e["subject_id"])}
    raise HTTPException(400, "nothing to sign in to")
