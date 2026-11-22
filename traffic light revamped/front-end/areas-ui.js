"use strict";

/* ============================================================
   Area classification - rendering, search and panels
   Loaded by BOTH editor.html and simulation.html, AFTER areas.js
   (which owns the data model, the spatial indexes and the focus
   logic this file drives) and BEFORE editor.js/simulation.js.

   Everything here is presentation: the two toggleable area layers
   on the canvas, area hit-testing, the fuzzy place search with its
   suggestion list, the Areas sidebar panel (layer toggles + per-level
   visibility), the Focus panel that recategorises the map by
   jurisdiction, and the shared read-only parts of the area
   inspector. The editing controls that sit on top of that inspector
   live in editor.js, which calls into the mutators in areas.js.
   ============================================================ */

/* ---------------- Layer visibility ---------------- */

// Session + persisted view state (Config keys, see settings.js) - which of
// the two classification layers are drawn, which jurisdiction levels within
// the first one, and whether names are painted over them.
function areaLayerVisible(area) {
  if (area.kind === "zone") return !!Config.showZones;
  if (!Config.showJurisdictions) return false;
  const levels = Config.jurisdictionLevels || {};
  return levels[area.level] !== false;
}

function areaVisible(area) {
  return areaLayerVisible(area) && AreaFocus.isAreaVisible(area);
}

/* ---------------- Rendering ---------------- */

// Zones paint first (they are land-use washes that everything else sits on),
// then jurisdictions coarse-to-fine so a locality outline draws over the city
// outline it sits inside rather than under it.
function drawAreas() {
  if (!State.areas || !State.areas.size) return;
  if (!Config.showJurisdictions && !Config.showZones) return;
  const vis = visibleWorldBounds();

  const zones = [];
  const juris = [];
  for (const a of State.areas.values()) {
    if (!areaVisible(a)) continue;
    if (!rectsOverlap(areaBBox(a), vis)) continue;
    (a.kind === "zone" ? zones : juris).push(a);
  }
  juris.sort((a, b) => JURISDICTION_RANK[a.level] - JURISDICTION_RANK[b.level]);

  for (const a of zones) drawOneArea(a);
  for (const a of juris) drawOneArea(a);
}

