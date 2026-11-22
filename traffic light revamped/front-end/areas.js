"use strict";

/* ============================================================
   Area classification (shared engine)
   Loaded by BOTH editor.html and simulation.html, AFTER
   map-core.js/settings.js/redlight.js and BEFORE editor.js/
   simulation.js - the same plain-global-scripts, load-order-is-the-
   wiring convention the rest of the front-end uses.

   Two independent classification layers sit on top of the same
   polygon primitive (drawn exactly the way a building footprint is):

     1. JURISDICTION - a strict 5-level containment hierarchy
        country > state > city > district > locality. Membership is
        never stored on a feature: a building/road/amenity belongs to
        whatever jurisdiction polygons geometrically contain it, so
        drawing one new locality instantly re-addresses everything
        inside it, and reshaping that locality re-addresses them
        again. Police stations are assigned to a jurisdiction
        explicitly (area.stations), since "which station polices this
        zone" is a decision, not a geometric fact.

     2. ZONE - a flat land-use classification (residential,
        commercial, industrial, ...). Zones overlap the jurisdiction
        layer freely and have no hierarchy of their own.

   This file owns the data model for both, the spatial indexes,
   address derivation, the road span classification that drives the
   level-of-detail focus (see AreaFocus), the rendering of the area
   layers, and the fuzzy place search. Mutation (drawing a new area,
   deleting one, assigning stations, numbering houses) is driven from
   editor.js but implemented here - the areaEditable() guard keeps
   every one of those a no-op on the read-only simulation page rather
   than duplicating the code across both.
   ============================================================ */

/* ---------------- Levels, types, styling ---------------- */

// Ordered coarse -> fine. The index into this array IS the rank used
// everywhere below (0 = country ... 4 = locality); a "finer" level is a
// HIGHER rank, which reads backwards at first but keeps every comparison a
// plain numeric one.
const JURISDICTION_LEVELS = ["country", "state", "city", "district", "locality"];
const JURISDICTION_RANK = Object.fromEntries(JURISDICTION_LEVELS.map((l, i) => [l, i]));
const JURISDICTION_LABEL = {
  country: "Country", state: "State", city: "City", district: "District", locality: "Locality",
};

// Coarser levels get a heavier, more saturated outline and no fill, so a
// country/state boundary reads as a border rather than as a coloured patch;
// the finer levels get a faint fill so a locality still reads as an area.
const JURISDICTION_STYLE = {
  country:  { stroke: "#7b2cbf", width: 3.4, dash: [14, 6], fill: null,                        label: 17 },
  state:    { stroke: "#5a189a", width: 2.8, dash: [10, 5], fill: null,                        label: 15.5 },
  city:     { stroke: "#c1121f", width: 2.4, dash: [8, 4],  fill: "rgba(193, 18, 31, 0.05)",   label: 14 },
  district: { stroke: "#e07a1f", width: 1.9, dash: [6, 3],  fill: "rgba(224, 122, 31, 0.06)",  label: 12.5 },
  locality: { stroke: "#2a9d8f", width: 1.5, dash: [4, 3],  fill: "rgba(42, 157, 143, 0.07)",  label: 11.5 },
};

const ZONE_TYPES = [
  "residential", "commercial", "industrial", "institutional", "mixed_use",
  "recreational", "agricultural", "transport", "utilities", "military",
  "forest", "water", "special_economic", "heritage", "other",
];

const ZONE_STYLE = {
  residential:      { stroke: "#e9c46a", fill: "rgba(233, 196, 106, 0.22)" },
  commercial:       { stroke: "#4361ee", fill: "rgba(67, 97, 238, 0.18)" },
  industrial:       { stroke: "#8d6e63", fill: "rgba(141, 110, 99, 0.24)" },
  institutional:    { stroke: "#9d4edd", fill: "rgba(157, 78, 221, 0.18)" },
  mixed_use:        { stroke: "#f4845f", fill: "rgba(244, 132, 95, 0.20)" },
  recreational:     { stroke: "#52b788", fill: "rgba(82, 183, 136, 0.22)" },
  agricultural:     { stroke: "#a7c957", fill: "rgba(167, 201, 87, 0.24)" },
  transport:        { stroke: "#6c757d", fill: "rgba(108, 117, 125, 0.20)" },
  utilities:        { stroke: "#ffb703", fill: "rgba(255, 183, 3, 0.18)" },
  military:         { stroke: "#606c38", fill: "rgba(96, 108, 56, 0.22)" },
  forest:           { stroke: "#2d6a4f", fill: "rgba(45, 106, 79, 0.24)" },
  water:            { stroke: "#48cae4", fill: "rgba(72, 202, 228, 0.26)" },
  special_economic: { stroke: "#f72585", fill: "rgba(247, 37, 133, 0.16)" },
  heritage:         { stroke: "#b08968", fill: "rgba(176, 137, 104, 0.22)" },
  other:            { stroke: "#6c6478", fill: "rgba(108, 100, 120, 0.16)" },
};
const ZONE_STYLE_FALLBACK = ZONE_STYLE.other;

