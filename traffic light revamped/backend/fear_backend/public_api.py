"""/public - the FEAR public app's API (citizens).

Privacy rules this module keeps:
  - A citizen's position is never stored or shown to Command, except the
    location they send with an SOS or a report (that becomes the incident's
    location) - and their contact details for an SOS, which only the
    authority handling it can open, and only until the incident closes.
  - Anonymous traffic sharing is opt-in; each ping is forwarded to the traffic
    engine under a rotating random tag and never written anywhere.
  - Nearby emergency vehicles are shown by category only - no vehicle id,
    organization or driver.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

import aiosqlite
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from . import access, auth_v2, geo, incidents, places, providers, routing, schema_v2, security, sim_bridge
from .access import now_iso
from .gov_api import active_alerts
from .live import hub

router = APIRouter(prefix="/public", tags=["public"])
DB = Depends(schema_v2.get_db)
CITIZEN = Depends(auth_v2.current_citizen)

OTP_TTL_SEC = 300
OTP_COOLDOWN_SEC = 30
OTP_MAX_PER_HOUR = 5
OTP_MAX_ATTEMPTS = 5
COVERAGE_MARGIN_DEG = 0.02  # ~2 km past the mapped area still counts as covered

SOS_KINDS = ("medical", "fire", "crime", "accident")
REPORT_KINDS = ("accident", "hazard", "road_blocked", "congestion", "fire", "other")
CITIZEN_VEHICLE_TYPES = ("car", "motorcycle", "scooter", "auto_rickshaw", "bus", "truck", "other")
PLATE_RE = re.compile(r"^[A-Z]{2}[ -]?\d{1,2}[ -]?[A-Z]{0,3}[ -]?\d{1,4}$")


def normalize_phone(raw: str) -> str:
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if not re.fullmatch(r"[6-9]\d{9}", digits):
        raise HTTPException(400, "enter a valid 10-digit Indian mobile number")
    return "+91" + digits


def _covered(lat: float, lon: float) -> None:
    if not geo.within_bounds(lat, lon, places.meta().get("bounds"), COVERAGE_MARGIN_DEG):
        raise HTTPException(422, "this location is outside FEAR's current coverage area - call 112")


def _ago(seconds: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


# ---------------------------------------------------------------------------
# Sign-in
# ---------------------------------------------------------------------------

class OtpReq(BaseModel):
    phone: str


@router.post("/auth/otp/request")
async def otp_request(body: OtpReq, conn: aiosqlite.Connection = DB):
    phone = normalize_phone(body.phone)
    cur = await conn.execute("SELECT created_at FROM otp_requests WHERE phone=? AND created_at >= ? ORDER BY id DESC",
                             (phone, _ago(3600)))
    recent = await cur.fetchall()
    if len(recent) >= OTP_MAX_PER_HOUR:
        raise HTTPException(429, "too many codes requested - try again in an hour")
    if recent and recent[0]["created_at"] >= _ago(OTP_COOLDOWN_SEC):
        raise HTTPException(429, f"wait {OTP_COOLDOWN_SEC} seconds before asking for another code")
    code = f"{secrets.randbelow(1_000_000):06d}"
    code_hash, salt = security.hash_password(code)
    expires = (datetime.now(timezone.utc) + timedelta(seconds=OTP_TTL_SEC)).isoformat()
    await conn.execute("UPDATE otp_requests SET consumed=1 WHERE phone=? AND consumed=0", (phone,))
    await conn.execute("INSERT INTO otp_requests(phone, code_hash, code_salt, expires_at, created_at) VALUES (?,?,?,?,?)",
                       (phone, code_hash, salt, expires, now_iso()))
    await providers.otp_sender().send(conn, phone, code)
    await conn.commit()
    return {"ok": True, "phone": phone, "expiresInSec": OTP_TTL_SEC, "devMode": providers.DEV_MODE}


class OtpVerifyReq(BaseModel):
    phone: str
    code: str = Field(min_length=6, max_length=6)
    name: Optional[str] = Field(default=None, max_length=120)


@router.post("/auth/otp/verify")
async def otp_verify(body: OtpVerifyReq, conn: aiosqlite.Connection = DB):
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
    await conn.execute("UPDATE otp_requests SET consumed=1 WHERE id=?", (req["id"],))
    cur = await conn.execute("SELECT * FROM citizens WHERE phone=? AND deleted_at IS NULL", (phone,))
    c = await cur.fetchone()
    is_new = c is None
    if is_new:
        cid = schema_v2.new_id("CIT", 4)
        # Anonymous traffic sharing starts on (the app says so on first launch
        # and it can be turned off under Me) - it is what lets the signals see
        # real traffic in realistic mode.
        await conn.execute("INSERT INTO citizens(id, phone, name, share_traffic, created_at) VALUES (?,?,?,1,?)",
                           (cid, phone, (body.name or "").strip() or None, now_iso()))
    else:
        cid = c["id"]
        if body.name and not c["name"]:
            await conn.execute("UPDATE citizens SET name=? WHERE id=?", (body.name.strip(), cid))
    await conn.commit()
    token = await auth_v2.create_session(conn, "citizen", cid)
    return {"token": token, "isNew": is_new, "me": await _me(conn, cid)}


async def _me(conn, cid: str) -> dict:
    from .profile_api import citizen_view

    return await citizen_view(conn, cid)


@router.post("/auth/logout")
async def logout(authorization: Optional[str] = Header(None), conn: aiosqlite.Connection = DB, me=CITIZEN):
    tok = auth_v2.bearer(authorization)
    await conn.execute("DELETE FROM sessions WHERE token=?", (tok,))
    await conn.commit()
    return {"ok": True}


@router.get("/me")
async def get_me(conn: aiosqlite.Connection = DB, me=CITIZEN):
    return await _me(conn, me["id"])


class MeReq(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)
    address: Optional[str] = Field(default=None, max_length=400)
    share_traffic: Optional[bool] = None


@router.patch("/me")
async def update_me(body: MeReq, conn: aiosqlite.Connection = DB, me=CITIZEN):
    if body.name is not None:
        await conn.execute("UPDATE citizens SET name=? WHERE id=?", (body.name.strip() or None, me["id"]))
    if body.address is not None:
        await conn.execute("UPDATE citizens SET address=? WHERE id=?", (body.address.strip() or None, me["id"]))
    if body.share_traffic is not None:
        await conn.execute("UPDATE citizens SET share_traffic=? WHERE id=?", (int(body.share_traffic), me["id"]))
    await conn.commit()
    return await _me(conn, me["id"])


# ---------------------------------------------------------------------------
# Vehicles (registration verified by the RTO queue in FEAR Command)
# ---------------------------------------------------------------------------

@router.get("/vehicles")
async def my_vehicles(conn: aiosqlite.Connection = DB, me=CITIZEN):
    cur = await conn.execute(
        "SELECT id, plate, vehicle_type, make_model, rto_status, review_note, created_at FROM citizen_vehicles WHERE citizen_id=? ORDER BY created_at",
        (me["id"],))
    return [dict(r) for r in await cur.fetchall()]


class CitizenVehicleReq(BaseModel):
    plate: str = Field(min_length=4, max_length=16)
    vehicle_type: str
    make_model: Optional[str] = Field(default=None, max_length=80)


@router.post("/vehicles")
async def add_vehicle(body: CitizenVehicleReq, conn: aiosqlite.Connection = DB, me=CITIZEN):
    plate = body.plate.strip().upper()
    if not PLATE_RE.match(plate):
        raise HTTPException(400, "that doesn't look like an Indian registration number (e.g. UP14 AB 1234)")
    if body.vehicle_type not in CITIZEN_VEHICLE_TYPES:
        raise HTTPException(400, "unknown vehicle type")
    cur = await conn.execute("SELECT COUNT(*) AS n FROM citizen_vehicles WHERE citizen_id=?", (me["id"],))
    if (await cur.fetchone())["n"] >= 10:
        raise HTTPException(409, "you can register up to 10 vehicles")
    vid = schema_v2.new_id("CV", 4)
    await conn.execute(
        "INSERT INTO citizen_vehicles(id, citizen_id, plate, vehicle_type, make_model, rto_status, created_at) VALUES (?,?,?,?,?,'pending',?)",
        (vid, me["id"], plate, body.vehicle_type, body.make_model, now_iso()))
    await conn.commit()
    return {"id": vid, "rto_status": "pending"}


@router.delete("/vehicles/{vehicle_id}")
async def remove_vehicle(vehicle_id: str, conn: aiosqlite.Connection = DB, me=CITIZEN):
    await conn.execute("DELETE FROM citizen_vehicles WHERE id=? AND citizen_id=?", (vehicle_id, me["id"]))
    await conn.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# SOS and reports
# ---------------------------------------------------------------------------

class VoiceMeta(BaseModel):
    """Sent along with a note that came from /public/voice."""
    language: Optional[str] = Field(default=None, max_length=16)
    original: Optional[str] = Field(default=None, max_length=1500)


class SosReq(BaseModel):
    kind: Literal["medical", "fire", "crime", "accident"]
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    note: Optional[str] = Field(default=None, max_length=1500)
    share_contact: bool = True
    demo: bool = False
    voice: Optional[VoiceMeta] = None


async def _triage_new(conn, inc_id: str, text: Optional[str], kind: str, source: str, voice: Optional[VoiceMeta]) -> None:
    """Rule triage now (instant), Sarvam's refinement in the background."""
    from . import triage

    if voice is not None:
        await conn.execute("UPDATE incidents SET voice=? WHERE id=?", (json.dumps(voice.model_dump()), inc_id))
    await triage.store(conn, inc_id, triage.merge(triage.rules(text or "", kind, source), None, text or ""))
    await conn.commit()
    triage.schedule_ai(inc_id)


