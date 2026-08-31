"""
Generates a batch of vehicle trips (unique id, start/end node, physical/driver
tags) against the CURRENT map_data.json, and writes them out as
maps/vehicles.json + maps/vehicles.csv.

This is Phase 1 of the traffic simulation project: the future C++ simulation
engine (backend/sim/, not built yet) will load this file's output as its
trip manifest - each vehicle computes its own shortest route ONCE, right when
it starts driving, from startNodeId to endNodeId. This script's only job is
to decide WHO drives WHERE and WHAT they're driving; it does no routing
itself (that's the CH router's job - see backend/ch/ch_query.cpp).

Why start/end nodes are restricted to the largest connected component of the
road graph: a few real OSM extracts have small disconnected slivers (a
service road with no through connection, a footway fragment, ...) - picking
a start/end pair straddling two components would hand the simulation engine
an unroutable trip. Connectivity here is checked on the UNDIRECTED graph
implied by ways[].nodes (ignoring oneway) - a deliberately cheap
approximation of true directed reachability, good enough to rule out actual
islands without needing a full graph-search per candidate pair.

Ambulances are pinned to a home depot: every amenity tagged amenity=hospital,
plus (to also catch hospitals that only exist as a building footprint, not a
point amenity) every building tagged building=hospital not already linked to
one of those amenities. Each ambulance's start is the routable node nearest
its assigned depot - this is the same depot list the future emergency-dispatch
system (Phase 5) will read hospitals from, so the generator and the engine
agree on what "a hospital" is from day one.

`driverAge`/`responseTimeSec`/`weight`/`length`/`width` etc. are generated now
per the project plan's own instruction that they're for FUTURE simulations -
today's engine (once built) will use dimensions/maxSpeed for physics, but
age/response-time are intentionally inert for now.

Run:
    python generate_vehicles.py                       # 10,000 vehicles, seed 42
    python generate_vehicles.py --count 500 --seed 7
    python generate_vehicles.py --vehicle-mix "{\"car\":0.9,\"ambulance\":0.1}"
"""

import argparse
import csv
import json
import math
import os
import random
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)
MAP_DATA_PATH = os.path.join(PROJECT_ROOT, "front-end", "map_data.json")
MAPS_DIR = os.path.join(PROJECT_ROOT, "maps")

# Default vehicle-type mix - overridable with --vehicle-mix. Weights don't
# need to sum to 1; apportion_counts() below normalizes them.
DEFAULT_VEHICLE_MIX = {
    "car": 0.82,
    "motorcycle": 0.10,
    "bus": 0.03,
    "truck": 0.03,
    "ambulance": 0.02,
}

# Per-type (min, max) ranges a real-world vehicle of that type would
# plausibly fall into. maxSpeedKmh is the VEHICLE's own capability ceiling,
# not a road speed limit - the simulation engine combines this with each
# road segment's own limit (min of the two) when deciding a desired speed.
# accelMps2 is the vehicle's own comfortable acceleration capability (IDM's
# aMax) - previously a fixed per-type constant baked into sim_engine.cpp's
# own profileFor() table; now generated per-vehicle here instead, so a
# gutless overloaded truck and a nimble one aren't identical. Ranges reflect
# real capability differences: a car/ambulance can accelerate briskly, a
# loaded bus or truck cannot, matching each type's own realistic top speed
# (car up to 120kmh, truck up to 80kmh, ambulance up to 130kmh, per the
# project's own brief).
VEHICLE_PROFILES = {
    "car":        {"length": (4.0, 5.1), "width": (1.6, 1.95), "height": (1.35, 1.65), "weightKg": (1000, 1900), "maxSpeedKmh": (90, 120), "accelMps2": (2.2, 3.2)},
    "motorcycle": {"length": (1.8, 2.3), "width": (0.65, 0.9), "height": (1.05, 1.4), "weightKg": (110, 260), "maxSpeedKmh": (80, 110), "accelMps2": (3.0, 4.5)},
    "bus":        {"length": (7.0, 10.0), "width": (2.4, 2.6), "height": (3.0, 3.6), "weightKg": (8000, 14000), "maxSpeedKmh": (60, 85), "accelMps2": (0.8, 1.4)},
    "truck":      {"length": (6.0, 12.0), "width": (2.3, 2.6), "height": (2.5, 3.8), "weightKg": (5000, 16000), "maxSpeedKmh": (60, 80), "accelMps2": (0.7, 1.3)},
    "ambulance":  {"length": (5.5, 6.5), "width": (2.0, 2.3), "height": (2.4, 2.85), "weightKg": (2500, 4500), "maxSpeedKmh": (100, 130), "accelMps2": (2.6, 3.6)},
}

