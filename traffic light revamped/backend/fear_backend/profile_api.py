"""People's own accounts - the "Me" screens of both apps - and the requests
they can raise, reviewed in FEAR Command.

Citizens (FEAR app): see and edit their name and address, change their phone
number (verified by a code sent to the NEW number), set or change a password
(so they can sign in without an OTP), and ask for their account to be
deleted or for one of their vehicles to be transferred to another registered
user.

Drivers (FEAR Command app): see their own record, update their phone and
address, change their password, and ask for their account to be closed.

Requests are reviewed in FEAR Command: account deletions of citizens by
FEAR's super admin, vehicle transfers by the RTO desk (or the super admin),
drivers' requests by their organization's admin.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import access, auth_v2, providers, schema_v2, security
from .access import now_iso
from .live import hub

router = APIRouter(tags=["profile"])
DB = Depends(schema_v2.get_db)
CITIZEN = Depends(auth_v2.current_citizen)
GOV = Depends(auth_v2.current_gov_user)

MIN_PASSWORD = 8


def _check_password(pw: str) -> None:
    if len(pw) < MIN_PASSWORD or not re.search(r"[A-Za-z]", pw) or not re.search(r"\d", pw):
        raise HTTPException(400, f"use at least {MIN_PASSWORD} characters with letters and numbers")


async def citizen_view(conn, cid: str) -> dict:
    cur = await conn.execute("SELECT * FROM citizens WHERE id=?", (cid,))
    c = await cur.fetchone()
    return {"id": c["id"], "phone": c["phone"], "name": c["name"], "address": c["address"],
            "shareTraffic": bool(c["share_traffic"]), "hasPassword": bool(c["pw_hash"]), "createdAt": c["created_at"]}


async def anonymize_citizen(conn, cid: str) -> None:
    """Deletes a citizen's personal data. Past incidents stay on record without
    any link back to the person."""
    await conn.execute("DELETE FROM citizen_vehicles WHERE citizen_id=?", (cid,))
    await conn.execute("UPDATE incident_contacts SET citizen_id=NULL, name=NULL, phone=NULL, sharing_active=0 WHERE citizen_id=?", (cid,))
    await conn.execute("UPDATE incidents SET reporter_citizen_id=NULL WHERE reporter_citizen_id=?", (cid,))
    await conn.execute("UPDATE citizens SET phone=NULL, name=NULL, address=NULL, pw_hash=NULL, pw_salt=NULL, share_traffic=0, deleted_at=? WHERE id=?",
                       (now_iso(), cid))
    await conn.execute("DELETE FROM sessions WHERE subject_type='citizen' AND subject_id=?", (cid,))


# ---------------------------------------------------------------------------
# Citizens
# ---------------------------------------------------------------------------

class PasswordLoginReq(BaseModel):
    phone: str
    password: str


@router.post("/public/auth/login")
async def citizen_password_login(body: PasswordLoginReq, conn: aiosqlite.Connection = DB):
    from .public_api import normalize_phone

    phone = normalize_phone(body.phone)
    cur = await conn.execute("SELECT * FROM citizens WHERE phone=? AND deleted_at IS NULL", (phone,))
    c = await cur.fetchone()
    if c is None or not c["pw_hash"] or not security.verify_password(body.password, c["pw_hash"], c["pw_salt"]):
        raise HTTPException(401, "wrong number or password (no password set yet? sign in with a code)")
    token = await auth_v2.create_session(conn, "citizen", c["id"])
    return {"token": token, "me": await citizen_view(conn, c["id"])}


class CitizenPasswordReq(BaseModel):
    current_password: Optional[str] = None
    new_password: str = Field(min_length=1, max_length=128)


@router.post("/public/me/password")
async def citizen_set_password(body: CitizenPasswordReq, conn: aiosqlite.Connection = DB, me=CITIZEN):
    if me["pw_hash"] and not security.verify_password(body.current_password or "", me["pw_hash"], me["pw_salt"]):
        raise HTTPException(400, "current password is wrong")
    _check_password(body.new_password)
    h, s = security.hash_password(body.new_password)
    await conn.execute("UPDATE citizens SET pw_hash=?, pw_salt=? WHERE id=?", (h, s, me["id"]))
    await conn.commit()
    return await citizen_view(conn, me["id"])


class PhoneChangeReq(BaseModel):
    phone: str


@router.post("/public/me/phone/request")
async def citizen_phone_change_request(body: PhoneChangeReq, conn: aiosqlite.Connection = DB, me=CITIZEN):
    from .public_api import OtpReq, normalize_phone, otp_request

    phone = normalize_phone(body.phone)
    if phone == me["phone"]:
        raise HTTPException(400, "that is already your number")
    cur = await conn.execute("SELECT 1 FROM citizens WHERE phone=? AND deleted_at IS NULL", (phone,))
    if await cur.fetchone():
        raise HTTPException(409, "that number belongs to another FEAR account")
    return await otp_request(OtpReq(phone=phone), conn)


class PhoneVerifyReq(BaseModel):
    phone: str
    code: str = Field(min_length=6, max_length=6)


@router.post("/public/me/phone/verify")
async def citizen_phone_change_verify(body: PhoneVerifyReq, conn: aiosqlite.Connection = DB, me=CITIZEN):
    from .public_api import OTP_MAX_ATTEMPTS, normalize_phone

    phone = normalize_phone(body.phone)
    cur = await conn.execute("SELECT * FROM otp_requests WHERE phone=? AND consumed=0 ORDER BY id DESC LIMIT 1", (phone,))
    req = await cur.fetchone()
    if req is None or req["expires_at"] < now_iso():
        raise HTTPException(400, "code expired - request a new one")
    if req["attempts"] >= OTP_MAX_ATTEMPTS:
        raise HTTPException(429, "too many wrong attempts - request a new code")
    if not security.verify_password(body.code, req["code_hash"], req["code_salt"]):
        await conn.execute("UPDATE otp_requests SET attempts=attempts+1 WHERE id=?", (req["id"],))
        await conn.commit()
        raise HTTPException(400, "wrong code")
    cur = await conn.execute("SELECT 1 FROM citizens WHERE phone=? AND deleted_at IS NULL AND id != ?", (phone, me["id"]))
    if await cur.fetchone():
        raise HTTPException(409, "that number belongs to another FEAR account")
    await conn.execute("UPDATE otp_requests SET consumed=1 WHERE id=?", (req["id"],))
    await conn.execute("UPDATE citizens SET phone=? WHERE id=?", (phone, me["id"]))
    await conn.commit()
    return await citizen_view(conn, me["id"])


class CitizenRequestReq(BaseModel):
    kind: Literal["delete_account", "transfer_vehicle"]
    vehicle_id: Optional[str] = None
    target_phone: Optional[str] = None
    note: Optional[str] = Field(default=None, max_length=500)


@router.post("/public/requests")
async def citizen_request(body: CitizenRequestReq, conn: aiosqlite.Connection = DB, me=CITIZEN):
    from .public_api import normalize_phone

    target = None
    if body.kind == "transfer_vehicle":
        cur = await conn.execute("SELECT 1 FROM citizen_vehicles WHERE id=? AND citizen_id=?", (body.vehicle_id, me["id"]))
        if await cur.fetchone() is None:
            raise HTTPException(404, "vehicle not found")
        target = normalize_phone(body.target_phone or "")
        if target == me["phone"]:
            raise HTTPException(400, "that is your own number")
    cur = await conn.execute(
        "SELECT 1 FROM account_requests WHERE subject_type='citizen' AND subject_id=? AND kind=? AND status='pending' AND IFNULL(vehicle_id,'')=?",
        (me["id"], body.kind, body.vehicle_id or ""))
    if await cur.fetchone():
        raise HTTPException(409, "you already have this request pending")
    rid = schema_v2.new_id("REQ", 3)
    await conn.execute(
        """INSERT INTO account_requests(id, subject_type, subject_id, kind, vehicle_id, target_phone, note, status, created_at)
           VALUES (?,?,?,?,?,?,?,'pending',?)""",
        (rid, "citizen", me["id"], body.kind, body.vehicle_id, target, body.note, now_iso()))
    await conn.commit()
    hub.bump()
    return {"id": rid, "status": "pending"}


@router.get("/public/requests")
async def citizen_requests(conn: aiosqlite.Connection = DB, me=CITIZEN):
    cur = await conn.execute(
        """SELECT r.id, r.kind, r.vehicle_id, r.target_phone, r.status, r.created_at, r.reviewed_at, r.review_note, v.plate
           FROM account_requests r LEFT JOIN citizen_vehicles v ON v.id = r.vehicle_id
           WHERE r.subject_type='citizen' AND r.subject_id=? ORDER BY r.created_at DESC""", (me["id"],))
    return [dict(r) for r in await cur.fetchall()]


# ---------------------------------------------------------------------------
# Government accounts (drivers and everyone else signed in to FEAR Command)
# ---------------------------------------------------------------------------

@router.get("/gov/me/profile")
async def gov_profile(conn: aiosqlite.Connection = DB, user=GOV):
    out = {"username": user["username"], "displayName": user["display_name"], "role": user["role"],
           "orgName": user["org_name"], "driver": None, "vehicle": None}
    if user["role"] == "driver":
        cur = await conn.execute("SELECT * FROM drivers WHERE gov_user_id=?", (user["id"],))
        d = await cur.fetchone()
        if d:
            out["driver"] = {"fullName": d["full_name"], "phone": d["phone"], "address": d["address"], "licenceNo": d["licence_no"]}
            cur = await conn.execute(
                """SELECT v.id, v.category, v.plate, v.make_model FROM assignments a JOIN fleet_vehicles v ON v.id=a.vehicle_id
                   WHERE a.driver_id=? AND a.revoked_at IS NULL""", (d["id"],))
            v = await cur.fetchone()
            if v:
                out["vehicle"] = {"id": v["id"], "category": v["category"], "categoryLabel": access.VEHICLE_CATEGORIES[v["category"]][0],
                                  "plate": v["plate"], "makeModel": v["make_model"]}
        cur = await conn.execute("SELECT id, kind, status, created_at, review_note FROM account_requests WHERE subject_type='gov' AND subject_id=? ORDER BY created_at DESC",
                                 (user["id"],))
        out["requests"] = [dict(r) for r in await cur.fetchall()]
    return out


class GovPasswordReq(BaseModel):
    current_password: str
    new_password: str = Field(min_length=1, max_length=128)


@router.post("/gov/me/password")
async def gov_change_password(body: GovPasswordReq, conn: aiosqlite.Connection = DB, user=GOV):
    if not security.verify_password(body.current_password, user["pw_hash"], user["pw_salt"]):
        raise HTTPException(400, "current password is wrong")
    _check_password(body.new_password)
    h, s = security.hash_password(body.new_password)
    await conn.execute("UPDATE gov_users SET pw_hash=?, pw_salt=? WHERE id=?", (h, s, user["id"]))
    await access.audit(conn, "gov", user["id"], "user.password_changed", "gov_user", user["id"], user["org_id"])
    return {"ok": True}


class DriverProfileReq(BaseModel):
    phone: Optional[str] = Field(default=None, max_length=20)
    address: Optional[str] = Field(default=None, max_length=400)


@router.patch("/gov/me/profile")
async def driver_update_profile(body: DriverProfileReq, conn: aiosqlite.Connection = DB, user=GOV):
    auth_v2.require_roles(user, "driver")
    from .public_api import normalize_phone

    sets, args = [], []
    if body.phone is not None:
        sets.append("phone=?"); args.append(normalize_phone(body.phone))
    if body.address is not None:
        sets.append("address=?"); args.append(body.address.strip() or None)
    if sets:
        await conn.execute(f"UPDATE drivers SET {', '.join(sets)} WHERE gov_user_id=?", (*args, user["id"]))
        await access.audit(conn, "gov", user["id"], "driver.profile_updated", "gov_user", user["id"], user["org_id"])
    return await gov_profile(conn, user)


class GovRequestReq(BaseModel):
    kind: Literal["delete_account"]
    note: Optional[str] = Field(default=None, max_length=500)


@router.post("/gov/me/requests")
async def driver_request(body: GovRequestReq, conn: aiosqlite.Connection = DB, user=GOV):
    auth_v2.require_roles(user, "driver")
    cur = await conn.execute("SELECT 1 FROM account_requests WHERE subject_type='gov' AND subject_id=? AND kind=? AND status='pending'",
                             (user["id"], body.kind))
    if await cur.fetchone():
        raise HTTPException(409, "you already have this request pending")
    rid = schema_v2.new_id("REQ", 3)
    await conn.execute(
        """INSERT INTO account_requests(id, subject_type, subject_id, kind, note, org_id, status, created_at)
           VALUES (?,?,?,?,?,?,'pending',?)""", (rid, "gov", user["id"], body.kind, body.note, user["org_id"], now_iso()))
    await conn.commit()
    hub.bump()
    return {"id": rid, "status": "pending"}


# ---------------------------------------------------------------------------
# Reviewing requests in FEAR Command
# ---------------------------------------------------------------------------

async def _can_review(conn, user, r) -> bool:
    if user["role"] == "super_admin":
        return True
    if r["subject_type"] == "citizen" and r["kind"] == "transfer_vehicle":
        return user["role"] == "operator" and user["authority"] == "rto"
    if r["subject_type"] == "gov" and user["role"] == "org_admin":
        return r["org_id"] in await access.org_subtree(conn, user["org_id"])
    return False


@router.get("/gov/requests")
async def list_requests(status: str = "pending", conn: aiosqlite.Connection = DB, user=GOV):
    cur = await conn.execute(
        """SELECT r.*, c.name AS citizen_name, c.phone AS citizen_phone, v.plate, v.vehicle_type,
                  g.display_name AS gov_name, g.username AS gov_username
           FROM account_requests r
           LEFT JOIN citizens c ON r.subject_type='citizen' AND c.id = r.subject_id
           LEFT JOIN citizen_vehicles v ON v.id = r.vehicle_id
           LEFT JOIN gov_users g ON r.subject_type='gov' AND g.id = r.subject_id
           WHERE (?='all' OR r.status=?) ORDER BY r.created_at DESC LIMIT 200""", (status, status))
    out = []
    for r in await cur.fetchall():
        if await _can_review(conn, user, r):
            out.append({"id": r["id"], "kind": r["kind"], "status": r["status"], "createdAt": r["created_at"],
                        "who": r["citizen_name"] or r["gov_name"] or "-", "phone": r["citizen_phone"],
                        "username": r["gov_username"], "app": "public" if r["subject_type"] == "citizen" else "gov",
                        "vehicle": ({"plate": r["plate"], "type": r["vehicle_type"]} if r["vehicle_id"] else None),
                        "targetPhone": r["target_phone"], "note": r["note"], "reviewNote": r["review_note"]})
    return out


class ReviewReq(BaseModel):
    approve: bool
    note: Optional[str] = Field(default=None, max_length=300)


@router.post("/gov/requests/{request_id}")
async def review_request(request_id: str, body: ReviewReq, conn: aiosqlite.Connection = DB, user=GOV):
    cur = await conn.execute("SELECT * FROM account_requests WHERE id=?", (request_id,))
    r = await cur.fetchone()
    if r is None or not await _can_review(conn, user, r):
        raise HTTPException(404, "request not found")
    if r["status"] != "pending":
        raise HTTPException(409, f"already {r['status']}")
    if body.approve:
        if r["subject_type"] == "citizen" and r["kind"] == "delete_account":
            await anonymize_citizen(conn, r["subject_id"])
        elif r["subject_type"] == "citizen" and r["kind"] == "transfer_vehicle":
            cur = await conn.execute("SELECT id FROM citizens WHERE phone=? AND deleted_at IS NULL", (r["target_phone"],))
            target = await cur.fetchone()
            if target is None:
                raise HTTPException(409, f"{r['target_phone']} has no FEAR account - the recipient must sign up first")
            await conn.execute("UPDATE citizen_vehicles SET citizen_id=? WHERE id=?", (target["id"], r["vehicle_id"]))
        elif r["subject_type"] == "gov" and r["kind"] == "delete_account":
            from . import staff

            target = await auth_v2.load_gov_user(conn, r["subject_id"])
            if target is not None and not target["deleted_at"]:
                await staff.remove_user(conn, user["id"], target, reason="the employee asked for their account to be deleted")
    await conn.execute("UPDATE account_requests SET status=?, reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?",
                       ("approved" if body.approve else "rejected", user["id"], now_iso(), body.note, request_id))
    await access.audit(conn, "gov", user["id"], f"request.{r['kind']}.{'approve' if body.approve else 'reject'}", "request", request_id, r["org_id"])
    hub.bump()
    return {"ok": True}
