"""Makes fear_backend findable over Wi-Fi without anyone typing an IP address.

The problem this solves: fear_system_deployable (and fear_authorization_app)
used to ship a hardcoded server URL, so every time the laptop running
fear_backend got a different DHCP lease - a new Wi-Fi network, a router
reboot, switching from hotspot to home Wi-Fi - somebody had to open the app's
Settings screen and retype the address by hand.

Instead, on startup (and on a heartbeat afterwards) this module:

  1. Works out which IPv4 address this machine is actually reachable on from
     the local network - the Wi-Fi/Ethernet address, never 127.0.0.1, which is
     only ever reachable by the machine itself and is exactly what made the
     old default useless from a phone.
  2. Publishes {host, port, base_url} to a Supabase table, keyed by a stable
     per-machine instance id so a restart UPDATES the row rather than piling
     up stale ones.

The apps then read the most recently updated online row and point themselves
at it. See supabase_schema.sql for the table and its policies, and
SETUP_SUPABASE.md for the one-time setup.

Everything here is best-effort and non-fatal: if Supabase isn't configured, or
the network is down, or the table doesn't exist yet, fear_backend still starts
and still serves every request exactly as before - the apps just fall back to
their manually-configured address. A prototype LAN tool should not refuse to
boot because a cloud directory is unreachable.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import socket
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

from . import config

logger = logging.getLogger("fear_backend.discovery")


# ---------------------------------------------------------------------------
# Which address is this machine actually reachable on?
# ---------------------------------------------------------------------------

def _score_candidate(ip: str) -> int:
    """Ranks a local IPv4 by how likely a phone on the same Wi-Fi is to be able
    to reach the machine on it. Higher is better; a negative score means
    "never advertise this one".

    The ordering matters because a developer laptop typically has several
    IPv4s at once - the real Wi-Fi adapter plus whatever WSL, Docker,
    VirtualBox and VMware have installed - and handing a phone the Docker
    bridge address looks exactly like "the app can't connect to the server".
    """
    try:
        addr = ipaddress.IPv4Address(ip)
    except ValueError:
        return -1
    if addr.is_loopback:
        return -1          # 127.x - the whole bug this module exists to fix
    if addr.is_link_local:
        return -1          # 169.254.x - APIPA, means DHCP actually failed
    if addr.is_multicast or addr.is_reserved or addr.is_unspecified:
        return -1

    # Known virtual-adapter ranges: routable-looking, but on a network segment
    # no phone is attached to.
    if ip.startswith("192.168.56."):
        return 1           # VirtualBox host-only
    if ip.startswith("172.17.") or ip.startswith("172.18."):
        return 1           # Docker / WSL2 bridges

    if addr.is_private:
        if ip.startswith("192.168."):
            return 100     # the overwhelmingly common home/phone-hotspot range
        if ip.startswith("10."):
            return 90      # common on larger/campus networks
        return 80          # the rest of 172.16/12
    return 40              # a public address - unusual here, but still routable


def detect_lan_ipv4() -> str | None:
    """Best guess at this machine's LAN-facing IPv4.

    Two independent sources, because neither alone is reliable on Windows:

      - The default-route probe: opening a UDP socket towards a public address
        and reading back the local end. No packet is ever sent (UDP connect is
        purely a local routing-table lookup), it needs no internet access to
        work, and it picks the interface the OS itself would use for outbound
        traffic - which on a laptop on Wi-Fi is the Wi-Fi adapter.
      - A full enumeration of the host's own addresses, as a fallback for the
        case where there is no default route at all (an isolated router or a
        phone hotspot with no upstream), where the probe can come back empty.

    Both feed into _score_candidate so a virtual-adapter address never wins
    over a real one. Returns None only if the machine genuinely has no usable
    non-loopback IPv4.
    """
    override = os.environ.get("FEAR_ADVERTISE_HOST", "").strip()
    if override:
        return override    # explicit operator override always wins - e.g. a port-forwarded hostname

    candidates: list[str] = []

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        candidates.append(s.getsockname()[0])
    except OSError:
        pass               # no default route - the enumeration below still has a chance
    finally:
        s.close()

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            candidates.append(info[4][0])
    except OSError:
        pass

    best, best_score = None, 0
    for ip in candidates:
        score = _score_candidate(ip)
        # Strictly greater, so the default-route probe (added first) wins any
        # tie against an enumerated address in the same range.
        if score > best_score:
            best, best_score = ip, score
    return best


# ---------------------------------------------------------------------------
# Supabase configuration
# ---------------------------------------------------------------------------

_CONFIG_PATH = os.environ.get(
    "FEAR_SUPABASE_CONFIG",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "supabase.json"),
)


def _load_supabase_config() -> dict:
    """Env vars first, then supabase.json next to this file. The JSON file is
    gitignored - it holds project keys - so a fresh checkout starts
    unconfigured and simply skips publishing rather than crashing."""
    cfg = {"url": "", "anon_key": "", "service_key": "", "table": "server_endpoints"}
    try:
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg.update({k: v for k, v in json.load(f).items() if v})
    except FileNotFoundError:
        pass
    except Exception as e:
        logger.warning("could not read %s (%s) - falling back to env vars", _CONFIG_PATH, e)

    for env_key, cfg_key in (
        ("FEAR_SUPABASE_URL", "url"),
        ("FEAR_SUPABASE_ANON_KEY", "anon_key"),
        ("FEAR_SUPABASE_SERVICE_KEY", "service_key"),
        ("FEAR_SUPABASE_TABLE", "table"),
    ):
        val = os.environ.get(env_key, "").strip()
        if val:
            cfg[cfg_key] = val
    cfg["url"] = cfg["url"].rstrip("/")
    return cfg


def _instance_id() -> str:
    """A stable id for THIS machine's fear_backend, so repeated startups update
    one row instead of appending a new one every time. Derived from the host
    name plus the MAC-based uuid.getnode(), both stable across reboots;
    overridable for the unusual case of two backends on one machine."""
    override = os.environ.get("FEAR_INSTANCE_ID", "").strip()
    if override:
        return override
    try:
        host = socket.gethostname()
    except OSError:
        host = "unknown"
    return f"{host}-{uuid.getnode():x}"


# ---------------------------------------------------------------------------
# Publishing
# ---------------------------------------------------------------------------

class EndpointRegistry:
    """Publishes this backend's reachable address to Supabase and keeps it
    fresh. One instance, created at import time below and driven by
    main.py's startup/shutdown hooks.

    The heartbeat re-detects the IP every time rather than caching it from
    startup: a laptop that moves from one Wi-Fi network to another keeps
    running, but its address changes underneath it, and the whole point of
    this module is that the apps follow that move without anyone retyping
    anything.
    """

    SERVICE = "fear_backend"
    HEARTBEAT_SECONDS = 30.0

    def __init__(self) -> None:
        self._cfg = _load_supabase_config()
        self._instance = _instance_id()
        self._task: asyncio.Task | None = None
        self._stopped = False
        self.last_published: dict | None = None
        self.last_error: str | None = None

    # -- configuration state, surfaced by main.py's /discovery endpoint -----

    @property
    def configured(self) -> bool:
        return bool(self._cfg["url"] and (self._cfg["service_key"] or self._cfg["anon_key"]))

    @property
    def _key(self) -> str:
        # The service key bypasses row-level security, so it is preferred when
        # present; the anon key works too as long as the table carries the
        # anon-write policy from supabase_schema.sql.
        return self._cfg["service_key"] or self._cfg["anon_key"]

    def describe(self) -> dict:
        return {
            "configured": self.configured,
            "supabaseUrl": self._cfg["url"] or None,
            "table": self._cfg["table"],
            "instanceId": self._instance,
            "usingServiceKey": bool(self._cfg["service_key"]),
            "lastPublished": self.last_published,
            "lastError": self.last_error,
        }

    # -- the payload -------------------------------------------------------

    def current_endpoint(self) -> dict | None:
        host = detect_lan_ipv4()
        if not host:
            return None
        port = config.API_PORT
        return {
            "service": self.SERVICE,
            "instance_id": self._instance,
            "host": host,
            "port": port,
            "base_url": f"http://{host}:{port}",
            "hostname": socket.gethostname(),
            "online": True,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    # -- HTTP --------------------------------------------------------------

    def _post_row(self, row: dict) -> None:
        """Blocking PostgREST upsert - always called via asyncio.to_thread.

        `on_conflict` plus `resolution=merge-duplicates` is PostgREST's upsert:
        it needs the (service, instance_id) unique constraint that
        supabase_schema.sql creates, otherwise this inserts a duplicate row
        every heartbeat.
        """
        url = (f"{self._cfg['url']}/rest/v1/{self._cfg['table']}"
               f"?on_conflict=service,instance_id")
        body = json.dumps(row).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "apikey": self._key,
                "Authorization": f"Bearer {self._key}",
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()

    async def publish_once(self) -> bool:
        """One publish attempt. Returns whether the row actually went out.
        Never raises - a failure here must not take the API down with it."""
        if not self.configured:
            self.last_error = "supabase not configured (see SETUP_SUPABASE.md)"
            return False
        row = self.current_endpoint()
        if row is None:
            self.last_error = "no non-loopback IPv4 found - is this machine on a network?"
            logger.warning("%s", self.last_error)
            return False
        try:
            await asyncio.to_thread(self._post_row, row)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            self.last_error = f"HTTP {e.code} from Supabase: {detail}"
            logger.warning("could not publish endpoint: %s", self.last_error)
            return False
        except Exception as e:
            self.last_error = str(e)
            logger.warning("could not publish endpoint: %s", e)
            return False

        if self.last_published is None or self.last_published.get("base_url") != row["base_url"]:
            logger.info("published endpoint %s to Supabase", row["base_url"])
        self.last_published = row
        self.last_error = None
        return True

    async def _heartbeat(self) -> None:
        while not self._stopped:
            await self.publish_once()
            try:
                await asyncio.sleep(self.HEARTBEAT_SECONDS)
            except asyncio.CancelledError:
                raise

    def start(self) -> None:
        if not self.configured:
            logger.info("Supabase endpoint publishing is off (not configured) - "
                        "apps will use their manually-set server address. See SETUP_SUPABASE.md")
            return
        self._stopped = False
        self._task = asyncio.create_task(self._heartbeat())

    async def stop(self) -> None:
        """Cancels the heartbeat and flips the row to online=false, so an app
        starting up while this backend is down doesn't connect to a dead
        address and sit there timing out. Best-effort and time-boxed: a slow
        network must not hold up shutdown."""
        self._stopped = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        if not self.configured or self.last_published is None:
            return
        row = dict(self.last_published)
        row["online"] = False
        row["updated_at"] = datetime.now(timezone.utc).isoformat()
        try:
            await asyncio.wait_for(asyncio.to_thread(self._post_row, row), timeout=5)
        except Exception:
            pass


registry = EndpointRegistry()
