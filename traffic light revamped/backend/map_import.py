"""Adds a new area to the live map from an OpenStreetMap .osm export.

osm_to_json.py builds a whole map_data.json from scratch out of one .osm file.
This runs the same processing - parse, split roads at junctions, pull road
ends back into junction groups, the lane policy, buildings and amenities -
on an uploaded file and MERGES the result into the existing map instead of
replacing it, so hand edits, signals and areas already there are kept:

  - the new area is projected with the existing map's origin, so it lands in
    the same x/y metres space as everything else (the engine, the viewer and
    the apps all share it);
  - roads, nodes, buildings and amenities the map already has (same OSM ids)
    are skipped, so overlapping exports don't duplicate anything;
  - synthetic ids (trim_N endpoints, jg_N junction groups) start past the
    map's own id counter, so they can't collide;
  - OSM highway=traffic_signals points become working signals on the
    junction they mark: one phase per approach, clockwise - the same
    one-approach-at-a-time rule every signal follows (signal_rules.py);
  - meta.bounds grows to cover the new area and meta.sources records it.

The previous map_data.json is backed up to maps/ first.

    python -m backend.map_import <file.osm>
"""

from __future__ import annotations

import json
import math
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from typing import Callable, Optional

from . import osm_to_json as o2j
from .signal_rules import normalize_signals

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)
MAP_PATH = os.path.join(PROJECT_ROOT, "front-end", "map_data.json")
BACKUP_DIR = os.path.join(PROJECT_ROOT, "maps")
SIGNAL_SNAP_M = 40.0
MAX_GROUP_SPAN_M = 150.0  # the biggest real junction cluster on the original map spans well under this


def _num_suffix(s: str) -> int:
    tail = s.rsplit("_", 1)[-1]
    return int(tail) if tail.isdigit() else 0


def _approaches(cluster: list, nodes: dict, ways: list) -> list:
    """(wayId, outward bearing) for every way that can drive INTO this junction."""
    member = set(cluster)
    cx = sum(nodes[m]["x"] for m in cluster) / len(cluster)
    cy = sum(nodes[m]["y"] for m in cluster) / len(cluster)
    out = []
    for w in ways:
        if w["tags"].get("highway") not in o2j.VEHICLE_HIGHWAY_TYPES:
            continue
        ids = w["nodes"]
        oneway = str(w["tags"].get("oneway", "")).lower()
        for end_idx, inner_idx, inbound_ok in ((len(ids) - 1, len(ids) - 2, oneway != "-1"), (0, 1, oneway not in ("yes", "true", "1"))):
            if ids[end_idx] in member and inbound_ok:
                nx, ny = nodes[ids[inner_idx]]["x"], nodes[ids[inner_idx]]["y"]
                out.append((w["id"], (math.degrees(math.atan2(nx - cx, ny - cy)) + 360) % 360))
                break
    seen, uniq = set(), []
    for wid, b in sorted(out, key=lambda t: t[1]):
        if wid not in seen:
            seen.add(wid)
            uniq.append((wid, b))
    return uniq


