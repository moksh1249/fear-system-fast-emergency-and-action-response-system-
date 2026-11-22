"""Live operational picture: where each authorized fleet vehicle is, whether it
is on duty, what it is doing, and what the traffic engine is doing about it.

Fleet positions arrive from FEAR Command's driver screen (POST
/gov/driver/location). Each fix is kept in memory, persisted at most every few
seconds, and forwarded to sim_engine.cpp as a liveVehicleUpdate - the same
channel the engine's realistic mode is built on. A vehicle gets emergency
signal priority only when ALL of these hold, checked here on the server and
never taken from the app's word:

  - its category is ambulance / firetruck / police,
  - the vehicle and its organization are active and verified,
  - the driver on duty holds an active (unrevoked) assignment to it,
  - it has an accepted task that is en route or transporting,
  - the driver has not switched priority off.

Only then does the engine receive emergency=true plus the task destination,
which turns the vehicle's engine route into the full road route and lets the
engine's preemption logic open the signals ahead of it.

The engine's own state frames are parsed (at most twice a second) for the
signal mode, the vehicle-source mode and which junctions are currently held
green for an emergency vehicle.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from dataclasses import dataclass, field
from typing import Optional

from . import access, config, geo, map_data, places, routing, schema_v2, signals, sim_bridge

logger = logging.getLogger("fear_backend.live")

STALE_SEC = 30.0          # no fix for this long -> "signal lost" on the dashboard
PERSIST_EVERY_SEC = 5.0
ROUTE_REFRESH_SEC = 20.0
OFF_ROUTE_M = 60.0
ACTIVE_TASK_STATES = ("assigned", "en_route", "on_scene", "transporting")
PRIORITY_TASK_STATES = ("en_route", "transporting")


@dataclass
class Unit:
    vehicle_id: str
    category: str
    org_id: str
    plate: str
    authorized: bool = False          # vehicle+org active/verified and a valid assignment for the duty driver
    driver_id: Optional[str] = None   # internal id only - never sent to Command
    on_duty: bool = False
    priority_requested: bool = True
    lat: Optional[float] = None
    lon: Optional[float] = None
    heading: Optional[float] = None
    speed_kmh: Optional[float] = None
    accuracy_m: Optional[float] = None
    demo: bool = False
    fix_mono: float = 0.0
    fix_iso: Optional[str] = None
    persisted_mono: float = 0.0
    task: Optional[dict] = None       # active incident_units row joined with its incident
    route: Optional[dict] = None      # {"points", "durationSec", "distanceM", "dest", "at"}
    route_pending: bool = False

    @property
    def has_fix(self) -> bool:
        return self.lat is not None and self.lon is not None

    @property
    def stale(self) -> bool:
        return not self.has_fix or time.monotonic() - self.fix_mono > STALE_SEC

    @property
    def emergency_active(self) -> bool:
        return (self.authorized and self.on_duty and self.category in access.EMERGENCY_CATEGORIES
                and self.priority_requested and self.task is not None
                and self.task["status"] in PRIORITY_TASK_STATES)

    def engine_type(self) -> str:
        return access.VEHICLE_CATEGORIES.get(self.category, ("", "", "car"))[2]


@dataclass
class EngineView:
    connected: bool = False
    sim_mode: Optional[str] = None
    signal_mode: Optional[str] = None
    sim_time: Optional[float] = None
    live_vehicles: int = 0
    preempted: list = field(default_factory=list)  # [{"nodeId", "lat", "lon"}]
    lamps: list = field(default_factory=list)      # the engine's own lamp reports (preemption / density)
    frame_mono: float = 0.0
    # Every moving vehicle, anonymous: [lat, lon, heading deg, km/h, class, fleet]
    # (class e emergency / b bus / t truck / m two-wheeler / c car; fleet 1 =
    # a FEAR unit Command already draws with its identity). See traffic().
    traffic: list = field(default_factory=list)

    @property
    def realistic(self) -> bool:
        return self.connected and self.sim_mode == "realistic"


class LiveHub:
    def __init__(self):
        self.units: dict[str, Unit] = {}
        self.engine = EngineView()
        self._latest_state: Optional[str] = None
        self._tasks: list[asyncio.Task] = []
        self.signal_colors = ""   # one char per signals.layout() lamp - see signals.py
        self.signal_timers: list = []  # seconds for each lamp - see signals.py
        self.signal_timer_kinds = ""     # what each of those numbers means - see signals.py
        self.overrides: dict = {}  # serve.py External Control holds: nodeId -> {"greenLamps": [...]}
        self.version = 0  # bumped on any registry/incident change - clients refetch lists when it moves

    # ---------------------------------------------------------------- lifecycle
    async def start(self) -> None:
        await self.reload_all()
        sim_bridge.bridge.add_listener(self._on_engine_message)
        self._tasks = [asyncio.create_task(self._engine_loop()), asyncio.create_task(self._tick_loop()),
                       asyncio.create_task(self._signals_loop())]

    async def stop(self) -> None:
        sim_bridge.bridge.remove_listener(self._on_engine_message)
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass

    def bump(self) -> None:
        self.version += 1

    # ---------------------------------------------------------------- registry state
    async def reload_all(self) -> None:
        conn = await schema_v2.connect()
        try:
            cur = await conn.execute("SELECT id FROM fleet_vehicles WHERE deleted_at IS NULL")
            ids = [r["id"] for r in await cur.fetchall()]
            for vid in ids:
                await self.refresh_unit(conn, vid)
            # Last known positions survive a restart (marked stale until a fresh fix).
            cur = await conn.execute("SELECT * FROM fleet_location")
            for r in await cur.fetchall():
                u = self.units.get(r["vehicle_id"])
                if u is not None and u.lat is None:
                    u.lat, u.lon, u.heading, u.speed_kmh = r["lat"], r["lon"], r["heading"], r["speed_kmh"]
                    u.demo, u.fix_iso = bool(r["demo"]), r["updated_at"]
        finally:
            await conn.close()
        self.bump()

    async def refresh_unit(self, conn, vehicle_id: str) -> Optional[Unit]:
        """Re-reads one vehicle's registry, duty and task state from the DB.
        Called after anything that could change whether it may hold priority."""
        cur = await conn.execute(
            """SELECT v.*, o.verified AS org_verified FROM fleet_vehicles v
               JOIN organizations o ON o.id = v.org_id WHERE v.id=? AND v.deleted_at IS NULL""",
            (vehicle_id,),
        )
        v = await cur.fetchone()
        if v is None:
            self.units.pop(vehicle_id, None)
            return None
        u = self.units.get(vehicle_id)
        if u is None:
            u = Unit(vehicle_id=vehicle_id, category=v["category"], org_id=v["org_id"], plate=v["plate"])
            self.units[vehicle_id] = u
        u.category, u.org_id, u.plate = v["category"], v["org_id"], v["plate"]

        cur = await conn.execute("SELECT * FROM duty WHERE vehicle_id=?", (vehicle_id,))
        d = await cur.fetchone()
        u.on_duty = bool(d and d["on_duty"])
        u.driver_id = d["driver_id"] if d else None
        u.priority_requested = bool(d["priority_requested"]) if d else True

        assignment_ok = False
        if u.on_duty and u.driver_id:
            cur = await conn.execute(
                """SELECT 1 FROM assignments a JOIN drivers dr ON dr.id = a.driver_id
                   JOIN gov_users g ON g.id = dr.gov_user_id
                   WHERE a.vehicle_id=? AND a.driver_id=? AND a.revoked_at IS NULL AND g.active=1""",
                (vehicle_id, u.driver_id),
            )
            assignment_ok = (await cur.fetchone()) is not None
        u.authorized = bool(v["active"] and v["verified"] and v["org_verified"] and assignment_ok)

        cur = await conn.execute(
            f"""SELECT iu.*, i.kind AS incident_kind, i.lat AS incident_lat, i.lon AS incident_lon,
                       i.place AS incident_place, i.description AS incident_description, i.status AS incident_status
                FROM incident_units iu JOIN incidents i ON i.id = iu.incident_id
                WHERE iu.vehicle_id=? AND iu.status IN ({",".join("?" * len(ACTIVE_TASK_STATES))})
                ORDER BY iu.assigned_at DESC LIMIT 1""",
            (vehicle_id, *ACTIVE_TASK_STATES),
        )
        t = await cur.fetchone()
        new_task = dict(t) if t else None
        old_dest = (u.task["dest_lat"], u.task["dest_lon"]) if u.task else None
        new_dest = (new_task["dest_lat"], new_task["dest_lon"]) if new_task else None
        u.task = new_task
        if new_dest != old_dest:
            u.route = None
        return u

    # ---------------------------------------------------------------- fixes
    async def on_fix(self, conn, unit: Unit, lat: float, lon: float, heading: Optional[float],
                     speed_kmh: Optional[float], accuracy_m: Optional[float], demo: bool) -> bool:
        now = time.monotonic()
        unit.lat, unit.lon, unit.heading, unit.speed_kmh = lat, lon, heading, speed_kmh
        unit.accuracy_m, unit.demo = accuracy_m, demo
        unit.fix_mono, unit.fix_iso = now, access.now_iso()
        if now - unit.persisted_mono > PERSIST_EVERY_SEC:
            unit.persisted_mono = now
            await conn.execute(
                """INSERT INTO fleet_location(vehicle_id, lat, lon, heading, speed_kmh, demo, updated_at) VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(vehicle_id) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, heading=excluded.heading,
                   speed_kmh=excluded.speed_kmh, demo=excluded.demo, updated_at=excluded.updated_at""",
                (unit.vehicle_id, lat, lon, heading, speed_kmh, int(demo), unit.fix_iso),
            )
            await conn.commit()
        self._maybe_refresh_route(unit)
        return await self.forward_to_engine(unit)

    async def forward_to_engine(self, unit: Unit) -> bool:
        # Phones are part of the traffic picture only in realistic mode; in
        # simulation mode the engine drives synthetic vehicles alone.
        if not unit.has_fix or not unit.on_duty or not self.engine.realistic:
            return False
        payload = {
            "cmd": "liveVehicleUpdate", "vehicleId": unit.vehicle_id, "vehicleType": unit.engine_type(),
            "lat": unit.lat, "lon": unit.lon, "headingDeg": unit.heading, "speedKmh": unit.speed_kmh or 0.0,
        }
        if unit.emergency_active:
            payload.update({"emergency": True, "destLat": unit.task["dest_lat"], "destLon": unit.task["dest_lon"]})
        return await sim_bridge.bridge.send_command(payload)

    async def remove_from_engine(self, vehicle_id: str) -> None:
        await sim_bridge.bridge.send_command({"cmd": "liveVehicleRemove", "vehicleId": vehicle_id})

    def _maybe_refresh_route(self, unit: Unit) -> None:
        if unit.task is None or not unit.has_fix or unit.route_pending:
            return
        r = unit.route
        need = r is None or time.monotonic() - r["at"] > ROUTE_REFRESH_SEC
        if not need and r:
            off, _ = geo.nearest_on_polyline(unit.lat, unit.lon, r["points"])
            need = off > OFF_ROUTE_M
        if need:
            unit.route_pending = True
            asyncio.create_task(self._compute_route(unit))

    async def _compute_route(self, unit: Unit) -> None:
        try:
            t = unit.task
            if t is None or not unit.has_fix:
                return
            res = await routing.route(unit.lat, unit.lon, t["dest_lat"], t["dest_lon"])
            if res and res.get("found") and unit.task is t:
                unit.route = {"points": res["points"], "durationSec": res["durationSec"], "distanceM": res["distanceM"],
                              "steps": res.get("steps") or [], "dest": [t["dest_lat"], t["dest_lon"]], "at": time.monotonic()}
        except Exception:
            logger.exception("route computation failed for %s", unit.vehicle_id)
        finally:
            unit.route_pending = False

    # ---------------------------------------------------------------- views
    def eta_sec(self, unit: Unit) -> Optional[float]:
        """Remaining time on the unit's route, scaled by how much of it is left."""
        r = unit.route
        if not r or not unit.has_fix:
            return None
        remaining = geo.polyline_length_m(geo.trim_polyline_ahead(unit.lat, unit.lon, r["points"], 1e9))
        if r["distanceM"] <= 1:
            return 0.0
        return max(0.0, r["durationSec"] * min(1.0, remaining / r["distanceM"]))

    def unit_public_view(self, unit: Unit) -> dict:
        """What Command sees of a vehicle: the vehicle identity, never the driver's."""
        return {
            "vehicleId": unit.vehicle_id, "category": unit.category, "orgId": unit.org_id, "plate": unit.plate,
            "lat": unit.lat, "lon": unit.lon, "heading": unit.heading, "speedKmh": unit.speed_kmh,
            "onDuty": unit.on_duty, "stale": unit.stale, "demo": unit.demo, "updatedAt": unit.fix_iso,
            "authorized": unit.authorized, "emergency": unit.emergency_active,
            "status": self.unit_status(unit),
            "task": ({"unitId": unit.task["id"], "incidentId": unit.task["incident_id"], "status": unit.task["status"],
                      "destName": unit.task["dest_name"], "destKind": unit.task["dest_kind"]} if unit.task else None),
            "etaSec": self.eta_sec(unit),
        }

    def unit_status(self, unit: Unit) -> str:
        if not unit.on_duty:
            return "off_duty"
        if unit.task:
            return unit.task["status"]
        return "available"

    def corridor(self, unit: Unit, ahead_m: float = 3000.0) -> Optional[list]:
        if not unit.route or not unit.has_fix:
            return None
        return geo.trim_polyline_ahead(unit.lat, unit.lon, unit.route["points"], ahead_m)

    def signals_on_route(self, unit: Unit, within_m: float = 25.0) -> list:
        """Preempted junctions that lie on this unit's remaining route."""
        pts = self.corridor(unit, 2000.0)
        if not pts:
            return []
        out = []
        for p in self.engine.preempted:
            d, _ = geo.nearest_on_polyline(p["lat"], p["lon"], pts)
            if d <= within_m:
                out.append({**p, "distanceM": round(geo.distance_m(unit.lat, unit.lon, p["lat"], p["lon"]))})
        out.sort(key=lambda p: p["distanceM"])
        return out

    # ---------------------------------------------------------------- engine
    def _on_engine_message(self, raw: str) -> None:
        if raw.startswith('{"type":"state"'):
            self._latest_state = raw

    async def _engine_loop(self) -> None:
        while True:
            await asyncio.sleep(0.5)
            self.engine.connected = sim_bridge.bridge.connected()
            raw, self._latest_state = self._latest_state, None
            if raw is None:
                if time.monotonic() - self.engine.frame_mono > 5:
                    self.engine.preempted = []
                continue
            try:
                parsed = await asyncio.to_thread(_parse_engine_state, raw)
            except Exception:
                logger.exception("could not parse engine state")
                continue
            e = self.engine
            was_realistic = e.realistic
            e.sim_mode, e.signal_mode, e.sim_time = parsed["simMode"], parsed["mode"], parsed["t"]
            e.live_vehicles, e.preempted, e.frame_mono = parsed["liveVehicles"], parsed["preempted"], time.monotonic()
            e.lamps = parsed["lamps"]
            e.traffic = parsed["traffic"]
            if was_realistic != e.realistic:
                await self._on_mode_change(e.realistic)

    async def _on_mode_change(self, realistic: bool) -> None:
        logger.info("engine vehicle source is now %s", "realistic" if realistic else "simulation")
        for u in list(self.units.values()):
            if realistic:
                await self.forward_to_engine(u)
            elif u.on_duty:
                await self.remove_from_engine(u.vehicle_id)
        self.bump()

    async def _signals_loop(self) -> None:
        """Recomputes every lamp's colour once a second for the phones (see
        signals.py) and refreshes serve.py's External Control holds."""
        from .main import _serve_json

        n = 0
        while True:
            await asyncio.sleep(1.0)
            try:
                if n % 3 == 0:
                    r = await asyncio.to_thread(_serve_json, "/api/signal/overrides", None, 2)
                    self.overrides = r.get("overrides") or {} if r.get("ok") else {}
                n += 1
                e = self.engine
                clock = e.sim_time if e.connected and e.sim_time is not None else None
                self.signal_colors = await asyncio.to_thread(signals.colors, clock, e.lamps if e.connected else [], self.overrides)
                self.signal_timers = signals.last_timers
                self.signal_timer_kinds = signals.last_timer_kinds
            except Exception:
                logger.exception("signal colours failed")

    async def _tick_loop(self) -> None:
        """Keeps emergency vehicles' engine state fresh between fixes (the
        engine forgets a live vehicle after 20s without an update) and
        their routes current."""
        while True:
            await asyncio.sleep(5.0)
            for u in list(self.units.values()):
                if u.on_duty and u.has_fix and not u.stale:
                    if u.emergency_active:
                        await self.forward_to_engine(u)
                    self._maybe_refresh_route(u)


