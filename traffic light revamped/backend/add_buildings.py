"""
Adds buildings and amenities from the source OpenStreetMap export
(map (2).osm) into the EXISTING map_data.json, without touching its roads
in any way.

Why this is a separate script from osm_to_json.py: that script's main()
regenerates the entire map_data.json from scratch, including the road
network - fine the first time, but re-running it later would silently
discard every manual road edit made since (intersection joins, added
traffic lights, moved nodes, deleted roads, ...), which this project's own
map_data.json.bak-* files show is a lot of accumulated work. This script
instead:
  1. Parses map (2).osm for nodes + building/amenity-tagged ways only,
     reusing osm_to_json.py's own parse_osm()/extract_buildings_and_amenities()
     so the two stay in agreement (same id scheme, same linked-building rule).
  2. Loads the CURRENT map_data.json from disk as-is.
  3. Projects the OSM nodes using THAT file's own meta.origin (not a freshly
     computed bounding-box centre) - critical: buildings must land in the
     exact same local-metres coordinate space the existing roads already use,
     or they'd be spatially misaligned with the road network.
  4. Merges newly-extracted buildings/amenities into the existing
     data["buildings"]/data["amenities"] arrays, ADDING only - any id
     already present (whether imported earlier by this same script, or
     hand-added/edited in the editor) is left completely untouched, so
     re-running this script is always safe and never clobbers editor work.
  5. Retags every building still tagged building=yes (newly added ones and
     ones from earlier runs alike) with a real type - see retag_yes_buildings()
     and the big comment above it for exactly how. This is the one exception
     to "never touch existing data": it only ever rewrites the single
     'building' tag key, and only when its value is literally 'yes'.
  6. Writes a timestamped backup of the current map_data.json (matching this
     project's own map_data.json.bak-YYYYMMDD-HHMMSS convention), then writes
     the merged data back. data["nodes"], data["ways"], data["meta"] (besides
     nothing - not even nextIdCounter) and data["redlightGroups"] are never
     touched.

Run:
    python add_buildings.py
"""

import collections
import json
import math
import os
import shutil
import sys
from datetime import datetime

from osm_to_json import SRC, PROJECT_ROOT, project, parse_osm, extract_buildings_and_amenities

MAP_DATA_PATH = os.path.join(PROJECT_ROOT, "front-end", "map_data.json")
MAPS_DIR = os.path.join(PROJECT_ROOT, "maps")

# ---------------------------------------------------------------------------
# building=yes retagging
#
# Most buildings - whether hand-drawn as a placeholder or pulled from OSM -
# land in map_data.json tagged building=yes, which just means "this is a
# building, type unknown". Two real signals let us do better:
#   1. A linked amenity (amenity.buildingId -> this building) or a
#      shop/office/tourism/leisure tag on the way itself tells us its
#      function directly - AMENITY_TO_BUILDING below maps that to a proper
#      building=* value.
#   2. Absent that (the vast majority - bare footprints with no other tags),
#      proximity to major roads is a reasonable proxy for zoning, same as in
#      any real city: footprints right on a secondary/tertiary road are
#      almost always shops/offices (commercial); a big footprint right on a
#      trunk road is almost always a warehouse/factory (industrial); footprints
#      a bit further back but still road-adjacent are usually multi-storey
#      apartment blocks; anything deeper in the street grid is a house
#      (residential). Thresholds below were tuned against this project's own
#      map_data.json to land roughly on: ~40-60% residential, ~20% commercial,
#      industrial a small slice (trunk-road frontage is rare in this extract),
#      with "apartments" absorbing the moderately-road-adjacent middle band -
#      see the conversation this was added in for the tuning sweep.
# ---------------------------------------------------------------------------

AMENITY_TO_BUILDING = {
    "hospital": "hospital", "clinic": "clinic", "doctors": "clinic", "dentist": "clinic",
    "blood_bank": "hospital", "pharmacy": "retail", "place_of_worship": "religious",
    "school": "school", "college": "school", "university": "school", "kindergarten": "school",
    "police": "civic", "fire_station": "civic", "post_office": "civic", "public_building": "civic",
    "townhall": "civic", "community_centre": "civic", "social_centre": "civic", "events_venue": "civic",
    "theatre": "civic", "toilets": "civic", "shelter": "civic", "studio": "commercial",
    "bank": "commercial", "atm": "commercial", "conference_centre": "commercial",
    "fast_food": "retail", "restaurant": "retail", "cafe": "retail", "food_court": "retail",
    "bar": "retail", "pub": "retail", "marketplace": "retail", "fuel": "retail",
}
DEFAULT_AMENITY_BUILDING = "commercial"
TOURISM_TO_BUILDING = {"hotel": "hotel", "guest_house": "hotel", "motel": "hotel", "hostel": "hotel"}