function zoneLabel(t) {
  return String(t || "other").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/* ---------------- Road "span" classes (level-of-detail input) ---------------- */

// How far a road reaches through the jurisdiction hierarchy: the rank of the
// COARSEST level whose boundary it crosses, or SPAN_LOCAL when it never
// leaves one single locality. A road running between two localities of the
// same district is span 4 ("inter-locality"), between two districts of the
// same city span 3 ("inter-district"), and so on upward.
const SPAN_LOCAL = JURISDICTION_LEVELS.length; // 5 - never leaves its locality

const SPAN_LABEL = {
  0: "inter-country", 1: "inter-state", 2: "inter-city",
  3: "inter-district", 4: "inter-locality", 5: "local",
};

// The level-of-detail table: focusing N areas of a given level draws only
// roads whose span rank is <= the entry for that level. Focusing localities
// or districts keeps every road inside them (including the purely local
// streets); focusing cities drops those local streets and the inter-locality
// links, keeping the inter-district/inter-city network; each coarser level
// above that drops one more class. "Include local roads" in the Focus panel
// overrides this with SPAN_LOCAL when the full detail is wanted anyway at a
// coarse level.
const LOD_SPAN_BY_LEVEL = {
  country:  1,          // only roads crossing a state border or bigger
  state:    2,          // + inter-city roads
  city:     3,          // + inter-district roads
  district: SPAN_LOCAL, // everything inside the focused districts
  locality: SPAN_LOCAL, // everything inside the focused localities
};

// Below these focus levels the per-feature clutter is dropped along with the
// local roads - a 3-city view is about the network between them, not about
// individual footprints.
const LOD_BUILDING_MIN_RANK = JURISDICTION_RANK.district; // buildings from district focus down
const LOD_AMENITY_MIN_RANK = JURISDICTION_RANK.city;      // amenities from city focus down

/* ---------------- Mutation guards (shared file, editor-only edits) ---------------- */

// editor.js defines pushUndo/scheduleAutosave; simulation.js does not. Every
// mutator below routes through these rather than calling them directly, so
// one file can back both pages without the read-only one throwing.
function areaEditable() { return typeof pushUndo === "function"; }
function areaPushUndo() { if (typeof pushUndo === "function") pushUndo(); }
function areaSaved() { if (typeof scheduleAutosave === "function") scheduleAutosave(); }

/* ---------------- Geometry helpers ---------------- */

// Proper area-weighted (shoelace) centroid - unlike map-core's vertex-average
// polygonCentroid, this stays put when one edge of a polygon gains extra
// vertices, which matters for a label that should not drift while a boundary
// is being reshaped. Falls back to the vertex average for a degenerate ring.
function polygonAreaCentroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const cross = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
    a += cross;
    cx += (poly[j].x + poly[i].x) * cross;
    cy += (poly[j].y + poly[i].y) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) return polygonCentroid(poly);
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return Math.abs(a * 0.5);
}

function distPointToPolygonEdge(p, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = distPointToSegment(p, poly[j], poly[i]);
    if (d < best) best = d;
  }
  return best;
}

function bboxContainsPoint(bb, p) {
  return p.x >= bb.minX && p.x <= bb.maxX && p.y >= bb.minY && p.y <= bb.maxY;
}

function bboxUnion(a, b) {
  if (!a) return { ...b };
  return {
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
  };
}

function bboxPad(bb, m) {
  return { minX: bb.minX - m, minY: bb.minY - m, maxX: bb.maxX + m, maxY: bb.maxY + m };
}

/* ============================================================
   DATA MODEL
   ============================================================ */

// One area record, as stored in map_data.json's top-level "areas" array:
//   { id, kind:"jurisdiction"|"zone", level?, zoneType?, name, polygon:[{x,y}],
//     stations?:[amenityId], tags?:{} }
// `level` is only meaningful for kind:"jurisdiction", `zoneType` only for
// kind:"zone", and `stations` only for jurisdictions.

function loadAreas(list) {
  State.areas = new Map();
  for (const a of (list || [])) {
    if (!a || !Array.isArray(a.polygon) || a.polygon.length < 3) continue;
    const kind = a.kind === "zone" ? "zone" : "jurisdiction";
    State.areas.set(a.id, {
      id: a.id,
      kind,
      level: kind === "jurisdiction" ? (JURISDICTION_RANK[a.level] != null ? a.level : "locality") : undefined,
      zoneType: kind === "zone" ? (a.zoneType || "other") : undefined,
      name: a.name != null ? String(a.name) : "",
      polygon: a.polygon.map(p => ({ x: p.x, y: p.y })),
      stations: kind === "jurisdiction" && Array.isArray(a.stations) ? a.stations.slice() : [],
      tags: a.tags ? { ...a.tags } : {},
    });
  }
  areasInvalidate();
  AreaFocus.clear(false);
}

function serializeAreas() {
  const out = [];
  for (const a of State.areas.values()) {
    out.push({
      id: a.id,
      kind: a.kind,
      level: a.kind === "jurisdiction" ? a.level : undefined,
      zoneType: a.kind === "zone" ? a.zoneType : undefined,
      name: a.name || "",
      polygon: a.polygon.map(p => ({ x: p.x, y: p.y })),
      stations: a.kind === "jurisdiction" && a.stations && a.stations.length ? a.stations.slice() : undefined,
      tags: a.tags && Object.keys(a.tags).length ? a.tags : undefined,
    });
  }
  return out;
}

function areaRank(area) {
  return area && area.kind === "jurisdiction" ? JURISDICTION_RANK[area.level] : null;
}

function areaDisplayName(area) {
  if (!area) return "(missing area)";
  if (area.name) return area.name;
  return area.kind === "jurisdiction"
    ? `Unnamed ${JURISDICTION_LABEL[area.level] || area.level}`
    : `Unnamed ${zoneLabel(area.zoneType)} zone`;
}

function areaTypeLabel(area) {
  if (!area) return "";
  return area.kind === "jurisdiction" ? (JURISDICTION_LABEL[area.level] || area.level) : `${zoneLabel(area.zoneType)} zone`;
}

function areaStyle(area) {
  if (area.kind === "zone") return ZONE_STYLE[area.zoneType] || ZONE_STYLE_FALLBACK;
  return JURISDICTION_STYLE[area.level] || JURISDICTION_STYLE.locality;
}

/* ============================================================
   SPATIAL INDEX + DERIVED CACHES
   ============================================================ */

// Everything derived from area geometry (containment, addresses, road spans,
// the search index) is cached and thrown away wholesale whenever the areas
// change - recomputing from scratch is cheap at this map size and a single
// version counter is far less error-prone than trying to patch each cache.
const AreaIndex = {
  version: 0,      // bumped by areasInvalidate()
  built: -1,       // version the grid below was built from
  cellSize: 250,   // metres
  minX: 0, minY: 0, cols: 0, rows: 0,
  buckets: new Map(), // "cx|cy" -> [area]
  meta: new Map(),    // areaId -> { bbox, centroid, area (m2) }
};

