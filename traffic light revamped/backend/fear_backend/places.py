"""Named places from map_data.json - amenities (hospitals, police, schools...)
and named areas - for search, "nearest hospital" and the map's bounds.

Cached on the file's mtime like map_data.py, which covers roads only.
"""

from __future__ import annotations

import json
import math
import os
import threading
from typing import Optional

from . import config, geo

# amenity tag -> what the apps call it
KIND_LABELS = {
    "hospital": "Hospital", "clinic": "Clinic", "doctors": "Doctor", "blood_bank": "Blood bank",
    "police": "Police station", "fire_station": "Fire station", "school": "School", "college": "College",
    "bank": "Bank", "atm": "ATM", "post_office": "Post office", "bus_station": "Bus station",
    "marketplace": "Market", "place_of_worship": "Place of worship", "restaurant": "Restaurant",
    "fast_food": "Fast food", "food_court": "Food court", "theatre": "Theatre", "toilets": "Toilets",
    "public_building": "Public building", "events_venue": "Events venue", "shelter": "Shelter",
}

# Where each emergency category hands over at the end of an assignment.
HANDOVER_KINDS = {
    "ambulance": ("hospital",),
    "firetruck": ("fire_station", "police"),  # this map has no fire station - see generate_vehicles.py
    "police": ("police",),
}

_lock = threading.Lock()
_cache: Optional[dict] = None