MAJOR_HIGHWAY_TIERS = {
    "trunk": "trunk", "trunk_link": "trunk",
    "primary": "primary", "primary_link": "primary",
    "secondary": "secondary", "secondary_link": "secondary",
    "tertiary": "secondary", "tertiary_link": "secondary",
}
ROAD_GRID_CELL_M = 40.0
COMMERCIAL_RADIUS_M = 60.0     # within this of a major road -> commercial (or industrial)
APARTMENTS_RADIUS_M = 150.0    # within this (but beyond COMMERCIAL_RADIUS_M) -> apartments; beyond -> residential
INDUSTRIAL_MIN_AREA_M2 = 250.0  # commercial-band footprint on a trunk road this big or bigger -> industrial


def polygon_area_centroid(polygon):
    """Shoelace area + centroid. polygon is [{x,y}, ...], open ring."""
    area2 = 0.0
    cx = 0.0
    cy = 0.0
    n = len(polygon)
    for i in range(n):
        x0, y0 = polygon[i]["x"], polygon[i]["y"]
        x1, y1 = polygon[(i + 1) % n]["x"], polygon[(i + 1) % n]["y"]
        cross = x0 * y1 - x1 * y0
        area2 += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    area = abs(area2) / 2.0
    if area < 1e-6:
        xs = [p["x"] for p in polygon]
        ys = [p["y"] for p in polygon]
        return area, (sum(xs) / n, sum(ys) / n)
    return area, (cx / (3 * area2), cy / (3 * area2))


