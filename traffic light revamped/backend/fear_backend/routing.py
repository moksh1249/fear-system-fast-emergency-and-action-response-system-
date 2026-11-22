"""Road routing in lat/lon for the apps, on top of serve.py's ch_query-backed
/api/route (the same Contraction Hierarchy the sim engine routes on)."""

from __future__ import annotations

import asyncio
from typing import Optional

from . import geo, map_data, navigation


def _route_blocking(from_lat: float, from_lon: float, to_lat: float, to_lon: float) -> Optional[dict]:
    from .main import _serve_json  # serve.py proxy helper - imported late, main imports this module

    rm = map_data.get_road_map()
    fx, fy = geo.to_xy(from_lat, from_lon)
    tx, ty = geo.to_xy(to_lat, to_lon)
    start = rm.nearest_routable_node(fx, fy)
    end = rm.nearest_routable_node(tx, ty)
    if not start or not end:
        return None
    if start == end:
        return {"found": True, "points": [[from_lat, from_lon], [to_lat, to_lon]],
                "durationSec": 0.0, "distanceM": geo.distance_m(from_lat, from_lon, to_lat, to_lon)}
    res = _serve_json("/api/route", {"start": start, "end": end})
    if not res.get("ok"):
        return {"found": False, "error": res.get("error", "routing failed")}
    if not res.get("found"):
        return {"found": False, "error": "no road route between these points"}
    path = res.get("path", [])
    pts = [list(geo.to_latlon(p["x"], p["y"])) for p in path]
    # Join the real endpoints to the road so the line starts at the vehicle
    # and ends at the incident, not at the nearest graph node.
    pts = [[from_lat, from_lon]] + pts + [[to_lat, to_lon]]
    try:
        steps = navigation.steps_for(path, (fx, fy), (tx, ty))
    except Exception:
        steps = []
    return {"found": True, "points": pts, "durationSec": float(res.get("distanceSec") or 0.0),
            "distanceM": geo.polyline_length_m(pts), "steps": steps}


async def route(from_lat: float, from_lon: float, to_lat: float, to_lon: float) -> Optional[dict]:
    return await asyncio.to_thread(_route_blocking, from_lat, from_lon, to_lat, to_lon)