def _load() -> dict:
    global _cache
    mtime = os.path.getmtime(config.MAP_DATA_PATH)
    with _lock:
        if _cache is not None and _cache["mtime"] == mtime:
            return _cache
        with open(config.MAP_DATA_PATH, encoding="utf-8") as f:
            raw = json.load(f)
        meta = raw.get("meta", {})
        items = []
        for a in raw.get("amenities", []):
            tags = a.get("tags") or {}
            kind = tags.get("amenity", "")
            name = tags.get("name") or tags.get("designation")
            if not name and kind not in ("hospital", "police", "fire_station", "clinic"):
                continue
            x, y = float(a.get("x", 0.0)), float(a.get("y", 0.0))
            lat, lon = geo.to_latlon(x, y)
            items.append({
                "id": a.get("id"), "name": name or KIND_LABELS.get(kind, kind.title()),
                "kind": kind, "kindLabel": KIND_LABELS.get(kind, kind.replace("_", " ").title()),
                "lat": lat, "lon": lon, "_pts": [(x, y)],
            })
        for ar in raw.get("areas", []):
            poly = ar.get("polygon") or []
            if not ar.get("name") or not poly:
                continue
            cx, cy = geo.centroid((p["x"], p["y"]) for p in poly)
            lat, lon = geo.to_latlon(cx, cy)
            label = (ar.get("level") or ar.get("zoneType") or "area").replace("_", " ").title()
            items.append({"id": ar.get("id"), "name": ar["name"].title(), "kind": "area", "kindLabel": label,
                          "lat": lat, "lon": lon, "_pts": [(cx, cy)]})
        nodes = raw.get("nodes", {})
        roads: dict = {}
        for w in raw.get("ways", []):
            tags = w.get("tags") or {}
            name = tags.get("name")
            if not name or not tags.get("highway"):
                continue
            pts = [nodes[i] for i in w.get("nodes", []) if i in nodes]
            if pts:
                roads.setdefault(name, []).extend(pts)
        for name, pts in roads.items():
            # A road is every point along it, not one midpoint: a search
            # answers with the stretch of that road nearest the person.
            xy = [(float(p.get("x", 0.0)), float(p.get("y", 0.0))) for p in pts]
            mid = xy[len(xy) // 2]
            lat, lon = geo.to_latlon(*mid)
            items.append({"id": f"road:{name}", "name": name, "kind": "road", "kindLabel": "Road", "lat": lat, "lon": lon,
                          "_pts": xy})
        _cache = {"mtime": mtime, "items": items, "bounds": meta.get("bounds"), "origin": meta.get("origin")}
        return _cache


def meta() -> dict:
    c = _load()
    return {"bounds": c["bounds"], "origin": c["origin"]}


def _nearest_pt(it: dict, x: float, y: float) -> tuple[float, tuple]:
    best, bp = math.inf, it["_pts"][0]
    for p in it["_pts"]:
        d = (p[0] - x) ** 2 + (p[1] - y) ** 2
        if d < best:
            best, bp = d, p
    return math.sqrt(best), bp


def _strip(it: dict) -> dict:
    return {k: v for k, v in it.items() if not k.startswith("_")}


def _public(it: dict, x: Optional[float], y: Optional[float]) -> dict:
    out = _strip(it)
    if x is not None:
        d, p = _nearest_pt(it, x, y)
        out["distanceM"] = round(d)
        out["lat"], out["lon"] = geo.to_latlon(*p)
    else:
        out["distanceM"] = None
    return out


# How far (metres) a weaker text match is pushed down the list: a road that
# only contains what was typed mid-word ranks with a name-prefix match ~3 km nearer.
_TIER_PENALTY_M = 1500


def _words(text: str) -> list:
    return text.lower().replace("-", " ").replace(",", " ").split()


def _tier(it: dict, name: str, q: str, toks: list) -> int:
    # typing a kind ("hosp", "fuel") asks for every place of that kind, nearest first
    kind_words = _words(it["kindLabel"])
    if all(any(w.startswith(t) for w in kind_words) for t in toks):
        return 0
    if name == q or name.startswith(q):
        return 0
    words = _words(name)
    if all(any(w.startswith(t) for w in words) for t in toks):
        return 1
    return 2


def search(q: str, lat: Optional[float] = None, lon: Optional[float] = None, limit: int = 20) -> list:
    """Autocomplete. Typed text matches every word of a name (or its kind -
    "hospital" finds every hospital); results come nearest-first, name-prefix
    matches ahead of mid-word ones, and a road answers with its own stretch
    nearest the person. An empty query with a location lists what is around:
    the nearest roads and named places."""
    q = (q or "").strip().lower()
    toks = q.split()
    x = y = None
    if lat is not None and lon is not None:
        x, y = geo.to_xy(lat, lon)
    items = _load()["items"]
    if not q:
        if x is None:
            return []
        near = []
        for it in items:
            if it["kind"] == "area":
                continue
            d, _ = _nearest_pt(it, x, y)
            if d <= 3000:
                near.append((d, it))
        near.sort(key=lambda t: t[0])
        # a mix: the closest roads (where you are) and places (what is around)
        roads = [it for _, it in near if it["kind"] == "road"][:5]
        others = [it for _, it in near if it["kind"] != "road"][: max(0, limit - len(roads))]
        out = [_public(it, x, y) for it in roads + others]
        out.sort(key=lambda p: p["distanceM"])
        return out[:limit]
    scored = []
    for it in items:
        name = it["name"].lower()
        hay = f"{name} {it['kindLabel']} {it['kind']}".lower()
        if not all(tok in hay for tok in toks):
            continue
        tier = _tier(it, name, q, toks)
        d = _nearest_pt(it, x, y)[0] if x is not None else 0.0
        scored.append((d + tier * _TIER_PENALTY_M, tier, it["name"], it))
    scored.sort(key=lambda t: t[:3])
    return [_public(t[3], x, y) for t in scored[:limit]]


def at(lat: float, lon: float) -> dict:
    """What to call a point picked on the map: the road it is on (within ~40 m),
    else a dropped pin described as "near <closest named place>"."""
    x, y = geo.to_xy(lat, lon)
    best, bd = None, math.inf
    for it in _load()["items"]:
        if it["kind"] != "road":
            continue
        d, _ = _nearest_pt(it, x, y)
        if d < bd:
            best, bd = it, d
    if best is not None and bd <= 40:
        return {"name": best["name"], "detail": describe(lat, lon), "lat": lat, "lon": lon}
    return {"name": "Dropped pin", "detail": describe(lat, lon), "lat": lat, "lon": lon}


def nearest(kinds: tuple, lat: float, lon: float, limit: int = 1) -> list:
    cands = [it for it in _load()["items"] if it["kind"] in kinds]
    cands.sort(key=lambda it: geo.distance_m(lat, lon, it["lat"], it["lon"]))
    return [_strip(it) for it in cands[:limit]]


# OSM tags eye/dental/diagnostic/acupuncture clinics as amenity=hospital too;
# none of them can receive an ambulance patient.
_NOT_EMERGENCY_CARE = ("eye", "dental", "diagnos", "acupuncture", "sanatorium", "laser")


def receiving_hospitals(lat: float, lon: float, limit: int = 6) -> list:
    """Named hospitals able to take an emergency patient, nearest first."""
    cands = [it for it in _load()["items"] if it["kind"] == "hospital" and it["name"] != KIND_LABELS["hospital"]
             and not any(w in it["name"].lower() for w in _NOT_EMERGENCY_CARE)]
    cands.sort(key=lambda it: geo.distance_m(lat, lon, it["lat"], it["lon"]))
    return [_strip(it) for it in cands[:limit]]


def describe(lat: float, lon: float) -> str:
    """A short human hint for a point: 'near <closest named place>'."""
    named = [it for it in _load()["items"] if it["kind"] != "area"]
    if not named:
        return f"{lat:.5f}, {lon:.5f}"
    best = min(named, key=lambda it: geo.distance_m(lat, lon, it["lat"], it["lon"]))
    d = geo.distance_m(lat, lon, best["lat"], best["lon"])
    return f"near {best['name']}" if d < 600 else f"{round(d / 100) / 10} km from {best['name']}"
