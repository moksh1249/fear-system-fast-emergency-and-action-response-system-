"""
Converts a raw OpenStreetMap XML export (map (2).osm) into a compact JSON file
(map_data.json) that the browser-based map editor (index.html / editor.js) can
load quickly.

What it does:
  - Streams the .osm file with iterparse (keeps memory low even for large exports).
  - Keeps every <node>, remembering its lat/lon and any tags.
  - Keeps every <way> that has a highway=* tag (i.e. is a road / path / track),
    along with its tags and ordered list of node references.
  - Projects lat/lon to a local flat X/Y coordinate system in metres using an
    equirectangular projection centred on the middle of the bounding box, so the
    front end can draw straight canvas coordinates without doing trig per frame.
  - Splits each way at every node where it passes straight through a junction
    (a node some other way also touches) instead of ending there - otherwise
    that one continuous way only contributes a single connected-way entry at
    the junction, and a real 4-way crossing where one road runs straight
    through reads as a 3-way intersection in the editor.
  - Drops nodes that are not used by any kept way, UNLESS they carry a tag that
    is interesting on its own (e.g. highway=traffic_signals, highway=crossing)
    even when it also happens to sit on a road (kept anyway) - this keeps the
    output focused on the road network instead of every POI/building in the city.
  - Shortens every vehicle-traffic way by SHORTEN_M at each end that's a real
    junction (2+ roads), giving each road its own private, pulled-back endpoint
    instead of every road sharing one exact point - then tags every junction's
    own set of pulled-back endpoints into one join_group, so the editor's
    dynamically-sized junction ring (see buildRingPath in editor.js) draws the
    connecting surface, the same way "Join into one intersection" already does
    manually for several real intersections at once. A connecting way that ends
    up SHORT_CONNECTOR_MAX_M or shorter after shortening - both its ends already
    real junctions - is dropped entirely and its two junction groups are merged
    into one, mirroring a manual join across a short connector.
  - Writes map_data.json into front-end/ (reads the source .osm from maps/).

Run:
    python osm_to_json.py
"""

import json
import math
import os
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)
SRC = os.path.join(PROJECT_ROOT, "maps", "map (2).osm")
DST = os.path.join(PROJECT_ROOT, "front-end", "map_data.json")

# Node point tags worth keeping even if the node were otherwise unused.
INTERESTING_NODE_TAGS = {
    "highway",  # traffic_signals, crossing, stop, mini_roundabout, ...
    "railway",  # level_crossing, switch
    "traffic_signals",
    "traffic_calming",
}

EARTH_RADIUS_M = 6378137.0


def project(lat, lon, lat0, lon0):
    """Equirectangular projection to metres, centred on (lat0, lon0).
    x is east-positive, y is north-positive."""
    x = math.radians(lon - lon0) * math.cos(math.radians(lat0)) * EARTH_RADIUS_M
    y = math.radians(lat - lat0) * EARTH_RADIUS_M
    return x, y


# Only these count as a "real" vehicle-traffic junction for splitting
# purposes. A footway/cycleway/path/steps crossing a road shares a node with
# it in OSM very often (marked pedestrian crossings especially), but that's
# not a vehicular approach - splitting the road there, or counting it toward
# the road's connected-way total, inflated plain 3-way T-junctions into
# spurious "4-way" ones anywhere a footway happened to touch them.
VEHICLE_HIGHWAY_TYPES = {
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
    "unclassified", "residential", "living_street", "service",
}


