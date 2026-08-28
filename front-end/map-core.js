"use strict";

/* ============================================================
   Map Core (shared engine)
   Loaded by BOTH editor.html and simulation.html, in that role
   BEFORE settings.js/redlight.js/editor.js|simulation.js (plain
   global-scope scripts, no modules - load order is what makes
   this work). Owns the data model (State), loading map_data.json,
   the camera (pan/zoom/rotate), the whole rendering pipeline
   (roads, junctions, buildings, amenities, lane/arrow decorations,
   redlight rendering is in redlight.js), hit-testing, and the
   selection primitives (setSelection/isSelected/...).

   Everything MUTATION-related (add/delete/move/rotate/join/split,
   undo/redo, the tool system, the editing inspector, save/load) is
   editor.js-only and lives there instead - this file only ever
   READS State to render it or figure out what was clicked; the one
   exception is State.selected itself, which both a full editor
   click and a read-only simulation-page click need to update via
   the shared setSelection().
   ============================================================ */

const DATA_URL = "map_data.json";
const HIGHWAY_TYPES = [
  "motorway", "trunk", "primary", "secondary", "tertiary",
  "unclassified", "residential", "living_street", "service",
  "pedestrian", "footway", "cycleway", "track", "path", "steps",
  "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
];

const BUILDING_TYPES = [
  "yes", "residential", "house", "apartments", "commercial", "retail",
  "industrial", "warehouse", "office", "school", "university", "hospital",
  "clinic", "religious", "civic", "hotel", "church", "garage", "hut", "shed",
  "construction",
];

const AMENITY_TYPES = [
  "hospital", "clinic", "doctors", "pharmacy", "fire_station", "police",
  "school", "university", "college", "kindergarten", "library", "townhall",
  "community_centre", "place_of_worship", "restaurant", "cafe", "fast_food",
  "bank", "atm", "fuel", "parking", "marketplace", "post_office", "cinema",
  "theatre", "bus_station", "courthouse", "other",
];

const ROAD_STYLE = {
  motorway:        { color: "#ef476f", width: 5,   outline: "#4a4458" },
  trunk:           { color: "#f4845f", width: 4.6, outline: "#4a4458" },
  primary:         { color: "#f8961e", width: 4.2, outline: "#4a4458" },
  secondary:       { color: "#f9c74f", width: 3.6, outline: "#4a4458" },
  tertiary:        { color: "#fee08b", width: 3.2, outline: "#4a4458" },
  motorway_link:   { color: "#ef476f", width: 3,   outline: "#4a4458" },
  trunk_link:      { color: "#f4845f", width: 3,   outline: "#4a4458" },
  primary_link:    { color: "#f8961e", width: 3,   outline: "#4a4458" },
  secondary_link:  { color: "#f9c74f", width: 2.6, outline: "#4a4458" },
  tertiary_link:   { color: "#fee08b", width: 2.6, outline: "#4a4458" },
  unclassified:    { color: "#faf3e0", width: 2.6, outline: "#4a4458" },
  residential:     { color: "#faf3e0", width: 2.6, outline: "#4a4458" },
  living_street:   { color: "#ede0d4", width: 2.4, outline: "#4a4458" },
  service:         { color: "#f5ebe0", width: 1.6, outline: "#4a4458" },
  pedestrian:      { color: "#c9b2e6", width: 2, dash: [1, 4] },
  footway:         { color: "#90c2e7", width: 1.4, dash: [1, 5] },
  cycleway:        { color: "#4cc9f0", width: 1.4, dash: [4, 3] },
  track:           { color: "#b98a52", width: 1.6, dash: [6, 3] },
  path:            { color: "#8a9a5b", width: 1.3, dash: [1, 5] },
  steps:           { color: "#b06fc7", width: 1.6, dash: [2, 2] },
  default:         { color: "#d4cdc0", width: 1.8 },
};

/* ---------------- Buildings & amenities: types, styling, icons ---------------- */

// Curated quick-pick lists for the inspector's type dropdowns - the full tag
// is still freely editable via the generic tagEditor below them, these are
// just a convenient shortcut for the common values.
const BUILDING_STYLE_DEFAULT = { fill: "rgba(198, 176, 145, 0.55)", stroke: "#7a6a52" };

// Every amenity gets an icon, resolved (see resolveAmenityIcon) from its own
// tags.icon_image / tags.icon_emoji first - this is only the built-in
// fallback keyed by its `amenity` tag value.
const DEFAULT_AMENITY_ICONS = {
  hospital: "🏥", clinic: "🏥", doctors: "🏥", pharmacy: "💊",
  fire_station: "🚒", police: "🚓",
  school: "🏫", university: "🎓", college: "🎓", kindergarten: "🧸",
  library: "📚", townhall: "🏛️", community_centre: "🏘️",
  place_of_worship: "⛪", restaurant: "🍽️", cafe: "☕", fast_food: "🍔",
  bank: "🏦", atm: "🏧", fuel: "⛽", parking: "🅿️", marketplace: "🛒",
  post_office: "✉️", cinema: "🎬", theatre: "🎭", bus_station: "🚌",
  courthouse: "⚖️",
};
const DEFAULT_AMENITY_ICON_FALLBACK = "📍";

// Pre-fills a new fleet's vehicleType field when the amenity's own type
// suggests an obvious default - always freely editable afterwards, and any
// amenity can have a fleet regardless of its type (generic, not a whitelist).
function resolveAmenityIcon(tags) {
  if (tags && tags.icon_image) return { image: tags.icon_image };
  if (tags && tags.icon_emoji) return { emoji: tags.icon_emoji };
  const byType = tags && DEFAULT_AMENITY_ICONS[tags.amenity];
  return { emoji: byType || DEFAULT_AMENITY_ICON_FALLBACK };
}

// HTMLImageElement cache for uploaded icon images, keyed by their server path
// (e.g. "icons/xxxx.png") - images load asynchronously; markDirty() on load
// is what makes a freshly-uploaded icon appear on the very next frame once
// it's ready, without any polling (the render loop is already dirty-gated).
const IconImageCache = new Map();
function getIconImage(path) {
  let entry = IconImageCache.get(path);
  if (entry) return entry.loaded ? entry.img : null;
  const img = new Image();
  entry = { img, loaded: false };
  img.onload = () => { entry.loaded = true; markDirty(); };
  img.src = path;
  IconImageCache.set(path, entry);
  return null;
}

/* ---------------- State ---------------- */

const State = {
  meta: null,
  nodes: new Map(),   // id -> {x, y, tags}
  ways: new Map(),    // id -> {id, tags, nodes:[ids], curve}
  buildings: new Map(),  // id -> {id, tags, polygon:[{x,y},...]}
  amenities: new Map(),  // id -> {id, x, y, tags, fleets:[...], buildingId?}
  nodeWayIndex: new Map(), // nodeId -> Set(wayId)  (rebuilt after topology changes)
  redlightGroups: new Map(), // groupId -> { id, memberIds:[nodeId...], turnSec }
  nextIdCounter: 1,

  // External signal control (see redlight.js) - session-only, never saved to
  // map_data.json, never undoable. signalFreeze holds each frozen
  // intersection's (or turn-taking group's) own paused fixed-time clock;
  // externalOverrides mirrors the server-side registry in serve.py so any
  // Python/C++ script hitting POST /api/signal/override shows up here too.
  signalFreeze: new Map(),      // freezeKey ("n:"+nodeId or "g:"+groupId) -> {offset, frozenAt, refCount}
  externalOverrides: new Map(), // nodeId -> {wayId, controller, since}

  view: { scale: 1, cx: 0, cy: 0, rotation: 0 }, // scale = px per metre; (cx,cy) = world point at canvas centre; rotation in radians
  tool: "pan",
  selected: [], // [{type:'node'|'way', id}, ...] - index 0 is "primary" (rotate handle, single-item inspector)

  drawingWay: null, // { nodeIds: [...], curve: 'line'|'spline', createdNodeIds:Set }
  drawingBuilding: null, // { points: [{x,y}, ...] } - see startBuildingDrawing
  ghostPoint: null, // world point for live preview while drawing a road

  drag: null, // active drag/rotate operation, see startDrag()

  // Session-only UI toggle (never saved, never undoable): when true and
  // exactly one way is selected, dragging that road's body in the select
  // tool moves the whole road (see the "Move whole road" checkbox in
  // renderInspector) instead of the default reshape-by-adding-a-point
  // behaviour. Reset on every selection change (see setSelection) so it
  // never silently carries over onto a different road.
  roadMoveMode: false,

  // Gates the rotate-handle affordance render() draws for a single selected
  // way/joined-node-group - true on the editing page, set false by the
  // read-only simulation page's boot() so a click-to-inspect selection there
  // never shows a "you can rotate this" handle you actually can't grab (the
  // handle-grab logic itself only exists in editor.js's mousedown handler).
  showEditingHandles: true,

  undoStack: [],
  redoStack: [],
};

const SelectionFilters = {
  intersections: true,
  traffic_signals: true,
  motorway: true,
  trunk: true,
  primary: true,
  secondary: true,
  tertiary: true,
  unclassified: true,
  residential: true,
  living_street: true,
  service: true,
  pedestrian: true,
  footway: true,
  cycleway: true,
  track: true,
  path: true,
  steps: true,
  motorway_link: true,
  trunk_link: true,
  primary_link: true,
  secondary_link: true,
  tertiary_link: true,
  default: true,
  buildings: true,
  amenities: true,
  // Per-type keys are namespaced ("building:"/"amenity:" prefix) because
  // several building types (e.g. "residential") are also literal highway-type
  // keys already in this same object - a bare key would collide.
  ...Object.fromEntries(BUILDING_TYPES.map(t => [`building:${t}`, true])),
  ...Object.fromEntries(AMENITY_TYPES.map(t => [`amenity:${t}`, true])),
};

function isItemSelectable(type, id) {
  if (type === "node") {
    const node = State.nodes.get(id);
    if (!node) return false;
    const isSignal = (node.tags && node.tags.highway === "traffic_signals") || node.signal;
    if (isSignal) return SelectionFilters.traffic_signals;
    return SelectionFilters.intersections;
  } else if (type === "way") {
    const way = State.ways.get(id);
    if (!way) return false;
    const hw = (way.tags && way.tags.highway) || "default";
    return SelectionFilters[hw] !== false;
  } else if (type === "building") {
    const building = State.buildings.get(id);
    if (!building) return false;
    const btype = (building.tags && building.tags.building) || "yes";
    return SelectionFilters.buildings && SelectionFilters[`building:${btype}`] !== false;
  } else if (type === "amenity") {
    const amenity = State.amenities.get(id);
    if (!amenity) return false;
    const atype = (amenity.tags && amenity.tags.amenity) || "other";
    return SelectionFilters.amenities && SelectionFilters[`amenity:${atype}`] !== false;
  }
  return false;
}

function applySelectionFilters() {
  const next = State.selected.filter(s => isItemSelectable(s.type, s.id));
  if (next.length !== State.selected.length) {
    setSelection(next);
  }
}

function renderSelectionFilters() {
  const container = $("#selectionFiltersContainer");
  if (!container) return;
  container.innerHTML = "";

  function createFilterRow(label, key) {
    const chk = el("input", { type: "checkbox" });
    chk.checked = SelectionFilters[key];
    chk.addEventListener("change", () => {
      SelectionFilters[key] = chk.checked;
      applySelectionFilters();
    });
    return el("div", { class: "checkrow" }, chk, el("label", {}, label));
  }

  // Toggle All button
  const allBtn = el("button", {
    style: "margin-bottom: 6px; padding: 5px 8px; font-size: 11px; font-family: var(--font); font-weight: 600; border: 2px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; background: var(--panel-bg);",
    onclick: () => {
      const anyUnchecked = Object.values(SelectionFilters).some(v => !v);
      for (const k of Object.keys(SelectionFilters)) {
        SelectionFilters[k] = anyUnchecked;
      }
      renderSelectionFilters();
      applySelectionFilters();
    }
  }, "Toggle All");
  container.append(allBtn);

  container.append(createFilterRow("Intersections", "intersections"));
  container.append(createFilterRow("Traffic Lights", "traffic_signals"));
  container.append(createFilterRow("Buildings", "buildings"));
  container.append(createFilterRow("Amenities", "amenities"));

  container.append(el("hr", { style: "margin: 6px 0; border: none; border-top: 1.5px solid var(--border);" }));

  for (const hw of HIGHWAY_TYPES) {
    container.append(createFilterRow(`Road (${hw})`, hw));
  }

  container.append(el("hr", { style: "margin: 6px 0; border: none; border-top: 1.5px solid var(--border);" }));

  for (const t of BUILDING_TYPES) {
    container.append(createFilterRow(`Building (${t})`, `building:${t}`));
  }

  container.append(el("hr", { style: "margin: 6px 0; border: none; border-top: 1.5px solid var(--border);" }));

  for (const t of AMENITY_TYPES) {
    container.append(createFilterRow(`Amenity (${t})`, `amenity:${t}`));
  }
}