def build_major_road_grid(nodes, ways):
    """Buckets nodes of trunk/primary/secondary/tertiary ways into a coarse
    grid, keyed by (x//CELL, y//CELL), for fast nearest-road lookups."""
    grid = collections.defaultdict(list)
    for w in ways:
        tier = MAJOR_HIGHWAY_TIERS.get((w.get("tags") or {}).get("highway"))
        if not tier:
            continue
        for nid in w["nodes"]:
            n = nodes.get(nid)
            if n is None:
                continue
            x, y = n["x"], n["y"]
            grid[(int(x // ROAD_GRID_CELL_M), int(y // ROAD_GRID_CELL_M))].append((x, y, tier))
    return grid


def nearest_major_road(grid, cx, cy, max_radius):
    """Nearest (tier, distance) among grid points within max_radius metres of
    (cx, cy), via expanding-ring search over the grid cells. None if nothing
    is within range."""
    best = None
    best_d2 = max_radius * max_radius
    ccx, ccy = int(cx // ROAD_GRID_CELL_M), int(cy // ROAD_GRID_CELL_M)
    max_ring = int(max_radius // ROAD_GRID_CELL_M) + 1
    for ring in range(max_ring + 1):
        for dx in range(-ring, ring + 1):
            for dy in range(-ring, ring + 1):
                if max(abs(dx), abs(dy)) != ring:
                    continue
                for x, y, tier in grid.get((ccx + dx, ccy + dy), ()):
                    d2 = (x - cx) ** 2 + (y - cy) ** 2
                    if d2 < best_d2:
                        best_d2 = d2
                        best = (tier, math.sqrt(d2))
        if best is not None and ring > 0:
            break
    return best


def classify_building_type(building, linked_amenity, grid):
    """Returns the building=* value a currently-'yes' building should get."""
    tags = building.get("tags") or {}
    if linked_amenity is not None:
        atype = (linked_amenity.get("tags") or {}).get("amenity")
        return AMENITY_TO_BUILDING.get(atype, DEFAULT_AMENITY_BUILDING)
    if "shop" in tags:
        return "retail"
    if "office" in tags:
        return "office"
    if "tourism" in tags:
        return TOURISM_TO_BUILDING.get(tags["tourism"], "commercial")
    if "leisure" in tags:
        return "commercial"

    area, (cx, cy) = polygon_area_centroid(building["polygon"])
    nearest = nearest_major_road(grid, cx, cy, APARTMENTS_RADIUS_M)
    if nearest is None:
        return "residential"
    tier, dist = nearest
    if dist <= COMMERCIAL_RADIUS_M:
        if tier == "trunk" and area >= INDUSTRIAL_MIN_AREA_M2:
            return "industrial"
        return "commercial"
    return "apartments"


def retag_yes_buildings(data):
    """Retags every building still tagged building=yes with a real type,
    in place. Only ever touches the 'building' tag key - nothing else about
    the building, and buildings already tagged something other than 'yes'
    (including hand-edited ones) are left completely alone."""
    buildings = data.get("buildings", [])
    amenities = data.get("amenities", [])
    yes_buildings = [b for b in buildings if (b.get("tags") or {}).get("building") == "yes"]
    if not yes_buildings:
        return 0, {}

    amenity_by_building = {}
    for a in amenities:
        bid = a.get("buildingId")
        if bid:
            amenity_by_building[bid] = a

    grid = build_major_road_grid(data.get("nodes", {}), data.get("ways", []))

    histogram = collections.Counter()
    for b in yes_buildings:
        new_type = classify_building_type(b, amenity_by_building.get(b["id"]), grid)
        b["tags"]["building"] = new_type
        histogram[new_type] += 1

    return len(yes_buildings), histogram


def main():
    if not os.path.exists(SRC):
        print(f"ERROR: source file not found: {SRC}", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(MAP_DATA_PATH):
        print(f"ERROR: {MAP_DATA_PATH} not found - run osm_to_json.py first "
              f"to create the initial map_data.json.", file=sys.stderr)
        sys.exit(1)

    with open(MAP_DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)

    origin = (data.get("meta") or {}).get("origin")
    if not origin or "lat" not in origin or "lon" not in origin:
        print("ERROR: map_data.json has no meta.origin to project against - "
              "it doesn't look like it was produced by osm_to_json.py.", file=sys.stderr)
        sys.exit(1)
    lat0, lon0 = origin["lat"], origin["lon"]

    nodes, _roads, feature_ways, _bounds = parse_osm(SRC)

    for n in nodes.values():
        n["x"], n["y"] = project(n["lat"], n["lon"], lat0, lon0)

    new_buildings, new_amenities = extract_buildings_and_amenities(feature_ways, nodes)

    existing_buildings = data.setdefault("buildings", [])
    existing_amenities = data.setdefault("amenities", [])
    existing_building_ids = {b["id"] for b in existing_buildings}
    existing_amenity_ids = {a["id"] for a in existing_amenities}

    added_buildings = [b for b in new_buildings if b["id"] not in existing_building_ids]
    added_amenities = [a for a in new_amenities if a["id"] not in existing_amenity_ids]
    skipped_buildings = len(new_buildings) - len(added_buildings)
    skipped_amenities = len(new_amenities) - len(added_amenities)

    existing_buildings.extend(added_buildings)
    existing_amenities.extend(added_amenities)

    retagged_count, retag_histogram = retag_yes_buildings(data)

    if not added_buildings and not added_amenities and not retagged_count:
        print("Nothing new to add and nothing to retag - every building/amenity from the "
              "source already exists in map_data.json (identified by id), and no building "
              f"is still tagged building=yes. ({skipped_buildings} building(s), "
              f"{skipped_amenities} amenity(ies) already present.)")
        return

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    os.makedirs(MAPS_DIR, exist_ok=True)
    backup_path = os.path.join(MAPS_DIR, f"map_data.json.bak-{timestamp}")
    shutil.copyfile(MAP_DATA_PATH, backup_path)
    print(f"Backed up current map_data.json to {os.path.basename(backup_path)}")

    tmp_path = MAP_DATA_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp_path, MAP_DATA_PATH)

    print(f"Added {len(added_buildings)} building(s) and {len(added_amenities)} amenity(ies) "
          f"({skipped_buildings} building(s), {skipped_amenities} amenity(ies) already present, left untouched).")
    if retagged_count:
        breakdown = ", ".join(f"{v} {k}" for k, v in retag_histogram.most_common())
        print(f"Retagged {retagged_count} building(s) that were still building=yes -> {breakdown}.")
    print(f"Roads/nodes/traffic lights untouched - {len(data.get('nodes', {}))} nodes, "
          f"{len(data.get('ways', []))} ways still exactly as they were.")
    print(f"Wrote {MAP_DATA_PATH}")


if __name__ == "__main__":
    main()
