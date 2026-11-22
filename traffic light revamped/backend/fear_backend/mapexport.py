"""The map for the phone apps' native renderer, which draws it in the
red-lights-revamped viewer's own style (map-core.js's ROAD_STYLE, building
colours and junction fills).

Split by level of detail so a zoomed-out phone never downloads detail it
can't see:

  /v2/map              base layer: meta, the major roads (motorway ...
                       tertiary and their links), their junction fills,
                       areas, signals and lamps
  /v2/map/tile?tx=&ty= one 1 km x 1 km tile of detail: minor roads, their
                       junction fills, buildings, amenities - fetched by the
                       app only for tiles in view once zoomed in

Everything is in the project's x/y metres (x east, y north from
meta.origin), rounded to 0.1 m, as positional arrays:

  ways       [highway, widthM (0 = style default), oneway, layer, name, [x0, y0, x1, y1, ...]]
  junctions  [highway of the widest road meeting there, [x0, y0, ...]]  - the
             surface joining the road ends of one junction (roads stop a
             few metres short of a junction, see osm_to_json.py)
  buildings  [[x0, y0, ...], ...]
  areas      [kind, zoneType|level, name, [x0, y0, ...]]
  amenities  [amenity, name, x, y]
  lamps      [x, y]          - same order as signals.layout(), coloured by the live tick
  signals    [nodeId, x, y]
"""

from __future__ import annotations

import gzip
import json
import math
import threading
from typing import Optional

from . import mapraw, signals