@router.post("/sos")
async def sos(body: SosReq, conn: aiosqlite.Connection = DB, me=CITIZEN):
    _covered(body.lat, body.lon)
    cur = await conn.execute(
        f"""SELECT id FROM incidents WHERE reporter_citizen_id=? AND source='sos'
            AND status IN ({','.join('?' * len(incidents.OPEN_INCIDENT))})""",
        (me["id"], *incidents.OPEN_INCIDENT))
    open_sos = await cur.fetchone()
    if open_sos:
        return {"id": open_sos["id"], "existing": True}
    contact = {"citizen_id": me["id"], "name": me["name"], "phone": me["phone"]} if body.share_contact else None
    inc_id = await incidents.create(conn, kind=body.kind, source="sos", lat=body.lat, lon=body.lon,
                                    description=body.note, severity="high", reporter_citizen_id=me["id"],
                                    demo=body.demo, contact=contact)
    await _triage_new(conn, inc_id, body.note, body.kind, "sos", body.voice)
    return {"id": inc_id, "existing": False}


class DetailsReq(BaseModel):
    note: str = Field(min_length=1, max_length=1500)
    voice: Optional[VoiceMeta] = None


@router.post("/sos/{incident_id}/details")
async def sos_details(incident_id: str, body: DetailsReq, conn: aiosqlite.Connection = DB, me=CITIZEN):
    """The caller tells Command more (typed or by voice) while help is
    coming; the incident is re-triaged with it."""
    inc = await incidents.get(conn, incident_id)
    if inc["reporter_citizen_id"] != me["id"]:
        raise HTTPException(404, "not found")
    if inc["status"] not in incidents.OPEN_INCIDENT:
        raise HTTPException(409, "this incident is closed")
    text = ((inc["description"] or "") + "\n" + body.note.strip()).strip()[-3000:]
    await conn.execute("UPDATE incidents SET description=? WHERE id=?", (text, incident_id))
    if body.voice is not None:
        await conn.execute("UPDATE incidents SET voice=? WHERE id=?", (json.dumps(body.voice.model_dump()), incident_id))
    await incidents.event(conn, incident_id, "caller", "Caller added details" + (" (voice)" if body.voice else ""), public=True)
    from . import triage

    await triage.store(conn, incident_id, triage.merge(triage.rules(text, inc["kind"], inc["source"]), None, text))
    await conn.commit()
    triage.schedule_ai(incident_id)
    hub.bump()
    return await incidents.citizen_view(conn, incident_id)


