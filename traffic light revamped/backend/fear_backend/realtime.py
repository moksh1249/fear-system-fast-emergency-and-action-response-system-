"""/v2/ws - one WebSocket for both apps, pushing each client its own slice of
the live picture once a second.

The first message must authenticate: {"type": "auth", "app": "gov" | "public",
"token": <session token>} (not a query parameter, so tokens stay out of access
logs). After that the server sends {"type": "tick", ...} every second:

  gov (Command / org admin)  engine state, the vehicles this account may see,
                             and the active emergency corridors among them
  gov (driver)               the driver's own vehicle, task, route and signals
  public                     emergency vehicles near the position the phone last
                             sent ({"type": "pos", "lat", "lon"}) plus the
                             caller's own open incidents

`version` moves whenever incidents, alerts or the registry change - clients
refetch those lists over HTTP when it does, instead of the server pushing them.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect

from . import access, auth_v2, incidents, mapraw, schema_v2
from .gov_api import driver_state, visible_units
from .live import hub, traffic_view
from .public_api import nearby_emergencies

logger = logging.getLogger("fear_backend.realtime")
AUTH_TIMEOUT_SEC = 10
TICK_SEC = 1.0


async def _gov_tick(conn, user) -> dict:
    e = hub.engine
    msg = {"type": "tick", "version": hub.version, "mapVersion": mapraw.version(), "signals": hub.signal_colors,
           "signalTimers": hub.signal_timers, "signalTimerKinds": hub.signal_timer_kinds,
           "engine": {"connected": e.connected, "simMode": e.sim_mode, "signalMode": e.signal_mode,
                      "liveVehicles": e.live_vehicles, "preempted": e.preempted, "simTime": e.sim_time}}
    if user["role"] == "driver":
        cur = await conn.execute(
            """SELECT a.vehicle_id FROM assignments a JOIN drivers d ON d.id=a.driver_id
               WHERE d.gov_user_id=? AND a.revoked_at IS NULL""", (user["id"],))
        r = await cur.fetchone()
        msg["driver"] = driver_state(r["vehicle_id"]) if r else None
        return msg
    units = await visible_units(conn, user)
    msg["units"] = [hub.unit_public_view(u) for u in units]
    if access.can_view_traffic(user):
        msg["traffic"] = traffic_view()
    msg["corridors"] = [{"vehicleId": u.vehicle_id, "category": u.category, "points": hub.corridor(u)}
                        for u in units if u.emergency_active and u.route]
    return msg


async def _public_tick(conn, citizen_id: str, pos: Optional[tuple]) -> dict:
    e = hub.engine
    msg = {"type": "tick", "version": hub.version, "mapVersion": mapraw.version(), "signals": hub.signal_colors,
           "engine": {"connected": e.connected, "simMode": e.sim_mode},
           "nearby": nearby_emergencies(*pos) if pos else []}
    cur = await conn.execute(
        f"""SELECT id FROM incidents WHERE reporter_citizen_id=? AND source='sos'
            AND status IN ({','.join('?' * len(incidents.OPEN_INCIDENT))}) ORDER BY created_at DESC""",
        (citizen_id, *incidents.OPEN_INCIDENT))
    msg["myIncidents"] = [await incidents.citizen_view(conn, r["id"]) for r in await cur.fetchall()]
    return msg


async def serve(ws: WebSocket) -> None:
    await ws.accept()
    conn = await schema_v2.connect()
    try:
        try:
            first = json.loads(await asyncio.wait_for(ws.receive_text(), AUTH_TIMEOUT_SEC))
        except (asyncio.TimeoutError, ValueError, WebSocketDisconnect):
            await ws.close(code=4401, reason="auth required")
            return
        app = first.get("app") if isinstance(first, dict) else None
        token = str(first.get("token", "")) if isinstance(first, dict) else ""
        user = citizen_id = None
        if app == "gov":
            uid = await auth_v2.subject_for_token(conn, token, "gov")
            user = await auth_v2.load_gov_user(conn, uid) if uid else None
            if user is None or not user["active"]:
                await ws.close(code=4401, reason="sign in again")
                return
        elif app == "public":
            citizen_id = await auth_v2.subject_for_token(conn, token, "citizen")
            if citizen_id is None:
                await ws.close(code=4401, reason="sign in again")
                return
        else:
            await ws.close(code=4400, reason="unknown app")
            return
        await ws.send_text(json.dumps({"type": "hello", "app": app}))

        pos: list = [None]

        async def reader():
            while True:
                try:
                    msg = json.loads(await ws.receive_text())
                except ValueError:
                    continue
                if isinstance(msg, dict) and msg.get("type") == "pos":
                    try:
                        lat, lon = float(msg["lat"]), float(msg["lon"])
                        if math.isfinite(lat) and math.isfinite(lon):
                            pos[0] = (lat, lon)  # used for this connection's own alerts only, never stored
                    except (KeyError, TypeError, ValueError):
                        pass

        read_task = asyncio.create_task(reader())
        try:
            while not read_task.done():
                try:
                    if user is not None:
                        tick = await _gov_tick(conn, user)
                    else:
                        tick = await _public_tick(conn, citizen_id, pos[0])
                except Exception:
                    logger.exception("tick failed")
                    tick = {"type": "tick", "version": hub.version, "error": "server error"}
                await ws.send_text(json.dumps(tick, separators=(",", ":")))
                await asyncio.wait([read_task], timeout=TICK_SEC)
        finally:
            read_task.cancel()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        await conn.close()