def split_ways_at_junctions(ways):
    """Break each vehicle-traffic way into separate segments at every
    INTERIOR node where it passes through a junction with another vehicle
    way (footways/paths/etc. don't trigger this - see VEHICLE_HIGHWAY_TYPES)
    rather than actually ending there. A way that already ends at a shared
    node (a normal T/crossing corner) is left alone - only a way that runs
    straight through one gets split, into a piece before and a piece after,
    each carrying a copy of the original tags. This is what lets the editor
    count every physical direction meeting at a junction as its own
    connected way, instead of a through-road silently swallowing one.

    The first segment of a split way keeps the original id; later segments
    get `<id>_s<n>` (way ids from OSM are purely numeric, so this can't
    collide with a real one). Non-vehicle ways pass through unchanged.
    """
    touch_count = {}
    for w in ways:
        if w["tags"].get("highway") not in VEHICLE_HIGHWAY_TYPES:
            continue
        for nid in set(w["nodes"]):
            touch_count[nid] = touch_count.get(nid, 0) + 1

    out = []
    for w in ways:
        if w["tags"].get("highway") not in VEHICLE_HIGHWAY_TYPES:
            out.append(w)
            continue
        nds = w["nodes"]
        seg_start = 0
        seg_index = 0
        for i in range(1, len(nds) - 1):  # interior nodes only - endpoints never need splitting
            if touch_count.get(nds[i], 0) < 2:
                continue
            seg_nodes = nds[seg_start:i + 1]
            if len(seg_nodes) >= 2:
                seg_id = w["id"] if seg_index == 0 else f"{w['id']}_s{seg_index}"
                out.append({"id": seg_id, "tags": w["tags"], "nodes": seg_nodes})
                seg_index += 1
            seg_start = i
        seg_nodes = nds[seg_start:]
        if len(seg_nodes) >= 2:
            seg_id = w["id"] if seg_index == 0 else f"{w['id']}_s{seg_index}"
            out.append({"id": seg_id, "tags": w["tags"], "nodes": seg_nodes})
    return out


def apply_lane_policy(ways):
    """Deliberate simulation lane-count policy.

    primary/secondary/tertiary are a hard override - forced to these values
    regardless of what OSM tagged (or didn't), since it's a chosen policy
    rather than a data-quality fix:

      primary:   3 lanes, regardless of oneway
      secondary: 4 lanes two-way, 2 lanes one-way
      tertiary:  2 lanes two-way only - one-way tertiary is left alone

    residential is a genuine DEFAULT instead - only filled in when the way
    has no lanes tag at all, so it's just a starting point that stays
    further tinkerable (via an explicit OSM tag, or later in the editor)
    rather than being clobbered on every regeneration like the three above.

    Every other class (motorway, service, ...) is untouched here and keeps
    falling back to the editor's own defaults for anything unset.
    """
    for w in ways:
        hw = w["tags"].get("highway")
        oneway = (w["tags"].get("oneway") or "").strip().lower() == "yes"
        if hw == "primary":
            w["tags"]["lanes"] = "3"
        elif hw == "secondary":
            w["tags"]["lanes"] = "2" if oneway else "4"
        elif hw == "tertiary" and not oneway:
            w["tags"]["lanes"] = "2"
        elif hw == "residential" and "lanes" not in w["tags"]:
            w["tags"]["lanes"] = "2"
    return ways


# How far each end of a vehicle way is pulled back from a real junction
# (2+ roads meeting), and the length threshold (measured AFTER that
# pull-back) below which a connecting way between two real junctions is
# dropped and its two junctions merged into one group instead. See
# shorten_and_group_junctions.
SHORTEN_M = 2.5
SHORT_CONNECTOR_MAX_M = 10.0


def way_layer(way):
    """A way's effective vertical layer - mirrors editor.js's own wayLayer():
    explicit tags.layer if it parses as an int, otherwise 1 for a bridge or
    0 for an ordinary ground-level road. Two ways that happen to share an
    OSM node but sit on different layers (a flyover mapped with a node in
    common with the street it passes over, rather than truly connecting)
    are NOT a real at-grade junction there - see shorten_and_group_junctions,
    which must agree with the editor on this or it'll shorten/group a road
    at a point the editor itself would never treat as a junction, leaving a
    stray gap in what should be one continuous road (see waysAtNodeByLayer's
    own docstring in editor.js).
    """
    raw = way["tags"].get("layer")
    if raw not in (None, ""):
        try:
            return int(raw)
        except ValueError:
            pass
    return 1 if str(way["tags"].get("bridge", "")).lower() == "yes" else 0


def path_length(pts):
    return sum(
        math.hypot(pts[i + 1]["x"] - pts[i]["x"], pts[i + 1]["y"] - pts[i]["y"])
        for i in range(len(pts) - 1)
    )


