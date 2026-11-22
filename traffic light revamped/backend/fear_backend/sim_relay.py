"""Read-only fan-out of the sim engine's state stream to phone map pages.

sim_engine.cpp's WebSocket server only listens on loopback, so a phone can't
connect to it the way the laptop's simulation page does. Instead the phone's
map page (front-end/simulation.html?mobile=1, served by main.py's /web mount)
connects to /ws/live here, and this relays what sim_bridge's one engine
connection already receives. Three things differ from a direct connection:

  - It needs a driver session. The stream carries the live GPS position of
    every tracked real vehicle, so the page's first message has to be
    {"type": "relayAuth", "token": <driver session token>}; nothing is sent
    before that, and the socket is closed if it doesn't arrive in time.
  - Each state frame is cut down per client to what that phone can use: the
    vehicles inside its current view (reported as {"type": "relayView",
    "bbox": [minX, minY, maxX, maxY], "me": [x, y] | null, "nearbyRadius": m}),
    every emergency-capable vehicle within its nearby radius, and every live
    GPS-tracked vehicle. A full frame is ~100 bytes a vehicle at ~20 Hz - too
    much to push to a phone over Wi-Fi. Frames are also throttled to
    config.RELAY_HZ, and a slow phone skips frames rather than queueing them.
  - It is read-only. A phone may ask for a vehicle's route or info
    (getRoute/getVehicleInfo); every other command - start/stop, signal mode,
    dispatch - is dropped, so a phone can never change the simulation.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from collections import deque
from datetime import datetime, timezone
from typing import Optional

import aiosqlite
from fastapi import WebSocket, WebSocketDisconnect

from . import config, sim_bridge

logger = logging.getLogger("fear_backend.sim_relay")

# Same allowlist as sim-client.js's EMERGENCY_VEHICLE_TYPES / vehicles.hpp's
# isEmergencyCapable.
EMERGENCY_TYPES = frozenset({"ambulance", "firetruck", "police"})

# Page -> engine commands that only read state. The engine answers them on
# the bridge's socket, as "route"/"vehicleInfo" messages, which go back to
# every relay client - each page ignores an answer for an id it didn't ask about.
FORWARDED_COMMANDS = frozenset({"getRoute", "getVehicleInfo"})
FORWARDED_REPLIES = frozenset({"route", "vehicleInfo"})

AUTH_TIMEOUT_SEC = 10
VIEW_MARGIN_M = 80  # vehicles just off-screen too, so they don't pop in at the edge while panning


def _finite(values, n) -> Optional[tuple]:
    if not isinstance(values, (list, tuple)) or len(values) != n:
        return None
    try:
        out = tuple(float(v) for v in values)
    except (TypeError, ValueError):
        return None
    return out if all(math.isfinite(v) for v in out) else None


class _Client:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.bbox: Optional[tuple] = None  # (minX, minY, maxX, maxY), world metres - None until the page reports its view
        self.me: Optional[tuple] = None    # (x, y) - this phone's own position, if it has a fix
        self.nearby_r = config.RELAY_NEARBY_RADIUS_M
        self._state_frame: Optional[str] = None  # latest only - a newer frame replaces an unsent one
        self._replies: deque[str] = deque(maxlen=32)
        self._wake = asyncio.Event()

    def set_view(self, msg: dict) -> None:
        bbox = _finite(msg.get("bbox"), 4)
        if bbox is not None:
            self.bbox = (min(bbox[0], bbox[2]), min(bbox[1], bbox[3]), max(bbox[0], bbox[2]), max(bbox[1], bbox[3]))
        self.me = _finite(msg.get("me"), 2)
        r = msg.get("nearbyRadius")
        if isinstance(r, (int, float)) and math.isfinite(r):
            self.nearby_r = min(10_000.0, max(100.0, float(r)))

    def view(self) -> tuple:
        return (self.bbox, self.me, self.nearby_r)

    def push_state(self, frame: str) -> None:
        self._state_frame = frame
        self._wake.set()

    def push_reply(self, raw: str) -> None:
        self._replies.append(raw)
        self._wake.set()

    async def send_loop(self) -> None:
        try:
            while True:
                await self._wake.wait()
                self._wake.clear()
                while self._replies:
                    await self.ws.send_text(self._replies.popleft())
                frame, self._state_frame = self._state_frame, None
                if frame is not None:
                    await self.ws.send_text(frame)
        except Exception:
            pass  # the page went away mid-send - serve()'s receive loop sees the disconnect and cleans up


def _select_vehicles(vehicles: list, view: tuple) -> list:
    bbox, me, nearby_r = view
    picked, in_view = [], []
    if bbox is not None:
        min_x, min_y = bbox[0] - VIEW_MARGIN_M, bbox[1] - VIEW_MARGIN_M
        max_x, max_y = bbox[2] + VIEW_MARGIN_M, bbox[3] + VIEW_MARGIN_M
    r2 = nearby_r * nearby_r
    for v in vehicles:
        x, y = v.get("x", 0.0), v.get("y", 0.0)
        if v.get("live"):
            picked.append(v)
        elif me is not None and v.get("ty") in EMERGENCY_TYPES and (x - me[0]) ** 2 + (y - me[1]) ** 2 <= r2:
            picked.append(v)
        elif bbox is not None and min_x <= x <= max_x and min_y <= y <= max_y:
            in_view.append(v)
    if len(in_view) > config.RELAY_MAX_VIEW_VEHICLES:
        cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
        in_view.sort(key=lambda v: (v.get("x", 0.0) - cx) ** 2 + (v.get("y", 0.0) - cy) ** 2)
        del in_view[config.RELAY_MAX_VIEW_VEHICLES:]
    return picked + in_view


def _build_frames(raw: str, views: list) -> list:
    """One parse of the engine's frame, one cut-down re-encode per client.
    Runs in a worker thread - a busy simulation's frame is ~1 MB of JSON."""
    msg = json.loads(raw)
    vehicles = msg.pop("vehicles", None) or []
    frames = []
    for view in views:
        msg["vehicles"] = _select_vehicles(vehicles, view)
        frames.append(json.dumps(msg, separators=(",", ":")))
    return frames


