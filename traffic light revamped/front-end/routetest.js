"use strict";

/* ============================================================
   ROUTING (permanent feature)
   ------------------------------------------------------------
   Point-to-point shortest-path routing, backed by the bidirectional-
   Dijkstra/CH query engine (ch/ch_query.cpp, driven through serve.py's
   POST /api/route). Mark a start and an end point - either an existing
   intersection, or anywhere along a road - and Run computes the fastest
   route between them, drawn on the map with a distance/time summary.
   An optional "Show search internals" toggle also draws both search
   frontiers' explored nodes/roads, useful for sanity-checking the engine
   (see the explored/path ratio it reports).

   Mid-road points: clicking a road (not an existing node) doesn't just
   snap to the nearer endpoint - it resolves the exact clicked point
   against that road's real node chain (resolveVirtualPoint below), and
   sends ch_query.exe a "virtual point" spec instead of a plain node id
   (see ch_query.cpp's EndpointSpec / parseEndpointSpec for the wire
   format). For an ordinary (undivided) road this just means "free to head
   either way from here", same as clicking an intersection. For a DIVIDED
   road (tags.divider="yes", rendered with a centre median - see
   drawLaneDecorations in map-core.js) it resolves which physical
   carriageway the click landed on and restricts the route to that
   direction only - so a destination that's physically behind you on the
   other carriageway correctly routes via a real U-turn point or
   intersection instead of "teleporting" across the median at the start.

   Depends on globals defined in map-core.js/editor.js (same page, loaded
   first): State, setTool, TOOL_HINTS, markDirty, toast, worldToScreen, ctx,
   el, $, isYes, findWayAt.
   ============================================================ */

// Mirrors ch_preprocess.cpp's fallbackSpeedKmh() table exactly, for
// estimating a mid-road click's partial-edge travel time client-side (the
// server only ever sees the already-computed distToA/distToB, never the
// way's tags) - see ch_preprocess.cpp for why these particular values.
const ROUTE_FALLBACK_SPEED_KMH = {
  motorway: 90, trunk: 60, primary: 60, secondary: 60, tertiary: 60, unclassified: 60,
  motorway_link: 45, trunk_link: 30, primary_link: 30, secondary_link: 30, tertiary_link: 30,
  residential: 35, living_street: 27, service: 35,
};

// True iff nodeId is the FIRST or LAST node of at least one of its connected
// ways - i.e. a real crossing point (an intersection approach, per this
// project's "pulled-back endpoints + join_group clique" junction model - see
// ch_preprocess.cpp's file header - or a plain dead end), never a purely
// interior shape vertex. Matters for routing specifically because
// ch_preprocess.cpp's buildGraph() only leaves a divided way's OWN endpoints
// travel-direction-unrestricted (see the #fwd/#bwd comment there) - clicking
// exactly on an interior vertex is physically no different from clicking
// 2px to either side of it, so it must resolve through the same mid-road/
// side-of-road logic as any other point along that road, not be treated as
// a free "come from anywhere" node.
function routeIsWayEndpointNode(nodeId) {
  const wayIds = State.nodeWayIndex.get(nodeId);
  if (!wayIds) return false;
  for (const wid of wayIds) {
    const way = State.ways.get(wid);
    if (way && (way.nodes[0] === nodeId || way.nodes[way.nodes.length - 1] === nodeId)) return true;
  }
  return false;
}

// Any one way that has nodeId as an interior (non-endpoint) vertex - used to
// resolve a click that landed on such a node via the normal mid-road path
// instead. Node ids are unique to a single way's interior by construction
// (junctions are always split to endpoints - see routeIsWayEndpointNode's
// comment), so "any" connected way is unambiguous in practice.
function routeWayContainingInteriorNode(nodeId) {
  const wayIds = State.nodeWayIndex.get(nodeId);
  if (!wayIds) return null;
  for (const wid of wayIds) {
    const way = State.ways.get(wid);
    if (way) return way;
  }
  return null;
}

function routeWayEffectiveSpeedMps(way) {
  const tags = way.tags || {};
  let kmh = parseFloat(tags.avg_max_speed);
  if (!(kmh > 0)) kmh = parseFloat(tags.maxspeed);
  if (!(kmh > 0)) kmh = ROUTE_FALLBACK_SPEED_KMH[tags.highway] ?? 30;
  return kmh / 3.6;
}