function isYes(v) {
  return typeof v === "string" && v.trim().toLowerCase() === "yes";
}

/* ---------------- Geometry helpers ---------------- */

function distPointToSegment(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq > 1e-9 ? (apx * abx + apy * aby) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + abx * t, cy = a.y + aby * t;
  const dx = p.x - cx, dy = p.y - cy;
  return Math.sqrt(dx * dx + dy * dy);
}

// Standard ray-casting point-in-polygon test (even-odd rule) - used to hit-test
// a building's footprint. `poly` is a plain [{x,y},...] ring (no repeated
// closing point, same convention as State.buildings' own polygon storage).
function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y))
      && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonBounds(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function polygonCentroid(poly) {
  let cx = 0, cy = 0;
  for (const p of poly) { cx += p.x; cy += p.y; }
  return { x: cx / poly.length, y: cy / poly.length };
}

/* ---------------- Data index ---------------- */

function rebuildIndex() {
  State.nodeWayIndex = new Map();
  for (const way of State.ways.values()) {
    for (const nid of way.nodes) {
      let set = State.nodeWayIndex.get(nid);
      if (!set) { set = new Set(); State.nodeWayIndex.set(nid, set); }
      set.add(way.id);
    }
  }
  State.joinGroupIndex = new Map();
  for (const [id, n] of State.nodes) {
    const g = n.tags && n.tags.join_group;
    if (!g) continue;
    let arr = State.joinGroupIndex.get(g);
    if (!arr) { arr = []; State.joinGroupIndex.set(g, arr); }
    arr.push(id);
  }
}

function nodeDegree(nodeId) {
  const set = State.nodeWayIndex.get(nodeId);
  return set ? set.size : 0;
}

// Every node explicitly joined with `nodeId` via "Join into one intersection"
// (see joinNodesIntoGroup), nodeId included - just [nodeId] when it isn't
// part of a group. Membership is a plain node tag (join_group) so it rides
// along with undo/redo and save/load for free; State.joinGroupIndex (built
// in rebuildIndex) is the fast lookup.
function junctionCluster(nodeId) {
  const n = State.nodes.get(nodeId);
  const g = n && n.tags && n.tags.join_group;
  if (!g) return [nodeId];
  const members = State.joinGroupIndex.get(g);
  return (members && members.length) ? members : [nodeId];
}

function clusterCentroid(members) {
  let cx = 0, cy = 0, count = 0;
  for (const id of members) {
    const n = State.nodes.get(id);
    if (!n) continue;
    cx += n.x; cy += n.y; count++;
  }
  return count ? { x: cx / count, y: cy / count } : { x: 0, y: 0 };
}

// The single node that represents a whole joined group for selection,
// display and signal purposes - a joined group of real intersections reads
// as ONE intersection (one marker, one traffic light governing every
// approach across every member), not N separate ones. Stable once a group
// has a traffic light (always the node actually carrying it, so an existing
// light is never orphaned by re-deriving a different primary later);
// otherwise the lowest node id, so repeated calls agree without needing any
// stored state. A non-grouped node is trivially its own primary.
function junctionPrimary(nodeId) {
  const members = junctionCluster(nodeId);
  if (members.length <= 1) return nodeId;
  for (const id of members) {
    const n = State.nodes.get(id);
    if (n && n.signal) return id;
  }
  return members.slice().sort()[0];
}

/* ---------------- Load / project ---------------- */

async function loadFromUrl(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const data = await res.json();
  loadData(data);
}

function loadData(data) {
  State.meta = data.meta || {};
  State.nodes = new Map();
  State.ways = new Map();
  State.buildings = new Map();
  State.amenities = new Map();

  for (const [id, n] of Object.entries(data.nodes || {})) {
    const node = { x: n.x, y: n.y, tags: n.tags ? { ...n.tags } : {} };
    if (n.signal) node.signal = JSON.parse(JSON.stringify(n.signal));
    State.nodes.set(id, node);
  }
  for (const w of (data.ways || [])) {
    State.ways.set(w.id, {
      id: w.id,
      tags: w.tags ? { ...w.tags } : {},
      nodes: w.nodes.slice(),
      curve: w.curve === "spline" ? "spline" : "line",
    });
  }
  for (const b of (data.buildings || [])) {
    State.buildings.set(b.id, {
      id: b.id,
      tags: b.tags ? { ...b.tags } : {},
      polygon: b.polygon.map(p => ({ x: p.x, y: p.y })),
    });
  }
  for (const a of (data.amenities || [])) {
    State.amenities.set(a.id, {
      id: a.id,
      x: a.x, y: a.y,
      tags: a.tags ? { ...a.tags } : {},
      fleets: a.fleets ? JSON.parse(JSON.stringify(a.fleets)) : [],
      buildingId: a.buildingId || undefined,
    });
  }
  State.nextIdCounter = data.meta && data.meta.nextIdCounter ? data.meta.nextIdCounter : 1;
  // A freshly-loaded map has all-new node ids, so any frozen clock/override
  // keyed on the previous map's ids is meaningless - drop them rather than
  // leaving orphaned entries around (a live external override just gets
  // re-applied on the next poll, against whatever node id it actually names).
  State.signalFreeze = new Map();
  State.externalOverrides = new Map();
  State.redlightGroups = new Map();
  for (const g of (data.redlightGroups || [])) {
    State.redlightGroups.set(g.id, {
      id: g.id, memberIds: g.memberIds.slice(), turnSec: g.turnSec,
      direction: g.direction === "ccw" ? "ccw" : "cw",
    });
  }
  backfillRoadDefaults();
  rebuildIndex();
  clearSelection();
  State.undoStack = [];
  State.redoStack = [];
  updateUndoButtons();
  fitView();
  updateStatusCounts();
  markDirty();
}

function backfillRoadDefaults() {
  for (const way of State.ways.values()) {
    const t = way.tags;
    if (t.maxspeed == null) t.maxspeed = String(Config.defaultMaxSpeed);
    if (t.avg_min_speed == null) t.avg_min_speed = String(Config.defaultAvgMinSpeed);
    if (t.avg_max_speed == null) t.avg_max_speed = String(Config.defaultAvgMaxSpeed);
    if (t.lanes == null) t.lanes = String(isYes(t.oneway) ? 1 : Config.defaultLanes);
    if (t.lane_width == null) t.lane_width = String(Config.defaultLaneWidth);
    if (t.divider == null) t.divider = (isYes(t.oneway) || parseInt(t.lanes, 10) < 2) ? "no" : "yes";
  }
}

function updateUndoButtons() {
  const undoBtn = $("#undoBtn"), redoBtn = $("#redoBtn");
  if (undoBtn) undoBtn.disabled = State.undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = State.redoStack.length === 0;
}

/* ---------------- Autosave ---------------- */

const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
let dpr = window.devicePixelRatio || 1;

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  canvas.style.width = rect.width + "px";
  canvas.style.height = rect.height + "px";
  markDirty();
}
window.addEventListener("resize", resizeCanvas);

function cssW() { return canvas.width / dpr; }
function cssH() { return canvas.height / dpr; }

function worldToScreen(x, y) {
  const dx = x - State.view.cx, dy = y - State.view.cy;
  const c = Math.cos(State.view.rotation), s = Math.sin(State.view.rotation);
  const rx = dx * c - dy * s;
  const ry = dx * s + dy * c;
  return {
    x: cssW() / 2 + rx * State.view.scale,
    y: cssH() / 2 - ry * State.view.scale,
  };
}
function screenToWorld(sx, sy) {
  const rx = (sx - cssW() / 2) / State.view.scale;
  const ry = -(sy - cssH() / 2) / State.view.scale;
  const c = Math.cos(State.view.rotation), s = Math.sin(State.view.rotation);
  const dx = rx * c + ry * s;
  const dy = -rx * s + ry * c;
  return { x: dx + State.view.cx, y: dy + State.view.cy };
}

function fitView() {
  if (!State.nodes.size) { State.view = { scale: 1, cx: 0, cy: 0, rotation: State.view.rotation }; markDirty(); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of State.nodes.values()) {
    if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
  }
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const pad = 1.08;
  const scaleX = cssW() / (w * pad);
  const scaleY = cssH() / (h * pad);
  State.view.scale = Math.min(scaleX, scaleY);
  State.view.cx = (minX + maxX) / 2;
  State.view.cy = (minY + maxY) / 2;
  updateZoomReadout();
  markDirty();
}

function zoomAt(sx, sy, factor) {
  const before = screenToWorld(sx, sy);
  State.view.scale = Math.min(4000, Math.max(0.02, State.view.scale * factor));
  const after = screenToWorld(sx, sy);
  State.view.cx += before.x - after.x;
  State.view.cy += before.y - after.y;
  updateZoomReadout();
  markDirty();
}

function updateZoomReadout() {
  // scale is px per metre; treat the initial fit as a rough 100% baseline reference of 1 px = ~1.5m
  $("#zoomReadout").textContent = Math.round(State.view.scale * 100) + "%";
}

function shouldShowIntersections() {
  return State.view.scale >= Config.intersectionZoomThreshold;
}

function setRotation(deg) {
  State.view.rotation = (deg * Math.PI) / 180;
  updateRotationReadout();
  markDirty();
}

function updateRotationReadout() {
  const deg = Math.round((State.view.rotation * 180) / Math.PI);
  $("#rotationReadout").textContent = deg + "°";
  $("#rotationSlider").value = deg;
}

/* ================================================================
   RENDERING
   ================================================================ */

let dirty = true;
function markDirty() { dirty = true; }

function wayStyle(tags) {
  const hw = tags && tags.highway;
  return ROAD_STYLE[hw] || ROAD_STYLE.default;
}

function wayPoints(way) {
  const pts = [];
  for (const nid of way.nodes) {
    const n = State.nodes.get(nid);
    if (n) pts.push(n);
  }
  return pts;
}

