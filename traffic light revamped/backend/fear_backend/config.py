"""Runtime configuration for fear_backend, all overridable via env vars so the
service can be pointed at a different sim-engine host/port or DB location
without editing code - this app is meant to run on a LAN with phones and the
traffic-light operator machine potentially being different hosts."""

import os

API_HOST = os.environ.get("FEAR_API_HOST", "0.0.0.0")
API_PORT = int(os.environ.get("FEAR_API_PORT", "8080"))

# UDP port lan_discovery.py answers broadcasts on. The apps broadcast to a fixed
# port (ServerDiscovery.defaultPort in fear_shared) so they can find the API
# even when FEAR_API_PORT is changed - change both together or not at all.
DISCOVERY_PORT = int(os.environ.get("FEAR_DISCOVERY_PORT", "8081"))

DB_PATH = os.environ.get(
    "FEAR_DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "fear.db"),
)

# Matches serve.py's SIM_DEFAULT_PORT - the sim engine's own hand-rolled
# WebSocket server, the same one front-end/sim-client.js connects to.
SIM_ENGINE_HOST = os.environ.get("FEAR_SIM_HOST", "127.0.0.1")
SIM_ENGINE_PORT = int(os.environ.get("FEAR_SIM_PORT", "8766"))

# A sign-in lasts until the person signs out (or the account is disabled,
# removed or its password reset) - phones and Command stay signed in.
SESSION_TTL_SECONDS = int(os.environ.get("FEAR_SESSION_TTL", str(10 * 365 * 24 * 3600)))

# Kept identical to generate_vehicles.py / sim_engine.cpp's vehicle types so a
# vehicle registered here is guaranteed to render/behave correctly once live.
VEHICLE_TYPES = ["car", "motorcycle", "bus", "truck", "ambulance", "firetruck", "police"]

# The project root's own map_data.json - same file sim_engine.cpp/road_graph.hpp
# read (see buildRoadGraph), read directly off disk rather than via serve.py so
# fear_backend can serve map data even when serve.py isn't running.
MAP_DATA_PATH = os.environ.get(
    "FEAR_MAP_DATA_PATH",
    os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "front-end", "map_data.json")),
)

# serve.py's own HTTP API (map_data.json editor/viewer + POST /api/route, the
# ch_query.exe-backed point-to-point router - see that file's own docstring).
# Only the routing proxy (see main.py's /route) needs this; map/roads reads
# map_data.json directly and works even if serve.py isn't up.
SERVE_HOST = os.environ.get("FEAR_SERVE_HOST", "127.0.0.1")
SERVE_PORT = int(os.environ.get("FEAR_SERVE_PORT", "8765"))

# The laptop's web viewer, served read-only under /web (see main.py) so a
# phone can load the very same map page (front-end/simulation.html, in its
# ?mobile=1 mode) that the laptop renders - serve.py itself only listens on
# loopback. ICONS_DIR mirrors serve.py's own icons/ special case.
FRONTEND_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "front-end"))
ICONS_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "icons"))

# sim_relay.py - the phone map pages' read-only view of the engine's state
# stream. The engine broadcasts at ~20 Hz; a phone gets at most RELAY_HZ of
# those, cut down to its own view (capped at RELAY_MAX_VIEW_VEHICLES, nearest
# the view centre first) plus every emergency-capable vehicle within its
# nearby radius.
RELAY_HZ = float(os.environ.get("FEAR_RELAY_HZ", "10"))
RELAY_MAX_VIEW_VEHICLES = int(os.environ.get("FEAR_RELAY_MAX_VIEW_VEHICLES", "2500"))
RELAY_NEARBY_RADIUS_M = float(os.environ.get("FEAR_RELAY_NEARBY_RADIUS_M", "1500"))

# A phone that opens the live map or starts tracking needs the engine up;
# when nothing is connected, fear_backend asks serve.py to start one with
# these settings (the web viewer's own Start-button defaults). serve.py still
# owns the engine's lifecycle - this only ever sends it the same
# /api/sim/start request that button does. FEAR_SIM_AUTOSTART=0 turns it off.
SIM_AUTOSTART = os.environ.get("FEAR_SIM_AUTOSTART", "1") != "0"
SIM_AUTOSTART_MODE = os.environ.get("FEAR_SIM_AUTOSTART_MODE", "simulation")
SIM_AUTOSTART_CONCURRENCY = int(os.environ.get("FEAR_SIM_AUTOSTART_CONCURRENCY", "500"))

# FEAR Command's web build, served at /command so any browser on the LAN can
# open the Command & Control dashboard (see apps/fear_gov in the repo root).
COMMAND_WEB_DIR = os.environ.get(
    "FEAR_COMMAND_WEB_DIR",
    os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "apps", "fear_gov", "build", "web")),
)

# The Android apps offered for download at /get (downloads.py): the
# "Android apps" folder in the project root, refreshed by `launcher/fear.ps1 build`.
APPS_DIR = os.environ.get(
    "FEAR_APPS_DIR",
    os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "Android apps")),
)


# Sarvam AI (https://docs.sarvam.ai): speech-to-text for voice reports and the
# language model behind incident triage and the AI dispatch agent. The key
# comes from SARVAM_API_KEY, else local_secrets.json next to this file (kept
# on this machine; nothing serves it). With no key, voice reports are off and
# triage / the agent fall back to their rule-based parts.
def _local_secret(name: str) -> str:
    try:
        import json as _json

        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "local_secrets.json"), encoding="utf-8") as f:
            return str(_json.load(f).get(name) or "")
    except (OSError, ValueError):
        return ""


SARVAM_API_KEY = os.environ.get("SARVAM_API_KEY") or _local_secret("SARVAM_API_KEY")
SARVAM_BASE_URL = os.environ.get("SARVAM_BASE_URL", "https://api.sarvam.ai")
SARVAM_STT_MODEL = os.environ.get("SARVAM_STT_MODEL", "saaras:v4")
SARVAM_CHAT_MODEL = os.environ.get("SARVAM_CHAT_MODEL", "sarvam-105b")

# The AI dispatch agent (ai_dispatch.py): how long an emergency may wait with
# no human response and no unit before the agent steps in.
AI_DISPATCH_WINDOW_SEC = int(os.environ.get("FEAR_AI_DISPATCH_WINDOW_SEC", "120"))