MIN_DRIVER_AGE, MAX_DRIVER_AGE = 16, 80


def load_map_data(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Connectivity: the routing graph is DIRECTED (one-way streets), so plain
# undirected connectivity is the wrong test - two nodes can be in the same
# undirected component while one is simply unreachable from the other (e.g.
# it sits behind a one-way street entered from the far side). An earlier
# version of this script used undirected union-find and it silently produced
# thousands of unroutable trips - ch_query.exe (the same router the live app
# uses) returned "found: false" for a large fraction of them. The correct
# test is mutual reachability, i.e. the largest STRONGLY connected component
# of the directed graph: any two nodes drawn from it are guaranteed
# routable in both directions.
#
# The directed edges mirror backend/ch/ch_preprocess.cpp's buildGraph() (see
# its header comment): chain edges along each way honoring oneway/roundabout,
# plus bidirectional junction-clique edges between every pair of nodes
# sharing a tags.join_group - real junctions in this map format are NOT
# shared node ids, they're these pulled-back-endpoint cliques (see
# ch_preprocess.cpp's own header comment for why). Speed/weight aren't needed
# here, only which directed edges exist.
# ---------------------------------------------------------------------------

def build_directed_edges(nodes, ways):
    adj = {}
    touched = set()

    def add_edge(a, b):
        adj.setdefault(a, []).append(b)
        touched.add(a)
        touched.add(b)

    for way in ways:
        tags = way.get("tags") or {}
        highway = tags.get("highway", "")
        if not isRoutableHighway(highway):
            continue
        if tags.get("access") == "no":
            continue
        way_nodes = way.get("nodes") or []
        if len(way_nodes) < 2 or any(nid not in nodes for nid in way_nodes):
            continue

        oneway = tags.get("oneway", "")
        junction = tags.get("junction", "")
        forward, backward = True, True
        if oneway == "yes":
            backward = False
        elif oneway == "-1":
            forward = False
        elif oneway != "no" and junction == "roundabout":
            backward = False

        for a, b in zip(way_nodes, way_nodes[1:]):
            if forward:
                add_edge(a, b)
            if backward:
                add_edge(b, a)

    join_groups = {}
    for nid in touched:
        jg = (nodes[nid].get("tags") or {}).get("join_group")
        if jg:
            join_groups.setdefault(jg, []).append(nid)
    for members in join_groups.values():
        if len(members) < 2:
            continue
        for a in members:
            for b in members:
                if a != b:
                    add_edge(a, b)

    return adj, touched


def isRoutableHighway(hw):
    # Mirrors backend/ch/ch_preprocess.cpp's isRoutableHighway() exactly -
    # must stay in lockstep, see the module docstring.
    excluded = {
        "footway", "path", "steps", "track", "cycleway", "pedestrian",
        "bridleway", "construction", "proposed", "platform", "elevator",
        "corridor", "razed", "raceway",
    }
    return bool(hw) and hw not in excluded


def kosaraju_scc(all_nodes, adj):
    # Iterative Kosaraju's (recursive DFS would blow Python's default
    # recursion limit on a graph this size): first pass records finish order
    # on the forward graph, second pass walks the reverse graph in reverse
    # finish order - each tree found is one strongly connected component.
    visited = set()
    order = []
    for start in all_nodes:
        if start in visited:
            continue
        visited.add(start)
        stack = [(start, iter(adj.get(start, ())))]
        while stack:
            node, it = stack[-1]
            advanced = False
            for nxt in it:
                if nxt not in visited:
                    visited.add(nxt)
                    stack.append((nxt, iter(adj.get(nxt, ()))))
                    advanced = True
                    break
            if not advanced:
                order.append(node)
                stack.pop()

    radj = {}
    for u, vs in adj.items():
        for v in vs:
            radj.setdefault(v, []).append(u)

    visited2 = set()
    components = []
    for node in reversed(order):
        if node in visited2:
            continue
        visited2.add(node)
        comp = [node]
        stack = [node]
        while stack:
            n = stack.pop()
            for nb in radj.get(n, ()):
                if nb not in visited2:
                    visited2.add(nb)
                    comp.append(nb)
                    stack.append(nb)
        components.append(comp)
    return components


def largest_connected_component(nodes, ways):
    adj, touched = build_directed_edges(nodes, ways)
    components = kosaraju_scc(list(touched), adj)
    if not components:
        return []
    return max(components, key=len)


def dist(nodes, a, b):
    na, nb = nodes[a], nodes[b]
    return math.hypot(na["x"] - nb["x"], na["y"] - nb["y"])


# ---------------------------------------------------------------------------
# Ambulance depots: every hospital amenity, plus any hospital BUILDING not
# already covered by one of those amenities (see module docstring).
# ---------------------------------------------------------------------------

def polygon_centroid(polygon):
    xs = [p["x"] for p in polygon]
    ys = [p["y"] for p in polygon]
    return {"x": sum(xs) / len(xs), "y": sum(ys) / len(ys)}


def find_hospital_depots(map_data, routable_nodes, nodes):
    amenities = map_data.get("amenities") or []
    buildings = map_data.get("buildings") or []

    depots = []
    covered_building_ids = set()
    for a in amenities:
        if (a.get("tags") or {}).get("amenity") != "hospital":
            continue
        name = (a.get("tags") or {}).get("name") or f"Hospital (amenity {a['id']})"
        depots.append({"id": a["id"], "name": name, "x": a["x"], "y": a["y"]})
        if a.get("buildingId"):
            covered_building_ids.add(a["buildingId"])

    for b in buildings:
        if (b.get("tags") or {}).get("building") != "hospital":
            continue
        if b["id"] in covered_building_ids:
            continue
        name = (b.get("tags") or {}).get("name") or f"Hospital (building {b['id']})"
        centroid = polygon_centroid(b["polygon"])
        depots.append({"id": b["id"], "name": name, "x": centroid["x"], "y": centroid["y"]})

    depots.sort(key=lambda d: str(d["id"]))  # deterministic order for reproducible round-robin assignment

    # Snap each depot to its nearest routable node - O(depots * routable
    # nodes) is a few hundred thousand distance checks at this map's scale,
    # cheap enough not to need a spatial index.
    for depot in depots:
        best_id, best_d2 = None, None
        for nid in routable_nodes:
            n = nodes[nid]
            d2 = (n["x"] - depot["x"]) ** 2 + (n["y"] - depot["y"]) ** 2
            if best_d2 is None or d2 < best_d2:
                best_id, best_d2 = nid, d2
        depot["nodeId"] = best_id

    return depots


# ---------------------------------------------------------------------------
# Vehicle-type apportionment: exact integer counts from float weights
# (largest-remainder method), so e.g. "ambulance: 0.02" of 10000 vehicles
# always yields exactly 200, not a noisy value close to it.
# ---------------------------------------------------------------------------

def apportion_counts(total, weights):
    total_weight = sum(weights.values())
    if total_weight <= 0:
        raise ValueError("vehicle-mix weights must sum to > 0")
    raw = {k: total * w / total_weight for k, w in weights.items()}
    floors = {k: int(math.floor(v)) for k, v in raw.items()}
    remainder = total - sum(floors.values())
    order = sorted(weights.keys(), key=lambda k: raw[k] - floors[k], reverse=True)
    for k in order[:remainder]:
        floors[k] += 1
    return floors


def sample_trip_endpoints(rng, routable_list, nodes, min_trip_m, max_attempts=50):
    for _ in range(max_attempts):
        start, end = rng.choice(routable_list), rng.choice(routable_list)
        if start != end and dist(nodes, start, end) >= min_trip_m:
            return start, end
    # Fallback (tiny map, or an unreasonably large min_trip_m): accept
    # whatever distinct pair we last drew rather than looping forever.
    while start == end:
        end = rng.choice(routable_list)
    return start, end


def random_in_range(rng, lo_hi):
    lo, hi = lo_hi
    return round(rng.uniform(lo, hi), 2)


def make_response_time(rng, age, is_ambulance):
    # Baseline perception-reaction time, worse for very young (less
    # experience) and older (slower reflexes) drivers; trained ambulance
    # drivers get a faster baseline. Not consumed by any simulation logic
    # yet - see module docstring.
    base = 0.55 if is_ambulance else 0.75
    if age < 21:
        base += 0.15 * (21 - age) / 5
    elif age > 65:
        base += 0.10 * (age - 65) / 10
    base += rng.uniform(-0.1, 0.15)
    return round(max(0.35, min(2.0, base)), 3)


def generate(map_data, count, seed, min_trip_m, vehicle_mix):
    rng = random.Random(seed)
    nodes = map_data["nodes"]
    ways = map_data["ways"]

    routable_list = largest_connected_component(nodes, ways)
    if len(routable_list) < 2:
        raise ValueError("road graph has fewer than 2 connected routable nodes - can't generate trips")
    routable_set = set(routable_list)

    depots = find_hospital_depots(map_data, routable_list, nodes)

    counts = apportion_counts(count, vehicle_mix)
    if depots and counts.get("ambulance", 0) > 0:
        pass  # depots exist, fine - ambulances below get real homes
    elif counts.get("ambulance", 0) > 0:
        print("[generate_vehicles] WARNING: no hospitals found in map_data.json - "
              "ambulances will get a random start instead of a depot home.", file=sys.stderr)

    type_list = []
    for vtype, n in counts.items():
        type_list.extend([vtype] * n)
    rng.shuffle(type_list)

    # Deterministic, evenly-spread round-robin across depots (in their
    # already-sorted, stable order) rather than a random pick per ambulance -
    # keeps depot coverage balanced regardless of RNG luck.
    ambulance_depot_cursor = 0
    depot_ambulance_counts = {d["id"]: 0 for d in depots}

    vehicles = []
    trip_distances = []
    for i, vtype in enumerate(type_list, start=1):
        profile = VEHICLE_PROFILES[vtype]
        home_amenity_id = None
        home_hospital_name = None

        if vtype == "ambulance" and depots:
            depot = depots[ambulance_depot_cursor % len(depots)]
            ambulance_depot_cursor += 1
            depot_ambulance_counts[depot["id"]] += 1
            start = depot["nodeId"]
            end = start
            while end == start:
                end = rng.choice(routable_list)
            home_amenity_id = depot["id"]
            home_hospital_name = depot["name"]
        else:
            start, end = sample_trip_endpoints(rng, routable_list, nodes, min_trip_m)

        trip_distances.append(dist(nodes, start, end))

        vehicles.append({
            "id": i,
            "vehicleType": vtype,
            "startNodeId": start,
            "endNodeId": end,
            "startX": nodes[start]["x"], "startY": nodes[start]["y"],
            "endX": nodes[end]["x"], "endY": nodes[end]["y"],
            "length": random_in_range(rng, profile["length"]),
            "width": random_in_range(rng, profile["width"]),
            "height": random_in_range(rng, profile["height"]),
            "weightKg": round(rng.uniform(*profile["weightKg"])),
            "maxSpeedKmh": round(rng.uniform(*profile["maxSpeedKmh"]), 1),
            "accelMps2": round(rng.uniform(*profile["accelMps2"]), 2),
            "driverAge": rng.randint(MIN_DRIVER_AGE, MAX_DRIVER_AGE),
            "responseTimeSec": None,  # filled below, needs driverAge
            "homeAmenityId": home_amenity_id,
            "homeHospitalName": home_hospital_name,
        })
        vehicles[-1]["responseTimeSec"] = make_response_time(rng, vehicles[-1]["driverAge"], vtype == "ambulance")

    for d in depots:
        d["ambulanceCount"] = depot_ambulance_counts.get(d["id"], 0)

    meta = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "seed": seed,
        "count": count,
        "minTripM": min_trip_m,
        "vehicleMix": vehicle_mix,
        "vehicleCounts": counts,
        "routableNodeCount": len(routable_list),
        "totalNodeCount": len(nodes),
        "sourceMap": {
            "path": os.path.relpath(MAP_DATA_PATH, PROJECT_ROOT).replace(os.sep, "/"),
            "generated": (map_data.get("meta") or {}).get("generated"),
            "bounds": (map_data.get("meta") or {}).get("bounds"),
        },
        "depots": depots,
    }
    return meta, vehicles, trip_distances