# Voice reports: at most this many transcriptions per person per 10 minutes.
VOICE_PER_10_MIN = 20
VOICE_MAX_BYTES = 3 * 1024 * 1024
_voice_calls: dict = {}


@router.post("/voice")
async def voice(request: Request, kind: str = "accident", me=CITIZEN):
    """Speech to text for a report or SOS: the recorded clip (under 30 s,
    any common format) as the request body. Returns the English text (and the
    words as spoken, for other languages) with a triage preview - nothing is
    stored, the clip included; the person reviews the text and sends it as
    the note of their report."""
    from . import sarvam, triage

    if not sarvam.available():
        raise HTTPException(503, "voice reports aren't set up on this server - please type it")
    now = time.monotonic()
    calls = [t for t in _voice_calls.get(me["id"], []) if now - t < 600]
    if len(calls) >= VOICE_PER_10_MIN:
        raise HTTPException(429, "too many voice reports in a few minutes - please type it")
    audio = await request.body()
    if not audio:
        raise HTTPException(400, "no audio received")
    if len(audio) > VOICE_MAX_BYTES:
        raise HTTPException(413, "recording too long - keep it under 30 seconds")
    _voice_calls[me["id"]] = calls + [now]
    ctype = (request.headers.get("content-type") or "audio/wav").split(";")[0].strip()
    ext = {"audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/aac": "aac",
           "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/webm": "webm", "audio/flac": "flac"}.get(ctype, "wav")
    try:
        t = await sarvam.transcribe_report(audio, f"report.{ext}", ctype)
    except sarvam.SarvamError as e:
        raise HTTPException(502, f"couldn't transcribe the recording - please type it ({e})")
    if not t["transcript"]:
        raise HTTPException(422, "couldn't hear anything in the recording - try again closer to the phone")
    k = kind if kind in access.INCIDENT_KINDS else "accident"
    tri = await triage.analyze(t["transcript"], k, "report", ai_timeout=8)
    return {**t, "triage": {key: tri.get(key) for key in ("severity", "label", "terms", "injured", "vehicles",
                                                          "needs", "summary", "kindSuggestion", "method")}}