TILE_M = 1000.0
MAJOR = {"motorway", "trunk", "primary", "secondary", "tertiary",
         "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
# Real carriageway width when a way has no lanes tag (metres).
DEFAULT_WIDTH_M = {"motorway": 14, "trunk": 11, "primary": 10.5, "secondary": 7, "tertiary": 7,
                   "motorway_link": 5, "trunk_link": 5, "primary_link": 5, "secondary_link": 5, "tertiary_link": 5,
                   "unclassified": 6, "residential": 6, "living_street": 5, "service": 4}
RANK = ["motorway", "trunk", "primary", "secondary", "tertiary", "motorway_link", "trunk_link", "primary_link",
        "secondary_link", "tertiary_link", "unclassified", "residential", "living_street", "service"]

_lock = threading.Lock()
_cache: Optional[dict] = None


def _r(v) -> float:
    try:
        return round(float(v), 1)
    except (TypeError, ValueError):
        return 0.0


def _flat(points) -> list:
    out = []
    for p in points:
        out += [_r(p.get("x")), _r(p.get("y"))]
    return out


def _tile(x: float, y: float) -> tuple:
    return (math.floor(x / TILE_M), math.floor(y / TILE_M))


def _hull(pts: list) -> list:
    pts = sorted(set(pts))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _build() -> dict:
    m = mapraw.load()
    raw, nodes = m["raw"], m["nodes"]
    base = {"ways": [], "junctions": []}
    tiles: dict = {}

    def tile_of(key):
        return tiles.setdefault(key, {"ways": [], "junctions": [], "buildings": [], "amenities": []})

    ends: dict = {}  # join_group -> [(x, y, ux, uy, halfWidth, highway)]
    for w in raw.get("ways", []):
        tags = w.get("tags") or {}
        hw = tags.get("highway")
        if not hw:
            continue
        ids = [i for i in w.get("nodes", []) if i in nodes]
        if len(ids) < 2:
            continue
        pts = [nodes[i] for i in ids]
        try:
            lanes = int(tags.get("lanes") or 0)
            lane_w = float(tags.get("lane_width") or 0)
        except ValueError:
            lanes, lane_w = 0, 0.0
        width = round(lanes * lane_w, 1) if lanes > 0 and lane_w > 0 else 0
        oneway = 1 if str(tags.get("oneway", "")).lower() in ("yes", "true", "1") else 0
        try:
            layer = int(tags.get("layer") or 0)
        except ValueError:
            layer = 0
        if str(tags.get("bridge", "")).lower() in ("yes", "true", "1") and layer <= 0:
            layer = 1
        # the width a phone draws: tagged lanes x lane width, else the class default
        rec = [hw, width or DEFAULT_WIDTH_M.get(hw, 0), oneway, layer, tags.get("name") or tags.get("ref") or "", _flat(pts)]
        if hw in MAJOR:
            base["ways"].append(rec)
        else:
            xs = [float(p.get("x", 0)) for p in pts]
            ys = [float(p.get("y", 0)) for p in pts]
            tile_of(_tile((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2))["ways"].append(rec)
        if hw in DEFAULT_WIDTH_M:
            half = (width or DEFAULT_WIDTH_M[hw]) / 2
            for e, inner in ((0, 1), (len(ids) - 1, len(ids) - 2)):
                g = (nodes[ids[e]].get("tags") or {}).get("join_group")
                if not g:
                    continue
                ex, ey = float(pts[e].get("x", 0)), float(pts[e].get("y", 0))
                ix, iy = float(pts[inner].get("x", 0)), float(pts[inner].get("y", 0))
                dx, dy = ex - ix, ey - iy
                ln = math.hypot(dx, dy) or 1.0
                ends.setdefault(g, []).append((ex, ey, dx / ln, dy / ln, half, hw))

    # Junction fills: the hull of every road end's two edge points (plus a
    # little overlap back into each road) - the native stand-in for
    # map-core.js's buildJunctionRing.
    for g, legs in ends.items():
        pts = []
        for ex, ey, ux, uy, half, _ in legs:
            nx, ny = -uy, ux
            for back in (0.0, -1.0):
                bx, by = ex + ux * back, ey + uy * back
                pts += [(round(bx + nx * half, 1), round(by + ny * half, 1)), (round(bx - nx * half, 1), round(by - ny * half, 1))]
        hull = _hull(pts)
        if len(hull) < 3:
            continue
        top = min((leg[5] for leg in legs), key=lambda h: RANK.index(h) if h in RANK else 99)
        rec = [top, [c for p in hull for c in p]]
        if top in MAJOR:
            base["junctions"].append(rec)
        else:
            cx = sum(p[0] for p in hull) / len(hull)
            cy = sum(p[1] for p in hull) / len(hull)
            tile_of(_tile(cx, cy))["junctions"].append(rec)

    for b in raw.get("buildings", []):
        poly = b.get("polygon") or b.get("points") or []
        if len(poly) >= 3:
            cx = sum(float(p.get("x", 0)) for p in poly) / len(poly)
            cy = sum(float(p.get("y", 0)) for p in poly) / len(poly)
            tile_of(_tile(cx, cy))["buildings"].append(_flat(poly))
    for a in raw.get("amenities", []):
        tags = a.get("tags") or {}
        tile_of(_tile(float(a.get("x", 0)), float(a.get("y", 0))))["amenities"].append(
            [tags.get("amenity") or "other", tags.get("name") or "", _r(a.get("x")), _r(a.get("y"))])

    areas = []
    for a in raw.get("areas", []):
        poly = a.get("polygon") or []
        if len(poly) >= 3:
            areas.append([a.get("kind"), a.get("zoneType") or a.get("level") or "", a.get("name") or "", _flat(poly)])
    sigs = [[nid, _r(n.get("x")), _r(n.get("y"))] for nid, n in nodes.items() if n.get("signal")]
    meta = raw.get("meta", {})
    version = mapraw.version()
    base.update({
        "version": version, "origin": meta.get("origin"), "bounds": meta.get("bounds"), "tileM": TILE_M,
        "tiles": sorted([list(k) for k in tiles]), "areas": areas, "signals": sigs,
        "lamps": [[lp["x"], lp["y"]] for lp in signals.layout()],
    })
    return {"version": version, "base": base, "tiles": tiles}


def _ensure() -> dict:
    global _cache
    v = mapraw.version()
    with _lock:
        if _cache is None or _cache["version"] != v:
            built = _build()
            _cache = {"version": v, "raw": built, "gz": {}}
        return _cache


def _gz(key, obj) -> bytes:
    c = _ensure()
    if key not in c["gz"]:
        c["gz"][key] = gzip.compress(json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8"), 6)
    return c["gz"][key]


def gzipped() -> tuple[str, bytes]:
    """(version, gzip-compressed base layer)."""
    c = _ensure()
    return c["version"], _gz("base", c["raw"]["base"])


def gzipped_tile(tx: int, ty: int) -> tuple[str, bytes]:
    """(version, gzip-compressed detail tile) - an empty tile if there's nothing there."""
    c = _ensure()
    t = c["raw"]["tiles"].get((tx, ty), {"ways": [], "junctions": [], "buildings": [], "amenities": []})
    return c["version"], _gz(("tile", tx, ty), {"version": c["version"], "tx": tx, "ty": ty, **t})