// Caches keyed on BOTH the area version and the map-data version, so an edit
// to a road name or a building polygon invalidates them too (State.dataVersion
// is bumped by map-core's loadData and by editor.js's pushUndo).
const AreaCache = {
  stamp: null,
  buildingChain: new Map(), // buildingId -> chain array
  buildingCentroid: new Map(), // buildingId -> {x,y}
  waySpan: new Map(),       // wayId -> span rank
  wayAreas: new Map(),      // wayId -> { byRank: [Set|null x5], touched: Set(areaId) }
  nearestStreet: new Map(), // buildingId -> { wayId, name, dist } | null
};

function areasInvalidate() {
  AreaIndex.version++;
  SearchIndex.built = -1;
  // The status bar carries an area count, so keep it honest here rather than
  // at each of the call sites - this is the one funnel every area change
  // already goes through, including loadAreas.
  if (typeof updateStatusCounts === "function") updateStatusCounts();
  markDirty();
}

function currentStamp() {
  return `${AreaIndex.version}|${State.dataVersion || 0}`;
}

function ensureAreaCaches() {
  const stamp = currentStamp();
  if (AreaCache.stamp === stamp) return;
  AreaCache.stamp = stamp;
  AreaCache.buildingChain = new Map();
  AreaCache.buildingCentroid = new Map();
  AreaCache.waySpan = new Map();
  AreaCache.wayAreas = new Map();
  AreaCache.nearestStreet = new Map();
  RoadIndex.built = -1;
}

function ensureAreaIndex() {
  if (AreaIndex.built === AreaIndex.version) return;
  AreaIndex.built = AreaIndex.version;
  AreaIndex.buckets = new Map();
  AreaIndex.meta = new Map();
  if (!State.areas || !State.areas.size) { AreaIndex.cols = AreaIndex.rows = 0; return; }

  let world = null;
  for (const a of State.areas.values()) {
    const bbox = polygonBounds(a.polygon);
    AreaIndex.meta.set(a.id, { bbox, centroid: polygonAreaCentroid(a.polygon), area: polygonArea(a.polygon) });
    world = bboxUnion(world, bbox);
  }
  // Keep the grid at a sane number of cells no matter how big the mapped
  // extent is - a country-sized polygon must not blow this up into millions
  // of buckets, and a handful of tiny localities must not collapse it into
  // one bucket that defeats the point.
  const w = Math.max(1, world.maxX - world.minX), h = Math.max(1, world.maxY - world.minY);
  const target = 64;
  AreaIndex.cellSize = Math.max(50, Math.max(w, h) / target);
  AreaIndex.minX = world.minX; AreaIndex.minY = world.minY;
  AreaIndex.cols = Math.ceil(w / AreaIndex.cellSize) + 1;
  AreaIndex.rows = Math.ceil(h / AreaIndex.cellSize) + 1;

  for (const a of State.areas.values()) {
    const bb = AreaIndex.meta.get(a.id).bbox;
    const c0 = Math.floor((bb.minX - AreaIndex.minX) / AreaIndex.cellSize);
    const c1 = Math.floor((bb.maxX - AreaIndex.minX) / AreaIndex.cellSize);
    const r0 = Math.floor((bb.minY - AreaIndex.minY) / AreaIndex.cellSize);
    const r1 = Math.floor((bb.maxY - AreaIndex.minY) / AreaIndex.cellSize);
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const key = `${c}|${r}`;
        let arr = AreaIndex.buckets.get(key);
        if (!arr) { arr = []; AreaIndex.buckets.set(key, arr); }
        arr.push(a);
      }
    }
  }
}

function areaBBox(areaOrId) {
  ensureAreaIndex();
  const id = typeof areaOrId === "string" ? areaOrId : areaOrId.id;
  const m = AreaIndex.meta.get(id);
  if (m) return m.bbox;
  const a = State.areas.get(id);
  return a ? polygonBounds(a.polygon) : null;
}

function areaCentroid(areaOrId) {
  ensureAreaIndex();
  const id = typeof areaOrId === "string" ? areaOrId : areaOrId.id;
  const m = AreaIndex.meta.get(id);
  if (m) return m.centroid;
  const a = State.areas.get(id);
  return a ? polygonAreaCentroid(a.polygon) : { x: 0, y: 0 };
}

function areaSizeM2(areaOrId) {
  ensureAreaIndex();
  const id = typeof areaOrId === "string" ? areaOrId : areaOrId.id;
  const m = AreaIndex.meta.get(id);
  return m ? m.area : 0;
}

// Every area (either kind) whose polygon contains `p`.
function areasAtPoint(p) {
  ensureAreaIndex();
  if (!AreaIndex.buckets.size) return [];
  const c = Math.floor((p.x - AreaIndex.minX) / AreaIndex.cellSize);
  const r = Math.floor((p.y - AreaIndex.minY) / AreaIndex.cellSize);
  const bucket = AreaIndex.buckets.get(`${c}|${r}`);
  if (!bucket) return [];
  const out = [];
  for (const a of bucket) {
    const m = AreaIndex.meta.get(a.id);
    if (m && !bboxContainsPoint(m.bbox, p)) continue;
    if (pointInPolygon(p, a.polygon)) out.push(a);
  }
  return out;
}

// The jurisdiction chain at a point, coarse -> fine, one entry per level that
// actually has a polygon there (levels with no polygon are simply absent).
// Where two areas of the SAME level overlap, the smaller one wins - the finer
// drawing is the more specific answer.
function jurisdictionChainAtPoint(p) {
  const hits = areasAtPoint(p);
  const best = new Array(JURISDICTION_LEVELS.length).fill(null);
  for (const a of hits) {
    if (a.kind !== "jurisdiction") continue;
    const rank = JURISDICTION_RANK[a.level];
    if (rank == null) continue;
    const cur = best[rank];
    if (!cur || areaSizeM2(a) < areaSizeM2(cur)) best[rank] = a;
  }
  return best.filter(Boolean);
}