def shorten_points(node_ids, pts, start_clearance, end_clearance):
    """Mirrors the editor's own shortenPath() (editor.js), including its
    parallel-nodeIds extension: trims a polyline from both ends by the given
    clearances, walking segment by segment and interpolating the exact cut
    point rather than just moving an endpoint in a straight line, threading
    `node_ids` through the identical splice/interpolate operations so every
    surviving point still knows which original node it is - `None` for a
    fresh interpolated cut point that isn't an original vertex (the caller
    assigns a real node id there). This is what lets an original INTERIOR
    vertex that happens to fall inside one end's own clearance zone (a tight
    bend very close to a junction) get dropped correctly instead of assumed
    to always be the nearest ones to whichever end was trimmed. Returns
    `(ids, pts)`, or `(None, None)` if the path is too short to survive
    both cuts.
    """
    out_ids = list(node_ids)
    out_pts = [dict(p) for p in pts]
    if path_length(out_pts) <= start_clearance + end_clearance:
        return None, None

    if start_clearance > 0:
        remaining = start_clearance
        for i in range(len(out_pts) - 1):
            seg_len = math.hypot(out_pts[i + 1]["x"] - out_pts[i]["x"], out_pts[i + 1]["y"] - out_pts[i]["y"])
            if remaining <= seg_len:
                t = (remaining / seg_len) if seg_len > 1e-9 else 0.0
                cut = {
                    "x": out_pts[i]["x"] + (out_pts[i + 1]["x"] - out_pts[i]["x"]) * t,
                    "y": out_pts[i]["y"] + (out_pts[i + 1]["y"] - out_pts[i]["y"]) * t,
                }
                out_pts = [cut] + out_pts[i + 1:]
                out_ids = [None] + out_ids[i + 1:]
                break
            remaining -= seg_len

    if end_clearance > 0:
        remaining = end_clearance
        for i in range(len(out_pts) - 1, 0, -1):
            seg_len = math.hypot(out_pts[i]["x"] - out_pts[i - 1]["x"], out_pts[i]["y"] - out_pts[i - 1]["y"])
            if remaining <= seg_len:
                t = (remaining / seg_len) if seg_len > 1e-9 else 0.0
                cut = {
                    "x": out_pts[i]["x"] + (out_pts[i - 1]["x"] - out_pts[i]["x"]) * t,
                    "y": out_pts[i]["y"] + (out_pts[i - 1]["y"] - out_pts[i]["y"]) * t,
                }
                out_pts = out_pts[:i] + [cut]
                out_ids = out_ids[:i] + [None]
                break
            remaining -= seg_len

    return out_ids, out_pts