CSV_FIELDS = [
    "id", "vehicleType", "startNodeId", "endNodeId", "startX", "startY", "endX", "endY",
    "length", "width", "height", "weightKg", "maxSpeedKmh", "accelMps2", "driverAge", "responseTimeSec",
    "homeAmenityId", "homeHospitalName",
]


def write_outputs(out_dir, meta, vehicles):
    os.makedirs(out_dir, exist_ok=True)
    json_path = os.path.join(out_dir, "vehicles.json")
    csv_path = os.path.join(out_dir, "vehicles.csv")

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "vehicles": vehicles}, f, separators=(",", ":"))

    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for v in vehicles:
            writer.writerow({k: ("" if v[k] is None else v[k]) for k in CSV_FIELDS})

    return json_path, csv_path


def parse_args(argv):
    p = argparse.ArgumentParser(description="Generate a batch of vehicle trips against map_data.json.")
    p.add_argument("--count", type=int, default=10000, help="number of vehicles to generate (default 10000)")
    p.add_argument("--seed", type=int, default=42, help="RNG seed, for reproducible batches (default 42)")
    p.add_argument("--min-trip-m", type=float, default=200.0,
                   help="minimum straight-line start/end separation in metres for non-ambulance trips (default 200)")
    p.add_argument("--vehicle-mix", type=str, default=None,
                   help='JSON weights overriding the default type mix, e.g. \'{"car":0.9,"ambulance":0.1}\'')
    p.add_argument("--out-dir", type=str, default=None, help="output directory (default maps/)")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if args.count <= 0:
        print("--count must be positive", file=sys.stderr)
        return 1

    vehicle_mix = DEFAULT_VEHICLE_MIX
    if args.vehicle_mix:
        try:
            vehicle_mix = json.loads(args.vehicle_mix)
        except json.JSONDecodeError as e:
            print(f"--vehicle-mix is not valid JSON: {e}", file=sys.stderr)
            return 1

    if not os.path.exists(MAP_DATA_PATH):
        print(f"map_data.json not found at {MAP_DATA_PATH}", file=sys.stderr)
        return 1
    map_data = load_map_data(MAP_DATA_PATH)

    meta, vehicles, trip_distances = generate(
        map_data, args.count, args.seed, args.min_trip_m, vehicle_mix,
    )

    out_dir = args.out_dir or MAPS_DIR
    json_path, csv_path = write_outputs(out_dir, meta, vehicles)

    counts = meta["vehicleCounts"]
    print(f"[generate_vehicles] wrote {len(vehicles)} vehicles to:")
    print(f"  {json_path}")
    print(f"  {csv_path}")
    print(f"[generate_vehicles] routable nodes: {meta['routableNodeCount']} / {meta['totalNodeCount']} total")
    print(f"[generate_vehicles] type counts: {counts}")
    print(f"[generate_vehicles] hospitals detected: {len(meta['depots'])}")
    for d in meta["depots"]:
        if d["ambulanceCount"]:
            print(f"    {d['name']} ({d['id']}) -> {d['ambulanceCount']} ambulance(s), home node {d['nodeId']}")
    if trip_distances:
        print(f"[generate_vehicles] straight-line trip distance (m): "
              f"min={min(trip_distances):.1f} max={max(trip_distances):.1f} "
              f"avg={sum(trip_distances) / len(trip_distances):.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