TRAFFIC_MAX = 3000  # vehicles sent to a Command map per tick


def traffic_view() -> dict:
    """The traffic picture for Command: every vehicle the engine is moving
    (no identities) plus the numbers an operator reads congestion from."""
    vs = hub.engine.traffic if hub.engine.connected and time.monotonic() - hub.engine.frame_mono < 5 else []
    speeds = [v[3] for v in vs]
    moving = [s for s in speeds if s >= 3]
    return {"vehicles": vs, "count": len(vs), "live": hub.engine.realistic, "connected": hub.engine.connected,
            "avgKmh": round(sum(moving) / len(moving), 1) if moving else None,
            "slowShare": round(sum(1 for s in speeds if s < 10) / len(speeds), 2) if speeds else None}


def _parse_engine_state(raw: str) -> dict:
    msg = json.loads(raw)
    rm = map_data.get_road_map()
    preempted = []
    seen = set()
    lamps = msg.get("lamps") or []
    for lamp in lamps:
        if lamp.get("r") != "emergency":
            continue
        nid = lamp.get("nodeId")
        if nid in seen:
            continue
        seen.add(nid)
        xy = rm.nodes.get(nid)
        if xy is None:
            continue
        lat, lon = geo.to_latlon(*xy)
        preempted.append({"nodeId": nid, "lat": lat, "lon": lon})
    traffic = []
    for v in msg.get("vehicles") or []:
        try:
            lat, lon = geo.to_latlon(float(v["x"]), float(v["y"]))
            hdg = (90.0 - math.degrees(float(v.get("h", 0.0)))) % 360.0
            ty = v.get("ty") or "car"
            cls = "e" if ty in ("ambulance", "firetruck", "police") else {"bus": "b", "truck": "t", "motorcycle": "m"}.get(ty, "c")
            fleet = 1 if str(v.get("vid", "")).startswith("FEAR-") else 0
            traffic.append([round(lat, 5), round(lon, 5), round(hdg), round(float(v.get("s", 0.0))), cls, fleet])
        except (KeyError, TypeError, ValueError):
            continue
        if len(traffic) >= TRAFFIC_MAX:
            break
    return {"t": msg.get("t"), "mode": msg.get("mode"), "simMode": msg.get("simMode"), "traffic": traffic,
            "liveVehicles": msg.get("liveVehicles", 0), "preempted": preempted,
            "lamps": [{"nodeId": l.get("nodeId"), "wayId": l.get("wayId"), "movement": l.get("movement"), "color": l.get("color"),
                       "reason": l.get("r")} for l in lamps]}


_last_autostart = 0.0
REALISTIC_RUN_SECONDS = 7 * 24 * 3600


async def ensure_engine(force: bool = False) -> dict:
    """Starts the traffic engine in realistic mode (GPS vehicles only) with
    emergency-only signal control, if nothing is connected. serve.py owns the
    engine process; this sends it the same /api/sim/start the web viewer does."""
    global _last_autostart
    from .main import _serve_json

    if sim_bridge.bridge.connected():
        return {"ok": True, "alreadyRunning": True}
    if not force and (not config.SIM_AUTOSTART or time.monotonic() - _last_autostart < 30):
        return {"ok": False, "throttled": True}
    _last_autostart = time.monotonic()
    result = await asyncio.to_thread(_serve_json, "/api/sim/start", {
        "mode": "realistic", "signalMode": "emergency", "concurrency": config.SIM_AUTOSTART_CONCURRENCY,
        # The engine's default run is 300 sim-seconds, then it exits - right for
        # a timed simulation, wrong for live operations that must stay up.
        "simSeconds": REALISTIC_RUN_SECONDS,
    })
    logger.info("engine start (realistic): %s", result)
    return result


hub = LiveHub()