def shorten_and_group_junctions(ways, nodes, next_id_start=1):
    """Pulls every vehicle-traffic way's own end back SHORTEN_M from any
    real junction it meets (2+ distinct roads sharing that point), giving
    each road its own private endpoint node instead of several roads all
    sharing one exact point - then tags every junction's own set of
    pulled-back endpoints with a shared join_group, so the editor's
    dynamically-sized junction ring (buildRingPath) draws the connecting
    surface across them, exactly like manually selecting several real
    intersections and using "Join into one intersection". A connecting way
    whose length (after pull-back) is SHORT_CONNECTOR_MAX_M or less, with
    both ends already real junctions, is dropped outright and its two
    junction groups are unioned into one - the automatic equivalent of
    manually joining across a short connector.

    Non-vehicle ways (footway, cycleway, ...) and closed-loop ways (a
    roundabout's own first/last node coinciding - pulling both ends back
    independently would break its closure into an open path, which was
    never a real junction there) are left completely untouched.

    Mutates `nodes` in place (adding the new pulled-back endpoint nodes,
    each `{"x", "y", "tags": {}}` - already in the same projected metres
    space as every other node by this point in the pipeline). `next_id_start`
    seeds the synthetic node id counter so it can never collide with a real
    OSM numeric id. Returns `(ways, next_id_counter)` - the updated way list,
    and a counter value the caller should write into meta.nextIdCounter (see
    its own docstring note below) so the editor's own newId() can't later
    mint a "jg_N" that collides with one of these already-real groups.
    """
    vehicle_ways = [w for w in ways if w["tags"].get("highway") in VEHICLE_HIGHWAY_TYPES]
    other_ways = [w for w in ways if w["tags"].get("highway") not in VEHICLE_HIGHWAY_TYPES]

    # Keyed by (node id, layer) - see way_layer(). A node only counts as a
    # junction for the ways that actually meet there AT THE SAME LEVEL; a
    # bridge/tunnel that happens to share a node with an unrelated at-grade
    # road (common in source OSM data around flyovers) must never be treated
    # as connecting to it.
    endpoint_way_count = {}
    for w in vehicle_ways:
        if w["nodes"][0] == w["nodes"][-1]:
            continue  # closed loop - its shared start/end isn't a real 2-road junction
        layer = way_layer(w)
        for nid in (w["nodes"][0], w["nodes"][-1]):
            key = (nid, layer)
            endpoint_way_count[key] = endpoint_way_count.get(key, 0) + 1

    def is_junction(nid, layer):
        return endpoint_way_count.get((nid, layer), 0) >= 2

    next_seq = [next_id_start]

    def new_node_id():
        next_seq[0] += 1
        return f"trim_{next_seq[0]}"

    origin_of = {}  # new endpoint node id -> the real junction node id it was pulled back from
    entries = []  # per-way bookkeeping for the dissolve pass below

    for w in vehicle_ways:
        node_ids = w["nodes"]
        start_id, end_id = node_ids[0], node_ids[-1]
        is_loop = start_id == end_id
        layer = way_layer(w)
        pts = [{"x": nodes[nid]["x"], "y": nodes[nid]["y"]} for nid in node_ids]

        if is_loop or not (is_junction(start_id, layer) or is_junction(end_id, layer)):
            entries.append({"way": w, "start_id": start_id, "end_id": end_id, "layer": layer, "len": path_length(pts)})
            continue

        start_clear = SHORTEN_M if is_junction(start_id, layer) else 0.0
        end_clear = SHORTEN_M if is_junction(end_id, layer) else 0.0
        trimmed_ids, trimmed_pts = shorten_points(node_ids, pts, start_clear, end_clear)
        if trimmed_ids is None:
            # Too short to survive both cuts - leave geometry untouched; its
            # own (already very short) original length means the dissolve
            # pass below will almost certainly drop it anyway.
            entries.append({"way": w, "start_id": start_id, "end_id": end_id, "layer": layer, "len": path_length(pts)})
            continue

        if trimmed_ids[0] is None:
            nid = new_node_id()
            nodes[nid] = {"x": trimmed_pts[0]["x"], "y": trimmed_pts[0]["y"], "tags": {}}
            origin_of[nid] = (start_id, layer)
            trimmed_ids[0] = nid
        if trimmed_ids[-1] is None:
            nid = new_node_id()
            nodes[nid] = {"x": trimmed_pts[-1]["x"], "y": trimmed_pts[-1]["y"], "tags": {}}
            origin_of[nid] = (end_id, layer)
            trimmed_ids[-1] = nid

        w["nodes"] = trimmed_ids
        entries.append({"way": w, "start_id": start_id, "end_id": end_id, "layer": layer, "len": path_length(trimmed_pts)})

    # Union-find over (ORIGINAL junction node id, layer) keys, for the
    # short-connector dissolve pass - kept separate per layer for the same
    # reason is_junction() is: two same-node-different-layer roads were
    # never really joined, so their groups must never merge either.
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
            return rb
        return ra

    # Per-root bounding box, so the dissolve pass below can refuse to union
    # two junctions whose COMBINED footprint would span more than
    # MAX_GROUP_SPAN_M. Plain union-find has no sense of "too far apart" -
    # only "did THIS ONE connector qualify" - so a chain of individually
    # short (<= SHORT_CONNECTOR_MAX_M) connectors could otherwise
    # transitively pull two real, unrelated junctions many metres apart
    # (several streets' worth) into one group. The editor's own gate/curb
    # ring (buildRingPath) already copes fine with a group spread across a
    # real footprint - that's the whole point of "Join into one
    # intersection" - but the merge-wedge system (computeMergeWedges) and a
    # tangential one-way leg's own MERGE_MAX_HOME_DIST_M cap both assume a
    # LOCAL cluster; a chained group blows past that and reads as a long,
    # spiky fill reaching across the gap (see wrong/image copy.png, image
    # copy 2.png). Processing shortest connectors first (instead of
    # whatever order they appear in the source data) is what makes this a
    # sane greedy cap rather than an order-dependent one.
    MAX_GROUP_SPAN_M = 20.0
    bbox = {}

    def node_bbox(nid):
        n = nodes[nid]
        return (n["x"], n["x"], n["y"], n["y"])

    def merged_bbox(b1, b2):
        return (min(b1[0], b2[0]), max(b1[1], b2[1]), min(b1[2], b2[2]), max(b1[3], b2[3]))

    def bbox_diag(b):
        return math.hypot(b[1] - b[0], b[3] - b[2])

    def get_bbox(root):
        if root not in bbox:
            bbox[root] = node_bbox(root[0])
        return bbox[root]

    kept = []
    dissolved = 0
    refused = 0
    for entry in sorted(entries, key=lambda e: e["len"]):
        w = entry["way"]
        if (
            entry["start_id"] != entry["end_id"]
            and is_junction(entry["start_id"], entry["layer"])
            and is_junction(entry["end_id"], entry["layer"])
            and entry["len"] <= SHORT_CONNECTOR_MAX_M
        ):
            ka, kb = (entry["start_id"], entry["layer"]), (entry["end_id"], entry["layer"])
            ra, rb = find(ka), find(kb)
            if ra == rb:
                dissolved += 1
                continue
            combined = merged_bbox(get_bbox(ra), get_bbox(rb))
            if bbox_diag(combined) <= MAX_GROUP_SPAN_M:
                new_root = union(ka, kb)
                bbox[new_root] = combined
                dissolved += 1
                continue
            refused += 1
        kept.append(w)

    # Every real (node, layer) junction gets its own group by default (one
    # original point's own fan of pulled-back road ends, on one level); the
    # dissolve pass above unions several such groups together when their
    # connector was short enough to drop.
    for key in endpoint_way_count:
        find(key)

    group_id_of_root = {}
    next_group_seq = [0]

    def group_id_for(key):
        root = find(key)
        if root not in group_id_of_root:
            next_group_seq[0] += 1
            group_id_of_root[root] = f"jg_{next_group_seq[0]}"
        return group_id_of_root[root]

    for new_nid, orig_key in origin_of.items():
        nodes[new_nid]["tags"]["join_group"] = group_id_for(orig_key)

    print(
        f"  shortened {len(origin_of)} road-end(s) at real junctions, "
        f"dissolved {dissolved} short connector(s) <= {SHORT_CONNECTOR_MAX_M}m "
        f"({refused} refused for exceeding {MAX_GROUP_SPAN_M}m combined group span), "
        f"{len(group_id_of_root)} junction group(s)."
    )

    # The editor's own newId() mints new ids as "<prefix>_<N>" off ONE
    # shared counter (State.nextIdCounter) across every prefix, including
    # "jg" for a manually-joined group - the same prefix used here. Report
    # the highest counter this pass used (both "trim_N" node ids and "jg_N"
    # group ids) so the caller can seed meta.nextIdCounter past it; otherwise
    # a later manual "Join into one intersection" in the editor could mint a
    # "jg_1" that collides with one of these already-real groups.
    next_id_counter = max(next_seq[0], next_group_seq[0]) + 1
    return kept + other_ways, next_id_counter


