"""
fear_backend - REST API behind fear_authorization_app (employer/employee back
office) and fear_system_deployable (driver GPS tracking), and the bridge that
forwards live vehicle locations into traffic light revamped's sim_engine.cpp
over its existing external-command WebSocket channel (see sim_bridge.py).

Run (from the `traffic light revamped` directory, so the package path below
resolves):
    ../.venv/Scripts/uvicorn.exe backend.fear_backend.main:app --host 0.0.0.0 --port 8080

Security posture: like this project's own serve.py, this is plain HTTP for a
LAN/prototype deployment, not TLS-hardened for the open internet. Passwords
are hashed (security.py, PBKDF2-HMAC-SHA256) and only ever returned in
plaintext once, at generation time, for the employer/employee to hand off.
"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

import aiosqlite
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

from . import config, lan_discovery, map_data, security, sim_bridge
from .db import get_conn, init_db

app = FastAPI(title="FEAR backend")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
async def on_startup():
    await init_db()
    sim_bridge.bridge.start()
    lan_discovery.responder.start()


@app.on_event("shutdown")
async def on_shutdown():
    lan_discovery.responder.stop()
    await sim_bridge.bridge.stop()


@app.get("/health")
async def health():
    # "service" lets the apps confirm an address found by broadcast really is
    # fear_backend, not some other server that happens to answer on that port.
    return {"ok": True, "service": lan_discovery.SERVICE}


# ---------------------------------------------------------------------------
# Session helpers - opaque bearer tokens in the sessions table, not JWTs (see
# security.py's docstring for why).
# ---------------------------------------------------------------------------

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def create_session(conn: aiosqlite.Connection, subject_type: str, subject_id: str) -> str:
    token = security.gen_token()
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=config.SESSION_TTL_SECONDS)).isoformat()
    await conn.execute(
        "INSERT INTO sessions(token, subject_type, subject_id, expires_at) VALUES (?,?,?,?)",
        (token, subject_type, subject_id, expires_at),
    )
    await conn.commit()
    return token


async def resolve_session(conn: aiosqlite.Connection, authorization: Optional[str]):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    token = authorization[len("Bearer "):].strip()
    cur = await conn.execute("SELECT * FROM sessions WHERE token=?", (token,))
    row = await cur.fetchone()
    if row is None:
        raise HTTPException(401, "invalid session")
    if datetime.fromisoformat(row["expires_at"]) < datetime.now(timezone.utc):
        await conn.execute("DELETE FROM sessions WHERE token=?", (token,))
        await conn.commit()
        raise HTTPException(401, "session expired")
    return row


async def require_employer(authorization: Optional[str] = Header(None), conn: aiosqlite.Connection = Depends(get_conn)):
    session = await resolve_session(conn, authorization)
    if session["subject_type"] != "employer":
        raise HTTPException(403, "employer session required")
    cur = await conn.execute("SELECT * FROM employers WHERE id=?", (session["subject_id"],))
    row = await cur.fetchone()
    if row is None:
        raise HTTPException(401, "employer not found")
    return row


async def require_employee(authorization: Optional[str] = Header(None), conn: aiosqlite.Connection = Depends(get_conn)):
    session = await resolve_session(conn, authorization)
    if session["subject_type"] != "employee":
        raise HTTPException(403, "employee session required")
    cur = await conn.execute("SELECT * FROM employees WHERE id=?", (session["subject_id"],))
    row = await cur.fetchone()
    if row is None or not row["active"]:
        raise HTTPException(401, "employee not found or inactive")
    return row


async def require_driver(authorization: Optional[str] = Header(None), conn: aiosqlite.Connection = Depends(get_conn)):
    session = await resolve_session(conn, authorization)
    if session["subject_type"] != "driver":
        raise HTTPException(403, "driver session required")
    cur = await conn.execute("SELECT * FROM vehicles WHERE id=?", (session["subject_id"],))
    row = await cur.fetchone()
    if row is None or not row["active"]:
        raise HTTPException(401, "vehicle not found or inactive")
    return row


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class EmployerRegisterReq(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=6, max_length=128)
    company_name: str = Field(min_length=1, max_length=200)


class LoginReq(BaseModel):
    username: str
    password: str


class HireEmployeeReq(BaseModel):
    full_name: str = Field(min_length=1, max_length=200)


class ActiveReq(BaseModel):
    active: bool


class RegisterVehicleReq(BaseModel):
    owner_name: str = Field(min_length=1, max_length=200)
    owner_phone: str = Field(min_length=1, max_length=40)
    owner_address: str = Field(min_length=1, max_length=400)
    owner_id_number: str = Field(min_length=1, max_length=100)
    vehicle_type: Literal["car", "motorcycle", "bus", "truck", "ambulance", "firetruck", "police"]
    plate_number: str = Field(min_length=1, max_length=40)
    make_model: Optional[str] = None


class LocationReq(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    # Not range-constrained here on purpose: Android's raw compass azimuth
    # (flutter_compass) comes back in [-180, 180), not [0, 360) - rejecting
    # the whole request (lat/lon included) over a heading field that's merely
    # unnormalized would silently drop real position updates. Normalized to
    # [0, 360) below instead.
    heading_deg: Optional[float] = None
    speed_kmh: Optional[float] = Field(default=None, ge=0)

    @field_validator("heading_deg")
    @classmethod
    def _normalize_heading(cls, v: Optional[float]) -> Optional[float]:
        if v is None:
            return None
        return v % 360.0


class RouteReq(BaseModel):
    from_x: float
    from_y: float
    to_x: float
    to_y: float


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------

@app.post("/auth/employer/register")
async def employer_register(body: EmployerRegisterReq, conn: aiosqlite.Connection = Depends(get_conn)):
    pw_hash, salt = security.hash_password(body.password)
    try:
        cur = await conn.execute(
            "INSERT INTO employers(username, pw_hash, pw_salt, company_name, created_at) VALUES (?,?,?,?,?)",
            (body.username, pw_hash, salt, body.company_name, now_iso()),
        )
        await conn.commit()
    except aiosqlite.IntegrityError:
        raise HTTPException(409, "username already taken")
    token = await create_session(conn, "employer", str(cur.lastrowid))
    return {"token": token, "employerId": cur.lastrowid, "companyName": body.company_name}


@app.post("/auth/employer/login")
async def employer_login(body: LoginReq, conn: aiosqlite.Connection = Depends(get_conn)):
    cur = await conn.execute("SELECT * FROM employers WHERE username=?", (body.username,))
    row = await cur.fetchone()
    if row is None or not security.verify_password(body.password, row["pw_hash"], row["pw_salt"]):
        raise HTTPException(401, "invalid credentials")
    token = await create_session(conn, "employer", str(row["id"]))
    return {"token": token, "employerId": row["id"], "companyName": row["company_name"]}


@app.post("/auth/employee/login")
async def employee_login(body: LoginReq, conn: aiosqlite.Connection = Depends(get_conn)):
    cur = await conn.execute("SELECT * FROM employees WHERE username=?", (body.username,))
    row = await cur.fetchone()
    if row is None or not row["active"] or not security.verify_password(body.password, row["pw_hash"], row["pw_salt"]):
        raise HTTPException(401, "invalid credentials")
    token = await create_session(conn, "employee", str(row["id"]))
    return {"token": token, "employeeId": row["id"], "fullName": row["full_name"]}


@app.post("/auth/driver/login")
async def driver_login(body: LoginReq, conn: aiosqlite.Connection = Depends(get_conn)):
    cur = await conn.execute("SELECT * FROM vehicles WHERE driver_username=?", (body.username,))
    row = await cur.fetchone()
    if row is None or not row["active"] or not security.verify_password(body.password, row["driver_pw_hash"], row["driver_pw_salt"]):
        raise HTTPException(401, "invalid credentials")
    token = await create_session(conn, "driver", row["id"])
    return {"token": token, "vehicleId": row["id"], "vehicleType": row["vehicle_type"]}


# ---------------------------------------------------------------------------
# Employer routes
# ---------------------------------------------------------------------------

@app.post("/employees")
async def hire_employee(body: HireEmployeeReq, employer=Depends(require_employer), conn: aiosqlite.Connection = Depends(get_conn)):
    for _ in range(5):
        username = security.gen_username("emp-")
        password = security.gen_password()
        pw_hash, salt = security.hash_password(password)
        try:
            cur = await conn.execute(
                "INSERT INTO employees(employer_id, username, pw_hash, pw_salt, full_name, active, created_at) VALUES (?,?,?,?,?,1,?)",
                (employer["id"], username, pw_hash, salt, body.full_name, now_iso()),
            )
            await conn.commit()
            return {
                "employeeId": cur.lastrowid,
                "username": username,
                "password": password,
                "fullName": body.full_name,
            }
        except aiosqlite.IntegrityError:
            continue
    raise HTTPException(500, "could not generate a unique employee username, try again")


@app.get("/employees")
async def list_employees(employer=Depends(require_employer), conn: aiosqlite.Connection = Depends(get_conn)):
    cur = await conn.execute(
        "SELECT id, username, full_name, active, created_at FROM employees WHERE employer_id=? ORDER BY created_at DESC",
        (employer["id"],),
    )
    rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.patch("/employees/{employee_id}")
async def set_employee_active(employee_id: int, body: ActiveReq, employer=Depends(require_employer), conn: aiosqlite.Connection = Depends(get_conn)):
    cur = await conn.execute("SELECT id FROM employees WHERE id=? AND employer_id=?", (employee_id, employer["id"]))
    row = await cur.fetchone()
    if row is None:
        raise HTTPException(404, "employee not found")
    await conn.execute("UPDATE employees SET active=? WHERE id=?", (1 if body.active else 0, employee_id))
    await conn.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Employee routes
# ---------------------------------------------------------------------------

@app.post("/vehicles")
async def register_vehicle(body: RegisterVehicleReq, employee=Depends(require_employee), conn: aiosqlite.Connection = Depends(get_conn)):
    for _ in range(5):
        vehicle_id = security.gen_vehicle_id()
        driver_username = security.gen_username("drv-")
        driver_password = security.gen_password()
        pw_hash, salt = security.hash_password(driver_password)
        try:
            await conn.execute(
                """INSERT INTO vehicles(id, employee_id, owner_name, owner_phone, owner_address, owner_id_number,
                   vehicle_type, plate_number, make_model, driver_username, driver_pw_hash, driver_pw_salt, active, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)""",
                (
                    vehicle_id, employee["id"], body.owner_name, body.owner_phone, body.owner_address,
                    body.owner_id_number, body.vehicle_type, body.plate_number, body.make_model,
                    driver_username, pw_hash, salt, now_iso(),
                ),
            )
            await conn.commit()
            return {
                "vehicleId": vehicle_id,
                "vehicleType": body.vehicle_type,
                "plateNumber": body.plate_number,
                "driverUsername": driver_username,
                "driverPassword": driver_password,
            }
        except aiosqlite.IntegrityError:
            continue
    raise HTTPException(500, "could not generate a unique vehicle id, try again")


@app.get("/vehicles")
async def list_my_vehicles(employee=Depends(require_employee), conn: aiosqlite.Connection = Depends(get_conn)):
    cur = await conn.execute(
        """SELECT id, owner_name, vehicle_type, plate_number, driver_username, active, created_at
           FROM vehicles WHERE employee_id=? ORDER BY created_at DESC""",
        (employee["id"],),
    )
    rows = await cur.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Driver routes
# ---------------------------------------------------------------------------

@app.get("/vehicles/me")
async def my_vehicle(vehicle=Depends(require_driver)):
    d = dict(vehicle)
    d.pop("driver_pw_hash", None)
    d.pop("driver_pw_salt", None)
    return d


@app.post("/vehicles/{vehicle_id}/location")
async def post_location(vehicle_id: str, body: LocationReq, vehicle=Depends(require_driver), conn: aiosqlite.Connection = Depends(get_conn)):
    if vehicle["id"] != vehicle_id:
        raise HTTPException(403, "session token does not match this vehicle id")
    await conn.execute(
        """INSERT INTO last_location(vehicle_id, lat, lon, heading, speed_kmh, updated_at) VALUES (?,?,?,?,?,?)
           ON CONFLICT(vehicle_id) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, heading=excluded.heading,
           speed_kmh=excluded.speed_kmh, updated_at=excluded.updated_at""",
        (vehicle_id, body.lat, body.lon, body.heading_deg, body.speed_kmh, now_iso()),
    )
    await conn.commit()
    forwarded = await sim_bridge.bridge.send_command({
        "cmd": "liveVehicleUpdate",
        "vehicleId": vehicle_id,
        "vehicleType": vehicle["vehicle_type"],
        "lat": body.lat,
        "lon": body.lon,
        "headingDeg": body.heading_deg,
        "speedKmh": body.speed_kmh,
    })
    return {"ok": True, "forwardedToSim": forwarded}


@app.post("/vehicles/{vehicle_id}/stop-tracking")
async def stop_tracking(vehicle_id: str, vehicle=Depends(require_driver)):
    if vehicle["id"] != vehicle_id:
        raise HTTPException(403, "session token does not match this vehicle id")
    forwarded = await sim_bridge.bridge.send_command({"cmd": "liveVehicleRemove", "vehicleId": vehicle_id})
    return {"ok": True, "forwardedToSim": forwarded}


@app.get("/sim/status")
async def sim_status():
    return {"connected": sim_bridge.bridge.connected()}


# ---------------------------------------------------------------------------
# Map + routing - fear_system_deployable's in-app map. Everything here works
# in the same local x/y metre space backend/sim/sim_engine.cpp and
# front-end/map-core.js already use (see map_data.py's own docstring) - the
# app converts its own GPS fix to x/y client-side and only ever sends/receives
# x/y here, never lat/lon, so this module never needs an inverse projection.
# ---------------------------------------------------------------------------

@app.get("/map/roads")
async def map_roads(vehicle=Depends(require_driver)):
    rm = await asyncio.to_thread(map_data.get_road_map)
    return {
        "origin": {"lat": rm.origin_lat, "lon": rm.origin_lon},
        "nodes": {nid: list(xy) for nid, xy in rm.nodes.items()},
        "ways": rm.ways,
    }


def _call_serve_route(start_node: str, end_node: str) -> dict:
    """Blocking call to serve.py's own POST /api/route (the ch_query.exe-backed
    point-to-point router) - run via asyncio.to_thread by the endpoint below.
    serve.py already owns compiling/invoking ch_query.exe and handling a
    missing/stale CH gracefully; this just reuses that instead of
    re-implementing subprocess invocation here too."""
    url = f"http://{config.SERVE_HOST}:{config.SERVE_PORT}/api/route"
    body = json.dumps({"start": start_node, "end": end_node}).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"routing service (serve.py) unreachable at {url}: {e}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/route")
async def plan_route(body: RouteReq, vehicle=Depends(require_driver)):
    rm = await asyncio.to_thread(map_data.get_road_map)
    start_node = rm.nearest_routable_node(body.from_x, body.from_y)
    end_node = rm.nearest_routable_node(body.to_x, body.to_y)
    if not start_node or not end_node:
        return {"ok": False, "error": "no routable road found near the given point(s)"}

    result = await asyncio.to_thread(_call_serve_route, start_node, end_node)
    if not result.get("ok"):
        return {"ok": False, "error": result.get("error", "routing failed")}
    if not result.get("found"):
        return {"ok": True, "found": False}

    points = [[p["x"], p["y"]] for p in result.get("path", [])]
    return {"ok": True, "found": True, "distanceSec": result.get("distanceSec"), "points": points}