function traceAreaPath(poly) {
  ctx.beginPath();
  const p0 = worldToScreen(poly[0].x, poly[0].y);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < poly.length; i++) {
    const p = worldToScreen(poly[i].x, poly[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
}

function drawOneArea(area) {
  const style = areaStyle(area);
  const isSel = isSelected("area", area.id);
  const isFocused = AreaFocus.active && AreaFocus.ids.has(area.id);
  const hl = searchHighlightFactor("area", area.id);

  ctx.save();
  traceAreaPath(area.polygon);

  if (style.fill) {
    ctx.fillStyle = style.fill;
    ctx.fill();
  }
  if (isSel || isFocused) {
    ctx.fillStyle = isSel ? "rgba(67, 97, 238, 0.10)" : "rgba(67, 97, 238, 0.06)";
    ctx.fill();
  }

  ctx.lineJoin = "round";
  ctx.setLineDash(area.kind === "jurisdiction" ? (style.dash || []) : []);
  // A focused/selected/just-searched boundary is drawn heavier and solid so
  // it reads as "this is the thing you asked for" against the dashed
  // administrative hairlines around it.
  const emphasise = isSel || isFocused || hl > 0;
  if (emphasise) ctx.setLineDash([]);
  ctx.lineWidth = (style.width || 1.6) * (emphasise ? 1.9 : 1) + hl * 2.5;
  ctx.strokeStyle = isSel ? "#4361ee" : style.stroke;
  ctx.globalAlpha = 0.95;
  ctx.stroke();
  ctx.restore();
}

// Labels are a separate pass over the areas, drawn after the roads/buildings
// so an area name is never buried under a road surface. A name is skipped
// whenever its polygon is too small on screen to carry it (below
// AREA_LABEL_MIN_PX across), which is what stops a zoomed-out view turning
// into a pile of overlapping administrative names.
const AREA_LABEL_MIN_PX = 90;

function drawAreaLabels() {
  if (!Config.showAreaLabels) return;
  if (!State.areas || !State.areas.size) return;
  if (!Config.showJurisdictions && !Config.showZones) return;
  const vis = visibleWorldBounds();

  // Labels are placed greedily, finest-level jurisdiction first and zones
  // last, with anything that would overlap an already-placed label dropped.
  // Priority that way round because the more specific name is the more
  // useful one for a given spot, and a land-use zone is a secondary
  // classification that should never cover an administrative name. Without
  // this, a zone and the district it sits in print on top of each other
  // wherever their centroids land close together.
  const candidates = [];
  for (const area of State.areas.values()) {
    if (!areaVisible(area)) continue;
    const bb = areaBBox(area);
    if (!rectsOverlap(bb, vis)) continue;
    const widthPx = (bb.maxX - bb.minX) * State.view.scale;
    const heightPx = (bb.maxY - bb.minY) * State.view.scale;
    if (Math.min(widthPx, heightPx) < AREA_LABEL_MIN_PX) continue;
    const c = areaCentroid(area);
    const sp = worldToScreen(c.x, c.y);
    if (sp.x < -100 || sp.x > cssW() + 100 || sp.y < -60 || sp.y > cssH() + 60) continue;
    candidates.push({ area, sp, priority: area.kind === "zone" ? -1 : JURISDICTION_RANK[area.level] });
  }
  candidates.sort((a, b) => b.priority - a.priority);

  const placed = [];
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const { area, sp } of candidates) {
    const style = areaStyle(area);
    const name = areaDisplayName(area);
    const sub = areaTypeLabel(area).toUpperCase();
    const size = area.kind === "jurisdiction" ? (style.label || 12) : 11.5;

    ctx.font = `700 ${size}px 'Space Grotesk', sans-serif`;
    const halfW = ctx.measureText(name).width / 2 + 4;
    const box = {
      minX: sp.x - halfW, maxX: sp.x + halfW,
      minY: sp.y - size * 0.8, maxY: sp.y + size * 1.7, // name + the type line under it
    };
    if (placed.some(p => rectsOverlap(p, box))) continue;
    placed.push(box);
    // A halo instead of a filled plate: the name has to stay readable over a
    // dense road network without hiding what is under it.
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = "rgba(245, 240, 232, 0.9)";
    ctx.strokeText(name, sp.x, sp.y);
    ctx.fillStyle = style.stroke;
    ctx.fillText(name, sp.x, sp.y);

    ctx.font = `600 ${Math.max(8.5, size * 0.62)}px 'Space Grotesk', sans-serif`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(245, 240, 232, 0.9)";
    ctx.strokeText(sub, sp.x, sp.y + size * 0.95);
    ctx.fillStyle = "rgba(60, 56, 70, 0.75)";
    ctx.fillText(sub, sp.x, sp.y + size * 0.95);
  }
  ctx.restore();
}

/* ---------------- Live preview while drawing an area ---------------- */

// Same dashed-outline treatment as the road/building previews in
// map-core's render(), tinted with the pending layer's own colour so it is
// obvious whether a jurisdiction or a zone is being drawn.
function drawAreaDrawingPreview() {
  const da = State.drawingArea;
  if (!da || !da.points.length) return;
  const style = da.kind === "zone"
    ? (ZONE_STYLE[da.zoneType] || ZONE_STYLE_FALLBACK)
    : (JURISDICTION_STYLE[da.level] || JURISDICTION_STYLE.locality);

  const screenPts = da.points.map(p => worldToScreen(p.x, p.y));
  if (State.ghostPoint) screenPts.push(worldToScreen(State.ghostPoint.x, State.ghostPoint.y));

  ctx.save();
  ctx.strokeStyle = style.stroke;
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(screenPts[0].x, screenPts[0].y);
  for (let i = 1; i < screenPts.length; i++) ctx.lineTo(screenPts[i].x, screenPts[i].y);
  if (screenPts.length >= 3) {
    ctx.closePath();
    ctx.fillStyle = style.fill || "rgba(67, 97, 238, 0.08)";
    ctx.fill();
  }
  ctx.stroke();
  ctx.restore();

  for (const sp of screenPts.slice(0, State.ghostPoint ? -1 : undefined)) {
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = style.stroke;
    ctx.fill();
  }
}

/* ---------------- Search result highlight ---------------- */

// A picked search result pulses for a few seconds so the eye can find it
// after the camera jumps, then fades out on its own. Kept as a plain
// timestamp + factor rather than an animation object: render() is already
// running, and markDirty() while the pulse is alive is all it needs.
const SearchHighlight = { type: null, ids: new Set(), until: 0 };

function setSearchHighlight(type, ids, ms = 4200) {
  SearchHighlight.type = type;
  SearchHighlight.ids = new Set(ids);
  SearchHighlight.until = performance.now() + ms;
  markDirty();
}

function clearSearchHighlight() {
  SearchHighlight.type = null;
  SearchHighlight.ids = new Set();
  SearchHighlight.until = 0;
}

// 0 when not highlighted, otherwise a 0..1 pulse that also drives markDirty()
// so the animation keeps ticking without its own rAF loop.
function searchHighlightFactor(type, id) {
  if (SearchHighlight.type !== type || !SearchHighlight.ids.has(id)) return 0;
  const left = SearchHighlight.until - performance.now();
  if (left <= 0) { clearSearchHighlight(); return 0; }
  markDirty();
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
  return pulse * Math.min(1, left / 900);
}

// Ways/buildings/amenities get their highlight painted as an overlay pass
// (after everything else) rather than by changing how they are drawn, so no
// existing draw path has to learn about search at all.
function drawSearchHighlights() {
  if (!SearchHighlight.type || !SearchHighlight.ids.size) return;
  if (SearchHighlight.until - performance.now() <= 0) { clearSearchHighlight(); return; }

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const id of SearchHighlight.ids) {
    const f = searchHighlightFactor(SearchHighlight.type, id);
    if (f <= 0) continue;
    ctx.globalAlpha = 0.35 + 0.5 * f;
    ctx.strokeStyle = "#4361ee";

    if (SearchHighlight.type === "way") {
      const way = State.ways.get(id);
      if (!way) continue;
      const pts = wayPoints(way).map(p => worldToScreen(p.x, p.y));
      if (pts.length < 2) continue;
      ctx.lineWidth = wayDrawWidth(way, wayStyle(way.tags)) + 6 + f * 5;
      traceMixedPath(ctx, pts, way.nodes, way.curve);
      ctx.stroke();
    } else if (SearchHighlight.type === "building") {
      const b = State.buildings.get(id);
      if (!b || b.polygon.length < 3) continue;
      traceAreaPath(b.polygon);
      ctx.lineWidth = 3 + f * 3;
      ctx.stroke();
    } else if (SearchHighlight.type === "amenity" || SearchHighlight.type === "node") {
      const p = SearchHighlight.type === "amenity" ? State.amenities.get(id) : State.nodes.get(id);
      if (!p) continue;
      const sp = worldToScreen(p.x, p.y);
      ctx.lineWidth = 2.5 + f * 2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 14 + f * 10, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/* ---------------- Hit-testing ---------------- */

const AREA_EDGE_TOLERANCE_PX = 10;

// Areas are grabbed by their BOUNDARY, never by their interior fill: a
// country polygon covers the whole map, so an interior hit-test would make
// every click on empty ground select it. The finest (smallest) boundary
// within tolerance wins, so a locality edge running alongside its district
// edge is still reachable.
function findAreaAt(world, tolerancePx = AREA_EDGE_TOLERANCE_PX) {
  if (!State.areas || !State.areas.size) return null;
  const tol = tolerancePx / State.view.scale;
  let best = null, bestSize = Infinity;
  for (const a of State.areas.values()) {
    if (!areaVisible(a)) continue;
    const bb = areaBBox(a);
    if (world.x < bb.minX - tol || world.x > bb.maxX + tol
      || world.y < bb.minY - tol || world.y > bb.maxY + tol) continue;
    if (distPointToPolygonEdge(world, a.polygon) > tol) continue;
    const size = areaSizeM2(a);
    if (size < bestSize) { best = a.id; bestSize = size; }
  }
  return best;
}

/* ============================================================
   FUZZY PLACE SEARCH
   ============================================================ */

// One flat, rebuilt-on-demand list of everything searchable, so a query is a
// single linear scan with no per-kind special cases. Rebuilt whenever the
// areas or the map data change (see the stamp in ensureSearchIndex).
const SearchIndex = {
  built: -1,
  entries: [],
};

function normalizeSearchText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")  // strip accents
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "level" here is the user-facing answer to "what kind of place is this" -
// it is what the suggestion row shows as a badge, and what decides how
// picking the result reframes the map.
function ensureSearchIndex() {
  const stamp = `${AreaIndex.version}|${State.dataVersion || 0}`;
  if (SearchIndex.built === stamp) return;
  SearchIndex.built = stamp;
  const entries = [];

  const push = (e) => {
    e.norm = normalizeSearchText(e.name);
    e.contextNorm = normalizeSearchText(e.context || "");
    if (!e.norm) return;
    entries.push(e);
  };

  // --- areas (both kinds) ---
  for (const area of State.areas.values()) {
    if (!area.name) continue;
    const chain = area.kind === "jurisdiction" ? jurisdictionChainOfArea(area) : jurisdictionChainAtPoint(areaCentroid(area));
    const context = chain.filter(a => a.id !== area.id).map(a => areaDisplayName(a)).reverse().join(", ");
    push({
      kind: "area", id: area.id, name: area.name,
      level: areaTypeLabel(area),
      levelRank: area.kind === "jurisdiction" ? JURISDICTION_RANK[area.level] : 99,
      context,
    });
  }

  // --- roads, grouped by name within their finest common jurisdiction ---
  // One "Ring Road" spanning 40 way records is ONE place, not 40 results; but
  // two unrelated "Main Road"s in different cities stay separate answers.
  const roadGroups = new Map();
  for (const way of State.ways.values()) {
    const name = roadDisplayName(way);
    if (!name) continue;
    const fp = wayAreaFootprint(way.id);
    // Group key: the coarsest jurisdiction the road stays inside of, so a
    // road crossing localities still groups as one road of its district.
    let scopeId = "";
    for (let rank = JURISDICTION_LEVELS.length - 1; rank >= 0; rank--) {
      const set = fp.byRank[rank];
      const real = Array.from(set).filter(x => x !== "\u0000outside");
      if (real.length === 1) { scopeId = real[0]; break; }
    }
    const key = `${normalizeSearchText(name)}|${scopeId}`;
    let g = roadGroups.get(key);
    if (!g) { g = { name, scopeId, wayIds: [], span: fp.span }; roadGroups.set(key, g); }
    g.wayIds.push(way.id);
    g.span = Math.min(g.span, fp.span);
  }
  for (const g of roadGroups.values()) {
    const scope = g.scopeId ? State.areas.get(g.scopeId) : null;
    const context = scope ? chainText(jurisdictionChainOfArea(scope), { fineFirst: true, sep: ", " }) : "";
    push({
      kind: "road", id: g.wayIds[0], wayIds: g.wayIds, name: g.name,
      level: "Road", levelRank: 100, context,
      detail: SPAN_LABEL[g.span],
    });
  }

  // --- named buildings and numbered houses ---
  for (const b of State.buildings.values()) {
    const t = b.tags || {};
    const houseNo = t["addr:housenumber"];
    const named = t.name;
    if (!named && !houseNo) continue;
    const addr = buildingAddress(b);
    const context = addr.parts.slice(named ? 0 : 1).join(", ");
    if (named) {
      push({
        kind: "building", id: b.id, name: named,
        level: t.building && t.building !== "yes" ? zoneLabel(t.building) : "Building",
        levelRank: 200, context,
      });
    }
    if (houseNo) {
      const label = addr.street ? `${houseNo} ${addr.street}` : `House ${houseNo}`;
      push({
        kind: "building", id: b.id, name: label,
        level: "House", levelRank: 210,
        context: [addr.locality, addr.district, addr.city].filter(Boolean).join(", "),
      });
    }
  }

  // --- amenities ---
  for (const a of State.amenities.values()) {
    const t = a.tags || {};
    const name = t.name || t.designation;
    if (!name) continue;
    const chain = jurisdictionChainAtPoint(a);
    push({
      kind: "amenity", id: a.id, name,
      level: t.amenity ? zoneLabel(t.amenity) : "Amenity",
      levelRank: 150,
      context: chain.map(x => areaDisplayName(x)).reverse().join(", "),
    });
  }

  SearchIndex.entries = entries;
}

/* ---------------- Fuzzy matching ---------------- */

// Bounded Levenshtein: bails out as soon as every cell in a row exceeds
// `max`, which turns the usual O(n*m) into something cheap enough to run
// over every index entry on each keystroke.
function boundedLevenshtein(a, b, max) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (!la) return lb;
  if (!lb) return la;
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    const t = prev; prev = cur; cur = t;
  }
  return prev[lb];
}

// How many single-character mistakes a token of this length is allowed to
// carry and still match - short words get almost no slack (otherwise "bank"
// matches "park"), long ones get a typo or three.
function typoBudget(len) {
  if (len <= 3) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  return 3;
}

// Score one query against one candidate string. Higher is better, 0 means no
// match at all. The tiers are deliberately far apart so an exact prefix
// always outranks any fuzzy hit, no matter how long the fuzzy string is.
function matchScore(query, text) {
  if (!query || !text) return 0;
  if (text === query) return 1000;
  if (text.startsWith(query)) return 900 - Math.min(80, text.length - query.length);

  const words = text.split(" ");
  // word-start ("nav" -> "Navyug Market")
  for (const w of words) {
    if (w.startsWith(query)) return 820 - Math.min(60, text.length - query.length);
  }
  if (text.includes(query)) return 720 - Math.min(60, text.length - query.length);

  // initials ("nmp" -> "Navyug Market Post office")
  if (words.length > 1 && query.length >= 2) {
    const initials = words.map(w => w[0]).join("");
    if (initials.startsWith(query)) return 700;
  }

  // Typo-tolerant: best per-word distance, then whole-string distance for a
  // query that spans several words ("navyg market").
  let best = 0;
  const qb = typoBudget(query.length);
  if (qb > 0) {
    for (const w of words) {
      if (Math.abs(w.length - query.length) > qb) continue;
      const d = boundedLevenshtein(query, w, qb);
      if (d <= qb) best = Math.max(best, 600 - d * 90);
    }
    // prefix-of-a-word with typos ("delih col" -> "Delhi Colony")
    for (const w of words) {
      if (w.length <= query.length) continue;
      const head = w.slice(0, query.length);
      const d = boundedLevenshtein(query, head, qb);
      if (d <= qb) best = Math.max(best, 560 - d * 90);
    }
    const wholeBudget = typoBudget(Math.max(query.length, text.length));
    const dWhole = boundedLevenshtein(query, text.slice(0, query.length + wholeBudget), wholeBudget);
    if (dWhole <= wholeBudget) best = Math.max(best, 540 - dWhole * 70);
  }
  return best;
}

// A multi-word query has to match every one of its words SOMEWHERE (name or
// context), which is what makes "market navyug" and "navyug delhi" both work
// while "market paris" correctly finds nothing.
function scoreEntry(entry, queryNorm, queryWords) {
  let score = matchScore(queryNorm, entry.norm);

  if (queryWords.length > 1) {
    let total = 0, matchedAll = true;
    for (const qw of queryWords) {
      const inName = matchScore(qw, entry.norm);
      const inContext = entry.contextNorm ? matchScore(qw, entry.contextNorm) * 0.55 : 0;
      const best = Math.max(inName, inContext);
      if (best <= 0) { matchedAll = false; break; }
      total += best;
    }
    if (matchedAll) score = Math.max(score, total / queryWords.length + 40);
  } else if (score <= 0 && entry.contextNorm) {
    score = matchScore(queryNorm, entry.contextNorm) * 0.45;
  }

  if (score <= 0) return 0;
  // Coarser places win ties: typing "del" should offer the city before a
  // side street of the same name.
  return score - Math.min(60, entry.levelRank * 0.25);
}

const SEARCH_MAX_RESULTS = 12;

function searchPlaces(query, limit = SEARCH_MAX_RESULTS) {
  ensureSearchIndex();
  const norm = normalizeSearchText(query);
  if (!norm) return [];
  const words = norm.split(" ").filter(Boolean);
  const hits = [];
  for (const e of SearchIndex.entries) {
    const score = scoreEntry(e, norm, words);
    if (score > 0) hits.push({ entry: e, score });
  }
  hits.sort((a, b) => b.score - a.score || a.entry.name.length - b.entry.name.length);

  // Collapse duplicates of the same underlying feature (a building that is
  // both named and numbered shows once, as its better-scoring form).
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const key = `${h.entry.kind}|${h.entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

/* ---------------- Camera helper ---------------- */

// Frames a world-space box, leaving a margin so the thing found is not
// welded to the edge of the canvas, and never zooming past a sane close-up
// for a single point.
function frameWorldBounds(bb, { padFrac = 0.22, maxScale = 6 } = {}) {
  const w = Math.max(bb.maxX - bb.minX, 1e-6);
  const h = Math.max(bb.maxY - bb.minY, 1e-6);
  const pad = 1 + padFrac * 2;
  const scale = Math.min(cssW() / (w * pad), cssH() / (h * pad));
  State.view.scale = Math.max(0.02, Math.min(maxScale, scale));
  State.view.cx = (bb.minX + bb.maxX) / 2;
  State.view.cy = (bb.minY + bb.maxY) / 2;
  updateZoomReadout();
  markDirty();
}

function framePoint(p, scale = 3) {
  State.view.scale = scale;
  State.view.cx = p.x;
  State.view.cy = p.y;
  updateZoomReadout();
  markDirty();
}

/* ---------------- Acting on a search result ---------------- */

// Picking an area reframes the whole map around it: the camera fits its
// boundary and the focus is set to exactly that one area, so its outline is
// the only administrative boundary left on screen and the level-of-detail
// table decides how much of the road network inside it is worth drawing.
function gotoArea(areaId, { focus = true } = {}) {
  const area = State.areas.get(areaId);
  if (!area) return;
  if (focus && area.kind === "jurisdiction") {
    AreaFocus.set([areaId]);
    if (typeof renderFocusPanel === "function") renderFocusPanel();
  }
  frameWorldBounds(areaBBox(area), { maxScale: 4 });
  setSelection([{ type: "area", id: areaId }]);
  setSearchHighlight("area", [areaId]);
  const chain = area.kind === "jurisdiction" ? jurisdictionChainOfArea(area) : jurisdictionChainAtPoint(areaCentroid(area));
  showPlaceBanner(areaDisplayName(area), areaTypeLabel(area), chainText(chain.filter(a => a.id !== areaId), { fineFirst: true, sep: ", " }));
}

function gotoRoad(entry) {
  const wayIds = entry.wayIds || [entry.id];
  let bb = null;
  for (const wid of wayIds) {
    const way = State.ways.get(wid);
    if (!way) continue;
    const pts = way.nodes.map(id => State.nodes.get(id)).filter(Boolean);
    if (!pts.length) continue;
    bb = bboxUnion(bb, polygonBounds(pts));
  }
  if (!bb) return;
  // A road that the current focus would hide is not worth jumping to blind -
  // widen the focus to the jurisdictions it actually runs through instead of
  // landing the camera on an empty patch.
  if (AreaFocus.active && !wayIds.some(id => AreaFocus.isWayVisible(id))) {
    const fp = wayAreaFootprint(wayIds[0]);
    const ids = Array.from(fp.touched).filter(id => {
      const a = State.areas.get(id);
      return a && a.kind === "jurisdiction" && JURISDICTION_RANK[a.level] === AreaFocus.rank;
    });
    if (ids.length) AreaFocus.set(ids, { includeLocalRoads: true });
    else AreaFocus.clear();
    if (typeof renderFocusPanel === "function") renderFocusPanel();
  }
  frameWorldBounds(bb, { maxScale: 5 });
  setSelection(wayIds.slice(0, 1).map(id => ({ type: "way", id })));
  setSearchHighlight("way", wayIds);
  showPlaceBanner(entry.name, `Road · ${entry.detail || ""}`.trim(), entry.context);
}

function gotoBuilding(entry) {
  const b = State.buildings.get(entry.id);
  if (!b) return;
  if (AreaFocus.active && !AreaView.isBuildingVisible(b)) {
    const chain = jurisdictionChainOfBuilding(b);
    const finest = chain[chain.length - 1];
    if (finest) AreaFocus.set([finest.id]); else AreaFocus.clear();
    if (typeof renderFocusPanel === "function") renderFocusPanel();
  }
  frameWorldBounds(bboxPad(polygonBounds(b.polygon), 60), { maxScale: 8 });
  setSelection([{ type: "building", id: b.id }]);
  setSearchHighlight("building", [b.id]);
  const addr = buildingAddress(b);
  showPlaceBanner(entry.name, entry.level, addr.text);
}

function gotoAmenity(entry) {
  const a = State.amenities.get(entry.id);
  if (!a) return;
  if (AreaFocus.active && !AreaView.isAmenityVisible(a)) {
    const chain = jurisdictionChainAtPoint(a);
    const finest = chain[chain.length - 1];
    if (finest) AreaFocus.set([finest.id]); else AreaFocus.clear();
    if (typeof renderFocusPanel === "function") renderFocusPanel();
  }
  framePoint(a, 4);
  setSelection([{ type: "amenity", id: a.id }]);
  setSearchHighlight("amenity", [a.id]);
  showPlaceBanner(entry.name, entry.level, entry.context);
}

function gotoSearchEntry(entry) {
  if (entry.kind === "area") gotoArea(entry.id);
  else if (entry.kind === "road") gotoRoad(entry);
  else if (entry.kind === "building") gotoBuilding(entry);
  else if (entry.kind === "amenity") gotoAmenity(entry);
}

/* ---------------- Search UI ---------------- */

// The banner under the search box: what was found, at what level, and where
// it sits in the hierarchy. It is the visible answer to "show me the LEVEL of
// the place I searched" - the badge names the level, the breadcrumb places it.
function showPlaceBanner(name, level, context) {
  const bar = $("#placeBanner");
  if (!bar) return;
  bar.hidden = false;
  $("#placeBannerName").textContent = name;
  $("#placeBannerLevel").textContent = level || "";
  $("#placeBannerContext").textContent = context || "";
}

function hidePlaceBanner() {
  const bar = $("#placeBanner");
  if (bar) bar.hidden = true;
}

const SearchUI = {
  results: [],
  active: -1,
  open: false,
};

function searchKindIcon(kind, level) {
  if (kind === "area") {
    const byLevel = { Country: "🌐", State: "🗺", City: "🏙", District: "🏘", Locality: "📍" };
    return byLevel[level] || "🏷";
  }
  if (kind === "road") return "🛣";
  if (kind === "building") return level === "House" ? "🏠" : "🏢";
  if (kind === "amenity") return "📌";
  return "🔎";
}

function renderSearchResults() {
  const box = $("#placeSearchResults");
  if (!box) return;
  box.innerHTML = "";
  if (!SearchUI.results.length) {
    box.hidden = !SearchUI.open;
    if (SearchUI.open) {
      box.hidden = false;
      box.append(el("div", { class: "search-empty" }, "No place matches that — try fewer letters."));
    }
    return;
  }
  box.hidden = false;

  SearchUI.results.forEach((hit, i) => {
    const e = hit.entry;
    const row = el("div", { class: "search-row" + (i === SearchUI.active ? " active" : "") },
      el("span", { class: "search-icon" }, searchKindIcon(e.kind, e.level)),
      el("div", { class: "search-text" },
        el("div", { class: "search-name" }, e.name),
        el("div", { class: "search-context" }, e.context || (e.detail ? SPAN_LABEL_TEXT(e.detail) : ""))),
      el("span", { class: "search-level" }, e.level));
    row.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      pickSearchResult(i);
    });
    row.addEventListener("mouseenter", () => {
      SearchUI.active = i;
      for (const [j, r] of Array.from(box.children).entries()) r.classList.toggle("active", j === i);
    });
    box.append(row);
  });
}

function SPAN_LABEL_TEXT(detail) { return detail ? `${detail} road` : ""; }

function pickSearchResult(i) {
  const hit = SearchUI.results[i];
  if (!hit) return;
  closeSearchResults();
  const input = $("#placeSearchInput");
  if (input) { input.value = hit.entry.name; input.blur(); }
  gotoSearchEntry(hit.entry);
  // Lets a layer on top of this page (mobile.js's Directions card) act on
  // the pick without this file having to know about it.
  document.dispatchEvent(new CustomEvent("placepicked", { detail: hit.entry }));
}

function closeSearchResults() {
  SearchUI.open = false;
  SearchUI.active = -1;
  const box = $("#placeSearchResults");
  if (box) { box.hidden = true; box.innerHTML = ""; }
}

function runSearch(query) {
  SearchUI.results = searchPlaces(query);
  SearchUI.active = SearchUI.results.length ? 0 : -1;
  SearchUI.open = true;
  renderSearchResults();
}

function initSearchUI() {
  const input = $("#placeSearchInput");
  if (!input) return;

  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (!q) { closeSearchResults(); return; }
    runSearch(q);
  });

  input.addEventListener("focus", () => {
    const q = input.value.trim();
    if (q) runSearch(q);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!SearchUI.results.length) return;
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      SearchUI.active = (SearchUI.active + dir + SearchUI.results.length) % SearchUI.results.length;
      renderSearchResults();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (SearchUI.active >= 0) pickSearchResult(SearchUI.active);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearchResults();
      input.blur();
    }
  });

  input.addEventListener("blur", () => setTimeout(closeSearchResults, 120));

  const clearBtn = $("#placeBannerClose");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      hidePlaceBanner();
      clearSearchHighlight();
      if (AreaFocus.active) {
        AreaFocus.clear();
        if (typeof renderFocusPanel === "function") renderFocusPanel();
      }
      markDirty();
    });
  }

  // Ctrl+K / "/" jump to the search box from anywhere on the page - the one
  // shortcut worth stealing, since finding a place is the most common thing
  // you do without a tool selected.
  window.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault(); input.focus(); input.select(); return;
    }
    if (e.key === "/" && tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") {
      e.preventDefault(); input.focus(); input.select();
    }
  });
}

/* ============================================================
   SIDEBAR PANELS
   ============================================================ */

/* ---------------- Areas panel (layer toggles) ---------------- */

function renderAreasPanel() {
  const box = $("#areaLayersContainer");
  if (!box) return;
  box.innerHTML = "";

  function toggleRow(label, get, set, swatch) {
    const chk = el("input", { type: "checkbox" });
    chk.checked = !!get();
    chk.addEventListener("change", () => { set(chk.checked); saveConfig(); markDirty(); });
    const row = el("div", { class: "checkrow" }, chk);
    if (swatch) row.append(el("span", { class: "area-swatch", style: `background:${swatch.fill || "transparent"};border-color:${swatch.stroke}` }));
    row.append(el("label", {}, label));
    return row;
  }

  box.append(toggleRow("Jurisdictions", () => Config.showJurisdictions, v => { Config.showJurisdictions = v; }));

  const levelBox = el("div", { class: "area-level-list" });
  for (const level of JURISDICTION_LEVELS) {
    const style = JURISDICTION_STYLE[level];
    levelBox.append(toggleRow(
      JURISDICTION_LABEL[level],
      () => (Config.jurisdictionLevels || {})[level] !== false,
      v => {
        if (!Config.jurisdictionLevels) Config.jurisdictionLevels = {};
        Config.jurisdictionLevels[level] = v;
      },
      { stroke: style.stroke, fill: style.fill },
    ));
  }
  box.append(levelBox);

  box.append(el("hr", { class: "area-sep" }));
  box.append(toggleRow("Zones (land use)", () => Config.showZones, v => { Config.showZones = v; }));
  box.append(toggleRow("Area names", () => Config.showAreaLabels, v => { Config.showAreaLabels = v; }));

  // Counts per layer, so it is obvious at a glance whether a level has been
  // mapped at all yet.
  const counts = new Map();
  for (const a of State.areas.values()) {
    const key = a.kind === "jurisdiction" ? a.level : "zone";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const summary = JURISDICTION_LEVELS
    .map(l => `${counts.get(l) || 0} ${JURISDICTION_LABEL[l].toLowerCase()}`)
    .join(" · ");
  box.append(el("div", { class: "area-count" }, `${summary} · ${counts.get("zone") || 0} zone`));
}

/* ---------------- Focus panel (recategorise by jurisdiction) ---------------- */

const FocusPanel = {
  level: "locality",
  filter: "",
  picked: new Set(),
};

function renderFocusPanel() {
  const box = $("#areaFocusContainer");
  if (!box) return;
  box.innerHTML = "";

  // A focus can be set from somewhere other than this panel - a search
  // result, the area inspector's "Load only this area". Re-seed the panel
  // from what is actually loaded so its level dropdown and ticks describe
  // the real state rather than whatever was last picked here.
  if (AreaFocus.active) {
    FocusPanel.level = AreaFocus.level;
    FocusPanel.picked = new Set(AreaFocus.ids);
  }

  const levelSel = el("select", {
    onchange: (e) => {
      FocusPanel.level = e.target.value;
      FocusPanel.picked = new Set();
      renderFocusPanel();
    },
  }, ...JURISDICTION_LEVELS.map(l => el("option", { value: l, selected: l === FocusPanel.level ? "selected" : null }, JURISDICTION_LABEL[l])));
  box.append(el("div", { class: "field" }, el("label", {}, "Load by level"), levelSel));

  const spanLimit = FocusPanel.level && LOD_SPAN_BY_LEVEL[FocusPanel.level];
  box.append(el("div", { class: "area-hint" },
    `Keeps whole roads up to ${SPAN_LABEL[spanLimit]} detail`
    + (spanLimit < SPAN_LOCAL ? ` — local streets inside each ${JURISDICTION_LABEL[FocusPanel.level].toLowerCase()} are dropped.` : " — every road inside is kept.")));

  const filterInput = el("input", { type: "text", placeholder: "Filter by name…", value: FocusPanel.filter });
  filterInput.addEventListener("input", () => {
    FocusPanel.filter = filterInput.value;
    renderFocusList();
  });
  box.append(filterInput);

  const list = el("div", { class: "area-pick-list", id: "areaFocusList" });
  box.append(list);

  const applyBtn = el("button", {
    class: "area-focus-apply",
    onclick: () => {
      if (!FocusPanel.picked.size) { toast("Pick at least one area to load"); return; }
      AreaFocus.set(Array.from(FocusPanel.picked));
      renderFocusPanel();
      // Frame everything that was loaded, so applying a focus always lands
      // the camera on the result rather than leaving it wherever it was.
      let bb = null;
      for (const id of AreaFocus.ids) bb = bboxUnion(bb, areaBBox(id));
      if (bb) frameWorldBounds(bb, { maxScale: 4 });
      const stats = focusStats();
      toast(`Loaded ${AreaFocus.describe()} — ${stats.roads} roads, ${stats.buildings} buildings`);
    },
  }, "Load these areas");
  const clearBtn = el("button", {
    onclick: () => {
      AreaFocus.clear();
      FocusPanel.picked = new Set();
      renderFocusPanel();
      hidePlaceBanner();
      toast("Full map restored");
    },
  }, "Show whole map");

  const localChk = el("input", { type: "checkbox" });
  localChk.checked = AreaFocus.includeLocalRoads;
  localChk.addEventListener("change", () => {
    AreaFocus.includeLocalRoads = localChk.checked;
    if (AreaFocus.active) AreaFocus.set(Array.from(AreaFocus.ids), { includeLocalRoads: localChk.checked });
    renderFocusPanel();
  });
  box.append(el("div", { class: "checkrow" }, localChk, el("label", {}, "Include local roads anyway")));

  const subChk = el("input", { type: "checkbox" });
  subChk.checked = AreaFocus.showSubAreas;
  subChk.addEventListener("change", () => {
    AreaFocus.showSubAreas = subChk.checked;
    markDirty();
  });
  box.append(el("div", { class: "checkrow" }, subChk, el("label", {}, "Show boundaries inside")));

  box.append(applyBtn, clearBtn);

  const status = el("div", { class: "area-count", id: "areaFocusStatus" });
  box.append(status);
  updateFocusStatus();
  renderFocusList();
}

function renderFocusList() {
  const list = $("#areaFocusList");
  if (!list) return;
  list.innerHTML = "";
  const filter = normalizeSearchText(FocusPanel.filter);
  const areas = Array.from(State.areas.values())
    .filter(a => a.kind === "jurisdiction" && a.level === FocusPanel.level)
    .filter(a => !filter || normalizeSearchText(areaDisplayName(a)).includes(filter))
    .sort((a, b) => areaDisplayName(a).localeCompare(areaDisplayName(b)));

  if (!areas.length) {
    list.append(el("div", { class: "area-hint" },
      `No ${JURISDICTION_LABEL[FocusPanel.level].toLowerCase()} drawn yet — use Add ▸ Jurisdiction Area.`));
    return;
  }

  for (const a of areas) {
    const chk = el("input", { type: "checkbox" });
    chk.checked = FocusPanel.picked.has(a.id);
    chk.addEventListener("change", () => {
      if (chk.checked) FocusPanel.picked.add(a.id); else FocusPanel.picked.delete(a.id);
    });
    const row = el("div", { class: "checkrow area-pick-row" + (AreaFocus.ids.has(a.id) ? " loaded" : "") },
      chk,
      el("label", {}, areaDisplayName(a)));
    row.title = chainText(jurisdictionChainOfArea(a), { fineFirst: true, sep: ", " });
    list.append(row);
  }
}

function updateFocusStatus() {
  const status = $("#areaFocusStatus");
  if (!status) return;
  if (!AreaFocus.active) {
    status.textContent = "Whole map loaded";
    status.classList.remove("active");
    return;
  }
  const stats = focusStats();
  status.classList.add("active");
  status.textContent = `${AreaFocus.describe()} loaded · ${stats.roads} roads · ${stats.buildings} buildings · ${stats.amenities} amenities`;
}

/* ============================================================
   INSPECTOR (shared, read-only parts)
   ============================================================ */

// The address block shown on a building in BOTH pages: the derived
// hierarchy, the street, and the station that would answer a call there.
// editor.js appends its own editable house-number/street fields under this.
function renderAddressReadout(b) {
  const wrap = el("div", {});
  const addr = buildingAddress(b);
  wrap.append(el("div", { class: "section-title" }, "Address"));
  wrap.append(el("div", { class: "field" }, el("label", {}, "Full address"), el("div", { class: "readonly" }, addr.text)));

  const rows = [
    ["House number", addr.house || "(not set)"],
    ["Street", addr.street || "(no named road nearby)"],
    ["Locality", addr.locality || "—"],
    ["District", addr.district || "—"],
    ["City", addr.city || "—"],
    ["State", addr.state || "—"],
    ["Country", addr.country || "—"],
  ];
  for (const [label, value] of rows) {
    wrap.append(el("div", { class: "field" }, el("label", {}, label), el("div", { class: "readonly" }, value)));
  }

  const zone = zoneAtPoint(buildingCentroid(b));
  wrap.append(el("div", { class: "field" }, el("label", {}, "Land-use zone"),
    el("div", { class: "readonly" }, zone ? `${areaDisplayName(zone)} · ${zoneLabel(zone.zoneType)}` : "—")));

  const police = policingStationAt(buildingCentroid(b));
  wrap.append(el("div", { class: "field" }, el("label", {}, "Policed by"),
    el("div", { class: "readonly" }, police
      ? `${amenityDisplayName(police.amenity)} (${areaDisplayName(police.area)})`
      : "— no station assigned to this jurisdiction")));

  return wrap;
}

// The same idea for a road: where it runs and how far it reaches, which is
// also the value the level-of-detail focus keys off.
function renderRoadAreaReadout(way) {
  const wrap = el("div", {});
  const fp = wayAreaFootprint(way.id);
  wrap.append(el("div", { class: "section-title" }, "Area classification"));

  for (let rank = 0; rank < JURISDICTION_LEVELS.length; rank++) {
    const names = Array.from(fp.byRank[rank])
      .filter(id => id !== "\u0000outside")
      .map(id => areaDisplayName(State.areas.get(id)))
      .sort();
    if (!names.length) continue;
    wrap.append(el("div", { class: "field" },
      el("label", {}, JURISDICTION_LABEL[JURISDICTION_LEVELS[rank]]),
      el("div", { class: "readonly" }, names.join(", "))));
  }
  wrap.append(el("div", { class: "field" }, el("label", {}, "Reach"),
    el("div", { class: "readonly" }, `${SPAN_LABEL[fp.span]} road — kept when loading ${SPAN_LABEL[fp.span] === "local" ? "a district or locality" : `any level down to ${JURISDICTION_LABEL[JURISDICTION_LEVELS[Math.max(0, fp.span - 1)]] || "country"}`}`)));
  return wrap;
}

// Read-only summary of an area itself - the editor builds its editable
// inspector around this same information (see renderAreaInspector there).
function renderAreaReadout(area) {
  const wrap = el("div", {});
  const chain = area.kind === "jurisdiction"
    ? jurisdictionChainOfArea(area)
    : jurisdictionChainAtPoint(areaCentroid(area));

  wrap.append(el("div", { class: "field" }, el("label", {}, "Type"),
    el("div", { class: "readonly" }, areaTypeLabel(area))));
  wrap.append(el("div", { class: "field" }, el("label", {}, "Sits in"),
    el("div", { class: "readonly" }, chainText(chain.filter(a => a.id !== area.id), { fineFirst: true, sep: ", " }) || "— not inside any larger area")));

  const km2 = areaSizeM2(area) / 1e6;
  wrap.append(el("div", { class: "field" }, el("label", {}, "Size"),
    el("div", { class: "readonly" }, km2 >= 0.01 ? `${km2.toFixed(2)} km²` : `${Math.round(areaSizeM2(area))} m²`)));

  if (area.kind === "jurisdiction") {
    const children = childAreasOf(area);
    if (children.length) {
      const byLevel = new Map();
      for (const c of children) byLevel.set(c.level, (byLevel.get(c.level) || 0) + 1);
      wrap.append(el("div", { class: "field" }, el("label", {}, "Contains"),
        el("div", { class: "readonly" }, Array.from(byLevel.entries())
          .map(([l, n]) => `${n} ${JURISDICTION_LABEL[l].toLowerCase()}${n === 1 ? "" : "s"}`).join(", "))));
    }
    const buildings = buildingsInsideArea(area);
    const numbered = buildings.filter(b => b.tags && b.tags["addr:housenumber"]).length;
    wrap.append(el("div", { class: "field" }, el("label", {}, "Buildings inside"),
      el("div", { class: "readonly" }, `${buildings.length} (${numbered} numbered)`)));
  }
  return wrap;
}

// Every finer jurisdiction whose centroid falls inside this one - the
// hierarchy read downward, derived the same geometric way as the upward
// chain so the two can never disagree.
function childAreasOf(area) {
  if (area.kind !== "jurisdiction") return [];
  const rank = JURISDICTION_RANK[area.level];
  const out = [];
  for (const other of State.areas.values()) {
    if (other.kind !== "jurisdiction" || other.id === area.id) continue;
    if (JURISDICTION_RANK[other.level] <= rank) continue;
    if (pointInPolygon(areaCentroid(other), area.polygon)) out.push(other);
  }
  out.sort((a, b) => JURISDICTION_RANK[a.level] - JURISDICTION_RANK[b.level] || areaDisplayName(a).localeCompare(areaDisplayName(b)));
  return out;
}

// The inspector's heading for an area: "City · Ghaziabad", but just
// "Residential zone" while it is still unnamed - areaDisplayName already
// falls back to "Unnamed <type>", so prefixing the type again read as
// "Residential zone · Unnamed Residential zone".
function areaInspectorTitle(area) {
  if (!area) return "Area";
  return area.name ? `${areaTypeLabel(area)} · ${area.name}` : areaDisplayName(area);
}

/* ---------------- Boot ---------------- */

function initAreasUI() {
  if (!Config.jurisdictionLevels) Config.jurisdictionLevels = {};
  renderAreasPanel();
  renderFocusPanel();
  initSearchUI();
}