def extract_buildings_and_amenities(feature_ways, nodes):
    """Pulls building footprints and point-of-interest amenities out of the
    source data, entirely separate from the road pipeline above.

    `feature_ways`: every <way> from the source that carries a `building`
    and/or `amenity` tag (regardless of whether it's also a highway - in
    practice it never is). `nodes`: the full id -> {lat,lon,x,y,tags} dict
    built during the main parse, already projected to local metres.

    A way with a `building` tag becomes a `buildings` polygon entry (its
    point ring, closing point dropped, world-space metres - the same space
    every node already lives in). A way that ALSO carries an `amenity` tag
    (the common OSM pattern of tagging the amenity directly onto the
    building outline, e.g. building=yes + amenity=hospital) additionally
    gets a synthesized point `amenities` entry at the polygon's centroid,
    linked back to the building via `buildingId` - this is what actually
    carries the icon/fleet features in the editor, while the polygon itself
    stays purely a footprint.

    Every amenity is linked to a building (the editor's own invariant: an
    amenity is never a bare point with nothing built there) via its
    `buildingId`. A standalone amenity NODE (not part of any building way -
    these are NOT filtered by the "used by a kept road way" rule the main
    road pipeline applies to `out_nodes`, since that rule only concerns the
    road node pool) gets a small synthesized placeholder footprint of its
    own, centred on the point, rather than being left building-less.
    """
    PLACEHOLDER_HALF_M = 4.0

    def square_polygon(cx, cy, half):
        return [
            {"x": round(cx - half, 2), "y": round(cy - half, 2)},
            {"x": round(cx + half, 2), "y": round(cy - half, 2)},
            {"x": round(cx + half, 2), "y": round(cy + half, 2)},
            {"x": round(cx - half, 2), "y": round(cy + half, 2)},
        ]

    buildings = []
    amenities = []

    for w in feature_ways:
        tags = w["tags"]
        has_building = "building" in tags
        has_amenity = "amenity" in tags
        if not (has_building or has_amenity):
            continue

        pts = []
        for nid in w["nodes"]:
            n = nodes.get(nid)
            if n is not None:
                pts.append({"x": round(n["x"], 2), "y": round(n["y"], 2)})
        if len(pts) >= 2 and pts[0] == pts[-1]:
            pts = pts[:-1]  # drop the repeated closing point of a closed ring
        if len(pts) < 3:
            continue  # not a real polygon (edge-of-extract or degenerate way)

        bid = f"b_{w['id']}"
        buildings.append({"id": bid, "tags": dict(tags), "polygon": pts})

        if has_amenity:
            cx = sum(p["x"] for p in pts) / len(pts)
            cy = sum(p["y"] for p in pts) / len(pts)
            amenities.append({
                "id": f"a_{w['id']}_c",
                "x": round(cx, 2), "y": round(cy, 2),
                "tags": dict(tags),
                "buildingId": bid,
            })

    # "bn_" (not "b_") for a node-synthesized placeholder - way ids and node
    # ids are separate OSM namespaces that can share the same numeric value,
    # so a plain "b_{nid}" could theoretically collide with a real "b_{wayid}"
    # building above; the distinct prefix rules that out entirely.
    for nid, n in nodes.items():
        if "amenity" not in n["tags"]:
            continue
        cx, cy = n["x"], n["y"]
        bid = f"bn_{nid}"
        buildings.append({"id": bid, "tags": {"building": "yes"}, "polygon": square_polygon(cx, cy, PLACEHOLDER_HALF_M)})
        amenities.append({
            "id": f"a_{nid}",
            "x": round(cx, 2), "y": round(cy, 2),
            "tags": dict(n["tags"]),
            "buildingId": bid,
        })

    return buildings, amenities