@router.post("/sos/{incident_id}/cancel")
async def cancel_sos(incident_id: str, conn: aiosqlite.Connection = DB, me=CITIZEN):
    inc = await incidents.get(conn, incident_id)
    if inc["reporter_citizen_id"] != me["id"] or inc["source"] != "sos":
        raise HTTPException(404, "not found")
    if inc["status"] not in ("open", "dispatched"):
        raise HTTPException(409, "help is already on scene - this can no longer be cancelled from the app")
    await incidents.close(conn, incident_id, "caller", None, status="cancelled")
    await conn.commit()
    for u in hub.units.values():
        if u.on_duty and u.has_fix and not u.stale:
            await hub.forward_to_engine(u)
    return {"ok": True}


class ReportReq(BaseModel):
    kind: Literal["accident", "hazard", "road_blocked", "congestion", "fire", "other"]
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    note: Optional[str] = Field(default=None, max_length=1500)
    demo: bool = False
    voice: Optional[VoiceMeta] = None


@router.post("/reports")
async def report(body: ReportReq, conn: aiosqlite.Connection = DB, me=CITIZEN):
    _covered(body.lat, body.lon)
    cur = await conn.execute("SELECT COUNT(*) AS n FROM incidents WHERE reporter_citizen_id=? AND source='report' AND created_at >= ?",
                             (me["id"], _ago(3600)))
    if (await cur.fetchone())["n"] >= 10:
        raise HTTPException(429, "you've sent a lot of reports in the last hour - thank you, please try again later")
    inc_id = await incidents.create(conn, kind=body.kind, source="report", lat=body.lat, lon=body.lon,
                                    description=body.note, reporter_citizen_id=me["id"], demo=body.demo)
    await _triage_new(conn, inc_id, body.note, body.kind, "report", body.voice)
    return {"id": inc_id}