function tracePath(ctxRef, screenPts, curve) {
  ctxRef.beginPath();
  if (screenPts.length < 2) return;
  ctxRef.moveTo(screenPts[0].x, screenPts[0].y);
  if (curve === "spline" && screenPts.length >= 3) {
    const p = screenPts;
    const n = p.length;
    for (let i = 0; i < n - 1; i++) {
      const p0 = i === 0 ? p[0] : p[i - 1];
      const p1 = p[i];
      const p2 = p[i + 1];
      const p3 = i + 2 < n ? p[i + 2] : p2;
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      ctxRef.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
  } else {
    for (let i = 1; i < screenPts.length; i++) ctxRef.lineTo(screenPts[i].x, screenPts[i].y);
  }
}

// Per-vertex shape override for a road-shaping point (see
// insertShapingNodeOnWay): node.tags.vertex_type = "angle" forces a sharp
// corner there even in a `spline` way (which otherwise Catmull-Rom-smooths
// through every point); "curve" forces a smooth rounded corner there even in
// a `line` way (straight everywhere by default). An untagged vertex - the
// overwhelming majority, including every ordinary junction node - just
// follows the way's own whole-way `defaultCurve`, so this is a no-op unless
// a vertex is explicitly tagged. `nodeIds[i]` may be `null` for a point
// shortenPath interpolated at a junction clip (see shortenPath) rather than
// a real node - that always falls through to the way's own default too.
function vertexTreatment(defaultCurve, nodeIds, i) {
  const nid = nodeIds && nodeIds[i];
  const node = nid && State.nodes.get(nid);
  const tag = node && node.tags && node.tags.vertex_type;
  if (tag === "angle") return "sharp";
  if (tag === "curve") return "smooth";
  return defaultCurve === "spline" ? "smooth" : "sharp";
}

// Generalizes tracePath with per-vertex shape control (see vertexTreatment)
// instead of one whole-way curve setting - used by drawWayBase (the actual
// road rendering) and wayEvaluationPointsMixed (hit-testing), so what's
// drawn and what's clickable never disagree. Degenerates to exactly
// tracePath's own output when no vertex along the way overrides the way's
// own `defaultCurve`.
function traceMixedPath(ctxRef, screenPts, nodeIds, defaultCurve) {
  ctxRef.beginPath();
  const n = screenPts.length;
  if (n < 2) return;
  ctxRef.moveTo(screenPts[0].x, screenPts[0].y);
  if (n < 3) { ctxRef.lineTo(screenPts[1].x, screenPts[1].y); return; }

  const isSharp = (i) => i <= 0 || i >= n - 1 || vertexTreatment(defaultCurve, nodeIds, i) === "sharp";

  if (defaultCurve === "spline") {
    // Catmull-Rom through every point, exactly like tracePath - except a
    // 'sharp'-tagged vertex collapses its own control-point window to
    // itself, the same trick already used for the array's real endpoints,
    // flattening the tangent to a genuine corner there instead of blending
    // through it.
    for (let i = 0; i < n - 1; i++) {
      const p1 = screenPts[i], p2 = screenPts[i + 1];
      const p0 = isSharp(i) ? p1 : screenPts[i - 1];
      const p3 = isSharp(i + 1) ? p2 : screenPts[i + 2];
      ctxRef.bezierCurveTo(
        p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
        p2.x, p2.y);
    }
  } else {
    // Straight walk, exactly like tracePath - except a 'smooth'-tagged
    // vertex pulls back along both adjacent segments (capped at 40% of the
    // shorter one, so two adjacent rounded vertices sharing one segment can
    // never overshoot each other) and rounds through the original vertex as
    // a quadratic control point.
    for (let i = 1; i < n - 1; i++) {
      const prevPt = screenPts[i - 1], vertex = screenPts[i], nextPt = screenPts[i + 1];
      if (isSharp(i)) {
        ctxRef.lineTo(vertex.x, vertex.y);
      } else {
        const d1 = Math.hypot(vertex.x - prevPt.x, vertex.y - prevPt.y);
        const d2 = Math.hypot(nextPt.x - vertex.x, nextPt.y - vertex.y);
        const pull = Math.min(d1, d2) * 0.4;
        const t1 = d1 > 1e-6 ? pull / d1 : 0, t2 = d2 > 1e-6 ? pull / d2 : 0;
        const inX = vertex.x + (prevPt.x - vertex.x) * t1, inY = vertex.y + (prevPt.y - vertex.y) * t1;
        const outX = vertex.x + (nextPt.x - vertex.x) * t2, outY = vertex.y + (nextPt.y - vertex.y) * t2;
        ctxRef.lineTo(inX, inY);
        ctxRef.quadraticCurveTo(vertex.x, vertex.y, outX, outY);
      }
    }
    ctxRef.lineTo(screenPts[n - 1].x, screenPts[n - 1].y);
  }
}

function drawGrid() {
  const targetPx = 90;
  const niceSteps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  let step = niceSteps.find(s => s * State.view.scale >= targetPx) || 5000;

  // world-space bounding box of the visible viewport - computed from all 4
  // screen corners (not just top-left/bottom-right) so this stays correct
  // once the view can be rotated.
  const corners = [screenToWorld(0, 0), screenToWorld(cssW(), 0), screenToWorld(0, cssH()), screenToWorld(cssW(), cssH())];
  const minX = Math.min(...corners.map(c => c.x)), maxX = Math.max(...corners.map(c => c.x));
  const minY = Math.min(...corners.map(c => c.y)), maxY = Math.max(...corners.map(c => c.y));

  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,0.05)";
  ctx.lineWidth = 1;
  const startX = Math.floor(minX / step) * step;
  for (let x = startX; x <= maxX; x += step) {
    const a = worldToScreen(x, minY), b = worldToScreen(x, maxY);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  const startY = Math.floor(minY / step) * step;
  for (let y = startY; y <= maxY; y += step) {
    const a = worldToScreen(minX, y), b = worldToScreen(maxX, y);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();

  // scale bar
  ctx.save();
  const barPx = step * State.view.scale;
  const bx = 14, by = cssH() - 14;
  ctx.strokeStyle = "#3d3846"; ctx.fillStyle = "#3d3846"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bx + barPx, by - 4); ctx.lineTo(bx + barPx, by + 4); ctx.stroke();
  ctx.font = "11px 'Space Grotesk', sans-serif";
  ctx.fillText((step >= 1000 ? (step / 1000) + " km" : step + " m"), bx, by - 8);
  ctx.restore();
}

/* ---------------- Buildings & amenities rendering (zoom-tiered + viewport-culled) ---------------- */

// Local to this new layer only - deliberately NOT wired into the existing
// road/junction rendering above, to avoid touching that already-tuned code.
function visibleWorldBounds() {
  const corners = [screenToWorld(0, 0), screenToWorld(cssW(), 0), screenToWorld(0, cssH()), screenToWorld(cssW(), cssH())];
  return {
    minX: Math.min(...corners.map(c => c.x)), maxX: Math.max(...corners.map(c => c.x)),
    minY: Math.min(...corners.map(c => c.y)), maxY: Math.max(...corners.map(c => c.y)),
  };
}

function rectsOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

// Below Config.buildingZoomThreshold, buildings aren't drawn (or hit-tested -
// see findBuildingAt) at all - at that zoom they'd be sub-pixel clutter over
// what's meant to read as a road-network overview. Above it, each polygon is
// still viewport-culled against the visible world rect before its (fill+
// stroke) draw calls, computed fresh every frame rather than cached, since a
// building's own vertex count is small and this avoids any cache-invalidation
// bookkeeping when one is moved.
function drawBuildings() {
  if (!Config.showBuildings || State.view.scale < Config.buildingZoomThreshold || !State.buildings.size) return;
  const vis = visibleWorldBounds();
  for (const b of State.buildings.values()) {
    const poly = b.polygon;
    if (poly.length < 3) continue;
    if (!rectsOverlap(polygonBounds(poly), vis)) continue;

    const isSel = isSelected("building", b.id);
    ctx.beginPath();
    const p0 = worldToScreen(poly[0].x, poly[0].y);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < poly.length; i++) {
      const p = worldToScreen(poly[i].x, poly[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fillStyle = isSel ? "rgba(67, 97, 238, 0.35)" : BUILDING_STYLE_DEFAULT.fill;
    ctx.fill();
    ctx.lineWidth = isSel ? 2.4 : 1.2;
    ctx.strokeStyle = isSel ? "#4361ee" : BUILDING_STYLE_DEFAULT.stroke;
    ctx.stroke();
  }
}

// Same zoom-gate + viewport-cull idea as drawBuildings, for point amenities -
// below Config.amenityZoomThreshold their icons aren't drawn/hit-tested
// either. Icon size is clamped between a min/max px (same idea as
// redlight.js's LAMP_MIN_RADIUS_PX/LAMP_MAX_RADIUS_PX) so it never shrinks to
// invisible or balloons absurdly as the view zooms.
function drawAmenities() {
  if (!Config.showAmenities || State.view.scale < Config.amenityZoomThreshold || !State.amenities.size) return;
  const vis = visibleWorldBounds();
  const sizePx = Math.max(10, Math.min(34, 16 * (Config.iconSizeMultiplier || 1)));
  for (const a of State.amenities.values()) {
    if (a.x < vis.minX || a.x > vis.maxX || a.y < vis.minY || a.y > vis.maxY) continue;
    const sp = worldToScreen(a.x, a.y);
    const isSel = isSelected("amenity", a.id);
    const icon = resolveAmenityIcon(a.tags);

    ctx.save();
    if (isSel) {
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sizePx * 0.72, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(67, 97, 238, 0.28)";
      ctx.fill();
    }
    const img = icon.image ? getIconImage(icon.image) : null;
    if (img) {
      ctx.drawImage(img, sp.x - sizePx / 2, sp.y - sizePx / 2, sizePx, sizePx);
    } else {
      ctx.font = `${sizePx}px 'Space Grotesk', sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(icon.emoji || DEFAULT_AMENITY_ICON_FALLBACK, sp.x, sp.y);
    }
    ctx.restore();
  }
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW(), cssH());
  ctx.fillStyle = "#f5f0e8";
  ctx.fillRect(0, 0, cssW(), cssH());

  clearJunctionCache();
  drawGrid();
  drawBuildings();

  const showAllVertices = State.view.scale > 6;
  const showIntersections = shouldShowIntersections();

  // draw non-bridge ways first, bridges on top
  const normal = [];
  const bridges = [];
  for (const w of State.ways.values()) (w.tags && isYes(w.tags.bridge) ? bridges : normal).push(w);

  // Narrowest-first within each group, so a wider road's opaque surface
  // paints over a narrower one wherever they meet - a shared junction node
  // or a raw crossing with no shared node alike - instead of whichever way
  // happens to come later in the data just covering the other regardless of
  // size. This is what makes a minor road look like it "opens into" a major
  // one rather than the two surfaces overlapping.
  const byWidthAsc = (a, b) => wayDrawWidth(a, wayStyle(a.tags)) - wayDrawWidth(b, wayStyle(b.tags));
  normal.sort(byWidthAsc);
  bridges.sort(byWidthAsc);

  // Each layer's base strokes, junction fills, decorations AND borders are
  // painted as one complete group before the next layer starts, so a higher
  // layer (e.g. a bridge) fully paints over everything from a lower layer,
  // including its junction fills. Doing the fills together with their own
  // layer's strokes (rather than batching all bases first, then all fills)
  // matters here: a flyover that happens to share a node with the street it
  // crosses (rather than passing over with no connection at all) must still
  // render as a continuous deck over an open ground junction, not have the
  // ground layer's fill drawn on top of the bridge afterwards.
  //
  // Decorations (lane dashes, the centre divider) are drawn AFTER the
  // junction fill/merge wedge, not before - otherwise the fill, which
  // legitimately paints over part of a road's own last metre or two near a
  // junction (see buildGates' setback), also paints over the tail end of
  // that road's divider line, making it look like the divider just vanishes
  // right before the junction instead of continuing cleanly into the open
  // area it's now part of. The curb/wall stroke is drawn last so it reads
  // above the divider it flanks.
  const drawnNormal = normal.map(way => [way, drawWayBase(way, false)]);
  drawJunctionShapes(L => L === 0, 'fill');
  for (const [way, drawn] of drawnNormal) drawWayDecorations(way, drawn);
  drawJunctionShapes(L => L === 0, 'stroke');

  const drawnBridges = bridges.map(way => [way, drawWayBase(way, true)]);
  drawJunctionShapes(L => L !== 0, 'fill');
  for (const [way, drawn] of drawnBridges) drawWayDecorations(way, drawn);
  drawJunctionShapes(L => L !== 0, 'stroke');

  // live preview of the road currently being drawn
  if (State.drawingWay && State.drawingWay.nodeIds.length) {
    const pts = State.drawingWay.nodeIds.map(id => State.nodes.get(id)).filter(Boolean);
    const screenPts = pts.map(p => worldToScreen(p.x, p.y));
    if (State.ghostPoint) screenPts.push(worldToScreen(State.ghostPoint.x, State.ghostPoint.y));
    ctx.save();
    ctx.strokeStyle = "#4361ee";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 2;
    tracePath(ctx, screenPts, State.drawingWay.curve);
    ctx.stroke();
    ctx.restore();
    for (const sp of screenPts.slice(0, -1)) {
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#4361ee"; ctx.fill();
    }
  }

  // live preview of the building polygon currently being drawn (see
  // startBuildingDrawing/addBuildingVertex) - same dashed-outline treatment
  // as the road preview above, closed with a line back to the first point
  // once there are enough points to read as a shape.
  if (State.drawingBuilding && State.drawingBuilding.points.length) {
    const screenPts = State.drawingBuilding.points.map(p => worldToScreen(p.x, p.y));
    if (State.ghostPoint) screenPts.push(worldToScreen(State.ghostPoint.x, State.ghostPoint.y));
    ctx.save();
    ctx.strokeStyle = "#2a9d8f";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(screenPts[0].x, screenPts[0].y);
    for (let i = 1; i < screenPts.length; i++) ctx.lineTo(screenPts[i].x, screenPts[i].y);
    if (screenPts.length >= 3) ctx.closePath();
    ctx.stroke();
    ctx.restore();
    for (const sp of screenPts.slice(0, State.ghostPoint ? -1 : undefined)) {
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#2a9d8f"; ctx.fill();
    }
  }

  // nodes - a joined group (see joinNodesIntoGroup) reads as ONE
  // intersection: only its primary member gets a marker, drawn at the
  // group's centroid rather than the primary's own point, so a join of
  // several real intersections shows one single central marker instead of
  // preserving every original point.
  const drawnGroups = new Set();
  for (const [id, n] of State.nodes) {
    const rawTags = n.tags || {};
    const groupId = rawTags.join_group;
    if (groupId) {
      if (drawnGroups.has(groupId)) continue;
      drawnGroups.add(groupId);
    }
    const primaryId = groupId ? junctionPrimary(id) : id;
    const primaryNode = groupId ? State.nodes.get(primaryId) : n;
    if (!primaryNode) continue;
    const deg = groupId ? 3 : nodeDegree(id); // a joined group is always treated as a real multi-road junction
    const tags = primaryNode.tags || {};
    const isSignal = tags.highway === "traffic_signals";
    const vType = tags.vertex_type;
    const isSpecial = isSignal || tags.highway === "crossing" || tags.highway === "stop" || tags.highway === "mini_roundabout"
      || vType === "angle" || vType === "curve";
    // "intersection markers" = anything that would otherwise always be drawn
    // regardless of vertex-zoom (deg>=2 junctions, signals/crossings/stops) -
    // gated behind the zoom threshold (Config.intersectionZoomThreshold,
    // default 75%); a plain deg<2 vertex still only shows up via
    // showAllVertices, unaffected by this threshold. The colored
    // per-approach lamps drawn by drawRedlights() are a separate layer and
    // are NOT gated here - they keep shrinking toward their own minimum
    // size instead of disappearing.
    const isIntersection = deg >= 2 || isSpecial;
    if (isIntersection && !showIntersections) continue;
    if (deg < 2 && !isSpecial && !showAllVertices) continue;

    const markerPos = groupId ? clusterCentroid(State.joinGroupIndex.get(groupId) || [id]) : n;
    const sp = worldToScreen(markerPos.x, markerPos.y);
    if (sp.x < -20 || sp.x > cssW() + 20 || sp.y < -20 || sp.y > cssH() + 20) continue;

    const isSel = isSelected("node", primaryId);

    // Road-shaping points (see insertShapingNodeOnWay) get their own
    // distinct glyphs - a diamond for a sharp Angle Point, a hollow ring for
    // a smooth Curve Point - so they read as something new rather than
    // blending into the generic signal/crossing dot styling below.
    if (vType === "angle" || vType === "curve") {
      const size = isSel ? 6.2 : 4.6;
      ctx.save();
      ctx.fillStyle = isSel ? "#4361ee" : (vType === "angle" ? "#7b5ea7" : "#2a9d8f");
      ctx.strokeStyle = "#1a1a2e";
      ctx.lineWidth = isSel ? 2 : 1;
      if (vType === "angle") {
        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y - size);
        ctx.lineTo(sp.x + size, sp.y);
        ctx.lineTo(sp.x, sp.y + size);
        ctx.lineTo(sp.x - size, sp.y);
        ctx.closePath();
      } else {
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, size * 0.68, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      continue;
    }

    let r = deg >= 2 ? 3.4 : 2.2;
    let fill = "#8a7e72";
    if (isSignal) { fill = "#ef476f"; r = 4.2; }
    else if (isSpecial) { fill = "#f8961e"; r = 3.6; }
    else if (deg >= 3) { fill = "#3d3846"; }

    ctx.beginPath();
    ctx.arc(sp.x, sp.y, isSel ? r + 2.2 : r, 0, Math.PI * 2);
    ctx.fillStyle = isSel ? "#4361ee" : fill;
    ctx.fill();
    if (isSel) { ctx.lineWidth = 2; ctx.strokeStyle = "#1a1a2e"; ctx.stroke(); }
  }

  drawAmenities();
  drawRedlights();

  // selection extras: rotate handle for a single selected way, or for a
  // single selected node that's the primary of a joined intersection group -
  // gated behind State.showEditingHandles (see its own comment on State) so
  // the read-only simulation page never shows a handle nothing can grab.
  const primary = primarySelection();
  if (State.showEditingHandles && State.selected.length === 1 && primary.type === "way") {
    const way = State.ways.get(primary.id);
    if (way) drawRotateHandle(way);
  } else if (State.showEditingHandles && State.selected.length === 1 && primary.type === "node") {
    const n = State.nodes.get(primary.id);
    const groupId = n && n.tags && n.tags.join_group;
    const members = groupId ? State.joinGroupIndex.get(groupId) : null;
    if (members && members.length > 1) drawClusterRotateHandle(members);
  }

  if (State.drag && State.drag.type === "rubberband") drawRubberBand(State.drag);
  if (State.drag && State.drag.type === "drawCircle") drawCirclePreview(State.drag);

  // Routing overlay (routetest.js) - guarded so map-core.js stays a no-op if
  // that script is ever removed from a page.
  if (window.RouteTest && window.RouteTest.draw) window.RouteTest.draw();

  updateStatusSelection();
}

function drawRubberBand(drag) {
  const x0 = Math.min(drag.startScreen.x, drag.curScreen.x);
  const y0 = Math.min(drag.startScreen.y, drag.curScreen.y);
  const w = Math.abs(drag.curScreen.x - drag.startScreen.x);
  const h = Math.abs(drag.curScreen.y - drag.startScreen.y);
  ctx.save();
  ctx.fillStyle = "rgba(67,97,238,0.12)";
  ctx.strokeStyle = "#4361ee";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeRect(x0, y0, w, h);
  ctx.restore();
}

// A way's real physical width in world metres (lanes * lane width) - unlike
// wayDrawWidth() this has no schematic minimum and no on-screen pixel cap, so
// it's a fixed, zoom-independent distance. This is what junction clearance,
// stop lines and signal lamps are positioned from, so they stay put in world
// space (only their on-screen size changes with zoom) instead of drifting
// relative to the road as you zoom, which is what a scale-derived offset
// (dividing a pixel value back down by the *current* zoom) would do.
function wayPhysicalWidth(way) {
  const lanes = parseInt(way.tags && way.tags.lanes, 10) || 1;
  const laneWidth = parseFloat(way.tags && way.tags.lane_width) || Config.defaultLaneWidth;
  return lanes * laneWidth;
}

// A way's effective vertical layer - explicit tags.layer if set, otherwise 1
// for a bridge/flyover (matching the Flyover checkbox, which force-sets
// layer:"1") or 0 for ordinary ground-level roads. Roads on different layers
// that happen to share a node (e.g. a flyover mapped with a node in common
// with the street it crosses, rather than passing over with no connection)
// must NOT be treated as one at-grade junction - see waysAtNodeByLayer().
function wayLayer(way) {
  const raw = way.tags && way.tags.layer;
  if (raw != null && raw !== "") {
    const L = parseInt(raw, 10);
    if (Number.isFinite(L)) return L;
  }
  return (way.tags && isYes(way.tags.bridge)) ? 1 : 0;
}

// Groups the ways touching a node by their effective layer. Junction
// clearance/blending only ever considers ways within the SAME group - a
// ground road and an overhead flyover that happen to share a node don't
// form a real at-grade intersection, so each keeps drawing straight through
// rather than the two being carved up together (which otherwise looks like
// the flyover deck pinching in at every street it crosses).
function waysAtNodeByLayer(nodeId) {
  const wayIds = State.nodeWayIndex.get(nodeId);
  const byLayer = new Map();
  if (!wayIds) return byLayer;
  for (const wid of wayIds) {
    const way = State.ways.get(wid);
    if (!way) continue;
    const L = wayLayer(way);
    let arr = byLayer.get(L);
    if (!arr) { arr = []; byLayer.set(L, arr); }
    arr.push(way);
  }
  return byLayer;
}

// Compute the clearance distance (in world metres) at a node where `forWay`
// should stop drawing. This is a thin wrapper around the junction fill
// pipeline (see computeJunctionData below) so the road body
// (shortenPath), the stop line (drawStopLine) and the junction gate polygon
// all agree on exactly the same distance for a given node/way in a given
// frame - no separate formula here means no seam is possible between them.
// `forWay` may have up to 2 legs at this node (a through-way threading past
// it) with different neighbour lengths; the smaller of their length-capped
// setbacks is used, which is always safe (never clips past either leg's own
// short end) even if very slightly conservative in that rare case.
function junctionClearance(nodeId, forWay) {
  const data = getJunctionData(nodeId, wayLayer(forWay));
  if (!data) return 0;
  let minCap = null;
  for (const leg of data.legs) {
    if (leg.way !== forWay) continue;
    if (leg.homeNodeId !== nodeId) continue; // belongs to a different member of a joined cluster
    const cap = Math.min(data.radius, JUNCTION_LEG_CAP_FRACTION * leg.legLen);
    if (minCap === null || cap < minCap) minCap = cap;
  }
  return minCap === null ? 0 : minCap;
}

// Walks and clips a sub-path from both ends based on the clearance of its
// start and end nodes, returning the shortened world points list. The
// returned array also carries a `.nodeIds` property - `nodeIds`, trimmed by
// the exact same splice/interpolate operations as the points themselves
// (an interpolated cut-point gets `null`, since it no longer sits exactly on
// a real node) - so a caller can still tell which surviving point is which
// real node after clipping, e.g. to look up a per-vertex tag (see
// traceMixedPath / vertex_type).
function shortenPath(way, nodeIds, worldPts) {
  if (worldPts.length < 2) {
    const out = worldPts.map(p => ({ x: p.x, y: p.y }));
    out.nodeIds = nodeIds.slice();
    return out;
  }
  const out = worldPts.map(p => ({ x: p.x, y: p.y }));
  let outIds = nodeIds.slice();

  const startId = nodeIds[0];
  const endId = nodeIds[nodeIds.length - 1];

  const startClearance = junctionClearance(startId, way);
  const endClearance = junctionClearance(endId, way);

  if (startClearance === 0 && endClearance === 0) { out.nodeIds = outIds; return out; }

  // Total length of the path in world units
  let totalLen = 0;
  const segLens = [];
  for (let i = 0; i < out.length - 1; i++) {
    const d = Math.hypot(out[i+1].x - out[i].x, out[i+1].y - out[i].y);
    segLens.push(d);
    totalLen += d;
  }

  if (totalLen <= startClearance + endClearance) {
    // Path is too short to survive shortening
    const empty = []; empty.nodeIds = []; return empty;
  }

  // Shorten from start
  if (startClearance > 0) {
    let remaining = startClearance;
    for (let i = 0; i < out.length - 1; i++) {
      const segLen = segLens[i];
      if (remaining <= segLen) {
        const t = remaining / segLen;
        out[i] = {
          x: out[i].x + (out[i+1].x - out[i].x) * t,
          y: out[i].y + (out[i+1].y - out[i].y) * t
        };
        outIds[i] = null;
        out.splice(0, i);
        outIds.splice(0, i);
        break;
      } else {
        remaining -= segLen;
      }
    }
  }

  // Shorten from end
  if (endClearance > 0) {
    let newSegLens = [];
    for (let i = 0; i < out.length - 1; i++) {
      newSegLens.push(Math.hypot(out[i+1].x - out[i].x, out[i+1].y - out[i].y));
    }

    let remaining = endClearance;
    for (let i = out.length - 1; i > 0; i--) {
      const segLen = newSegLens[i-1];
      if (remaining <= segLen) {
        const t = remaining / segLen;
        out[i] = {
          x: out[i].x + (out[i-1].x - out[i].x) * t,
          y: out[i].y + (out[i-1].y - out[i].y) * t
        };
        outIds[i] = null;
        out.splice(i + 1);
        outIds.splice(i + 1);
        break;
      } else {
        remaining -= segLen;
      }
    }
  }

  out.nodeIds = outIds;
  return out;
}

// Drawing a way is split into a "base" pass (outline + fill, the road
// surface itself) and a "decorations" pass (lane markings + one-way arrows,
// drawn on top).
function drawWayBase(way, isBridge) {
  const pts = wayPoints(way);
  if (pts.length < 2) return null;

  // Split the way into sub-paths at any junction node (degree >= 2)
  const subPaths = [];
  let currentSubNodes = [way.nodes[0]];
  let currentSubPts = [pts[0]];
  
  for (let i = 1; i < way.nodes.length; i++) {
    const nid = way.nodes[i];
    currentSubNodes.push(nid);
    currentSubPts.push(pts[i]);
    
    if (nodeDegree(nid) >= 2 && i < way.nodes.length - 1) {
      subPaths.push({ nodes: currentSubNodes, pts: currentSubPts });
      currentSubNodes = [nid];
      currentSubPts = [pts[i]];
    }
  }
  subPaths.push({ nodes: currentSubNodes, pts: currentSubPts });

  const style = wayStyle(way.tags);
  const isSel = isSelected("way", way.id);
  const width = wayDrawWidth(way, style);
  
  const drawnSubPaths = [];

  ctx.save();
  for (const sub of subPaths) {
    const clippedPts = shortenPath(way, sub.nodes, sub.pts);
    if (clippedPts.length < 2) continue;
    const screenPts = clippedPts.map(p => worldToScreen(p.x, p.y));
    const screenNodeIds = clippedPts.nodeIds;
    drawnSubPaths.push({ screenPts, clippedPts });

    drawnSubPaths[drawnSubPaths.length - 1].startNodeId = sub.nodes[0];
    drawnSubPaths[drawnSubPaths.length - 1].endNodeId = sub.nodes[sub.nodes.length - 1];

    if (isBridge) {
      ctx.strokeStyle = "#4a4458";
      ctx.lineWidth = width + 3.2;
      ctx.lineCap = "butt"; ctx.lineJoin = "round";
      ctx.setLineDash([]);
      traceMixedPath(ctx, screenPts, screenNodeIds, way.curve);
      ctx.stroke();
    } else if (style.outline) {
      ctx.strokeStyle = style.outline;
      ctx.lineWidth = width + 1.6;
      ctx.lineCap = "butt"; ctx.lineJoin = "round";
      ctx.setLineDash([]);
      traceMixedPath(ctx, screenPts, screenNodeIds, way.curve);
      ctx.stroke();
    }

    ctx.strokeStyle = isSel ? "#4361ee" : style.color;
    ctx.lineWidth = isSel ? width + 1.4 : width;
    ctx.lineCap = "butt"; ctx.lineJoin = "round";
    ctx.setLineDash(style.dash || []);
    traceMixedPath(ctx, screenPts, screenNodeIds, way.curve);
    ctx.stroke();

    if (isBridge) {
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      traceMixedPath(ctx, screenPts, screenNodeIds, way.curve);
      ctx.stroke();
    }
  }
  ctx.restore();

  return { subPaths: drawnSubPaths, style, width };
}

function drawWayDecorations(way, drawn) {
  if (!drawn || !drawn.subPaths) return;
  for (const sub of drawn.subPaths) {
    drawLaneDecorations(way, sub.screenPts, drawn.width, sub.startNodeId, sub.endNodeId);
    if (Config.showDirectionArrows && isYes(way.tags.oneway)) {
      drawArrowsAlongPath(sub.screenPts);
    }
  }
}

// ---------------------------------------------------------------------
// Junction fill: paint-style border-vertex sweep
//
// Every road ending at a node - or, once 2+ real intersections have been
// explicitly joined into one group (see joinNodesIntoGroup/junctionCluster),
// every road ending at any of its members - contributes one "leg". Each
// leg's own two kerb corners sit at a shared setback distance from its own
// home point, offset half its physical width to either side (see
// legCorners). The fill is then built exactly the way a painter would trace
// it around the junction: sort every leg's pair of corners by angle around
// the group's own centre and walk them in that order, connecting each
// corner straight to the very next one - the right-hand corner of whichever
// road you're "leaving" always lands next to the left-hand corner of
// whichever road is next going clockwise - all the way around until it
// closes back on the corner it started from (see buildJunctionRing). That
// closed loop is the junction's paved footprint, filled with the widest
// road's own colour. Nothing about this ever moves a real node or way -
// every leg keeps its own home point's real position (see buildClusterLegs),
// so the ring is purely a visual overlay drawn around the roads' real
// endpoints, never a change to the map's actual topology.
const JUNCTION_SETBACK_M = 1.5;          // base "push back" distance (~1-2m)
const JUNCTION_GROW_STEP_M = 0.25;
const JUNCTION_GROW_MAX_ITERS = 24;
const JUNCTION_MAX_SETBACK_M = 6;
const JUNCTION_LEG_CAP_FRACTION = 0.4;   // a leg's own setback never exceeds this fraction of its length to its neighbour
const TANGENT_ANGLE_RAD = Math.PI / 3;   // 60° - two adjacent corners meeting closer together (or closer to opposite) than this read as one continuing edge, not a real corner - no wall drawn between them
// A leg whose home is farther than this from the group's own centre never
// gets a ring presence - purely a backstop against corrupted data (e.g. a
// stray join_group tag linking two nodes that aren't really the same
// junction), not a real design limit: osm_to_json.py's own auto-grouping
// already caps a group's bounding-box diagonal at 20m (MAX_GROUP_SPAN_M),
// and "Join into one intersection" (joinNodesIntoGroup) applies no cap at
// all - a deliberate multi-road join can easily and correctly put a member
// 15-20m from the group's centroid (an 8-way join with members spread
// across ~30m was seen clipping legs at the old, much tighter 15m value).
// This only needs to catch data that's actually broken, not bound how big
// a real joined intersection is allowed to be.
const MAX_SIDE_HOME_DIST_M = 150;

// One leg per (way, neighbour side) touching any node in `members` at the
// given layer - a way that threads through a node as an interior vertex
// contributes two legs, one per direction. `members` is normally just the
// single node the junction is being computed for; when 2+ real intersections
// have been explicitly joined into one group (see joinNodesIntoGroup), it's
// every member of that group, and their legs are pooled into one shared
// ring. A leg always keeps its own home node's real position (homeX/homeY),
// so no road's own geometry ever moves - only the ring built around them
// spans the group's real footprint instead of a single point.
function buildClusterLegs(members, layer) {
  const legs = [];
  const memberSet = new Set(members);
  for (const homeId of members) {
    const home = State.nodes.get(homeId);
    if (!home) continue;
    const waysHere = waysAtNodeByLayer(homeId).get(layer);
    if (!waysHere) continue;
    for (const way of waysHere) {
      const idx = way.nodes.indexOf(homeId);
      if (idx === -1) continue;
      const neighborSides = [];
      if (idx + 1 < way.nodes.length) neighborSides.push(way.nodes[idx + 1]);
      if (idx - 1 >= 0) neighborSides.push(way.nodes[idx - 1]);

      const style = wayStyle(way.tags);
      const width = wayPhysicalWidth(way);
      const halfW = width / 2;

      for (const neighborId of neighborSides) {
        // Internal to the joined group already (a connector that wasn't
        // fully dissolved because a branch hangs off it) - not a real leg.
        if (memberSet.has(neighborId)) continue;
        const neighbor = State.nodes.get(neighborId);
        if (!neighbor) continue;

        const dx = neighbor.x - home.x, dy = neighbor.y - home.y;
        const legLen = Math.max(1e-6, Math.hypot(dx, dy));
        const dirX = dx / legLen, dirY = dy / legLen;

        legs.push({
          wayId: way.id, way, style, width, halfW, legLen, dirX, dirY,
          homeNodeId: homeId, homeX: home.x, homeY: home.y,
        });
      }
    }
  }
  return legs;
}

// A leg's own pair of kerb corners ('left'/'right', facing outward along the
// road) at the given shared setback radius - capped by JUNCTION_LEG_CAP_FRACTION
// of the leg's own length so a short block never clips past its own far end.
// `widthScale` (default 1) uniformly narrows every corner's own half-width
// for this placement only (never the road's own rendered width) - see
// resolveJunctionRadius's crowding fallback, for the rare case a short leg's
// own length cap stops it ever growing far enough to out-run a crowding
// neighbour by radius alone.
function legCorners(leg, r, widthScale) {
  const wScale = widthScale == null ? 1 : widthScale;
  const halfW = leg.halfW * wScale;
  const capR = Math.min(r, JUNCTION_LEG_CAP_FRACTION * leg.legLen);
  const cx = leg.homeX + leg.dirX * capR, cy = leg.homeY + leg.dirY * capR;
  const perpX = leg.dirY, perpY = -leg.dirX; // rotate dir -90°: the road's right-hand side facing outward
  return {
    right: { x: cx + perpX * halfW, y: cy + perpY * halfW },
    left: { x: cx - perpX * halfW, y: cy - perpY * halfW },
  };
}

// Whether every leg's own two corners land next to each other once all
// corners (of every leg) are angle-sorted around refPoint - if another
// leg's corner has landed between them, the two are crowding/crossing at
// this radius and need more room (see resolveJunctionRadius).
function isRingWellFormed(refPoint, legs, r, widthScale) {
  const flat = [];
  for (const leg of legs) {
    const c = legCorners(leg, r, widthScale);
    flat.push({ leg, x: c.left.x, y: c.left.y });
    flat.push({ leg, x: c.right.x, y: c.right.y });
  }
  for (const p of flat) p.ang = Math.atan2(p.y - refPoint.y, p.x - refPoint.x);
  flat.sort((a, b) => a.ang - b.ang);

  const n = flat.length;
  if (n === 0) return true;
  let start = 0;
  while (start < n && flat[start].leg === flat[(start - 1 + n) % n].leg) start++;
  if (start === n) return true; // degenerate (all one leg)
  let i = start, steps = 0;
  while (steps < n) {
    const leg = flat[i % n].leg;
    let count = 0;
    while (steps < n && flat[i % n].leg === leg) { count++; i++; steps++; }
    if (count !== 2) return false;
  }
  return true;
}

// Grows the shared setback radius from the base 1-2m only as far as needed
// to keep every leg's own two corners from crowding/crossing a neighbour's.
// Falls back to a fixed max after JUNCTION_GROW_MAX_ITERS rather than
// growing forever; if growing the radius still can't resolve crowding
// between two legs whose own length caps stop them ever moving further
// apart (a real short block between two other junctions, most commonly),
// uniformly narrows every corner's own half-width (never the road's own
// rendered width - see legCorners' widthScale) until they stop overlapping,
// or a floor is hit.
function resolveJunctionRadius(refPoint, legs) {
  let r = JUNCTION_SETBACK_M;
  if (legs.length < 2) return { radius: r, widthScale: 1 };
  let wellFormed = false;
  for (let iter = 0; iter < JUNCTION_GROW_MAX_ITERS; iter++) {
    if (isRingWellFormed(refPoint, legs, r)) { wellFormed = true; break; }
    if (r >= JUNCTION_MAX_SETBACK_M) break;
    r = Math.min(r + JUNCTION_GROW_STEP_M, JUNCTION_MAX_SETBACK_M);
  }
  let widthScale = 1;
  if (!wellFormed) {
    for (let scale = 0.85; scale >= 0.05; scale -= 0.08) {
      widthScale = scale;
      if (isRingWellFormed(refPoint, legs, r, scale)) break;
    }
  }
  return { radius: r, widthScale };
}

// Builds the closed ring (footprint outline) by walking every leg's two
// corners in clockwise angular order around refPoint and connecting each to
// the very next one with a straight line - the literal "paint" sweep: one
// road's own corner joins directly onto the next road's corner, all the way
// around back to where it started. Returns { path, segWall, segOutline }:
// segWall[i] says whether path[i]->path[(i+1)%len] is a real corner between
// two different roads (stroked as the thicker, zoom-gated curb/wall in the
// 'stroke' phase); segOutline[i] says whether it should get the thin,
// always-on continuity outline in the 'fill' phase instead - true for every
// segment except a single leg's own gate mouth (the straight line directly
// across that one road's own entrance, which must stay open/unmarked or it
// reads as a bar blocking the road).
function buildJunctionRing(refPoint, legs, radius, widthScale) {
  const pts = [];
  for (const leg of legs) {
    const c = legCorners(leg, radius, widthScale);
    pts.push({ x: c.left.x, y: c.left.y, leg });
    pts.push({ x: c.right.x, y: c.right.y, leg });
  }
  if (pts.length < 3) return null;
  for (const p of pts) p.ang = Math.atan2(p.y - refPoint.y, p.x - refPoint.x);
  pts.sort((a, b) => a.ang - b.ang);

  const n = pts.length;
  const path = [];
  const segWall = [];
  const segOutline = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    path.push(a);
    if (a.leg === b.leg) {
      // A single leg's own gate mouth - the straight line across its own
      // entrance. Never walled, never outlined.
      segWall.push(false);
      segOutline.push(false);
      continue;
    }
    // Two adjacent corners whose own legs point nearly parallel or nearly
    // opposite each other read as one continuing edge (a through-road
    // passing straight by, or two roads splitting apart at a shallow angle)
    // rather than a real corner - no wall between them, just the plain
    // straight connection already in `path`.
    const dot = a.leg.dirX * b.leg.dirX + a.leg.dirY * b.leg.dirY;
    const straightEdge = Math.abs(dot) > Math.cos(TANGENT_ANGLE_RAD);
    segWall.push(!straightEdge);
    segOutline.push(true);
  }
  return { path, segWall, segOutline };
}

// The confluence fill colour: the widest leg's own colour wins.
function resolveCoreStyle(legs) {
  let coreStyle = null, maxHalfW = -1;
  for (const leg of legs) {
    if (leg.halfW > maxHalfW) { maxHalfW = leg.halfW; coreStyle = leg.style; }
  }
  return coreStyle;
}

// Per-frame cache keyed by node+layer - cleared once at the top of render().
// Guarantees shortenPath's road-body clip (junctionClearance), the stop
// line and the gate/curb ring all read the exact same resolved radius for
// a given node in a given frame, and avoids recomputing the same node's
// geometry 3 times over (fill pass, stroke pass, junctionClearance calls).
let _junctionCache = new Map();
function clearJunctionCache() { _junctionCache = new Map(); }
function getJunctionData(nodeId, layer) {
  const key = nodeId + "|" + layer;
  if (_junctionCache.has(key)) return _junctionCache.get(key);
  const data = computeJunctionData(nodeId, layer);
  _junctionCache.set(key, data);
  return data;
}

function computeJunctionData(nodeId, layer) {
  const node = State.nodes.get(nodeId);
  if (!node) return null;

  // When this node has been explicitly joined with others (see
  // joinNodesIntoGroup), pool every member's legs into one shared ring
  // instead of nodeId's own alone - each leg still keeps its own home
  // node's real position, so this only changes how big a ring is drawn
  // AROUND the group, never any road's actual geometry. refPoint is purely
  // the angle-sort centre for the ring (the group's centroid), not an
  // anchor for any placement math.
  const members = junctionCluster(nodeId);
  const refPoint = members.length > 1 ? clusterCentroid(members) : node;

  const legs = buildClusterLegs(members, layer);
  if (legs.length < 2) return null;

  // A plain interior vertex of a single way threading straight through
  // (an ordinary bend, or a non-splitting "Angle Point"/"Curve Point" - see
  // insertShapingNodeOnWay) always contributes exactly 2 legs - its own
  // before/after neighbours - even though nothing actually branches there.
  // Without this check that reads as a real 2-leg junction to everything
  // below, growing a spurious fill ring (and clipping the road body back
  // for it) at a point that was never a real intersection. A genuine
  // junction always has legs from 2+ DISTINCT ways (real branching, or a
  // signal/U-turn split point - both of those use splitWayAt, which creates
  // a second way); require that here rather than just "2+ legs".
  const distinctWayIds = new Set(legs.map(l => l.wayId));
  if (distinctWayIds.size < 2) return null;

  // A leg whose home is unreasonably far from the group's own centre is most
  // likely a distant member of a joined cluster that shouldn't visually
  // stretch this junction's own footprint out to meet it - leave it out of
  // the ring entirely (its own road still renders and clips correctly
  // regardless - junctionClearance reads the raw `legs` list directly, not
  // this filtered one).
  const ringLegs = legs.filter(l => Math.hypot(l.homeX - refPoint.x, l.homeY - refPoint.y) <= MAX_SIDE_HOME_DIST_M);

  if (ringLegs.length < 2) {
    return { node, legs, ring: null, coreStyle: null, radius: JUNCTION_SETBACK_M };
  }

  const { radius, widthScale } = resolveJunctionRadius(refPoint, ringLegs);
  const ring = buildJunctionRing(refPoint, ringLegs, radius, widthScale);
  const coreStyle = resolveCoreStyle(ringLegs);

  return { node, legs, ring, coreStyle, radius };
}

// Single render entry point for both the confluence fill ('fill' phase,
// always on, painted before decorations so lane dashes/dividers draw on top
// and never get overpainted right at the junction) and the curb/wall stroke
// ('stroke' phase, zoom-gated like the plain intersection-dot markers and
// skipped for uturn-tagged nodes, painted after decorations so a wall reads
// above the divider it flanks).
function drawJunctionShapes(layerPredicate, phase) {
  if (phase === 'stroke' && !shouldShowIntersections()) return;
  for (const [nodeId, n] of State.nodes) {
    const isUturn = isYes(n.tags && n.tags.uturn);
    for (const layer of waysAtNodeByLayer(nodeId).keys()) {
      if (!layerPredicate(layer)) continue;
      const data = getJunctionData(nodeId, layer);
      if (!data) continue;

      const sp = worldToScreen(n.x, n.y);
      const reachPx = (data.radius + 3) * State.view.scale;
      if (sp.x < -reachPx * 4 || sp.x > cssW() + reachPx * 4 || sp.y < -reachPx * 4 || sp.y > cssH() + reachPx * 4) continue;

      if (phase === 'fill') {
        if (data.ring && data.coreStyle) {
          ctx.beginPath();
          const fp = worldToScreen(data.ring.path[0].x, data.ring.path[0].y);
          ctx.moveTo(fp.x, fp.y);
          for (let i = 1; i < data.ring.path.length; i++) {
            const p = worldToScreen(data.ring.path[i].x, data.ring.path[i].y);
            ctx.lineTo(p.x, p.y);
          }
          ctx.closePath();
          ctx.fillStyle = data.coreStyle.color;
          ctx.fill();

          // A thin outline continuing across every ring segment EXCEPT a
          // single leg's own gate mouth (segOutline, from buildJunctionRing)
          // - this is what makes a road's own outline stroke, which stops
          // dead at its clipped sub-path end (see drawWayBase), read as one
          // continuous kerb line straight through an ordinary open junction
          // instead of visibly breaking for the width of the gate. Skipping
          // each leg's own mouth matters just as much: stroking straight
          // across a single road's own entrance would draw what looks like
          // a bar blocking that road, right where it enters the junction.
          // Always on (never zoom-gated), matching a road's own outline.
          if (data.ring.segOutline) {
            ctx.save();
            ctx.strokeStyle = "#4a4458";
            ctx.lineWidth = 1;
            ctx.lineCap = "round";
            ctx.setLineDash([]);
            const path = data.ring.path, segOutline = data.ring.segOutline;
            for (let i = 0; i < path.length; i++) {
              if (!segOutline[i]) continue;
              const a = path[i], b = path[(i + 1) % path.length];
              const spA = worldToScreen(a.x, a.y), spB = worldToScreen(b.x, b.y);
              ctx.beginPath(); ctx.moveTo(spA.x, spA.y); ctx.lineTo(spB.x, spB.y); ctx.stroke();
            }
            ctx.restore();
          }
        }
      } else if (!isUturn && data.ring) {
        const { path, segWall } = data.ring;
        for (let i = 0; i < path.length; i++) {
          if (!segWall[i]) continue;
          const a = path[i], b = path[(i + 1) % path.length];
          const spA = worldToScreen(a.x, a.y), spB = worldToScreen(b.x, b.y);
          ctx.save();
          ctx.lineCap = "round";
          ctx.setLineDash([]);
          ctx.strokeStyle = "rgba(255,255,255,0.5)";
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(spA.x, spA.y); ctx.lineTo(spB.x, spB.y); ctx.stroke();
          ctx.strokeStyle = "#3d3846";
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(spA.x, spA.y); ctx.lineTo(spB.x, spB.y); ctx.stroke();
          ctx.restore();
        }
      }
    }
  }
}

// Roads are drawn at a flat schematic pixel width when zoomed out (as
// before), but once zoomed in far enough that the road's real lanes*width
// footprint would be wider than that schematic minimum, switch to the real,
// zoom-proportional width - this is what makes per-lane markings legible
// instead of being sub-pixel slivers on a constant-width stroke.
//
// The upper cap here is only a guard against pathological tag values (e.g. a
// typo'd lane_width in the thousands) - it must stay far above anything a
// normal zoom level actually produces, otherwise the drawn stroke would go
// narrower than the (uncapped, physical-width-based) junction clearance and
// stop-line placement, leaving a visible gap between the road's edge and
// where those are positioned.
function wayDrawWidth(way, style) {
  const lanes = parseInt(way.tags && way.tags.lanes, 10);
  const laneWidth = parseFloat(way.tags && way.tags.lane_width);
  if (lanes > 0 && laneWidth > 0) {
    const realWidthPx = lanes * laneWidth * State.view.scale;
    return Math.min(20000, Math.max(style.width, realWidthPx));
  }
  return style.width;
}

/* ---- lane markings + one-way direction arrows (schematic overlays) ---- */

function offsetPolyline(screenPts, off) {
  const n = screenPts.length;
  if (n < 2 || Math.abs(off) < 1e-6) return screenPts;
  const out = [];
  for (let i = 0; i < n; i++) {
    let nx, ny;
    if (i === 0) {
      const dx = screenPts[1].x - screenPts[0].x, dy = screenPts[1].y - screenPts[0].y;
      const len = Math.max(1e-6, Math.hypot(dx, dy));
      nx = -dy / len; ny = dx / len;
    } else if (i === n - 1) {
      const dx = screenPts[i].x - screenPts[i - 1].x, dy = screenPts[i].y - screenPts[i - 1].y;
      const len = Math.max(1e-6, Math.hypot(dx, dy));
      nx = -dy / len; ny = dx / len;
    } else {
      const dx1 = screenPts[i].x - screenPts[i - 1].x, dy1 = screenPts[i].y - screenPts[i - 1].y;
      const len1 = Math.max(1e-6, Math.hypot(dx1, dy1));
      const dx2 = screenPts[i + 1].x - screenPts[i].x, dy2 = screenPts[i + 1].y - screenPts[i].y;
      const len2 = Math.max(1e-6, Math.hypot(dx2, dy2));
      const n1x = -dy1 / len1, n1y = dx1 / len1;
      const n2x = -dy2 / len2, n2y = dx2 / len2;
      let sx = n1x + n2x, sy = n1y + n2y;
      const slen = Math.max(1e-6, Math.hypot(sx, sy));
      nx = sx / slen; ny = sy / slen;
    }
    out.push({ x: screenPts[i].x + nx * off, y: screenPts[i].y + ny * off });
  }
  return out;
}

function strokeOffsetPath(screenPts, curve, off) {
  ctx.beginPath();
  const offsetPts = offsetPolyline(screenPts, off);
  tracePath(ctx, offsetPts, curve);
  ctx.stroke();
}

// Returns a copy of `pts` with up to `trimStart`/`trimEnd` (same units as
// the points - screen px here) cut off each end, walking along the segments
// rather than just moving the endpoint in a straight line. Used to open a
// deliberate gap in the centre-divider line at a U-turn point (see
// drawLaneDecorations) without touching anything else about the path.
function trimPolylineEnds(pts, trimStart, trimEnd) {
  if (pts.length < 2 || (trimStart <= 0 && trimEnd <= 0)) return pts;
  let out = pts.map(p => ({ x: p.x, y: p.y }));

  if (trimStart > 0) {
    let remaining = trimStart;
    let cut = null;
    for (let i = 0; i < out.length - 1; i++) {
      const segLen = Math.hypot(out[i + 1].x - out[i].x, out[i + 1].y - out[i].y);
      if (remaining <= segLen) {
        const t = segLen > 1e-6 ? remaining / segLen : 0;
        out[i] = { x: out[i].x + (out[i + 1].x - out[i].x) * t, y: out[i].y + (out[i + 1].y - out[i].y) * t };
        cut = i;
        break;
      }
      remaining -= segLen;
    }
    if (cut === null) return []; // trimmed past the whole path
    out.splice(0, cut);
  }
  if (out.length >= 2 && trimEnd > 0) {
    let remaining = trimEnd;
    let cut = null;
    for (let i = out.length - 1; i > 0; i--) {
      const segLen = Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y);
      if (remaining <= segLen) {
        const t = segLen > 1e-6 ? remaining / segLen : 0;
        out[i] = { x: out[i].x + (out[i - 1].x - out[i].x) * t, y: out[i].y + (out[i - 1].y - out[i].y) * t };
        cut = i;
        break;
      }
      remaining -= segLen;
    }
    if (cut === null) return [];
    out.splice(cut + 1);
  }
  return out;
}

// A U-turn point (see addUturn) deliberately opens a gap in a road's centre
// divider - real-world, it's the cut through an otherwise continuous median
// that lets traffic cross to turn. UTURN_GAP_M is trimmed off the divider
// line (only the divider - not the ordinary lane-count dashes, which aren't
// a physical barrier) at whichever end of this sub-path sits on a
// U-turn-tagged node.
const UTURN_GAP_M = 3;
function isUturnNode(nodeId) {
  const n = State.nodes.get(nodeId);
  return !!(n && n.tags && isYes(n.tags.uturn));
}

function drawLaneDecorations(way, screenPts, totalWidth, startNodeId, endNodeId) {
  const lanes = parseInt(way.tags.lanes, 10);
  if (!lanes || lanes < 2) return;
  if (totalWidth < 14) return; // too narrow on screen for sub-lane lines to read cleanly
  const midIndex = lanes % 2 === 0 ? lanes / 2 : -1;
  const hasDivider = isYes(way.tags.divider) && !isYes(way.tags.oneway);

  ctx.save();
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = "rgba(74,68,88,0.75)";
  ctx.lineWidth = 1;
  for (let i = 1; i < lanes; i++) {
    if (hasDivider && i === midIndex) continue; // centre divider drawn separately below
    const off = -totalWidth / 2 + (totalWidth / lanes) * i;
    strokeOffsetPath(screenPts, way.curve, off);
  }
  ctx.restore();

  if (hasDivider) {
    const gapPx = UTURN_GAP_M * State.view.scale;
    const startGap = isUturnNode(startNodeId) ? gapPx : 0;
    const endGap = isUturnNode(endNodeId) ? gapPx : 0;
    const dividerPts = trimPolylineEnds(screenPts, startGap, endGap);
    if (dividerPts.length >= 2) {
      ctx.save();
      ctx.setLineDash([]);
      ctx.strokeStyle = "#4a4458";
      ctx.lineWidth = 1.4;
      strokeOffsetPath(dividerPts, way.curve, 0);
      ctx.restore();
    }
  }
}

function drawArrowsAlongPath(screenPts) {
  if (screenPts.length < 2) return;
  const spacing = 70;
  let dist = spacing / 2;
  let travelled = 0;
  for (let i = 0; i < screenPts.length - 1; i++) {
    const a = screenPts[i], b = screenPts[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    while (dist <= travelled + segLen) {
      const t = segLen > 1e-6 ? (dist - travelled) / segLen : 0;
      const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
      drawArrowHead(px, py, Math.atan2(b.y - a.y, b.x - a.x));
      dist += spacing;
    }
    travelled += segLen;
  }
}

function drawArrowHead(x, y, angle) {
  const size = 5;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(-size, -size * 0.7);
  ctx.lineTo(size, 0);
  ctx.lineTo(-size, size * 0.7);
  ctx.strokeStyle = "#3d3846";
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.restore();
}

function wayRotateHandleWorld(way) {
  const pts = wayPoints(way);
  if (pts.length < 2) return null;
  const first = pts[0], last = pts[pts.length - 1];
  const mx = (first.x + last.x) / 2, my = (first.y + last.y) / 2;
  const dx = last.x - first.x, dy = last.y - first.y;
  const len = Math.max(1e-6, Math.hypot(dx, dy));
  const nx = -dy / len, ny = dx / len; // perpendicular unit vector
  const offset = 26 / State.view.scale; // keep ~26 screen px away regardless of zoom
  return { x: mx + nx * offset, y: my + ny * offset, pivot: first };
}

// Shared draw for a `{x, y, pivot}` rotate handle (see wayRotateHandleWorld
// and clusterRotateHandleWorld) - a dashed spoke from the pivot out to a
// clickable ⟳ knob.
function drawRotateHandleAt(h) {
  if (!h) return;
  const sp = worldToScreen(h.x, h.y);
  const pivotSp = worldToScreen(h.pivot.x, h.pivot.y);
  ctx.save();
  ctx.strokeStyle = "rgba(67,97,238,0.6)";
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pivotSp.x, pivotSp.y); ctx.lineTo(sp.x, sp.y); ctx.stroke();

  ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(sp.x, sp.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = "#fff"; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = "#4361ee"; ctx.stroke();
  ctx.font = "10px 'Space Grotesk', sans-serif"; ctx.fillStyle = "#4361ee";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("⟳", sp.x, sp.y);
  ctx.restore();
}

function drawRotateHandle(way) {
  drawRotateHandleAt(wayRotateHandleWorld(way));
}

// The rotate handle for a whole joined intersection group (see
// joinNodesIntoGroup/junctionCluster) - pivots on the group's own centroid
// and sits just outside the farthest member, so it clears the group's own
// footprint at any cluster size/shape. Dragging it spins every member
// around that centroid together (see rotateClusterMembers) - since the
// junction fill/ring is rebuilt every frame straight from each member's
// live position (see computeJunctionData), the whole intersection's
// connection to its roads re-angles itself for free, exactly like a plain
// node drag already does for a single, ungrouped intersection.
function clusterRotateHandleWorld(members) {
  if (!members || members.length < 2) return null;
  const pivot = clusterCentroid(members);
  let maxR = 0;
  for (const id of members) {
    const n = State.nodes.get(id);
    if (!n) continue;
    maxR = Math.max(maxR, Math.hypot(n.x - pivot.x, n.y - pivot.y));
  }
  const offset = maxR + 26 / State.view.scale; // clear the group's own footprint, then ~26 screen px more
  return { x: pivot.x, y: pivot.y + offset, pivot };
}

function drawClusterRotateHandle(members) {
  drawRotateHandleAt(clusterRotateHandleWorld(members));
}

function loop(ts) {
  simTick(ts);
  if (dirty) { dirty = false; render(); }
  requestAnimationFrame(loop);
}

/* ================================================================
   HIT TESTING
   ================================================================ */

function findNodeAt(world, tolerancePx) {
  const tol = tolerancePx / State.view.scale;
  let best = null, bestD = tol;
  for (const [id, n] of State.nodes) {
    const d = Math.hypot(n.x - world.x, n.y - world.y);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

// Like findNodeAt, but hit-tests a joined group's single marker at its
// centroid (see render()'s node loop) instead of its members' own real
// points, resolving to the group's primary - this is what makes the
// central marker itself clickable for selection. Used only by the
// select/move tool's own click handling; road-drawing and the
// signal/uturn tools still use findNodeAt directly so they snap to a real
// node's own physical position, never a group's drawn-but-unreal centroid.
function findJunctionMarkerAt(world, tolerancePx) {
  const tol = tolerancePx / State.view.scale;
  let best = null, bestD = tol;
  const seenGroups = new Set();
  for (const [id, n] of State.nodes) {
    const groupId = n.tags && n.tags.join_group;
    let mx = n.x, my = n.y, resultId = id;
    if (groupId) {
      if (seenGroups.has(groupId)) continue;
      seenGroups.add(groupId);
      const c = clusterCentroid(State.joinGroupIndex.get(groupId) || [id]);
      mx = c.x; my = c.y;
      resultId = junctionPrimary(id);
    }
    const d = Math.hypot(mx - world.x, my - world.y);
    if (d < bestD) { bestD = d; best = resultId; }
  }
  return best;
}

// Like findNodeAt, but also reports the hit distance - lets the select
// tool's mousedown compare a real node's own point against a joined
// group's centroid marker (see findClusterMarkerAt) and drag whichever is
// actually closer, instead of a group's marker always winning regardless
// of distance. Matches every real node, including an individual member of
// a joined group - see the select tool's own mousedown handling for why
// that matters: since osm_to_json.py's auto-grouping (SHORTEN_M) gives
// every road its own private, un-shared endpoint node even inside a group,
// grabbing that node directly (not the group's own drawn-but-unreal
// centroid) is how one road's own end gets reshaped/dragged without moving
// the rest of the junction.
function findNodeAtWithDist(world, tolerancePx) {
  const tol = tolerancePx / State.view.scale;
  let best = null, bestD = tol;
  for (const [id, n] of State.nodes) {
    const d = Math.hypot(n.x - world.x, n.y - world.y);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best == null ? null : { id: best, d: bestD };
}

// Like findJunctionMarkerAt, but only matches a GENUINE multi-member group
// (a size-1 "group" has no centroid distinct from its own single node - use
// findNodeAtWithDist for that) and reports the hit distance - see
// findNodeAtWithDist for why the select tool needs both.
function findClusterMarkerAt(world, tolerancePx) {
  const tol = tolerancePx / State.view.scale;
  let best = null, bestD = tol;
  const seenGroups = new Set();
  for (const [id, n] of State.nodes) {
    const groupId = n.tags && n.tags.join_group;
    if (!groupId || seenGroups.has(groupId)) continue;
    seenGroups.add(groupId);
    const members = State.joinGroupIndex.get(groupId) || [id];
    if (members.length < 2) continue;
    const c = clusterCentroid(members);
    const d = Math.hypot(c.x - world.x, c.y - world.y);
    if (d < bestD) { bestD = d; best = junctionPrimary(id); }
  }
  return best == null ? null : { id: best, d: bestD };
}

// Evaluates and returns a list of world-space points along the road.
// For spline roads, it returns evaluated points along the smooth Catmull-Rom Bezier curve (8 steps per segment).
// For straight roads, it returns the raw control points.
function wayEvaluationPoints(way) {
  const pts = wayPoints(way);
  if (pts.length < 2) return [];
  if (way.curve !== "spline" || pts.length < 3) return pts;

  const out = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = i === 0 ? pts[0] : pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = i + 2 < n ? pts[i + 2] : p2;

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    const steps = 8;
    for (let s = 0; s <= steps; s++) {
      if (i > 0 && s === 0) continue; // avoid duplicates at segment boundaries
      const t = s / steps;
      const mt = 1 - t;
      const w0 = mt * mt * mt;
      const w1 = 3 * mt * mt * t;
      const w2 = 3 * mt * t * t;
      const w3 = t * t * t;

      const x = w0 * p1.x + w1 * cp1x + w2 * cp2x + w3 * p2.x;
      const y = w0 * p1.y + w1 * cp1y + w2 * cp2y + w3 * p2.y;
      out.push({ x, y });
    }
  }
  return out;
}

// Generalizes wayEvaluationPoints with the same per-vertex shape overrides
// as traceMixedPath (see vertexTreatment) - used by findWayAt so click
// hit-testing follows a rounded Curve Point / sharpened Angle Point the same
// way the road is actually drawn, instead of the old whole-way-only
// straight/spline assumption.
function wayEvaluationPointsMixed(way) {
  const pts = [], ids = [];
  for (const nid of way.nodes) {
    const nn = State.nodes.get(nid);
    if (nn) { pts.push(nn); ids.push(nid); }
  }
  if (pts.length < 2 || pts.length !== way.nodes.length) return pts;
  const n = pts.length;
  const isSharp = (i) => i <= 0 || i >= n - 1 || vertexTreatment(way.curve, ids, i) === "sharp";
  const STEPS = 8;

  if (way.curve === "spline") {
    const out = [];
    for (let i = 0; i < n - 1; i++) {
      const p1 = pts[i], p2 = pts[i + 1];
      const p0 = isSharp(i) ? p1 : pts[i - 1];
      const p3 = isSharp(i + 1) ? p2 : pts[i + 2];
      const cp1x = p1.x + (p2.x - p0.x) / 6, cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6, cp2y = p2.y - (p3.y - p1.y) / 6;
      for (let s = 0; s <= STEPS; s++) {
        if (i > 0 && s === 0) continue;
        const t = s / STEPS, mt = 1 - t;
        const w0 = mt * mt * mt, w1 = 3 * mt * mt * t, w2 = 3 * mt * t * t, w3 = t * t * t;
        out.push({
          x: w0 * p1.x + w1 * cp1x + w2 * cp2x + w3 * p2.x,
          y: w0 * p1.y + w1 * cp1y + w2 * cp2y + w3 * p2.y,
        });
      }
    }
    return out;
  }

  const out = [pts[0]];
  for (let i = 1; i < n - 1; i++) {
    const prevPt = pts[i - 1], vertex = pts[i], nextPt = pts[i + 1];
    if (isSharp(i)) {
      out.push(vertex);
    } else {
      const d1 = Math.hypot(vertex.x - prevPt.x, vertex.y - prevPt.y);
      const d2 = Math.hypot(nextPt.x - vertex.x, nextPt.y - vertex.y);
      const pull = Math.min(d1, d2) * 0.4;
      const t1 = d1 > 1e-6 ? pull / d1 : 0, t2 = d2 > 1e-6 ? pull / d2 : 0;
      const inPt = { x: vertex.x + (prevPt.x - vertex.x) * t1, y: vertex.y + (prevPt.y - vertex.y) * t1 };
      const outPt = { x: vertex.x + (nextPt.x - vertex.x) * t2, y: vertex.y + (nextPt.y - vertex.y) * t2 };
      out.push(inPt);
      for (let s = 1; s < STEPS; s++) {
        const t = s / STEPS, mt = 1 - t;
        out.push({
          x: mt * mt * inPt.x + 2 * mt * t * vertex.x + t * t * outPt.x,
          y: mt * mt * inPt.y + 2 * mt * t * vertex.y + t * t * outPt.y,
        });
      }
      out.push(outPt);
    }
  }
  out.push(pts[n - 1]);
  return out;
}

function findWayAt(world, tolerancePx) {
  const baseTol = tolerancePx / State.view.scale;
  let best = null, bestD = Infinity;
  for (const way of State.ways.values()) {
    // Determine the hit tolerance: max of screen base tolerance, visual half-width, and physical half-width.
    const style = wayStyle(way.tags);
    const halfWidth = wayDrawWidth(way, style) / State.view.scale / 2;
    const physicalHalfWidth = wayPhysicalWidth(way) / 2;

    const tol = Math.max(baseTol, halfWidth, physicalHalfWidth);
    
    // Evaluate points along the spline/line path to ensure the hitbox follows the curve.
    const pts = wayEvaluationPointsMixed(way);
    for (let i = 0; i < pts.length - 1; i++) {
      const d = distPointToSegment(world, pts[i], pts[i + 1]);
      if (d < tol && d < bestD) { bestD = d; best = way.id; }
    }
  }
  return best;
}

// Point-radius hit test for amenity markers, same shape as findNodeAt.
// Respects the same zoom gate drawAmenities() renders behind - nothing
// invisible is ever silently clickable.
function findAmenityAt(world, tolerancePx) {
  if (!Config.showAmenities || State.view.scale < Config.amenityZoomThreshold) return null;
  const tol = tolerancePx / State.view.scale;
  let best = null, bestD = Infinity;
  for (const a of State.amenities.values()) {
    const d = Math.hypot(world.x - a.x, world.y - a.y);
    if (d < tol && d < bestD) { bestD = d; best = a.id; }
  }
  return best;
}

// Area hit test for a building footprint (ray-casting point-in-polygon) -
// lowest priority of the four hit-testable feature types (see the select
// tool's mousedown handler), since a building's fill is the largest target
// and must never steal a click meant for a point/road inside/near it.
// Respects the same zoom gate drawBuildings() renders behind.
function findBuildingAt(world) {
  if (!Config.showBuildings || State.view.scale < Config.buildingZoomThreshold) return null;
  for (const b of State.buildings.values()) {
    if (pointInPolygon(world, b.polygon)) return b.id;
  }
  return null;
}

/* ================================================================
   SELECTION / INSPECTOR
   ================================================================ */

function primarySelection() {
  return State.selected[0] || { type: null, id: null };
}

function isSelected(type, id) {
  return State.selected.some(s => s.type === type && s.id === id);
}

// A node joined into a group (see joinNodesIntoGroup) always reads as one
// single intersection: whatever raw node id a selection arrives with (a
// rubber-band rectangle, a tool's own findNodeAt hit, a shift-click),
// selecting it selects the WHOLE group via its primary (see
// junctionPrimary) - this is the one place that's enforced, so every path
// that can select a node stays consistent without having to remember to
// resolve it itself.
function setSelection(items) {
  const next = items.map(s => s.type === "node" ? { type: "node", id: junctionPrimary(s.id) } : s);
  // Re-selecting the exact same single road (e.g. the plain mousedown that
  // starts every drag on it, including the very drag "Move whole road" just
  // got armed for) must NOT clear State.roadMoveMode - only an actual
  // change of selection (a different way/node, more than one item, or
  // nothing) should. Otherwise the toggle could never survive long enough
  // to ever be dragged.
  const sameSingleWay = next.length === 1 && State.selected.length === 1
    && next[0].type === "way" && State.selected[0].type === "way" && next[0].id === State.selected[0].id;
  if (!sameSingleWay) State.roadMoveMode = false;
  State.selected = next;
  renderInspector();
  markDirty();
}

function toggleInSelection(type, id) {
  const resolvedId = type === "node" ? junctionPrimary(id) : id;
  const idx = State.selected.findIndex(s => s.type === type && s.id === resolvedId);
  const next = State.selected.slice();
  if (idx === -1) next.push({ type, id: resolvedId }); else next.splice(idx, 1);
  setSelection(next);
}

function clearSelection() {
  setSelection([]);
}

function $(sel) { return document.querySelector(sel); }
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const c of children) e.append(c instanceof Node ? c : document.createTextNode(c));
  return e;
}

function projectInverse(x, y) {
  const origin = (State.meta && State.meta.origin) || { lat: 0, lon: 0 };
  const R = 6378137;
  const lat = origin.lat + (y / R) * (180 / Math.PI);
  const lon = origin.lon + (x / (R * Math.cos(origin.lat * Math.PI / 180))) * (180 / Math.PI);
  return { lat, lon };
}

/* ================================================================
   EDIT OPERATIONS
   ================================================================ */

const CIRCLE_MIN_RADIUS_M = 2;
const CIRCLE_SEGMENTS = 48; // nodes around the loop - enough that straight segments read as a smooth circle at any normal zoom

// Builds a new closed-loop way approximating a perfect circle: CIRCLE_SEGMENTS
// nodes evenly spaced around `center` at `radius`, first node repeated as the
// last to close the loop (the standard OSM convention for a closed way, e.g.
// a roundabout). The centre/radius are stashed as plain tags on the way
// (circle_cx/cy/radius) so the radius can be edited afterwards (see
// setCircleRadius) without having to re-fit a circle from the node
// positions. Nothing about junctions/intersections is special-cased here -
// this is deliberately just a road shaped like a circle; another road can
// already be connected onto it via the existing snap-to-road behaviour
// (trySnapDraggedNode / insertExistingNodeIntoWay), the same as any other
// road, and any dedicated support for that is left for later.
function drawCirclePreview(drag) {
  ctx.save();
  ctx.strokeStyle = "#4361ee";
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
    const ang = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    const sp = worldToScreen(drag.center.x + Math.cos(ang) * drag.radius, drag.center.y + Math.sin(ang) * drag.radius);
    if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  const csp = worldToScreen(drag.center.x, drag.center.y);
  ctx.beginPath(); ctx.arc(csp.x, csp.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#4361ee"; ctx.fill();
  ctx.restore();

  const labelSp = worldToScreen(drag.center.x + drag.radius, drag.center.y);
  ctx.save();
  ctx.font = "bold 12px 'Space Grotesk', sans-serif";
  ctx.fillStyle = "#1a1a2e";
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 3;
  const label = `${drag.radius.toFixed(1)} m`;
  ctx.strokeText(label, labelSp.x + 8, labelSp.y);
  ctx.fillText(label, labelSp.x + 8, labelSp.y);
  ctx.restore();
}

/* ---- move / rotate ---- */

function updateStatusCounts() {
  $("#statCounts").textContent = `${State.nodes.size} nodes, ${State.ways.size} roads`;
}

function updateStatusSelection() {
  const sel = State.selected;
  if (!sel.length) $("#statSelection").textContent = "";
  else if (sel.length === 1) $("#statSelection").textContent = `Selected ${sel[0].type}: ${sel[0].id}`;
  else $("#statSelection").textContent = `${sel.length} items selected`;
}

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ================================================================
   EVENTS
   ================================================================ */

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const factor = Math.pow(1.0015, -e.deltaY * Config.zoomSensitivity);
  zoomAt(sx, sy, factor);
}, { passive: false });

$("#zoomInBtn").addEventListener("click", () => zoomAt(cssW() / 2, cssH() / 2, 1.3));
$("#zoomOutBtn").addEventListener("click", () => zoomAt(cssW() / 2, cssH() / 2, 1 / 1.3));
$("#fitBtn").addEventListener("click", fitView);
$("#inspClose").addEventListener("click", clearSelection);

$("#rotationSlider").addEventListener("input", (e) => setRotation(parseFloat(e.target.value)));
$("#rotationResetBtn").addEventListener("click", () => setRotation(0));

// Wrapped in closures, not passed directly: toggleSim/resetSim are defined
// in redlight.js, which loads AFTER this file - a bare reference here would
// try to resolve the identifier immediately (at wiring time) and throw
// "toggleSim is not defined", instead of only at actual click time (by
// which every script has finished loading).
$("#simPlayBtn").addEventListener("click", () => toggleSim());
$("#simResetBtn").addEventListener("click", () => resetSim());

$("#simSpeedSlider").addEventListener("input", (e) => {
  setSimSpeed(parseFloat(e.target.value));
  updateSimPresetButtons();
});
$("#simSpeedSlider").addEventListener("change", () => { Config.simSpeedMultiplier = Sim.speedMultiplier; saveConfig(); });

for (const btn of document.querySelectorAll(".sim-preset-btn")) {
  btn.addEventListener("click", () => {
    const v = setSimSpeed(parseFloat(btn.dataset.speed));
    $("#simSpeedSlider").value = String(v);
    updateSimPresetButtons();
    Config.simSpeedMultiplier = v;
    saveConfig();
  });
}
function updateSimPresetButtons() {
  for (const btn of document.querySelectorAll(".sim-preset-btn")) {
    btn.classList.toggle("active", parseFloat(btn.dataset.speed) === Sim.speedMultiplier);
  }
}

$("#simDurationHoursInput").addEventListener("change", (e) => {
  const v = parseFloat(e.target.value);
  const hours = setSimDurationHours(Number.isFinite(v) ? v : 0);
  e.target.value = String(hours);
  Config.simDurationHours = hours;
  saveConfig();
});

$("#arrowsToggleBtn").addEventListener("click", () => {
  Config.showDirectionArrows = !Config.showDirectionArrows;
  saveConfig();
  updateArrowsButton();
  markDirty();
});
function updateArrowsButton() {
  $("#arrowsToggleBtn").classList.toggle("active", Config.showDirectionArrows);
}

$("#timersToggleBtn").addEventListener("click", () => {
  Config.showSignalTimers = !Config.showSignalTimers;
  saveConfig();
  updateTimersButton();
  markDirty();
});
function updateTimersButton() {
  $("#timersToggleBtn").classList.toggle("active", Config.showSignalTimers);
}

$("#buildingsToggleBtn").addEventListener("click", () => {
  Config.showBuildings = !Config.showBuildings;
  saveConfig();
  updateBuildingsButton();
  markDirty();
});
function updateBuildingsButton() {
  $("#buildingsToggleBtn").classList.toggle("active", Config.showBuildings);
}

$("#amenitiesToggleBtn").addEventListener("click", () => {
  Config.showAmenities = !Config.showAmenities;
  saveConfig();
  updateAmenitiesButton();
  markDirty();
});
function updateAmenitiesButton() {
  $("#amenitiesToggleBtn").classList.toggle("active", Config.showAmenities);
}

// Same deferred-lookup reasoning as toggleSim/resetSim above -
// toggleSettingsPanel is defined in settings.js, loaded after this file.
$("#settingsBtn").addEventListener("click", () => toggleSettingsPanel());
$("#settingsClose").addEventListener("click", () => { $("#settingsPanel").hidden = true; });

$("#sidebarToggle").addEventListener("click", () => {
  $("#sidebar").classList.toggle("collapsed");
  setTimeout(resizeCanvas, 260);
});

$("#closeServerBtn").addEventListener("click", async () => {
  if (!confirm("Shut down the local server (serve.py)? This page will stop working until you run it again.")) return;
  const btn = $("#closeServerBtn");
  btn.disabled = true;
  try {
    await fetch("/api/shutdown", { method: "POST" });
    document.body.innerHTML = "<p style='font:16px sans-serif;padding:2rem;'>Server closed. You may close this tab.</p>";
  } catch (err) {
    // The server closing the connection while responding is expected, not an error.
    document.body.innerHTML = "<p style='font:16px sans-serif;padding:2rem;'>Server closed. You may close this tab.</p>";
  }
});

/* ================================================================
   BOOTSTRAP
   ================================================================ */

// Panels are user-resizable (CSS `resize: horizontal`) so content that
// doesn't fit the default width isn't stuck cut off - this restores the
// last dragged width on load and saves it back whenever it changes, the
// same way other editor-wide preferences persist via Config.
function initResizablePanel(panel, configKey) {
  panel.style.width = Config[configKey] + "px";
  new ResizeObserver(() => {
    const w = Math.round(panel.getBoundingClientRect().width);
    if (w > 0 && w !== Config[configKey]) { Config[configKey] = w; saveConfig(); }
  }).observe(panel);
}