def parse_osm(src_path):
    """Streams the OSM XML exactly once, returning
    `(nodes, ways, feature_ways, bounds)`:
      - nodes: id -> {lat, lon, tags} for every <node> in the file.
      - ways: kept road ways (highway=*), as {id, tags, nodes: [id,...]}.
      - feature_ways: building/amenity-tagged ways, same shape.
      - bounds: the file's own <bounds> element, or a fallback computed from
        every node's lat/lon extents if the file doesn't have one.

    This is the shared parsing step behind both this script's own main()
    (the full road pipeline) and add_buildings.py (which only wants
    nodes/feature_ways - never re-touching the road pipeline at all, so an
    already-hand-edited map_data.json's road changes are never at risk of
    being overwritten by it).
    """
    print(f"Reading {src_path} ...")

    bounds = None
    nodes = {}   # id -> {lat, lon, tags}
    ways = []    # list of {id, tags, nodes: [id,...]}  (kept roads only)
    feature_ways = []  # list of {id, tags, nodes: [id,...]}  (building/amenity ways)

    context = ET.iterparse(src_path, events=("start", "end"))
    cur_tags = None
    cur_nds = None
    cur_id = None
    depth_elem = None  # 'node' | 'way' | 'relation' | None

    node_count = 0
    way_count = 0
    kept_way_count = 0

    for event, elem in context:
        tag = elem.tag
        if event == "start":
            if tag == "bounds" and bounds is None:
                bounds = {
                    "minlat": float(elem.get("minlat")),
                    "minlon": float(elem.get("minlon")),
                    "maxlat": float(elem.get("maxlat")),
                    "maxlon": float(elem.get("maxlon")),
                }
            elif tag == "node":
                depth_elem = "node"
                cur_id = elem.get("id")
                cur_tags = {}
                nodes[cur_id] = {
                    "lat": float(elem.get("lat")),
                    "lon": float(elem.get("lon")),
                    "tags": cur_tags,
                }
                node_count += 1
            elif tag == "way":
                depth_elem = "way"
                cur_id = elem.get("id")
                cur_tags = {}
                cur_nds = []
                way_count += 1
            elif tag == "tag" and depth_elem in ("node", "way"):
                k = elem.get("k")
                v = elem.get("v")
                if k is not None:
                    cur_tags[k] = v
            elif tag == "nd" and depth_elem == "way":
                ref = elem.get("ref")
                if ref is not None:
                    cur_nds.append(ref)
        else:  # end
            if tag == "node":
                depth_elem = None
                elem.clear()
            elif tag == "way":
                if cur_tags.get("highway") and len(cur_nds) >= 2:
                    ways.append({"id": cur_id, "tags": cur_tags, "nodes": cur_nds})
                    kept_way_count += 1
                elif (cur_tags.get("building") or cur_tags.get("amenity")) and len(cur_nds) >= 3:
                    feature_ways.append({"id": cur_id, "tags": cur_tags, "nodes": cur_nds})
                depth_elem = None
                elem.clear()
            elif tag == "relation":
                elem.clear()

    print(f"Parsed {node_count} nodes, {way_count} ways "
          f"({kept_way_count} kept as roads, {len(feature_ways)} building/amenity ways).")

    if bounds is None:
        lats = [n["lat"] for n in nodes.values()]
        lons = [n["lon"] for n in nodes.values()]
        bounds = {
            "minlat": min(lats), "maxlat": max(lats),
            "minlon": min(lons), "maxlon": max(lons),
        }

    return nodes, ways, feature_ways, bounds


