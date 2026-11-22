"""Where phones can reach this server.

  - LAN: every IPv4 address of this machine on a real network (the address
    phones on the same Wi-Fi use), best guess first.
  - Public: an optional Cloudflare quick tunnel (tools/cloudflared) that gives
    the server a temporary https://<random>.trycloudflare.com address reachable
    from any network - mobile data, another Wi-Fi. Started and stopped from
    FEAR Command; it dies with the backend. Anyone with the link reaches the
    sign-in screens, so it stays off until someone turns it on.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import socket
import subprocess
import threading
from typing import Optional

from . import config
from .discovery import detect_lan_ipv4

logger = logging.getLogger("fear_backend.netinfo")

CLOUDFLARED = os.environ.get(
    "FEAR_CLOUDFLARED",
    os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "tools", "cloudflared", "cloudflared.exe")),
)
_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


# Adapters no phone on the Wi-Fi can reach this machine through: VPNs
# (Cloudflare WARP's 172.16.0.2 ...), virtual switches, containers.
_NOT_LAN = ("warp", "vpn", "virtual", "vmware", "vbox", "hyper-v", "vethernet", "wsl", "docker", "loopback",
            "tailscale", "zerotier", "tap-", "tun", "pseudo")


def lan_addresses() -> list:
    ips = []
    best = detect_lan_ipv4()
    try:
        import psutil

        stats = psutil.net_if_stats()
        for name, addrs in psutil.net_if_addrs().items():
            st = stats.get(name)
            if st is None or not st.isup or any(k in name.lower() for k in _NOT_LAN):
                continue
            for a in addrs:
                ip = a.address
                if a.family == socket.AF_INET and not ip.startswith(("127.", "169.254.")) and ip not in ips:
                    ips.append(ip)
        if best in ips:  # the default-route adapter first
            ips.remove(best)
            ips.insert(0, best)
    except Exception:
        if best:
            ips.append(best)
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                ip = info[4][0]
                if ip not in ips and not ip.startswith(("127.", "169.254.", "172.16.0.")):
                    ips.append(ip)
        except OSError:
            pass
    return [f"http://{ip}:{config.API_PORT}" for ip in ips]


class Tunnel:
    def __init__(self):
        self.proc: Optional[subprocess.Popen] = None
        self.url: Optional[str] = None
        self.error: Optional[str] = None
        self.named = False  # the permanent address rather than a quick tunnel
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        return os.path.exists(CLOUDFLARED)

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def status(self) -> dict:
        if self.proc is not None and self.proc.poll() is not None and self.url:
            self.error, self.url = "the tunnel stopped", None
        return {"available": self.available, "running": self.running, "url": self.url if self.running else None,
                "permanent": bool(self.running and self.named), "error": self.error}

    def _start_named(self, named: dict, timeout: float) -> bool:
        """The permanent address (setup_permanent_link.py): same https URL
        every time. Up once Cloudflare registers a connection."""
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.proc = subprocess.Popen(
            [CLOUDFLARED, "tunnel", "--no-autoupdate", "--config", named["config"], "run"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
            creationflags=flags,
        )
        up = threading.Event()

        def pump():
            for line in self.proc.stdout:
                if "Registered tunnel connection" in line or "Connection registered" in line:
                    up.set()

        threading.Thread(target=pump, daemon=True).start()
        if up.wait(timeout):
            self.url = f"https://{named['hostname']}"
            self.named = True
            logger.info("permanent public address up at %s", self.url)
            return True
        logger.warning("named tunnel didn't connect - falling back to a quick tunnel")
        self._stop_locked()
        return False

    def _start_blocking(self, timeout: float = 25.0) -> dict:
        with self._lock:
            if self.running and self.url:
                return self.status()
            if not self.available:
                self.error = f"cloudflared not found at {CLOUDFLARED}"
                return self.status()
            self.error, self.url, self.named = None, None, False
            named = named_tunnel()
            if named and self._start_named(named, timeout):
                return self.status()
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            self.proc = subprocess.Popen(
                [CLOUDFLARED, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{config.API_PORT}"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                creationflags=flags,
            )
            found = threading.Event()

            def pump():
                for line in self.proc.stdout:  # keeps draining for the tunnel's whole life
                    m = _URL_RE.search(line)
                    if m and not self.url:
                        self.url = m.group(0)
                        logger.info("public tunnel up at %s", self.url)
                        found.set()

            threading.Thread(target=pump, daemon=True).start()
            if not found.wait(timeout):
                self.error = "Cloudflare did not hand out an address in time (is this machine online?)"
                self._stop_locked()
            return self.status()

    async def start(self) -> dict:
        return await asyncio.to_thread(self._start_blocking)

    def _stop_locked(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc, self.url = None, None

    def stop(self) -> dict:
        with self._lock:
            self._stop_locked()
            self.error = None
        return self.status()


tunnel = Tunnel()
tunnel_was_on_audited = False

# Whether the public link should be up: remembered across restarts, so a
# server that was reachable from anywhere comes back that way.
_STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public_link.json")


def _state() -> dict:
    try:
        import json

        with open(_STATE, encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_state(d: dict) -> None:
    import json

    try:
        with open(_STATE, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=2)
    except OSError:
        pass


def public_wanted() -> bool:
    return bool(_state().get("on"))


def set_public_wanted(on: bool) -> None:
    _save_state({**_state(), "on": bool(on)})


def named_tunnel() -> Optional[dict]:
    """The permanent address, once setup_permanent_link.py has made it:
    {"hostname": "app.example.com", "config": ".../fear-system.yml"}."""
    n = _state().get("named")
    if isinstance(n, dict) and n.get("hostname") and n.get("config") and os.path.exists(n["config"]):
        return n
    return None


def set_named_tunnel(hostname: str, config_path: str) -> None:
    _save_state({**_state(), "on": True, "named": {"hostname": hostname, "config": config_path}})


async def ensure_public(wait_reachable: float = 20.0) -> dict:
    """Starts the public link if it isn't up, and waits (up to
    `wait_reachable` s) until it actually answers - a fresh quick-tunnel
    address takes a few seconds to resolve on the internet. Used whenever a
    sign-in QR is made, so every QR works on the Wi-Fi AND from anywhere."""
    st = tunnel.status()
    already_up = bool(st["running"] and st["url"])
    if not already_up:
        st = await tunnel.start()
    if not st.get("url"):
        return st
    set_public_wanted(True)
    if already_up or st.get("permanent"):
        # Up already, or the permanent address (stable DNS, connector
        # registered): nothing to wait for - only a brand-new quick-tunnel
        # address needs a moment to resolve on the internet.
        return {**st, "reachable": True}
    import httpx

    deadline = asyncio.get_running_loop().time() + wait_reachable
    async with httpx.AsyncClient(timeout=5.0) as c:
        while asyncio.get_running_loop().time() < deadline:
            try:
                r = await c.get(f"{st['url']}/health")
                if r.status_code == 200:
                    return {**st, "reachable": True}
            except httpx.HTTPError:
                pass
            await asyncio.sleep(1.5)
    return {**st, "reachable": False}


def server_urls() -> list:
    """Every address a phone might use, LAN first, then the public tunnel."""
    urls = lan_addresses()
    if tunnel.running and tunnel.url:
        urls.append(tunnel.url)
    return urls