// The smallest land-use zone containing the point (zones may nest, e.g. a
// heritage pocket inside a commercial district - the tighter one is the
// answer that actually describes this spot).
function zoneAtPoint(p) {
  let best = null;
  for (const a of areasAtPoint(p)) {
    if (a.kind !== "zone") continue;
    if (!best || areaSizeM2(a) < areaSizeM2(best)) best = a;
  }
  return best;
}

// A building's own reference point for every containment question asked
// about it (which locality it is in, which zone, where its address sits).
// Cached because the shoelace centroid is recomputed otherwise on every
// frame the focus gate runs.
function buildingCentroid(b) {
  ensureAreaCaches();
  let c = AreaCache.buildingCentroid.get(b.id);
  if (c === undefined) {
    c = polygonAreaCentroid(b.polygon);
    AreaCache.buildingCentroid.set(b.id, c);
  }
  return c;
}

function jurisdictionChainOfBuilding(b) {
  ensureAreaCaches();
  let chain = AreaCache.buildingChain.get(b.id);
  if (chain === undefined) {
    chain = jurisdictionChainAtPoint(buildingCentroid(b));
    AreaCache.buildingChain.set(b.id, chain);
  }
  return chain;
}

// An area's own place in the hierarchy: its ancestors (derived purely from
// geometry, at its centroid) followed by itself. Nothing is stored - redraw a
// district inside a different city and its path follows, with no re-parenting
// step to remember.
function jurisdictionChainOfArea(area) {
  if (!area || area.kind !== "jurisdiction") return [];
  const rank = JURISDICTION_RANK[area.level];
  const chain = jurisdictionChainAtPoint(areaCentroid(area))
    .filter(a => JURISDICTION_RANK[a.level] < rank);
  chain.push(area);
  return chain;
}

function chainText(chain, opts = {}) {
  const sep = opts.sep || " › ";
  const names = chain.map(a => areaDisplayName(a));
  return (opts.fineFirst ? names.slice().reverse() : names).join(sep);
}

/* ---------------- Road segment index (nearest street lookup) ---------------- */

const RoadIndex = {
  built: -1,
  cellSize: 120,
  minX: 0, minY: 0,
  buckets: new Map(), // "c|r" -> [{ wayId, a:{x,y}, b:{x,y} }]
};

function roadDisplayName(way) {
  const t = way.tags || {};
  return t.name || t["addr:street"] || t.ref || "";
}

// Only NAMED roads go in - the index exists to answer "what street is this
// building on", and an unnamed service spur is never that answer.
function ensureRoadIndex() {
  ensureAreaCaches();
  if (RoadIndex.built === (State.dataVersion || 0)) return;
  RoadIndex.built = State.dataVersion || 0;
  RoadIndex.buckets = new Map();
  let world = null;
  const segs = [];
  for (const way of State.ways.values()) {
    if (!roadDisplayName(way)) continue;
    const pts = way.nodes.map(id => State.nodes.get(id)).filter(Boolean);
    for (let i = 1; i < pts.length; i++) {
      const seg = { wayId: way.id, a: { x: pts[i - 1].x, y: pts[i - 1].y }, b: { x: pts[i].x, y: pts[i].y } };
      segs.push(seg);
      const bb = {
        minX: Math.min(seg.a.x, seg.b.x), maxX: Math.max(seg.a.x, seg.b.x),
        minY: Math.min(seg.a.y, seg.b.y), maxY: Math.max(seg.a.y, seg.b.y),
      };
      world = bboxUnion(world, bb);
      seg.bb = bb;
    }
  }
  if (!segs.length) { RoadIndex.minX = 0; RoadIndex.minY = 0; return; }
  RoadIndex.minX = world.minX; RoadIndex.minY = world.minY;
  for (const seg of segs) {
    const c0 = Math.floor((seg.bb.minX - RoadIndex.minX) / RoadIndex.cellSize);
    const c1 = Math.floor((seg.bb.maxX - RoadIndex.minX) / RoadIndex.cellSize);
    const r0 = Math.floor((seg.bb.minY - RoadIndex.minY) / RoadIndex.cellSize);
    const r1 = Math.floor((seg.bb.maxY - RoadIndex.minY) / RoadIndex.cellSize);
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const key = `${c}|${r}`;
        let arr = RoadIndex.buckets.get(key);
        if (!arr) { arr = []; RoadIndex.buckets.set(key, arr); }
        arr.push(seg);
      }
    }
  }
}

const NEAREST_STREET_MAX_M = 150;

// Nearest named road to a world point, searching the segment grid in
// expanding rings so a building in a sparse area still finds its street
// without scanning all ~30k segments.
function nearestStreetAt(p, maxDist = NEAREST_STREET_MAX_M) {
  ensureRoadIndex();
  if (!RoadIndex.buckets.size) return null;
  const cs = RoadIndex.cellSize;
  const c0 = Math.floor((p.x - RoadIndex.minX) / cs);
  const r0 = Math.floor((p.y - RoadIndex.minY) / cs);
  const maxRing = Math.ceil(maxDist / cs);
  let best = null, bestD = maxDist;
  for (let ring = 0; ring <= maxRing; ring++) {
    // Once something has been found, one extra ring is still worth scanning:
    // a hit found in ring N can be beaten by a segment in ring N+1 that is
    // closer in straight-line distance.
    if (best && ring > Math.ceil((bestD / cs) + 1)) break;
    for (let c = c0 - ring; c <= c0 + ring; c++) {
      for (let r = r0 - ring; r <= r0 + ring; r++) {
        if (ring > 0 && Math.abs(c - c0) !== ring && Math.abs(r - r0) !== ring) continue;
        const bucket = RoadIndex.buckets.get(`${c}|${r}`);
        if (!bucket) continue;
        for (const seg of bucket) {
          const d = distPointToSegment(p, seg.a, seg.b);
          if (d < bestD) { bestD = d; best = seg; }
        }
      }
    }
  }
  if (!best) return null;
  const way = State.ways.get(best.wayId);
  if (!way) return null;
  return { wayId: best.wayId, name: roadDisplayName(way), dist: bestD };
}

