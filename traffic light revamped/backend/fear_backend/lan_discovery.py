"""Answers "where is fear_backend?" broadcasts from the apps on the local Wi-Fi.

The apps used to need the laptop's IP typed in (or baked in), and a DHCP lease
change - a router reboot, a different network - silently broke them. Now an
app that can't reach its saved address sends a small UDP broadcast to
DISCOVERY_PORT, and this responder replies straight back to it. The app takes
the reply's *source address* as the server host: that is, by construction, an
address of this machine the phone can already exchange packets with, which
sidesteps guessing between the Wi-Fi, WSL, Docker and VPN adapters that
discovery.detect_lan_ipv4 has to rank.

Wire format, one JSON object per datagram:

    request  {"t": "fear_discover", "v": 1, "service": "fear_backend"}
    reply    {"t": "fear_here", "v": 1, "service": "fear_backend",
              "port": 8080, "host": "10.12.21.81", "hostname": "LAPTOP"}

`host` is informational; the apps use the datagram's source address.

A plain blocking socket on a daemon thread rather than an asyncio datagram
endpoint: on Windows, a reply to an app that already stopped listening comes
back as ICMP port-unreachable, which surfaces as ConnectionResetError on the
next recvfrom. Here that is one `except` and the loop carries on, independent
of which event loop uvicorn picked.

Like the rest of fear_backend this is a LAN prototype: anything on the same
network can answer a broadcast. The apps only go looking when their saved
address has stopped answering, which limits but does not remove that.
"""

from __future__ import annotations

import json
import logging
import socket
import threading
import time

from . import config
from .discovery import detect_lan_ipv4

logger = logging.getLogger("fear_backend.lan_discovery")

SERVICE = "fear_backend"
PROTOCOL_VERSION = 1
REQUEST_TYPE = "fear_discover"
REPLY_TYPE = "fear_here"

# Real requests are ~60 bytes. Anything much bigger is not from the apps and is
# dropped before JSON parsing.
_MAX_REQUEST_BYTES = 512


def build_reply(data: bytes) -> bytes | None:
    """The reply for one received datagram, or None if it isn't a valid
    discovery request. Pure, so it can be tested without sockets."""
    if len(data) > _MAX_REQUEST_BYTES:
        return None
    try:
        msg = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(msg, dict) or msg.get("t") != REQUEST_TYPE or msg.get("service") != SERVICE:
        return None
    try:
        hostname = socket.gethostname()
    except OSError:
        hostname = None
    return json.dumps({
        "t": REPLY_TYPE,
        "v": PROTOCOL_VERSION,
        "service": SERVICE,
        "port": config.API_PORT,
        "host": detect_lan_ipv4(),
        "hostname": hostname,
    }).encode("utf-8")


class LanDiscoveryResponder:
    def __init__(self, port: int = config.DISCOVERY_PORT) -> None:
        self.port = port
        self._sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stopped = False

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        """Non-fatal like discovery.registry.start(): if the port is taken the
        API still serves, the apps just can't find it by broadcast."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.bind((config.API_HOST, self.port))
        except OSError as e:
            sock.close()
            logger.warning("LAN discovery is off - could not bind UDP port %d (%s)", self.port, e)
            return
        # The timeout only exists so stop() is noticed promptly.
        sock.settimeout(1.0)
        self._sock = sock
        self._stopped = False
        self._thread = threading.Thread(target=self._serve, name="fear-lan-discovery", daemon=True)
        self._thread.start()
        logger.info("LAN discovery listening on UDP %s:%d", config.API_HOST, self.port)

    def _serve(self) -> None:
        sock = self._sock
        assert sock is not None
        while not self._stopped:
            try:
                # 65535, not _MAX_REQUEST_BYTES: on Windows a datagram larger
                # than the buffer raises instead of truncating.
                data, addr = sock.recvfrom(65535)
            except socket.timeout:
                continue
            except ConnectionResetError:
                continue   # ICMP port-unreachable from an app that stopped listening
            except OSError as e:
                if self._stopped:
                    return
                logger.warning("LAN discovery receive failed: %s", e)
                time.sleep(1.0)
                continue

            reply = build_reply(data)
            if reply is None:
                continue
            try:
                sock.sendto(reply, addr)
            except OSError as e:
                logger.debug("could not answer discovery request from %s: %s", addr, e)

    def stop(self) -> None:
        self._stopped = True
        if self._sock is not None:
            self._sock.close()
            self._sock = None
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None


responder = LanDiscoveryResponder()