@router.get("/incidents")
async def my_incidents(conn: aiosqlite.Connection = DB, me=CITIZEN):
    cur = await conn.execute("SELECT * FROM incidents WHERE reporter_citizen_id=? ORDER BY created_at DESC LIMIT 50", (me["id"],))
    return [incidents.summary(r) for r in await cur.fetchall()]


@router.get("/incidents/{incident_id}")
async def my_incident(incident_id: str, conn: aiosqlite.Connection = DB, me=CITIZEN):
    inc = await incidents.get(conn, incident_id)
    if inc["reporter_citizen_id"] != me["id"]:
        raise HTTPException(404, "not found")
    return await incidents.citizen_view(conn, incident_id)


# ---------------------------------------------------------------------------
# Map: places, alerts, nearby emergency vehicles, navigation
# ---------------------------------------------------------------------------

@router.get("/meta")
async def meta():
    return {**places.meta(), "sosKinds": {k: access.INCIDENT_KINDS[k] for k in SOS_KINDS},
            "reportKinds": {k: access.INCIDENT_KINDS[k] for k in REPORT_KINDS},
            "vehicleTypes": list(CITIZEN_VEHICLE_TYPES), "devMode": providers.DEV_MODE}


@router.get("/places")
async def search_places(q: str = "", lat: Optional[float] = None, lon: Optional[float] = None, me=CITIZEN):
    """Autocomplete (see places.search): nearest-first around lat/lon - the
    person's location, or wherever they are looking on the map."""
    return await asyncio.to_thread(places.search, q, lat, lon)


@router.get("/places/at")
async def place_at(lat: float, lon: float, me=CITIZEN):
    """A name for a point picked on the map (the road it is on, else "near ...")."""
    return await asyncio.to_thread(places.at, lat, lon)


async def alerts_near(conn, lat: Optional[float], lon: Optional[float], within_m: float = 5000) -> list:
    out = []
    for a in await active_alerts(conn):
        if lat is not None and lon is not None:
            d = geo.distance_m(lat, lon, a["lat"], a["lon"])
            if d > a["radiusM"] + within_m:
                continue
            a = {**a, "distanceM": round(d), "inside": d <= a["radiusM"]}
        out.append(a)
    return out


@router.get("/alerts")
async def alerts(lat: Optional[float] = None, lon: Optional[float] = None, conn: aiosqlite.Connection = DB, me=CITIZEN):
    return await alerts_near(conn, lat, lon)


APPROACH_RADIUS_M = 800.0
ON_PATH_M = 60.0


def nearby_emergencies(lat: float, lon: float, radius_m: float = 2000.0) -> list:
    """Emergency vehicles currently responding near a point, by category only.
    `approaching` = its route ahead passes within ON_PATH_M of the point and it
    is less than APPROACH_RADIUS_M away - the app's "make way" warning."""
    out = []
    for u in hub.units.values():
        if not u.emergency_active or not u.has_fix or u.stale:
            continue
        d = geo.distance_m(lat, lon, u.lat, u.lon)
        if d > radius_m:
            continue
        ahead = hub.corridor(u, 1200.0) or []
        approaching = False
        if d <= APPROACH_RADIUS_M and len(ahead) >= 2:
            off, _ = geo.nearest_on_polyline(lat, lon, ahead)
            approaching = off <= ON_PATH_M
        out.append({"category": u.category, "categoryLabel": access.VEHICLE_CATEGORIES[u.category][0],
                    "lat": u.lat, "lon": u.lon, "heading": u.heading, "speedKmh": u.speed_kmh,
                    "distanceM": round(d), "approaching": approaching, "ahead": ahead})
    out.sort(key=lambda e: e["distanceM"])
    return out