function nearestStreetOfBuilding(b) {
  ensureAreaCaches();
  let hit = AreaCache.nearestStreet.get(b.id);
  if (hit === undefined) {
    hit = nearestStreetAt(buildingCentroid(b));
    AreaCache.nearestStreet.set(b.id, hit);
  }
  return hit;
}

/* ---------------- Addresses ---------------- */

// A building's full address, derived fresh from the area polygons every time
// (with the per-version cache above doing the actual work-saving).
//
// Precedence differs deliberately between the two halves of an address:
//   - the HIERARCHY levels (locality..country) come from the polygons
//     whenever one covers the building, and fall back to an existing addr:*
//     tag only where no area has been drawn at that level. Drawing an area IS
//     the act of saying what is inside it, so a stale imported tag must not
//     outvote the boundary you just drew - which also stops an OSM file whose
//     addr:district happens to hold the city name from producing
//     "Ghaziabad, Ghaziabad".
//   - the per-building facts (house number, street) come from the tags first,
//     since those are decisions about this one building that no polygon can
//     know; the street only falls back to the nearest named road.
function buildingAddress(b) {
  const chain = jurisdictionChainOfBuilding(b);
  const t = b.tags || {};
  const byLevel = {};
  for (const a of chain) byLevel[a.level] = areaDisplayName(a);

  const street = t["addr:street"] || (nearestStreetOfBuilding(b) || {}).name || "";
  const house = t["addr:housenumber"] || "";
  const addr = {
    house,
    street,
    locality: byLevel.locality || t["addr:suburb"] || "",
    district: byLevel.district || t["addr:district"] || "",
    city: byLevel.city || t["addr:city"] || "",
    state: byLevel.state || t["addr:state"] || "",
    country: byLevel.country || t["addr:country"] || "",
    postcode: t["addr:postcode"] || "",
    chain,
  };
  const line1 = [house, street].filter(Boolean).join(" ");
  // Adjacent duplicates are dropped: a district legitimately named after its
  // city should read "Kavi Nagar, Ghaziabad", not "Ghaziabad, Ghaziabad".
  const raw = [line1, addr.locality, addr.district, addr.city, addr.state, addr.country].filter(Boolean);
  addr.parts = raw.filter((p, i) => i === 0 || p.toLowerCase() !== raw[i - 1].toLowerCase());
  addr.text = addr.parts.join(", ") || "(no address - draw a locality over this building)";
  addr.short = line1 || (b.tags && b.tags.name) || "";
  return addr;
}

// Writes the derived address back onto the building as real addr:* tags.
// Used by the area inspector's bulk "Stamp addresses" action - the derived
// address already displays and searches without this, so stamping is only
// for exporting the map with addresses baked in.
//
// `overwrite` decides what happens to a tag that is already there and
// disagrees with the polygons (an imported addr:district naming the city,
// say): off, the existing tag is left alone even though the display ignores
// it; on, it is corrected to match the boundary it sits inside.
function stampBuildingAddress(b, { overwrite = false } = {}) {
  const addr = buildingAddress(b);
  let changed = false;
  const put = (k, v) => {
    if (!v) return;
    if (!overwrite && b.tags[k]) return;
    if (b.tags[k] === v) return;
    b.tags[k] = v; changed = true;
  };
  put("addr:street", addr.street);
  put("addr:suburb", addr.locality);
  put("addr:district", addr.district);
  put("addr:city", addr.city);
  put("addr:state", addr.state);
  put("addr:country", addr.country);
  return changed;
}

/* ---------------- Road span classification ---------------- */

// Which jurisdiction areas a road passes through, per level, plus the flat
// set of every area id it touches (used by the focus test). Sampled at the
// road's own nodes AND at each segment midpoint, so a long segment that cuts
// across a small area between two of its nodes is still counted.
function wayAreaFootprint(wayId) {
  ensureAreaCaches();
  let fp = AreaCache.wayAreas.get(wayId);
  if (fp) return fp;

  const way = State.ways.get(wayId);
  const byRank = JURISDICTION_LEVELS.map(() => new Set());
  const touched = new Set();
  if (!way) {
    fp = { byRank, touched, span: SPAN_LOCAL };
    AreaCache.wayAreas.set(wayId, fp);
    return fp;
  }

  const pts = [];
  const nodePts = way.nodes.map(id => State.nodes.get(id)).filter(Boolean);
  for (let i = 0; i < nodePts.length; i++) {
    pts.push(nodePts[i]);
    if (i + 1 < nodePts.length) {
      pts.push({ x: (nodePts[i].x + nodePts[i + 1].x) / 2, y: (nodePts[i].y + nodePts[i + 1].y) / 2 });
    }
  }

  for (const p of pts) {
    const chain = jurisdictionChainAtPoint(p);
    const seen = new Array(JURISDICTION_LEVELS.length).fill(false);
    for (const a of chain) {
      const rank = JURISDICTION_RANK[a.level];
      byRank[rank].add(a.id);
      seen[rank] = true;
      touched.add(a.id);
    }
    // A sample outside every polygon of a level is itself a distinct bucket:
    // a street running from inside a locality out into unmapped space HAS
    // left its locality, and must not read as purely local.
    for (let rank = 0; rank < seen.length; rank++) {
      if (!seen[rank]) byRank[rank].add("\u0000outside");
    }
  }

  // The coarsest level this road spans more than one area of. Levels nobody
  // has drawn a polygon for are skipped entirely (their only bucket is the
  // "outside" sentinel) so an unmapped country/state level never makes every
  // road look inter-country.
  let span = SPAN_LOCAL;
  for (let rank = 0; rank < byRank.length; rank++) {
    const set = byRank[rank];
    if (set.size <= 1) continue;
    if (set.size === 2 && set.has("\u0000outside") && !hasAnyAreaAtRank(rank)) continue;
    span = rank;
    break;
  }

  fp = { byRank, touched, span };
  AreaCache.wayAreas.set(wayId, fp);
  return fp;
}