def main():
    if not os.path.exists(SRC):
        print(f"ERROR: source file not found: {SRC}", file=sys.stderr)
        sys.exit(1)

    nodes, ways, feature_ways, bounds = parse_osm(SRC)

    lat0 = (bounds["minlat"] + bounds["maxlat"]) / 2.0
    lon0 = (bounds["minlon"] + bounds["maxlon"]) / 2.0

    # Project every node to local metres up front - shorten_and_group_junctions
    # (like split_ways_at_junctions before it) then does all its topology work
    # in that same metric space, and the rest of the pipeline never needs to
    # touch lat/lon again.
    for n in nodes.values():
        n["x"], n["y"] = project(n["lat"], n["lon"], lat0, lon0)

    before_split = len(ways)
    ways = split_ways_at_junctions(ways)
    print(f"Split through-junctions: {before_split} ways -> {len(ways)} segments.")

    ways, next_id_counter = shorten_and_group_junctions(ways, nodes)

    ways = apply_lane_policy(ways)

    buildings, amenities = extract_buildings_and_amenities(feature_ways, nodes)

    # Which node ids are actually referenced by a kept way? A node that
    # carries an INTERESTING_NODE_TAGS tag (e.g. a traffic signal) is kept
    # even if nothing references it any more - the shortening pass above
    # routinely orphans an original junction node once every road touching
    # it has its own pulled-back endpoint instead, and any such tag would
    # otherwise silently vanish from the output.
    used_ids = set()
    for w in ways:
        used_ids.update(w["nodes"])
    for nid, n in nodes.items():
        if nid not in used_ids and any(k in n["tags"] for k in INTERESTING_NODE_TAGS):
            used_ids.add(nid)

    out_nodes = {}
    for nid in used_ids:
        n = nodes.get(nid)
        if n is None:
            # Way referenced a node outside the extract (edge of the export) -
            # skip the whole way reference later by filtering, but for now just
            # drop the dangling id from ways below.
            continue
        entry = {"x": round(n["x"], 2), "y": round(n["y"], 2)}
        if n["tags"]:
            entry["tags"] = n["tags"]
        out_nodes[nid] = entry

    out_ways = []
    for w in ways:
        node_ids = [nid for nid in w["nodes"] if nid in out_nodes]
        if len(node_ids) < 2:
            continue
        out_ways.append({
            "id": w["id"],
            "tags": w["tags"],
            "nodes": node_ids,
            "curve": "line",
        })

    data = {
        "meta": {
            "source": os.path.basename(SRC),
            "generated": datetime.now(timezone.utc).isoformat(),
            "bounds": bounds,
            "origin": {"lat": lat0, "lon": lon0},
            "projection": "equirectangular-metres",
            "nextIdCounter": next_id_counter,
        },
        "nodes": out_nodes,
        "ways": out_ways,
        "buildings": buildings,
        "amenities": amenities,
    }

    with open(DST, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))

    size_mb = os.path.getsize(DST) / (1024 * 1024)
    print(f"Wrote {DST}")
    print(f"  nodes kept: {len(out_nodes)}")
    print(f"  ways kept:  {len(out_ways)}")
    print(f"  buildings kept: {len(buildings)}")
    print(f"  amenities kept: {len(amenities)}")
    print(f"  file size:  {size_mb:.2f} MB")


if __name__ == "__main__":
    main()