async def _driver_for_token(token: str) -> Optional[str]:
    """The vehicle id of an unexpired, active driver session - same checks as
    main.py's require_driver, minus the HTTP plumbing."""
    async with aiosqlite.connect(config.DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute(
            "SELECT s.subject_id, s.expires_at FROM sessions s JOIN vehicles v ON v.id = s.subject_id "
            "WHERE s.token=? AND s.subject_type='driver' AND v.active=1",
            (token,),
        )
        row = await cur.fetchone()
    if row is None or datetime.fromisoformat(row["expires_at"]) < datetime.now(timezone.utc):
        return None
    return row["subject_id"]


class SimRelay:
    def __init__(self):
        self.clients: set[_Client] = set()
        self._latest: Optional[str] = None
        self._new_frame = asyncio.Event()
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        sim_bridge.bridge.on_message = self.on_engine_message
        self._task = asyncio.create_task(self._pump())

    async def stop(self) -> None:
        sim_bridge.bridge.on_message = None
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

    def on_engine_message(self, raw: str) -> None:
        if not self.clients:
            return
        # Sniff the type without parsing: state frames are the big, frequent
        # ones, and only the newest is worth parsing at all (see _pump).
        if raw.startswith('{"type":"state"'):
            self._latest = raw
            self._new_frame.set()
            return
        try:
            kind = json.loads(raw).get("type")
        except (ValueError, AttributeError):
            return
        if kind in FORWARDED_REPLIES:
            for c in self.clients:
                c.push_reply(raw)

    async def _pump(self) -> None:
        min_interval = 1.0 / max(0.5, config.RELAY_HZ)
        while True:
            await self._new_frame.wait()
            self._new_frame.clear()
            raw, self._latest = self._latest, None
            clients = list(self.clients)
            if raw is None or not clients:
                continue
            started = time.monotonic()
            try:
                frames = await asyncio.to_thread(_build_frames, raw, [c.view() for c in clients])
            except Exception:
                logger.exception("could not relay a state frame")
                continue
            for c, frame in zip(clients, frames):
                c.push_state(frame)
            await asyncio.sleep(max(0.0, min_interval - (time.monotonic() - started)))

    async def serve(self, ws: WebSocket) -> None:
        """The whole life of one /ws/live connection."""
        await ws.accept()
        try:
            first = json.loads(await asyncio.wait_for(ws.receive_text(), AUTH_TIMEOUT_SEC))
            vehicle_id = await _driver_for_token(str(first.get("token", ""))) if first.get("type") == "relayAuth" else None
        except (asyncio.TimeoutError, ValueError, AttributeError, WebSocketDisconnect):
            vehicle_id = None
        if vehicle_id is None:
            await ws.close(code=4401, reason="driver session required")
            return

        client = _Client(ws)
        self.clients.add(client)
        sender = asyncio.create_task(client.send_loop())
        try:
            while True:
                try:
                    msg = json.loads(await ws.receive_text())
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("type") == "relayView":
                    client.set_view(msg)
                elif msg.get("cmd") in FORWARDED_COMMANDS:
                    await sim_bridge.bridge.send_command(msg)
        except WebSocketDisconnect:
            pass
        finally:
            self.clients.discard(client)
            sender.cancel()


relay = SimRelay()