function hasAnyAreaAtRank(rank) {
  const level = JURISDICTION_LEVELS[rank];
  for (const a of State.areas.values()) {
    if (a.kind === "jurisdiction" && a.level === level) return true;
  }
  return false;
}

function waySpan(wayId) {
  return wayAreaFootprint(wayId).span;
}

/* ============================================================
   FOCUS (level-of-detail "recategorise the map")
   ============================================================ */

// Focusing a set of same-level jurisdictions restricts what the map draws
// (and what can be clicked) to what matters at that level: whole roads that
// reach into any focused area and whose span class survives the LOD table,
// plus - only at the finer levels - the buildings and amenities inside.
// Nothing is unloaded from State; this is purely a visibility gate, so
// clearing the focus is instant and undo/save are untouched.
const AreaFocus = {
  active: false,
  level: null,        // the jurisdiction level every focused area shares
  rank: null,
  ids: new Set(),
  includeLocalRoads: false, // overrides LOD_SPAN_BY_LEVEL with SPAN_LOCAL
  showSubAreas: false,      // draw finer boundaries inside the focus too

  // Bumped on every change to what is focused. AreaView memoises its
  // per-feature answers against this (plus the data/area versions), which is
  // what keeps the gate a Map lookup per feature per frame instead of a
  // point-in-polygon sweep over 7000 buildings sixty times a second.
  generation: 0,

  set(ids, { includeLocalRoads = this.includeLocalRoads, showSubAreas = this.showSubAreas } = {}) {
    const areas = ids.map(id => State.areas.get(id)).filter(a => a && a.kind === "jurisdiction");
    if (!areas.length) { this.clear(); return false; }
    // A mixed-level selection has no single LOD answer - the coarsest level
    // present wins, which is the conservative reading ("show me at least as
    // much as the biggest thing I picked needs").
    let rank = Math.min(...areas.map(a => JURISDICTION_RANK[a.level]));
    this.active = true;
    this.rank = rank;
    this.level = JURISDICTION_LEVELS[rank];
    this.ids = new Set(areas.map(a => a.id));
    this.includeLocalRoads = includeLocalRoads;
    this.showSubAreas = showSubAreas;
    this.generation++;
    markDirty();
    return true;
  },

  clear(redraw = true) {
    this.active = false;
    this.level = null;
    this.rank = null;
    this.ids = new Set();
    this.generation++;
    if (redraw) markDirty();
  },

  spanLimit() {
    if (!this.active) return SPAN_LOCAL;
    if (this.includeLocalRoads) return SPAN_LOCAL;
    const v = LOD_SPAN_BY_LEVEL[this.level];
    return v == null ? SPAN_LOCAL : v;
  },

  // True when the road reaches into (any part of) the focused areas AND its
  // span class is detailed enough for this level. Whole-road granularity is
  // the point: a road that only clips a corner of a focused locality is drawn
  // in full, never trimmed to the bit inside the border.
  isWayVisible(wayId) {
    if (!this.active) return true;
    const fp = wayAreaFootprint(wayId);
    if (fp.span > this.spanLimit()) return false;
    for (const id of this.ids) if (fp.touched.has(id)) return true;
    // A road coarse enough to matter at this level (e.g. an inter-city
    // highway when two cities are focused) stays on the map even where it
    // runs between the focused areas rather than through them.
    return fp.span < this.rank;
  },

  isPointVisible(p, minRank) {
    if (!this.active) return true;
    if (this.rank < minRank) return false;
    const hits = areasAtPoint(p);
    for (const a of hits) if (this.ids.has(a.id)) return true;
    return false;
  },

  // Which area outlines are drawn while focused: the focused ones always,
  // their finer descendants only when "Show sub-areas" is on, and every
  // coarser/sibling boundary never (searching a city shows that city's
  // boundary and nothing else, as asked).
  isAreaVisible(area) {
    if (!this.active) return true;
    if (this.ids.has(area.id)) return true;
    if (!this.showSubAreas) return false;
    if (area.kind === "zone") return this.rank >= LOD_BUILDING_MIN_RANK;
    return JURISDICTION_RANK[area.level] > this.rank
      && jurisdictionChainOfArea(area).some(a => this.ids.has(a.id));
  },

  describe() {
    if (!this.active) return "";
    const n = this.ids.size;
    const label = (JURISDICTION_LABEL[this.level] || this.level).toLowerCase();
    // "1 city" / "2 cities" / "3 localities" - the only irregular plural in
    // the level list is the -y one.
    const plural = label.endsWith("y") ? `${label.slice(0, -1)}ies` : `${label}s`;
    return `${n} ${n === 1 ? label : plural}`;
  },
};

