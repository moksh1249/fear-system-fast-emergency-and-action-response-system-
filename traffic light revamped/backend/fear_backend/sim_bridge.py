"""Keeps one outbound WebSocket client connection to backend/sim/sim_engine.cpp's
own hand-rolled WS server (the same server front-end/sim-client.js connects to
- see serve.py's SIM_ENGINE lifecycle comments), auto-reconnecting whenever the
engine isn't running yet or gets restarted. fear_backend never manages the
engine's lifecycle itself (that stays serve.py's job, unchanged) - it just
forwards live vehicle commands to it, best-effort, whenever it's reachable.

The engine broadcasts its full simulation state to every connected client
several times a second. Every incoming message is handed to `on_message`
(sim_relay.py hooks in there to fan the stream out to phone map pages) and
otherwise drained - the alternative (not reading them at all) would
eventually deadlock the socket once the OS receive buffer filled up.
"""

import asyncio
import json
import logging
from typing import Callable, Optional

import websockets

from . import config

logger = logging.getLogger("fear_backend.sim_bridge")


class SimBridge:
    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self._ws = None
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._stopped = False
        # Called with each raw text message the engine sends; must not block.
        self.on_message: Optional[Callable[[str], None]] = None
        # Further subscribers (live.py's engine view), same contract.
        self._listeners: list[Callable[[str], None]] = []

    def start(self) -> None:
        self._stopped = False
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stopped = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        async with self._lock:
            self._ws = None

    async def _run(self) -> None:
        backoff = 1.0
        uri = f"ws://{self.host}:{self.port}"
        while not self._stopped:
            try:
                # max_size=None: one state frame carries every active vehicle
                # (~100 bytes each), so a busy simulation's frames outgrow the
                # library's 1 MiB default - which would drop the connection.
                async with websockets.connect(uri, open_timeout=3, max_size=None) as ws:
                    async with self._lock:
                        self._ws = ws
                    logger.info("connected to sim engine at %s", uri)
                    backoff = 1.0
                    async for raw in ws:
                        if not isinstance(raw, str):
                            continue
                        if self.on_message is not None:
                            self.on_message(raw)
                        for listener in self._listeners:
                            listener(raw)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.info("sim engine not reachable at %s (%s) - retrying in %.0fs", uri, e, backoff)
            async with self._lock:
                self._ws = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 1.5, 15.0)

    async def send_command(self, payload: dict) -> bool:
        """Best-effort send - returns whether it actually went out. Never
        raises: a caller (an HTTP request handler) must not fail just because
        the engine happens to be offline right now."""
        async with self._lock:
            ws = self._ws
        if ws is None:
            return False
        try:
            await ws.send(json.dumps(payload))
            return True
        except Exception:
            return False

    def add_listener(self, fn: Callable[[str], None]) -> None:
        self._listeners.append(fn)

    def remove_listener(self, fn: Callable[[str], None]) -> None:
        if fn in self._listeners:
            self._listeners.remove(fn)

    def connected(self) -> bool:
        return self._ws is not None


bridge = SimBridge(config.SIM_ENGINE_HOST, config.SIM_ENGINE_PORT)
