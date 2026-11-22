"""Turn-by-turn steps for a CH route (the node path ch_query returns).

Each route segment is matched to the map way it runs along; consecutive
segments on the same road (same name, or the same original OSM way when the
road has no name) form one leg; the junction-crossing hops between clusters
belong to no way and are folded into the next leg. Where one leg hands over
to the next, the change in heading decides the manoeuvre - straight on,
slight / normal / sharp turn, or U-turn.
"""

from __future__ import annotations

import math
from typing import Optional

from . import geo, mapraw

_edge_cache: Optional[tuple] = None


def _edges() -> dict:
    """(nodeA, nodeB) -> (wayId, name, highway), both directions."""
    global _edge_cache
    m = mapraw.load()
    if _edge_cache and _edge_cache[0] == m["mtime"]:
        return _edge_cache[1]
    edges = {}
    for wid, w in m["ways"].items():
        tags = w.get("tags") or {}
        if not tags.get("highway"):
            continue
        name = tags.get("name") or tags.get("ref") or ""
        ids = w.get("nodes") or []
        for a, b in zip(ids, ids[1:]):
            edges[(a, b)] = edges[(b, a)] = (wid, name, tags["highway"])
    _edge_cache = (m["mtime"], edges)
    return edges


def _strip(nid: str) -> str:
    for suf in ("#fwd", "#bwd"):
        if nid.endswith(suf):
            return nid[: -len(suf)]
    return nid


def _bearing(ax, ay, bx, by) -> float:
    return (math.degrees(math.atan2(bx - ax, by - ay)) + 360.0) % 360.0  # x east, y north


def _point_back(pts, idx, dist, forward: bool):
    """Walk `dist` metres from pts[idx] backwards (or forwards) along pts."""
    step = 1 if forward else -1
    x, y = pts[idx]
    acc, i = 0.0, idx
    while 0 <= i + step < len(pts):
        nx, ny = pts[i + step]
        d = math.hypot(nx - x, ny - y)
        if acc + d >= dist:
            f = (dist - acc) / d if d else 0
            return x + (nx - x) * f, y + (ny - y) * f
        acc += d
        x, y, i = nx, ny, i + step
    return x, y


_COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]


def steps_for(path: list, from_xy: Optional[tuple] = None, to_xy: Optional[tuple] = None) -> list:
    """path: [{"id", "x", "y"}] from ch_query. Returns manoeuvres, first =
    depart, last = arrive, each with the distance of the leg that follows it."""
    edges = _edges()
    nodes = []
    for p in path:
        nid = _strip(str(p.get("id", "")))
        if nodes and nodes[-1][0] == nid:
            continue
        nodes.append((nid, float(p["x"]), float(p["y"])))
    if len(nodes) < 2:
        return []
    pts = [(x, y) for _, x, y in nodes]
    if from_xy:
        pts.insert(0, from_xy)
        nodes.insert(0, ("_start", *from_xy))
    if to_xy:
        pts.append(to_xy)
        nodes.append(("_end", *to_xy))

    # one entry per segment: road key + display name
    segs = []
    for (a, ax, ay), (b, bx, by) in zip(nodes, nodes[1:]):
        e = edges.get((a, b))
        length = math.hypot(bx - ax, by - ay)
        if e:
            wid, name, hw = e
            base = wid.split("_s")[0]
            segs.append({"key": name or f"#{base}", "name": name, "hw": hw, "len": length})
        else:
            segs.append({"key": None, "name": None, "hw": None, "len": length})
    # junction hops / connectors take the identity of the next real segment (or the previous at the end)
    nxt = None
    for s in reversed(segs):
        if s["key"] is None and nxt is not None:
            s.update(key=nxt["key"], name=nxt["name"], hw=nxt["hw"])
        elif s["key"] is not None:
            nxt = s
    prev = None
    for s in segs:
        if s["key"] is None and prev is not None:
            s.update(key=prev["key"], name=prev["name"], hw=prev["hw"])
        elif s["key"] is not None:
            prev = s

    # legs = runs of the same road key; idx = index into pts where the leg starts
    legs = []
    for i, s in enumerate(segs):
        if legs and legs[-1]["key"] == s["key"]:
            legs[-1]["len"] += s["len"]
            legs[-1]["end"] = i + 1
        else:
            legs.append({"key": s["key"], "name": s["name"] or "", "hw": s["hw"], "len": s["len"], "start": i, "end": i + 1})

    def latlon(i):
        return geo.to_latlon(*pts[i])

    steps = []
    x0, y0 = pts[0]
    x1, y1 = _point_back(pts, 0, 20, True)
    head = _COMPASS[int(((_bearing(x0, y0, x1, y1) + 22.5) % 360) // 45)]
    lat, lon = latlon(0)
    on = f" on {legs[0]['name']}" if legs[0]["name"] else ""
    steps.append({"type": "depart", "modifier": "straight", "road": legs[0]["name"], "lat": lat, "lon": lon,
                  "distanceM": round(legs[0]["len"]), "instruction": f"Head {head}{on}"})
    for prev_leg, leg in zip(legs, legs[1:]):
        k = leg["start"]
        ax, ay = _point_back(pts, k, 15, False)
        bx, by = _point_back(pts, k, 15, True)
        cx, cy = pts[k]
        b_in, b_out = _bearing(ax, ay, cx, cy), _bearing(cx, cy, bx, by)
        turn = (b_out - b_in + 540.0) % 360.0 - 180.0  # +right / -left
        a = abs(turn)
        side = "right" if turn > 0 else "left"
        if a < 25:
            # Straight on: only worth saying when it puts you on a newly named road.
            if not leg["name"] or leg["name"] == prev_leg["name"]:
                steps[-1]["distanceM"] += round(leg["len"])
                continue
            kind, mod = "continue", "straight"
        elif a < 50:
            kind, mod = "slight", side
        elif a < 135:
            kind, mod = "turn", side
        elif a < 165:
            kind, mod = "sharp", side
        else:
            kind, mod = "uturn", side
        name = leg["name"]
        onto = f" onto {name}" if name else ""
        text = {
            "continue": f"Continue straight{onto}",
            "slight": f"Keep slightly {side}{onto}",
            "turn": f"Turn {side}{onto}",
            "sharp": f"Turn sharply {side}{onto}",
            "uturn": f"Make a U-turn{onto}",
        }[kind]
        lat, lon = latlon(k)
        steps.append({"type": kind, "modifier": mod, "road": name, "lat": lat, "lon": lon,
                      "distanceM": round(leg["len"]), "instruction": text})
    lat, lon = latlon(len(pts) - 1)
    steps.append({"type": "arrive", "modifier": "straight", "road": "", "lat": lat, "lon": lon, "distanceM": 0,
                  "instruction": "You have arrived"})
    return steps