// The visibility gate map-core.js/redlight.js call while rendering and
// hit-testing. Kept as one small object on window so those files stay a no-op
// if areas.js is ever dropped from a page (same guard style as RouteTest and
// LiveSim).
//
// EVERY entry point here is called once per feature per frame (and again per
// feature during hit-testing), so each one is memoised against the focus
// generation plus the data/area versions - the uncached building test alone
// is a centroid, a grid lookup and a point-in-polygon, which at 7000
// buildings is ~20ms a frame. With the cache it is a Map hit, and any change
// to the focus or to the map invalidates the whole thing at once.
const AreaView = {
  _key: null,
  _way: new Map(),
  _node: new Map(),
  _building: new Map(),
  _amenity: new Map(),

  _ensure() {
    const key = `${AreaFocus.generation}|${currentStamp()}`;
    if (this._key === key) return;
    this._key = key;
    this._way = new Map();
    this._node = new Map();
    this._building = new Map();
    this._amenity = new Map();
  },

  isWayVisible(wayId) {
    if (!AreaFocus.active) return true;
    this._ensure();
    let v = this._way.get(wayId);
    if (v === undefined) { v = AreaFocus.isWayVisible(wayId); this._way.set(wayId, v); }
    return v;
  },

  isNodeVisible(nodeId) {
    if (!AreaFocus.active) return true;
    this._ensure();
    let v = this._node.get(nodeId);
    if (v !== undefined) return v;
    const ways = State.nodeWayIndex.get(nodeId);
    if (ways && ways.size) {
      v = false;
      for (const wid of ways) if (this.isWayVisible(wid)) { v = true; break; }
    } else {
      const n = State.nodes.get(nodeId);
      v = n ? AreaFocus.isPointVisible(n, 0) : false;
    }
    this._node.set(nodeId, v);
    return v;
  },

  isBuildingVisible(b) {
    if (!AreaFocus.active) return true;
    this._ensure();
    let v = this._building.get(b.id);
    if (v === undefined) {
      v = AreaFocus.isPointVisible(buildingCentroid(b), LOD_BUILDING_MIN_RANK);
      this._building.set(b.id, v);
    }
    return v;
  },

  isAmenityVisible(a) {
    if (!AreaFocus.active) return true;
    this._ensure();
    let v = this._amenity.get(a.id);
    if (v === undefined) {
      v = AreaFocus.isPointVisible(a, LOD_AMENITY_MIN_RANK);
      this._amenity.set(a.id, v);
    }
    return v;
  },
};
window.AreaView = AreaView;

/* ---------------- Focus statistics (for the panel readout) ---------------- */

function focusStats() {
  if (!AreaFocus.active) return null;
  let roads = 0, buildings = 0, amenities = 0;
  for (const wid of State.ways.keys()) if (AreaFocus.isWayVisible(wid)) roads++;
  for (const b of State.buildings.values()) if (AreaView.isBuildingVisible(b)) buildings++;
  for (const a of State.amenities.values()) if (AreaView.isAmenityVisible(a)) amenities++;
  return { roads, buildings, amenities };
}

/* ============================================================
   MUTATION (editor-only - see areaEditable)
   ============================================================ */

// Drawing an area polygon mirrors startBuildingDrawing/addBuildingVertex/
// finishBuildingDrawing in editor.js exactly (click points, Enter or
// double-click to close, Esc to cancel) - State.drawingArea carries the
// pending kind/level/zoneType so the finished polygon lands in the right
// layer without a second prompt.
function startAreaDrawing(kind, levelOrType) {
  State.drawingArea = {
    points: [],
    kind: kind === "zone" ? "zone" : "jurisdiction",
    level: kind === "jurisdiction" ? levelOrType : undefined,
    zoneType: kind === "zone" ? levelOrType : undefined,
  };
  State.ghostPoint = null;
  markDirty();
}

function addAreaVertex(world) {
  if (!State.drawingArea) return;
  State.drawingArea.points.push({ x: world.x, y: world.y });
  markDirty();
}

function cancelAreaDrawing() {
  if (!State.drawingArea) return;
  State.drawingArea = null;
  State.ghostPoint = null;
  markDirty();
}

function finishAreaDrawing() {
  const da = State.drawingArea;
  if (!da) return;
  // newId/pushUndo only exist on the editing page. Nothing on the read-only
  // page can start an area drawing in the first place, but this keeps the
  // guarantee local rather than depending on that being true elsewhere.
  if (!areaEditable()) { cancelAreaDrawing(); return; }
  if (da.points.length < 3) { cancelAreaDrawing(); return; }
  areaPushUndo();
  const id = newId(da.kind === "zone" ? "z" : "j");
  const area = {
    id,
    kind: da.kind,
    level: da.kind === "jurisdiction" ? da.level : undefined,
    zoneType: da.kind === "zone" ? da.zoneType : undefined,
    name: "",
    polygon: da.points.slice(),
    stations: [],
    tags: {},
  };
  State.areas.set(id, area);
  State.drawingArea = null;
  State.ghostPoint = null;
  areasInvalidate();
  if (typeof setTool === "function") setTool("select");
  setSelection([{ type: "area", id }]);
  areaSaved();
  markDirty();
  toast(`${areaTypeLabel(area)} created — name it in the inspector`);
  return id;
}

function deleteAreaSilent(id) {
  State.areas.delete(id);
  areasInvalidate();
  if (AreaFocus.ids.has(id)) {
    const rest = Array.from(AreaFocus.ids).filter(x => x !== id);
    if (rest.length) AreaFocus.set(rest); else AreaFocus.clear();
  }
}

function deleteArea(id) {
  const area = State.areas.get(id);
  if (!area) return;
  areaPushUndo();
  deleteAreaSilent(id);
  clearSelection();
  areaSaved();
  markDirty();
  toast(`${areaTypeLabel(area)} deleted`);
}

function setAreaName(area, name) {
  areaPushUndo();
  area.name = name;
  areasInvalidate();
  areaSaved();
}

function setAreaLevel(area, level) {
  if (JURISDICTION_RANK[level] == null) return;
  areaPushUndo();
  area.level = level;
  areasInvalidate();
  areaSaved();
  // A focus pinned to this area is now at a different level - re-derive it so
  // the LOD table matches what is actually selected rather than the old rank.
  if (AreaFocus.ids.has(area.id)) AreaFocus.set(Array.from(AreaFocus.ids));
}

function setAreaZoneType(area, zoneType) {
  areaPushUndo();
  area.zoneType = zoneType;
  areasInvalidate();
  areaSaved();
}

/* ---------------- Police station assignment ---------------- */

function isPoliceAmenity(a) {
  const t = (a.tags && a.tags.amenity) || "";
  return t === "police" || t === "fire_station";
}

function amenityDisplayName(a) {
  const t = a.tags || {};
  return t.name || t.designation || t.operator || `${t.amenity || "amenity"} · ${a.id}`;
}

