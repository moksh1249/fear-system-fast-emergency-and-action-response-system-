"""One approach green at a time - the signal rule for every intersection.

Some signals in map_data.json let two approaches run green together: plain
phases that list two roads (typically the two opposite arms of a main road),
the "paired 4-way" scheme (opposite approaches with overlapping greens), and
intersections whose arms belong to two separate signal nodes that each ran
their own timer. normalize_signals() rewrites all of those into the strict
form every consumer already understands - the engine (redlights.hpp), the
viewer/editor (redlight.js) and fear_backend (signals.py):

  - each phase lists exactly ONE approach road; an approach shows green only
    during its own phase, so no two approaches ever overlap, with an all-red
    clearance (>= 2 s) between phases;
  - phases rotate clockwise around the junction;
  - signal nodes that form one physical intersection (same join_group, or
    within MERGE_DISTANCE_M of each other) become a redlight group, so they
    take turns instead of running independently.

A config that already follows the rule is left exactly as it is (custom
timings and order are kept). It runs on every save from the editor
(serve.py's /api/save), once over the existing map (`python -m
backend.signal_rules`), and on every OSM area import.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import sys
import time

MERGE_DISTANCE_M = 45.0
MIN_ALL_RED_SEC = 2.0
MIN_YELLOW_SEC = 3.0


def _f(v, d=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def _cycle(sig: dict) -> float:
    all_red = max(0.0, _f(sig.get("allRedSec")))
    return sum(max(0.0, _f(p.get("greenSec"))) + max(0.0, _f(p.get("yellowSec"))) + all_red for p in sig.get("phases") or [])


def _approach_bearings(node_id: str, nodes: dict, ways: dict, clusters: dict, way_ids: list) -> dict:
    """wayId -> outward bearing (degrees clockwise from north) of that
    approach at this junction, used to order phases clockwise."""
    n = nodes[node_id]
    g = (n.get("tags") or {}).get("join_group")
    members = clusters.get(g, [node_id]) if g else [node_id]
    cx = sum(_f(nodes[m].get("x")) for m in members) / len(members)
    cy = sum(_f(nodes[m].get("y")) for m in members) / len(members)
    out = {}
    for wid in way_ids:
        w = ways.get(wid)
        ids = [i for i in (w or {}).get("nodes", []) if i in nodes]
        if len(ids) < 2:
            out[wid] = 0.0
            continue
        a, b = nodes[ids[0]], nodes[ids[-1]]
        if math.hypot(_f(a.get("x")) - cx, _f(a.get("y")) - cy) <= math.hypot(_f(b.get("x")) - cx, _f(b.get("y")) - cy):
            end, nxt = nodes[ids[0]], nodes[ids[1]]
        else:
            end, nxt = nodes[ids[-1]], nodes[ids[-2]]
        dx, dy = _f(nxt.get("x")) - _f(end.get("x")), _f(nxt.get("y")) - _f(end.get("y"))
        out[wid] = (math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0
    return out


def normalize_signals(data: dict) -> dict:
    """Rewrites data["nodes"][*]["signal"] and data["redlightGroups"] in place.
    Returns counts of what changed."""
    nodes = data.get("nodes") or {}
    ways = {w.get("id"): w for w in data.get("ways") or [] if w.get("id")}
    clusters: dict = {}
    for nid, n in nodes.items():
        g = (n.get("tags") or {}).get("join_group")
        if g:
            clusters.setdefault(g, []).append(nid)
    stats = {"split": 0, "converted": 0, "grouped": 0, "signals": 0}

    for nid, n in nodes.items():
        sig = n.get("signal")
        if not isinstance(sig, dict):
            continue
        stats["signals"] += 1
        sig["allRedSec"] = max(MIN_ALL_RED_SEC, _f(sig.get("allRedSec"), MIN_ALL_RED_SEC))
        if sig.get("scheme") == "paired4way" and sig.get("paired"):
            paired = sig["paired"]
            lit, greens = [], {}
            for p in paired.get("pairs") or []:
                for wid in p.get("wayIds") or []:
                    if wid not in lit:
                        lit.append(wid)
                        greens[wid] = min(60.0, max(10.0, 2 * _f(p.get("stepSec"), 15.0)))
            yellow = max(MIN_YELLOW_SEC, _f(paired.get("yellowSec"), MIN_YELLOW_SEC))
            bearings = _approach_bearings(nid, nodes, ways, clusters, lit)
            lit.sort(key=lambda w: bearings.get(w, 0.0))
            sig["phases"] = [{"id": f"ph_{i + 1}", "label": f"Approach {i + 1}", "wayIds": [w],
                              "greenSec": greens[w], "yellowSec": yellow} for i, w in enumerate(lit)]
            sig["scheme"] = "phases"
            sig.pop("paired", None)
            stats["converted"] += 1
            continue
        phases = sig.get("phases") or []
        if all(len(p.get("wayIds") or []) <= 1 for p in phases):
            sig["scheme"] = "phases"
            continue
        out = []
        for p in phases:
            wids = list(dict.fromkeys(p.get("wayIds") or []))
            if len(wids) <= 1:
                out.append(p)
                continue
            bearings = _approach_bearings(nid, nodes, ways, clusters, wids)
            for wid in sorted(wids, key=lambda w: bearings.get(w, 0.0)):
                out.append({**p, "wayIds": [wid]})
        for i, p in enumerate(out):
            p["id"] = f"ph_{i + 1}"
            p["label"] = f"Approach {i + 1}"
            p["yellowSec"] = max(MIN_YELLOW_SEC, _f(p.get("yellowSec"), MIN_YELLOW_SEC))
        sig["phases"] = out
        sig["scheme"] = "phases"
        stats["split"] += 1

    # signal nodes of one physical intersection take turns
    sig_ids = sorted(nid for nid, n in nodes.items() if isinstance(n.get("signal"), dict))
    parent = {i: i for i in sig_ids}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for i, a in enumerate(sig_ids):
        na = nodes[a]
        ga = (na.get("tags") or {}).get("join_group")
        for b in sig_ids[i + 1:]:
            nb = nodes[b]
            gb = (nb.get("tags") or {}).get("join_group")
            close = math.hypot(_f(na.get("x")) - _f(nb.get("x")), _f(na.get("y")) - _f(nb.get("y"))) < MERGE_DISTANCE_M
            if (ga and ga == gb) or close:
                parent[find(a)] = find(b)
    sets: dict = {}
    for i in sig_ids:
        sets.setdefault(find(i), []).append(i)
    groups = data.get("redlightGroups")
    if not isinstance(groups, list):
        groups = []
    existing = {g.get("id") for g in groups if isinstance(g, dict)}
    for members in sets.values():
        if len(members) < 2:
            continue
        gids = {nodes[m]["signal"].get("groupId") for m in members}
        if len(gids) == 1 and None not in gids and next(iter(gids)) in existing:
            continue  # already one group
        k = 1
        while f"rg_auto_{k}" in existing:
            k += 1
        gid = f"rg_auto_{k}"
        existing.add(gid)
        turn = max(_cycle(nodes[m]["signal"]) for m in members) or 30.0
        groups.append({"id": gid, "memberIds": sorted(members), "turnSec": round(turn, 1), "direction": "cw"})
        for m in members:
            nodes[m]["signal"]["groupId"] = gid
        stats["grouped"] += 1
    data["redlightGroups"] = groups
    return stats


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "front-end", "map_data.json")
    path = os.path.normpath(path)
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    stats = normalize_signals(data)
    if stats["split"] or stats["converted"] or stats["grouped"]:
        backup_dir = os.path.normpath(os.path.join(os.path.dirname(path), "..", "maps"))
        os.makedirs(backup_dir, exist_ok=True)
        backup = os.path.join(backup_dir, f"map_data.json.bak-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(path, backup)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"))
        os.replace(tmp, path)
        print(f"backed up to {backup}")
    print(stats)


if __name__ == "__main__":
    main()