// Mirrors ch_preprocess.cpp's buildGraph() oneway/junction=roundabout
// forward/backward derivation exactly, so a mid-road click never offers a
// direction the routing graph itself wouldn't actually allow.
function routeWayLegalDirections(way) {
  const tags = way.tags || {};
  const oneway = tags.oneway || "";
  let forward = true, backward = true;
  if (isYes(oneway)) backward = false;
  else if (oneway.trim() === "-1") forward = false;
  else if (!isYes(oneway) && oneway.trim() !== "no" && tags.junction === "roundabout") backward = false;
  return { forward, backward };
}

// Strips a ch_preprocess.cpp "#fwd"/"#bwd" synthetic-node suffix (see its
// buildGraph() comment) back to the real map_data.json node id, so a path
// point returned by ch_query.exe can be looked up in State.nodes/way.nodes.
function routeBaseNodeId(id) {
  const i = id.indexOf("#");
  return i === -1 ? id : id.slice(0, i);
}

// World-space (y-up) left-hand-traffic normal: for a vehicle travelling
// along direction (dx,dy), this points toward the carriageway it should be
// on (India drives on the left). Same cross-product relationship verified
// in resolveVirtualPoint below - rotating the direction vector +90 degrees
// (CCW in a y-up frame) is "left of the direction you're facing".
function routeWorldLeftNormal(dx, dy) {
  const len = Math.max(1e-6, Math.hypot(dx, dy));
  return { x: -dy / len, y: dx / len };
}

// Finds the way that has real node ids idA/idB as adjacent chain entries (in
// either order), returning it only if that way is a DIVIDED two-way road
// (the only case where a route line drawn straight through the centreline
// would visibly run over the median). Returns null for an ordinary road (no
// side-offset needed - there's no divider to sit "over" in the first place)
// or when no such adjacency is found (e.g. a CH shortcut edge whose two path
// nodes aren't directly chain-adjacent in the same way - conservatively
// drawn on the centreline rather than guessing a side).
function routeDividedWayBetween(idA, idB) {
  const wayIds = State.nodeWayIndex.get(idA);
  if (!wayIds) return null;
  for (const wid of wayIds) {
    const way = State.ways.get(wid);
    if (!way) continue;
    for (let i = 0; i + 1 < way.nodes.length; i++) {
      const a = way.nodes[i], b = way.nodes[i + 1];
      if ((a === idA && b === idB) || (a === idB && b === idA)) {
        return (isYes(way.tags.divider) && !isYes(way.tags.oneway)) ? way : null;
      }
    }
  }
  return null;
}