@router.get("/nearby")
async def nearby(lat: float, lon: float, me=CITIZEN):
    return nearby_emergencies(lat, lon)


class RouteReq(BaseModel):
    from_lat: float
    from_lon: float
    to_lat: float
    to_lon: float


@router.post("/route")
async def route(body: RouteReq, conn: aiosqlite.Connection = DB, me=CITIZEN):
    _covered(body.from_lat, body.from_lon)
    _covered(body.to_lat, body.to_lon)
    res = await routing.route(body.from_lat, body.from_lon, body.to_lat, body.to_lon)
    if not res or not res.get("found"):
        return {"found": False, "error": (res or {}).get("error", "no route found")}
    pts = res["points"]
    warnings = []
    for a in await active_alerts(conn):
        d, _ = geo.nearest_on_polyline(a["lat"], a["lon"], pts)
        if d <= a["radiusM"]:
            warnings.append({"type": "alert", "kind": a["kind"], "title": a["title"], "body": a["body"],
                             "lat": a["lat"], "lon": a["lon"]})
    cur = await conn.execute(
        "SELECT * FROM incidents WHERE status IN ('open','dispatched','on_scene') AND kind IN ('accident','hazard','road_blocked','fire','congestion')")
    for inc in await cur.fetchall():
        d, _ = geo.nearest_on_polyline(inc["lat"], inc["lon"], pts)
        if d <= 120:
            warnings.append({"type": "incident", "kind": inc["kind"], "title": access.INCIDENT_KINDS[inc["kind"]],
                             "body": inc["place"], "lat": inc["lat"], "lon": inc["lon"]})
    return {**res, "warnings": warnings}


# ---------------------------------------------------------------------------
# Anonymous traffic contribution
# ---------------------------------------------------------------------------

class PingReq(BaseModel):
    tag: str = Field(pattern=r"^[A-Za-z0-9]{6,16}$")
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    heading_deg: Optional[float] = None
    speed_kmh: Optional[float] = Field(default=None, ge=0, le=250)


@router.post("/traffic-ping")
async def traffic_ping(body: PingReq, me=CITIZEN):
    if not me["share_traffic"]:
        raise HTTPException(403, "anonymous traffic sharing is turned off in your privacy settings")
    if not geo.within_bounds(body.lat, body.lon, places.meta().get("bounds")):
        return {"ok": True, "forwarded": False, "realistic": hub.engine.realistic}
    if not hub.engine.connected:
        # Nobody started the traffic engine yet: bring it up in realistic
        # mode (throttled inside ensure_engine) so this phone shows up.
        from .live import ensure_engine

        await ensure_engine()
        return {"ok": True, "forwarded": False, "realistic": False}
    if not hub.engine.realistic:
        return {"ok": True, "forwarded": False, "realistic": False}
    # The tag is generated on the phone and rotated every few minutes; it is
    # the only id the engine ever sees, and nothing here records it.
    forwarded = await sim_bridge.bridge.send_command({
        "cmd": "liveVehicleUpdate", "vehicleId": f"ANON-{body.tag}", "vehicleType": "car",
        "lat": body.lat, "lon": body.lon,
        "headingDeg": (body.heading_deg % 360.0) if body.heading_deg is not None else None,
        "speedKmh": body.speed_kmh or 0.0,
    })
    return {"ok": True, "forwarded": forwarded, "realistic": True}