// Every police/fire station whose point falls inside this jurisdiction -
// the candidate list the inspector offers, and what "Assign all inside"
// uses. A station OUTSIDE the area can still be assigned by hand (a
// neighbouring station covering a zone across the border is normal), which
// is why assignment is stored rather than derived.
function stationsInsideArea(area) {
  const out = [];
  for (const a of State.amenities.values()) {
    if (!isPoliceAmenity(a)) continue;
    if (pointInPolygon(a, area.polygon)) out.push(a);
  }
  return out;
}

function assignStationToArea(area, amenityId) {
  if (!area.stations) area.stations = [];
  if (area.stations.includes(amenityId)) return false;
  areaPushUndo();
  area.stations.push(amenityId);
  areaSaved();
  markDirty();
  return true;
}

function unassignStationFromArea(area, amenityId) {
  if (!area.stations) return false;
  const i = area.stations.indexOf(amenityId);
  if (i < 0) return false;
  areaPushUndo();
  area.stations.splice(i, 1);
  areaSaved();
  markDirty();
  return true;
}

// The reverse lookup, for the amenity inspector: which jurisdictions has this
// station been put in charge of.
function areasPolicedBy(amenityId) {
  const out = [];
  for (const a of State.areas.values()) {
    if (a.kind !== "jurisdiction") continue;
    if (a.stations && a.stations.includes(amenityId)) out.push(a);
  }
  return out;
}

// Which station actually covers a point: the assigned station of the FINEST
// jurisdiction containing it that has one at all, so a locality with its own
// outpost wins over the district station, and an unassigned locality still
// falls back to whoever polices its district/city.
function policingStationAt(p) {
  const chain = jurisdictionChainAtPoint(p);
  for (let i = chain.length - 1; i >= 0; i--) {
    const area = chain[i];
    for (const sid of (area.stations || [])) {
      const amenity = State.amenities.get(sid);
      if (amenity) return { area, amenity };
    }
  }
  return null;
}

/* ---------------- House numbering ---------------- */

function buildingsInsideArea(area) {
  const out = [];
  const bb = areaBBox(area);
  for (const b of State.buildings.values()) {
    const c = buildingCentroid(b);
    if (!bboxContainsPoint(bb, c)) continue;
    if (pointInPolygon(c, area.polygon)) out.push(b);
  }
  return out;
}

// Where along a road a point falls, and which side of it: `t` is the distance
// travelled from the road's first node to the projection (so sorting by it
// walks the street end to end), `side` is the sign of the cross product
// (+1/-1), which is what splits odd numbers from even ones.
function projectOntoWay(p, way) {
  const pts = way.nodes.map(id => State.nodes.get(id)).filter(Boolean);
  if (pts.length < 2) return null;
  let acc = 0, best = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const abx = b.x - a.x, aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    const segLen = Math.sqrt(lenSq);
    let t = lenSq > 1e-9 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + abx * t, cy = a.y + aby * t;
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (!best || d < best.d) {
      const cross = abx * (p.y - a.y) - aby * (p.x - a.x);
      best = { d, t: acc + t * segLen, side: cross >= 0 ? 1 : -1 };
    }
    acc += segLen;
  }
  return best;
}

// Assigns addr:housenumber (and addr:street) to every building inside the
// area, street by street: buildings are grouped by their nearest named road,
// ordered along that road, and numbered odd on one side / even on the other -
// the usual real-world convention, and the reason the numbers stay sensible
// when you later add a building between two existing ones (renumber to fix).
//
// `mode` is "all" (renumber everything) or "missing" (only fill in buildings
// that have no number yet).
function autoNumberHouses(area, { mode = "missing", start = 1 } = {}) {
  if (!areaEditable()) return { numbered: 0, streets: 0 };
  const buildings = buildingsInsideArea(area);
  if (!buildings.length) return { numbered: 0, streets: 0 };

  const byStreet = new Map(); // wayId -> [{ building, proj }]
  const noStreet = [];
  for (const b of buildings) {
    const hit = nearestStreetOfBuilding(b);
    if (!hit) { noStreet.push(b); continue; }
    const way = State.ways.get(hit.wayId);
    const proj = way ? projectOntoWay(buildingCentroid(b), way) : null;
    if (!proj) { noStreet.push(b); continue; }
    let arr = byStreet.get(hit.wayId);
    if (!arr) { arr = []; byStreet.set(hit.wayId, arr); }
    arr.push({ building: b, proj, streetName: hit.name });
  }
  if (!byStreet.size) return { numbered: 0, streets: 0, noStreet: noStreet.length };

  areaPushUndo();
  let numbered = 0;
  for (const [wayId, entries] of byStreet) {
    entries.sort((a, b) => a.proj.t - b.proj.t);
    let odd = start % 2 === 0 ? start + 1 : start;
    let even = start % 2 === 0 ? start : start + 1;
    for (const e of entries) {
      const tags = e.building.tags || (e.building.tags = {});
      const wantsNumber = mode === "all" || !tags["addr:housenumber"];
      const n = e.proj.side < 0 ? odd : even;
      if (e.proj.side < 0) odd += 2; else even += 2;
      if (!wantsNumber) continue;
      tags["addr:housenumber"] = String(n);
      if (e.streetName) tags["addr:street"] = e.streetName;
      numbered++;
    }
  }
  areasInvalidate();
  areaSaved();
  return { numbered, streets: byStreet.size, noStreet: noStreet.length };
}

// Bulk "write the derived hierarchy onto the buildings as real tags" for one
// area - see stampBuildingAddress.
function stampAddressesInArea(area, { overwrite = false } = {}) {
  if (!areaEditable()) return 0;
  const buildings = buildingsInsideArea(area);
  if (!buildings.length) return 0;
  areaPushUndo();
  let changed = 0;
  for (const b of buildings) if (stampBuildingAddress(b, { overwrite })) changed++;
  areasInvalidate();
  areaSaved();
  return changed;
}