const RouteTest = (() => {
  const state = {
    start: null,   // {x, y, spec} - spec: {kind:"node", id} | {kind:"virtual", nodeA, nodeB, distToA, distToB, directions}
    end: null,
    result: null,
    running: false,
    showInternals: false,
  };

  // Resolves a click already known to have landed on `way` into a virtual
  // routing point: the two real bracketing chain nodes, the partial-edge
  // travel time to each, and which travel direction(s) are legal right at
  // that point. Deliberately scans the way's own real node chain (not the
  // curve-interpolated points used for on-screen hit-testing/rendering) -
  // routing only ever cares about real graph nodes.
  function resolveVirtualPoint(way, world) {
    const speedMps = routeWayEffectiveSpeedMps(way);
    let best = null;
    for (let i = 0; i + 1 < way.nodes.length; i++) {
      const A = State.nodes.get(way.nodes[i]);
      const B = State.nodes.get(way.nodes[i + 1]);
      if (!A || !B) continue;
      const abx = B.x - A.x, aby = B.y - A.y;
      const apx = world.x - A.x, apy = world.y - A.y;
      const lenSq = abx * abx + aby * aby;
      let t = lenSq > 1e-9 ? (apx * abx + apy * aby) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const px = A.x + abx * t, py = A.y + aby * t;
      const d = Math.hypot(world.x - px, world.y - py);
      if (best && d >= best.d) continue;
      const segLen = Math.hypot(abx, aby);
      // World-space cross product of (A->B) with (A->click). worldToScreen
      // flips Y (screen y = ... - ry*scale), which flips the sign of any
      // cross product computed in screen space relative to world space - so
      // in WORLD coordinates, positive here is the A->B-direction carriageway
      // and negative is the B->A one (India drives on the left: facing
      // A->B, your own carriageway is your left, which works out to
      // cross > 0 once that screen/world flip is accounted for - verified
      // against the actual rendered lane offset, not just derived on paper).
      const cross = abx * apy - aby * apx;
      best = {
        d, x: px, y: py,
        nodeA: way.nodes[i], nodeB: way.nodes[i + 1],
        distToA: (t * segLen) / speedMps,
        distToB: ((1 - t) * segLen) / speedMps,
        crossSign: cross > 0 ? 1 : cross < 0 ? -1 : 0,
      };
    }
    if (!best) return null;

    const { forward, backward } = routeWayLegalDirections(way);
    const divided = isYes(way.tags.divider) && !isYes(way.tags.oneway);
    let directions;
    if (forward && !backward) directions = "AtoB";
    else if (backward && !forward) directions = "BtoA";
    else if (divided) directions = best.crossSign >= 0 ? "AtoB" : "BtoA";
    else directions = "both";

    // The click was resolved onto the way's CENTRELINE (the projection of
    // the click onto the A-B segment), which is exactly where the physical
    // median sits on a divided road - not where the correct-side carriageway
    // actually is. Nudge the marker/query point off the centreline and onto
    // the middle of whichever carriageway `directions` picked, so it (and
    // any route drawn to/from it) renders on the correct side of the
    // divider instead of straight through it.
    if (divided) {
      const A = State.nodes.get(best.nodeA), B = State.nodes.get(best.nodeB);
      const n = routeWorldLeftNormal(B.x - A.x, B.y - A.y);
      const halfCarriageway = wayPhysicalWidth(way) / 4;
      const sign = directions === "AtoB" ? 1 : -1;
      best.x += n.x * halfCarriageway * sign;
      best.y += n.y * halfCarriageway * sign;
    }

    return { x: best.x, y: best.y, nodeA: best.nodeA, nodeB: best.nodeB,
             distToA: best.distToA, distToB: best.distToB, directions };
  }

  function markPoint(tool, point) {
    if (tool === "routeStart") state.start = point; else state.end = point;
    state.result = null; // stale until re-run
    updateStatus();
    markDirty();
  }

  function specToRequestValue(spec) {
    if (spec.kind === "node") return spec.id;
    return { nodeA: spec.nodeA, nodeB: spec.nodeB, distToA: spec.distToA, distToB: spec.distToB, directions: spec.directions };
  }

  // The server's path[0]/path[last] are always the real graph nodes a
  // virtual point connects through, not the clicked point itself (ch_query
  // has no idea where exactly along that edge the click was) - stitch the
  // browser's own known coordinate on for drawing/distance purposes. `id` is
  // kept (raw, possibly "#fwd"/"#bwd"-suffixed) and stitched points carry a
  // `wayHint` of their originating segment's [nodeA, nodeB] - both consumed
  // only by offsetDisplayPath() below to find which divided way an edge runs
  // along; nothing else in this file looks at either field.
  function displayPath(result) {
    if (!result || !result.found) return null;
    const pts = result.path.map(p => ({ x: p.x, y: p.y, id: p.id }));
    if (state.start && state.start.spec.kind === "virtual") {
      pts.unshift({ x: state.start.x, y: state.start.y, wayHint: [state.start.spec.nodeA, state.start.spec.nodeB] });
    }
    if (state.end && state.end.spec.kind === "virtual") {
      pts.push({ x: state.end.x, y: state.end.y, wayHint: [state.end.spec.nodeA, state.end.spec.nodeB] });
    }
    return pts;
  }

  // displayPath()'s points sit on each road's CENTRELINE (real chain-node
  // positions, or - for a virtual endpoint - already nudged onto the correct
  // carriageway by resolveVirtualPoint). Drawing that centreline path
  // straight through a divided road's interior would run the line right
  // over the median, so this pushes every point touched by a divided-way
  // edge sideways onto that edge's correct carriageway (same left-hand-
  // traffic rule as resolveVirtualPoint), purely for rendering - the
  // reported distance/time and the underlying query are untouched. A point
  // touched by two divided-way edges (e.g. sitting between two consecutive
  // interior vertices of the same road) gets the average of both - they're
  // the same road/side in practice, so this is only ever a tiny smoothing
  // effect, never a conflict.
  function offsetDisplayPath(pts) {
    if (!pts || pts.length < 2) return pts;
    const n = pts.length;
    const acc = pts.map(() => ({ x: 0, y: 0, count: 0 }));
    for (let i = 0; i < n - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      let way;
      if (p.id != null && q.id != null) {
        way = routeDividedWayBetween(routeBaseNodeId(p.id), routeBaseNodeId(q.id));
      } else {
        const hint = p.wayHint || q.wayHint;
        way = hint ? routeDividedWayBetween(hint[0], hint[1]) : null;
      }
      if (!way) continue;
      const nrm = routeWorldLeftNormal(q.x - p.x, q.y - p.y);
      const mag = wayPhysicalWidth(way) / 4;
      acc[i].x += nrm.x * mag; acc[i].y += nrm.y * mag; acc[i].count++;
      acc[i + 1].x += nrm.x * mag; acc[i + 1].y += nrm.y * mag; acc[i + 1].count++;
    }
    return pts.map((p, i) => {
      const a = acc[i];
      return a.count ? { x: p.x + a.x / a.count, y: p.y + a.y / a.count } : { x: p.x, y: p.y };
    });
  }

  function pathDistanceMeters(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return d;
  }

  // ch_query.cpp only ever connects a virtual point to its OWN edge's two
  // real bracketing nodes - it has no idea a second virtual point might sit
  // on that exact same edge. Without this, two mid-road points on the same
  // segment would only "find" each other by detouring out to a real node and
  // back, even though travelling directly between them is legal and shorter.
  // Synthesizes a result shaped like the server's, so the normal
  // displayPath()/updateStatus() code needs no special-casing - with an
  // empty `path`, displayPath()'s existing virtual-endpoint stitching alone
  // produces exactly [start, end].
  function directSameEdgeCandidate() {
    const s = state.start, e = state.end;
    if (!s || !e || s.spec.kind !== "virtual" || e.spec.kind !== "virtual") return null;
    if (s.spec.nodeA !== e.spec.nodeA || s.spec.nodeB !== e.spec.nodeB) return null;
    const dirs = s.spec.directions; // same edge -> identical directions by construction
    const towardB = e.spec.distToB < s.spec.distToB; // end sits further toward B than start
    const legal = dirs === "both" || (towardB && dirs === "AtoB") || (!towardB && dirs === "BtoA");
    if (!legal) return null;
    return {
      ok: true, found: true,
      distanceSec: Math.abs(s.spec.distToA - e.spec.distToA),
      path: [],
      exploredForward: [], exploredBackward: [],
      exploredForwardSegments: [], exploredBackwardSegments: [],
      stats: { forwardSettled: 0, backwardSettled: 0, pathNodes: 0 },
    };
  }

  async function runQuery() {
    if (!state.start || !state.end) {
      toast("Route: mark both a start and an end point first");
      return;
    }
    state.running = true;
    updateStatus();
    try {
      const direct = directSameEdgeCandidate();
      let body;
      try {
        const res = await fetch("/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start: specToRequestValue(state.start.spec),
            end: specToRequestValue(state.end.spec),
          }),
        });
        const parsed = await res.json().catch(() => ({}));
        if (!res.ok || !parsed.ok) throw new Error(parsed.error || `HTTP ${res.status}`);
        body = parsed;
      } catch (err) {
        if (!direct) throw err;
        body = { ok: true, found: false };
      }
      // The direct same-edge leg only wins when it's actually shorter (or the
      // graph search found nothing at all) - a detour via faster roads
      // elsewhere is a legitimate reason for the searched route to win instead.
      if (direct && (!body.found || direct.distanceSec < body.distanceSec)) body = direct;
      state.result = body;
      if (!body.found) {
        toast("Route: no route found between those points");
      } else {
        const pts = displayPath(body);
        const km = pathDistanceMeters(pts) / 1000;
        const min = body.distanceSec / 60;
        toast(`Route: ${min < 1 ? Math.round(body.distanceSec) + "s" : min.toFixed(1) + " min"} - ${km.toFixed(2)} km`);
      }
    } catch (err) {
      state.result = null;
      toast("Route query failed: " + err.message);
    } finally {
      state.running = false;
      updateStatus();
      markDirty();
    }
  }

  function clearMarks() {
    state.start = null;
    state.end = null;
    state.result = null;
    updateStatus();
    markDirty();
  }

  function setShowInternals(on) {
    state.showInternals = on;
    markDirty();
  }

  function pointLabel(point) {
    if (!point) return "-";
    return point.spec.kind === "node" ? point.spec.id : "mid-road point";
  }

  function updateStatus() {
    const box = document.getElementById("routeTestStatus");
    if (!box) return;
    const parts = [];
    parts.push("Start: " + pointLabel(state.start));
    parts.push("End: " + pointLabel(state.end));
    if (state.running) {
      parts.push("Running…");
    } else if (state.result) {
      if (state.result.found) {
        const pts = displayPath(state.result);
        const km = pathDistanceMeters(pts) / 1000;
        const min = state.result.distanceSec / 60;
        parts.push(`${min < 1 ? Math.round(state.result.distanceSec) + "s" : min.toFixed(1) + " min"}`);
        parts.push(`${km.toFixed(2)} km`);
      } else {
        parts.push("No route found");
      }
      if (state.showInternals) {
        const st = state.result.stats || {};
        const edgeStats = classifyExploredEdges(state.result);
        const totalExplored = st.forwardSettled + st.backwardSettled;
        const ratio = st.pathNodes ? (totalExplored / st.pathNodes).toFixed(1) : "-";
        parts.push(`explored fwd/bwd ${st.forwardSettled}/${st.backwardSettled} (${ratio}x path)`);
        parts.push(`roads fwd-only/bwd-only/shared: ${edgeStats.fwdOnly.length}/${edgeStats.bwdOnly.length}/${edgeStats.shared.length}`);
      }
    }
    box.textContent = parts.join(" · ");
  }

  function drawDots(nodeList, color, radius) {
    if (!nodeList || !nodeList.length) return;
    ctx.save();
    ctx.fillStyle = color;
    for (const n of nodeList) {
      const sp = worldToScreen(n.x, n.y);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Splits ch_query.cpp's multi-point segments (one per settled node's tree
  // edge, already unpacked to real road nodes) into individual 2-point road
  // edges, so forward/backward overlap can be classified edge-by-edge
  // instead of only per whole segment.
  function explodeEdges(segments) {
    const edges = [];
    if (!segments) return edges;
    for (const seg of segments) {
      if (!seg || seg.length < 2) continue;
      for (let i = 0; i < seg.length - 1; i++) edges.push([seg[i], seg[i + 1]]);
    }
    return edges;
  }
  function edgeKey(a, b) {
    // Undirected: a road either search direction walked over counts as
    // "the same road" for overlap purposes, regardless of which way.
    return a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id;
  }

  // Classifies every explored road edge into forward-only / backward-only /
  // walked by both searches. Shared by draw() (to color them differently)
  // and updateStatus() (to report the shared count as an explicit number).
  function classifyExploredEdges(r) {
    const fwdEdges = explodeEdges(r.exploredForwardSegments);
    const bwdEdges = explodeEdges(r.exploredBackwardSegments);
    const fwdKeys = new Set(fwdEdges.map(([a, b]) => edgeKey(a, b)));
    const bwdKeys = new Set(bwdEdges.map(([a, b]) => edgeKey(a, b)));
    return {
      fwdOnly: fwdEdges.filter(([a, b]) => !bwdKeys.has(edgeKey(a, b))),
      bwdOnly: bwdEdges.filter(([a, b]) => !fwdKeys.has(edgeKey(a, b))),
      shared: fwdEdges.filter(([a, b]) => bwdKeys.has(edgeKey(a, b))),
    };
  }

  // Draws a flat list of 2-point road edges as one stroked path, so the
  // visited ROADS are visible - not just the visited nodes - letting you
  // eyeball how much road the search actually covered versus the final path.
  function drawEdgeList(edges, color, width) {
    if (!edges || !edges.length) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const [a, b] of edges) {
      const spA = worldToScreen(a.x, a.y);
      const spB = worldToScreen(b.x, b.y);
      ctx.moveTo(spA.x, spA.y);
      ctx.lineTo(spB.x, spB.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawPath(pts) {
    if (!pts || pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = "#2ecc71";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    pts.forEach((n, i) => {
      const sp = worldToScreen(n.x, n.y);
      if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  function drawMarker(point, label, color) {
    if (!point) return;
    const sp = worldToScreen(point.x, point.y);
    ctx.save();
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#1a1a2e";
    ctx.stroke();
    ctx.fillStyle = "#1a1a2e";
    ctx.font = "bold 11px 'Space Grotesk', sans-serif";
    ctx.fillText(label, sp.x + 10, sp.y - 8);
    ctx.restore();
  }

  function draw() {
    if (!state.start && !state.end && !state.result) return;
    const r = state.result;
    if (r) {
      if (state.showInternals) {
        // Two independent frontiers commonly reconverge onto much of the same
        // corridor near where they meet, and drawing one color flat on top of
        // the other would silently hide whichever direction happened to be
        // drawn second. Classifying edges into forward-only / backward-only /
        // walked-by-both and giving the overlap its own color makes that
        // overlap visible instead of erasing it.
        const { fwdOnly, bwdOnly, shared } = classifyExploredEdges(r);
        drawEdgeList(bwdOnly, "rgba(249,199,79,0.45)", 3);   // backward only: amber
        drawEdgeList(fwdOnly, "rgba(76,201,240,0.45)", 3);   // forward only: cyan
        drawEdgeList(shared, "rgba(186,104,255,0.8)", 3.4);  // walked by both: purple, on top
        drawDots(r.exploredBackward, "rgba(249,199,79,0.6)", 2.2);
        drawDots(r.exploredForward, "rgba(76,201,240,0.6)", 2.2);
      }
      if (r.found) drawPath(offsetDisplayPath(displayPath(r)));
    }
    drawMarker(state.start, "S", "#4361ee");
    drawMarker(state.end, "E", "#ef476f");
  }

  return {
    markPoint, resolveVirtualPoint, runQuery, clearMarks, setShowInternals, draw,
    isWayEndpointNode: routeIsWayEndpointNode,
    wayContainingInteriorNode: routeWayContainingInteriorNode,
  };
})();
window.RouteTest = RouteTest;

TOOL_HINTS.routeStart = "Route: click an intersection or anywhere along a road to set the route START.";
TOOL_HINTS.routeEnd = "Route: click an intersection or anywhere along a road to set the route END.";

(function initRouteTestSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  const internalsChk = el("input", { type: "checkbox" });
  internalsChk.addEventListener("change", () => RouteTest.setShowInternals(internalsChk.checked));

  const section = el("div", { class: "sidebar-section", id: "routeTestSection" },
    el("div", { class: "sidebar-section-title" }, "Route"),
    el("button", {
      class: "tool-btn", "data-tool": "routeStart",
      title: "Click an intersection or a road to set the route start",
    }, "📍 Mark Start"),
    el("button", {
      class: "tool-btn", "data-tool": "routeEnd",
      title: "Click an intersection or a road to set the route end",
    }, "🏁 Mark End"),
    el("button", {
      id: "routeRunBtn",
      title: "Run the shortest-path query between the marked points",
    }, "▶ Run"),
    el("button", {
      id: "routeClearBtn",
      title: "Clear the marked start/end and any drawn result",
    }, "✕ Clear"),
    el("div", { class: "checkrow", style: "margin-top:6px;" }, internalsChk, el("label", {}, "Show search internals")),
    el("div", {
      id: "routeTestStatus",
      style: "font-size:11px;color:rgba(255,255,255,0.55);margin-top:6px;line-height:1.5;",
    }),
  );
  sidebar.appendChild(section);

  section.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => setTool(btn.dataset.tool));
  });
  document.getElementById("routeRunBtn").addEventListener("click", RouteTest.runQuery);
  document.getElementById("routeClearBtn").addEventListener("click", RouteTest.clearMarks);
})();