def import_osm(osm_path: str, map_path: str = MAP_PATH, log: Callable[[str], None] = print,
               label: Optional[str] = None) -> dict:
    with open(map_path, encoding="utf-8") as f:
        data = json.load(f)
    meta = data.setdefault("meta", {})
    origin = meta.get("origin")
    if not origin:
        raise ValueError("the current map has no origin - build it with osm_to_json.py first")
    lat0, lon0 = float(origin["lat"]), float(origin["lon"])

    log(f"Reading {os.path.basename(osm_path)} ...")
    nodes, ways, feature_ways, bounds = o2j.parse_osm(osm_path)
    if not ways:
        raise ValueError("no roads (highway=*) in this file")
    centre_lat = (bounds["minlat"] + bounds["maxlat"]) / 2
    centre_lon = (bounds["minlon"] + bounds["maxlon"]) / 2
    km = math.hypot((centre_lat - lat0) * 111.0, (centre_lon - lon0) * 111.0 * math.cos(math.radians(lat0)))
    log(f"Area centre is {km:.1f} km from the map's origin")
    if km > 150:
        raise ValueError(f"this area is {km:.0f} km away from the current map - over 150 km the shared flat projection gets too inaccurate")

    for n in nodes.values():
        n["x"], n["y"] = o2j.project(n["lat"], n["lon"], lat0, lon0)

    existing_nodes = data.setdefault("nodes", {})
    existing_ways = data.setdefault("ways", [])
    existing_base = {w["id"].split("_s")[0] for w in existing_ways}
    before = len(ways)
    ways = [w for w in ways if w["id"] not in existing_base]
    log(f"{len(ways)} new road(s) ({before - len(ways)} already on the map, skipped)")
    if not ways:
        raise ValueError("every road in this file is already on the map")

    ways = o2j.split_ways_at_junctions(ways)
    counter = int(meta.get("nextIdCounter") or 1)
    for nid in existing_nodes:
        if nid.startswith(("trim_", "n_")):
            counter = max(counter, _num_suffix(nid) + 1)
    for n in existing_nodes.values():
        g = (n.get("tags") or {}).get("join_group")
        if g:
            counter = max(counter, _num_suffix(g) + 1)
    ways, next_counter = o2j.shorten_and_group_junctions(ways, nodes, next_id_start=counter)
    # osm_to_json numbers junction groups jg_1, jg_2, ... on every run - right
    # for a whole new map, but merged into an existing one those ids collide
    # with its own groups and fuse unrelated junctions kilometres apart into
    # one "intersection". Every group from this import gets a fresh id past
    # everything the map already uses.
    used_groups = {(n.get("tags") or {}).get("join_group") for n in existing_nodes.values()} - {None}
    seq = max([next_counter, counter] + [_num_suffix(g) + 1 for g in used_groups])
    remap: dict = {}
    for n in nodes.values():
        g = (n.get("tags") or {}).get("join_group")
        if g:
            if g not in remap:
                remap[g] = f"jg_{seq}"
                seq += 1
            n["tags"]["join_group"] = remap[g]
    next_counter = seq
    ways = o2j.apply_lane_policy(ways)
    buildings, amenities = o2j.extract_buildings_and_amenities(feature_ways, nodes)

    used = set()
    for w in ways:
        used.update(w["nodes"])
    for nid, n in nodes.items():
        if nid not in used and any(k in n["tags"] for k in o2j.INTERESTING_NODE_TAGS):
            used.add(nid)
    added_nodes = 0
    for nid in used:
        n = nodes.get(nid)
        if n is None or nid in existing_nodes:
            continue
        entry = {"x": round(n["x"], 2), "y": round(n["y"], 2)}
        if n["tags"]:
            entry["tags"] = n["tags"]
        existing_nodes[nid] = entry
        added_nodes += 1
    new_ways = []
    for w in ways:
        ids = [i for i in w["nodes"] if i in existing_nodes]
        if len(ids) >= 2:
            new_ways.append({"id": w["id"], "tags": w["tags"], "nodes": ids, "curve": "line"})
    existing_ways.extend(new_ways)
    have_b = {b.get("id") for b in data.setdefault("buildings", [])}
    have_a = {a.get("id") for a in data.setdefault("amenities", [])}
    nb = [b for b in buildings if b.get("id") not in have_b]
    na = [a for a in amenities if a.get("id") not in have_a]
    data["buildings"].extend(nb)
    data["amenities"].extend(na)
    log(f"Added {len(new_ways)} road segment(s), {added_nodes} node(s), {len(nb)} building(s), {len(na)} amenit(ies)")

    # OSM traffic signals -> working signals on the junctions they mark
    clusters: dict = {}
    for w in new_ways:
        for nid in (w["nodes"][0], w["nodes"][-1]):
            g = (existing_nodes[nid].get("tags") or {}).get("join_group")
            if g:
                clusters.setdefault(g, set()).add(nid)
    centroids = {g: (sum(existing_nodes[m]["x"] for m in ms) / len(ms), sum(existing_nodes[m]["y"] for m in ms) / len(ms))
                 for g, ms in clusters.items()}
    signalled = set()
    for nid, n in nodes.items():
        if n["tags"].get("highway") != "traffic_signals" and "traffic_signals" not in n["tags"]:
            continue
        best, bd = None, SIGNAL_SNAP_M
        for g, (cx, cy) in centroids.items():
            d = math.hypot(n["x"] - cx, n["y"] - cy)
            if d < bd:
                best, bd = g, d
        if best:
            signalled.add(best)
    made = 0
    for g in signalled:
        members = sorted(clusters[g])
        if any(existing_nodes[m].get("signal") for m in members):
            continue
        appr = _approaches(members, existing_nodes, new_ways)
        if len(appr) < 2:
            continue
        primary = existing_nodes[members[0]]
        primary["signal"] = {
            "allRedSec": 2, "scheme": "phases", "facing": "inward",
            "phases": [{"id": f"ph_{i + 1}", "label": f"Approach {i + 1}", "wayIds": [wid], "greenSec": 25, "yellowSec": 3}
                       for i, (wid, _) in enumerate(appr)],
        }
        primary.setdefault("tags", {})["highway"] = "traffic_signals"
        made += 1
    log(f"Created {made} traffic signal(s) from the OSM traffic_signals tags")
    stats = normalize_signals(data)
    log(f"Signal rule check: {stats}")

    old = meta.get("bounds") or bounds
    meta["bounds"] = {"minlat": min(old["minlat"], bounds["minlat"]), "minlon": min(old["minlon"], bounds["minlon"]),
                      "maxlat": max(old["maxlat"], bounds["maxlat"]), "maxlon": max(old["maxlon"], bounds["maxlon"])}
    meta["nextIdCounter"] = max(next_counter, int(meta.get("nextIdCounter") or 1))
    sources = meta.get("sources")
    if not isinstance(sources, list):
        sources = [{"file": meta.get("source"), "bounds": old}] if meta.get("source") else []
    sources.append({"file": label or os.path.basename(osm_path), "bounds": bounds,
                    "importedAt": datetime.now(timezone.utc).isoformat(), "roads": len(new_ways), "signals": made})
    meta["sources"] = sources
    meta["savedAt"] = datetime.now(timezone.utc).isoformat()

    # Safety net before anything is written: a junction group is one physical
    # intersection, so its members are metres apart - never hundreds.
    members: dict = {}
    for nid, n in existing_nodes.items():
        g = (n.get("tags") or {}).get("join_group")
        if g:
            members.setdefault(g, []).append(n)
    for g, ms in members.items():
        if len(ms) > 1:
            span = max(math.hypot(a["x"] - b["x"], a["y"] - b["y"]) for a in ms for b in ms)
            if span > MAX_GROUP_SPAN_M:
                raise ValueError(f"junction group {g} would span {span:.0f} m - import aborted, map left unchanged")

    os.makedirs(BACKUP_DIR, exist_ok=True)
    backup = os.path.join(BACKUP_DIR, f"map_data.json.bak-{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(map_path, backup)
    tmp = map_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, map_path)
    log(f"Map saved (previous version backed up as {os.path.basename(backup)})")
    return {"roads": len(new_ways), "nodes": added_nodes, "buildings": len(nb), "amenities": len(na),
            "signals": made, "bounds": meta["bounds"], "backup": backup}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python -m backend.map_import <file.osm>")
    print(import_osm(sys.argv[1]))
