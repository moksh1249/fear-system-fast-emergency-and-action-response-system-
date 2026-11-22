"""Lat/lon <-> map x/y and distance helpers.

x/y are the same equirectangular metres every other part of this project
uses (road_graph.hpp's latLonToXY, map-core.js): x east, y north, measured
from map_data.json's meta.origin. The apps only ever speak lat/lon; this
module is the one place that converts, so the projection constant and the
origin can't drift between call sites.
"""

from __future__ import annotations

import math
from typing import Iterable, Optional

from . import map_data

EARTH_RADIUS_M = 6378137.0  # matches road_graph.hpp's EARTH_RADIUS_M
_DEG = math.pi / 180.0


def _origin() -> tuple[float, float]:
    rm = map_data.get_road_map()
    return rm.origin_lat, rm.origin_lon


def to_xy(lat: float, lon: float) -> tuple[float, float]:
    olat, olon = _origin()
    x = (lon - olon) * _DEG * math.cos(olat * _DEG) * EARTH_RADIUS_M
    y = (lat - olat) * _DEG * EARTH_RADIUS_M
    return x, y


def to_latlon(x: float, y: float) -> tuple[float, float]:
    olat, olon = _origin()
    lat = olat + y / (_DEG * EARTH_RADIUS_M)
    lon = olon + x / (_DEG * math.cos(olat * _DEG) * EARTH_RADIUS_M)
    return lat, lon


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = lat1 * _DEG, lat2 * _DEG
    dp, dl = (lat2 - lat1) * _DEG, (lon2 - lon1) * _DEG
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = lat1 * _DEG, lat2 * _DEG
    dl = (lon2 - lon1) * _DEG
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.atan2(y, x) / _DEG + 360.0) % 360.0


def polyline_length_m(points: list) -> float:
    return sum(distance_m(a[0], a[1], b[0], b[1]) for a, b in zip(points, points[1:]))


def nearest_on_polyline(lat: float, lon: float, points: list) -> tuple[float, int]:
    """(distance in metres from the point to the polyline, index of the
    segment start it is nearest to). Flat-earth per segment - fine at city
    scale, where segments are tens of metres long."""
    if not points:
        return float("inf"), 0
    if len(points) == 1:
        return distance_m(lat, lon, points[0][0], points[0][1]), 0
    kx = math.cos(lat * _DEG) * _DEG * EARTH_RADIUS_M
    ky = _DEG * EARTH_RADIUS_M
    best, best_i = float("inf"), 0
    for i, (a, b) in enumerate(zip(points, points[1:])):
        ax, ay = (a[1] - lon) * kx, (a[0] - lat) * ky
        bx, by = (b[1] - lon) * kx, (b[0] - lat) * ky
        ex, ey = bx - ax, by - ay
        seg2 = ex * ex + ey * ey
        t = 0.0 if seg2 < 1e-9 else max(0.0, min(1.0, -(ax * ex + ay * ey) / seg2))
        px, py = ax + ex * t, ay + ey * t
        d = math.hypot(px, py)
        if d < best:
            best, best_i = d, i
    return best, best_i


def trim_polyline_ahead(lat: float, lon: float, points: list, max_m: float) -> list:
    """The part of `points` ahead of the point's nearest position on it, cut
    off after `max_m` metres."""
    if len(points) < 2:
        return list(points)
    _, i = nearest_on_polyline(lat, lon, points)
    out = [[lat, lon]]
    total = 0.0
    prev = out[0]
    for p in points[i + 1:]:
        total += distance_m(prev[0], prev[1], p[0], p[1])
        out.append(p)
        prev = p
        if total >= max_m:
            break
    return out


def within_bounds(lat: float, lon: float, bounds: Optional[dict], margin_deg: float = 0.0) -> bool:
    if not bounds:
        return True
    return (bounds["minlat"] - margin_deg <= lat <= bounds["maxlat"] + margin_deg
            and bounds["minlon"] - margin_deg <= lon <= bounds["maxlon"] + margin_deg)


def centroid(points: Iterable) -> tuple[float, float]:
    pts = list(points)
    if not pts:
        return 0.0, 0.0
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
