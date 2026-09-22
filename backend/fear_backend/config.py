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

SESSION_TTL_SECONDS = int(os.environ.get("FEAR_SESSION_TTL", str(60 * 60 * 12)))  # 12h

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
