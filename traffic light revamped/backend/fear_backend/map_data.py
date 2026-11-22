"""Loads map_data.json (the same file backend/sim/road_graph.hpp reads) and
extracts a slimmed-down road-only view for fear_system_deployable's in-app
map: routable ways + the nodes they reference, plus the projection origin -
buildings/amenities/redlightGroups are dropped, they're not needed for a
driving map. Cached in memory, refreshed only when the file's mtime changes,
since this is read on every /map/roads and /route request but the file itself
only changes when someone edits the map in the browser editor.

Kept deliberately dependency-free (stdlib json only) and free of any C++/CH
knowledge - this module only ever answers "what roads/nodes exist" and
"which node is nearest to this point", never "what's the shortest path"
(that's ch_query.exe's job, proxied from main.py's /route).
"""

from __future__ import annotations

import json
import os
import threading
from typing import Optional

from . import config

# Mirrors road_graph.hpp's isRoutableHighway() exactly - a way tagged with one
# of these is excluded from the routing graph there, so it's excluded from
# this app's road map too (no point showing a footway a car can't route onto).
_NON_ROUTABLE_HIGHWAYS = {
    "footway", "path", "steps", "track", "cycleway", "pedestrian",
    "bridleway", "construction", "proposed", "platform", "elevator",
    "corridor", "razed", "raceway",
}


class RoadMap:
    __slots__ = ("origin_lat", "origin_lon", "nodes", "ways", "routable_node_ids", "mtime")

    def __init__(self, origin_lat, origin_lon, nodes, ways, routable_node_ids, mtime):
        self.origin_lat = origin_lat
        self.origin_lon = origin_lon
        self.nodes = nodes  # id -> (x, y)
        self.ways = ways  # list of {"id": str, "hw": str, "n": [nodeId, ...]}
        self.routable_node_ids = routable_node_ids  # set of ids actually used by a routable way
        self.mtime = mtime

    def nearest_routable_node(self, x: float, y: float) -> Optional[str]:
        """Plain linear scan - same reasoning as vehicles.hpp's own
        nearestRoutableNodeId: only ever called once or twice per route
        request, nowhere near a hot path, not worth a spatial index for a
        ~15k-node map."""
        best_id = None
        best_d2 = float("inf")
        for node_id in self.routable_node_ids:
            nx, ny = self.nodes[node_id]
            d2 = (nx - x) ** 2 + (ny - y) ** 2
            if d2 < best_d2:
                best_d2 = d2
                best_id = node_id
        return best_id


_lock = threading.Lock()
_cached: Optional[RoadMap] = None


def _build(raw: dict, mtime: float) -> RoadMap:
    origin = raw.get("meta", {}).get("origin", {})
    origin_lat = float(origin.get("lat", 0.0))
    origin_lon = float(origin.get("lon", 0.0))

    all_nodes = raw.get("nodes", {})
    ways_out = []
    used_node_ids = set()
    for w in raw.get("ways", []):
        hw = (w.get("tags") or {}).get("highway")
        if not hw or hw in _NON_ROUTABLE_HIGHWAYS:
            continue
        node_ids = [n for n in w.get("nodes", []) if n in all_nodes]
        if len(node_ids) < 2:
            continue
        ways_out.append({"id": w.get("id", ""), "hw": hw, "n": node_ids})
        used_node_ids.update(node_ids)

    nodes_out = {}
    for node_id in used_node_ids:
        n = all_nodes[node_id]
        nodes_out[node_id] = (float(n.get("x", 0.0)), float(n.get("y", 0.0)))

    return RoadMap(origin_lat, origin_lon, nodes_out, ways_out, used_node_ids, mtime)


def get_road_map() -> RoadMap:
    global _cached
    mtime = os.path.getmtime(config.MAP_DATA_PATH)
    with _lock:
        if _cached is not None and _cached.mtime == mtime:
            return _cached
        with open(config.MAP_DATA_PATH, encoding="utf-8") as f:
            raw = json.load(f)
        _cached = _build(raw, mtime)
        return _cached
