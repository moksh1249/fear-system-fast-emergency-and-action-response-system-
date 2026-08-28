"use strict";

/* ============================================================
   Redlight (fixed-time traffic signal) system.

   A node may carry a `signal` object (sibling to x/y/tags) - this is one
   "redlight instance" for that intersection:
     { allRedSec, phases: [ { id, label, wayIds:[...], greenSec, yellowSec } ],
       groupId? }
   Phases run in order, each showing green then yellow for its listed
   approaches, followed by an all-red clearance shared by every phase, then
   the cycle repeats.

   Multiple redlight instances (possibly at different intersections) can be
   combined into a group via createRedlightGroup(): within a group, member
   intersections take turns - only the intersection whose turn it is runs its
   own phase plan, every other member shows all-red - so only one member of
   the group is ever "in control" (green) at a time.

   Everything here is pure data + math + rendering; addRedlight/removeRedlight
   mutate State.nodes / State.redlightGroups the same way the rest of the
   editor mutates State, so undo/redo and save/load (in editor.js) carry
   redlight instances and groups along for free.
   ============================================================ */

/* ---------------- Geometry: connected approaches ---------------- */

// When `nodeId` has been joined with others into one group (see
// joinNodesIntoGroup in editor.js), a single traffic light governs every
// approach across every member - so this pools each member's own connected
// ways into one list instead of just nodeId's own. Every approach keeps its
// own home node's real position (homeNodeId/dirX/dirY computed from THAT
// node, not nodeId) so stop lines and lamps still place correctly on
// whichever member's road they actually belong to (see drawStopLine,
// drawLampGlyph) - only the signal DATA and phase config live in one place
// (the group's primary node - see junctionPrimary), never the geometry.
function connectedWaysSorted(nodeId) {
  const members = (typeof junctionCluster === "function") ? junctionCluster(nodeId) : [nodeId];
  const approaches = [];
  for (const homeId of members) {
    const node = State.nodes.get(homeId);
    if (!node) continue;
    const wayIds = Array.from(State.nodeWayIndex.get(homeId) || []);
    for (const wid of wayIds) {
      const way = State.ways.get(wid);
      if (!way) continue;
      const idx = way.nodes.indexOf(homeId);
      if (idx === -1) continue;
      let neighborId = null;
      if (idx + 1 < way.nodes.length) neighborId = way.nodes[idx + 1];
      else if (idx - 1 >= 0) neighborId = way.nodes[idx - 1];
      if (!neighborId) continue;
      if (members.includes(neighborId)) continue; // internal to the group, not a real approach
      const neighbor = State.nodes.get(neighborId);
      if (!neighbor) continue;
      const dx = neighbor.x - node.x, dy = neighbor.y - node.y;
      const len = Math.max(1e-6, Math.hypot(dx, dy));
      approaches.push({ wayId: wid, dirX: dx / len, dirY: dy / len, bearing: Math.atan2(dy, dx), homeNodeId: homeId });
    }
  }
  approaches.sort((a, b) => a.bearing - b.bearing);
  return approaches;
}

// True when `way` is one-way AND `nodeId` is its upstream end for that
// direction - i.e. traffic on this way flows AWAY from the node, not toward
// it. A road leaving a junction isn't something anyone needs to stop for, so
// it should never be treated as a lightable "approach" - see
// approachableWaysSorted, used everywhere connectedWaysSorted previously fed
// straight into phase assignment/rendering without this direction check.
function wayIsOutgoingAt(way, nodeId) {
  const onewayTag = ((way.tags && way.tags.oneway) || "").trim().toLowerCase();
  if (onewayTag !== "yes" && onewayTag !== "-1") return false;
  const nodes = way.nodes;
  return onewayTag === "yes" ? nodes[0] === nodeId : nodes[nodes.length - 1] === nodeId;
}

// Same ordering as connectedWaysSorted, but excluding any one-way leg whose
// traffic flows away from this node (see wayIsOutgoingAt) - the set of
// connected roads that can actually be given a phase/lamp/stop line here.
function approachableWaysSorted(nodeId) {
  return connectedWaysSorted(nodeId).filter((a) => {
    const way = State.ways.get(a.wayId);
    return way && !wayIsOutgoingAt(way, a.homeNodeId);
  });
}

/* ---------------- Create / remove a redlight instance ---------------- */

function addRedlight(nodeId) {
  // A joined group (see junctionCluster) always gets ONE signal governing
  // every member's approaches - resolving to the primary here means it
  // doesn't matter which member's own point the light was actually placed
  // from, the data always lands in the same one place.
  const primaryId = (typeof junctionPrimary === "function") ? junctionPrimary(nodeId) : nodeId;
  const node = State.nodes.get(primaryId);
  if (!node) return;
  const approaches = approachableWaysSorted(primaryId);
  const n = approaches.length;
  let groups;
  if (n === 4) {
    groups = [[approaches[0], approaches[2]], [approaches[1], approaches[3]]];
  } else if (n === 3) {
    // A T-junction only needs 2 phases, not 3: the two approaches that form
    // the through road (most nearly opposite each other) don't conflict and
    // can run together, leaving the third (the stem of the T) as the only
    // other phase.
    const pairs = [[0, 1], [0, 2], [1, 2]];
    let through = pairs[0], mostOpposite = -1;
    for (const [i, j] of pairs) {
      let diff = Math.abs(approaches[i].bearing - approaches[j].bearing);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff > mostOpposite) { mostOpposite = diff; through = [i, j]; }
    }
    const stem = [0, 1, 2].find((i) => !through.includes(i));
    groups = [[approaches[through[0]], approaches[through[1]]], [approaches[stem]]];
  } else {
    groups = approaches.map(a => [a]);
  }
  const grouped = n === 3 || n === 4;
  const phases = groups.map((g, i) => ({
    id: `ph_${i + 1}`,
    label: grouped ? `Phase ${i + 1}` : `Approach ${i + 1}`,
    wayIds: g.map(a => a.wayId),
    greenSec: 25,
    yellowSec: 3,
  }));
  node.signal = { allRedSec: 2, phases, facing: "inward" };
  node.tags = node.tags || {};
  node.tags.highway = "traffic_signals";
}

// Places a light mid-road on a two-way way, governing ONLY the direction of
// travel on whichever side of the road was clicked - unlike addRedlight,
// which lights every approach at an existing junction node together. Splits
// the way at the clicked point (see splitWayAt in editor.js) and attaches a
// single-phase signal to the new node, assigning only ONE of the two
// resulting approaches to that phase; the other is left out of every phase,
// which drawRedlights() then renders as unlit/open rather than permanently
// red - that's what leaves the other side of the road untouched.
//
// India drives on the left, so the lane a direction of travel uses is on
// that direction's own left. The way's stored node order defines "forward";
// clicking the side that's on forward-travel's left lights the approach
// traffic arrives from when travelling forward, and vice versa for the
// other side. A one-way road only has one real direction, so the click side
// is ignored and that direction is used regardless of which side was
// clicked.
//
// Returns the new node's id, or null if the click wasn't usable (too close
// to the way's own endpoint - see splitWayAt) - callers should try
// findNodeAt first and only fall back here when that misses.
function addDirectionalRedlightOnWay(wayId, world) {
  const way = State.ways.get(wayId);
  if (!way) return null;

  const split = splitWayAt(wayId, world);
  if (!split) return null;
  const { nodeId, beforeWayId, afterWayId } = split;

  const before = State.ways.get(beforeWayId);
  const node = State.nodes.get(nodeId);
  const lastBeforeNode = State.nodes.get(before.nodes[before.nodes.length - 2]);
  const fx = node.x - lastBeforeNode.x, fy = node.y - lastBeforeNode.y;
  const flen = Math.max(1e-6, Math.hypot(fx, fy));
  const F = { x: fx / flen, y: fy / flen };

  const oneway = ((way.tags && way.tags.oneway) || "").trim().toLowerCase();
  let litWayId;
  if (oneway === "yes") {
    litWayId = beforeWayId; // only forward travel (node order) exists
  } else if (oneway === "-1") {
    litWayId = afterWayId; // only reverse travel exists
  } else {
    const cross = F.x * (world.y - node.y) - F.y * (world.x - node.x);
    litWayId = cross > 0 ? beforeWayId : afterWayId; // left of F = forward traffic's lane
  }

  node.signal = {
    allRedSec: 2,
    phases: [{ id: "ph_1", label: "Signal", wayIds: [litWayId], greenSec: 25, yellowSec: 3 }],
    facing: "inward",
  };
  node.tags = node.tags || {};
  node.tags.highway = "traffic_signals";
  return nodeId;
}

function removeRedlight(nodeId) {
  const primaryId = (typeof junctionPrimary === "function") ? junctionPrimary(nodeId) : nodeId;
  const node = State.nodes.get(primaryId);
  if (!node || !node.signal) return;
  if (node.signal.groupId) leaveRedlightGroup(primaryId);
  delete node.signal;
  if (node.tags && node.tags.highway === "traffic_signals") delete node.tags.highway;
}

/* ---------------- Groups: only one member "in control" at a time ---------------- */

// Compass bearing (clockwise from north, since x is east+ and y is north+)
// of each member as seen from the group's centroid, ascending = clockwise
// order around the intersection.
function orderNodesClockwise(nodeIds) {
  let cx = 0, cy = 0, n = 0;
  for (const id of nodeIds) {
    const node = State.nodes.get(id);
    if (!node) continue;
    cx += node.x; cy += node.y; n++;
  }
  if (!n) return nodeIds.slice();
  cx /= n; cy /= n;
  return nodeIds.slice().sort((a, b) => {
    const na = State.nodes.get(a), nb = State.nodes.get(b);
    const ba = Math.atan2(na.x - cx, na.y - cy);
    const bb = Math.atan2(nb.x - cx, nb.y - cy);
    return ba - bb;
  });
}

function createRedlightGroup(nodeIds, turnSec, direction) {
  const eligible = nodeIds.filter((id) => {
    const n = State.nodes.get(id);
    return n && n.signal;
  });
  if (eligible.length < 2) return null;
  for (const id of eligible) leaveRedlightGroup(id); // a node can only be in one group
  const gid = newId("grp");
  const dir = direction === "ccw" ? "ccw" : "cw";
  let ordered = orderNodesClockwise(eligible);
  if (dir === "ccw") ordered.reverse();
  State.redlightGroups.set(gid, { id: gid, memberIds: ordered, turnSec: Math.max(1, turnSec || 30), direction: dir });
  for (const id of eligible) State.nodes.get(id).signal.groupId = gid;
  return gid;
}

// Flip the group's turn-taking order (cw <-> ccw) in place - it's just a
// reversal of memberIds, so the member currently in control keeps its turn
// slot and only the order of who comes next changes.
function toggleRedlightGroupDirection(groupId) {
  const g = State.redlightGroups.get(groupId);
  if (!g) return;
  g.memberIds = g.memberIds.slice().reverse();
  g.direction = g.direction === "ccw" ? "cw" : "ccw";
}

function leaveRedlightGroup(nodeId) {
  const node = State.nodes.get(nodeId);
  const gid = node && node.signal && node.signal.groupId;
  if (!gid) return;
  const g = State.redlightGroups.get(gid);
  if (g) {
    g.memberIds = g.memberIds.filter((id) => id !== nodeId);
    if (g.memberIds.length < 2) {
      for (const mid of g.memberIds) {
        const mn = State.nodes.get(mid);
        if (mn && mn.signal) delete mn.signal.groupId;
      }
      State.redlightGroups.delete(gid);
    }
  }
  if (node.signal) delete node.signal.groupId;
}

// Which member currently has the group's turn, and how far into that turn.
function getGroupTurnInfo(groupId, clockSec) {
  const g = State.redlightGroups.get(groupId);
  if (!g || g.memberIds.length < 2) return null;
  const turnSec = Math.max(1, g.turnSec || 30);
  const cycle = turnSec * g.memberIds.length;
  const t = ((clockSec % cycle) + cycle) % cycle;
  const activeIdx = Math.min(g.memberIds.length - 1, Math.floor(t / turnSec));
  return {
    activeNodeId: g.memberIds[activeIdx],
    activeIdx,
    localClock: t - activeIdx * turnSec,
    turnSec,
    memberIds: g.memberIds,
  };
}

function nodeGroupWaitSec(groupId, nodeId, clockSec) {
  const info = getGroupTurnInfo(groupId, clockSec);
  if (!info) return 0;
  const idx = info.memberIds.indexOf(nodeId);
  if (idx === -1 || idx === info.activeIdx) return 0;
  let idxDiff = idx - info.activeIdx;
  if (idxDiff < 0) idxDiff += info.memberIds.length;
  return idxDiff * info.turnSec - info.localClock;
}

/* ---------------- Fixed-time phase math (single intersection) ---------------- */

function redlightCycleLength(signal) {
  if (!signal || !signal.phases || !signal.phases.length) return 0;
  const allRed = Math.max(0, signal.allRedSec || 0);
  return signal.phases.reduce((sum, p) => sum + Math.max(0, p.greenSec || 0) + Math.max(0, p.yellowSec || 0) + allRed, 0);
}

// Unrolls one full cycle into a flat list of [start,end) segments (green,
// then yellow, then a shared all-red clearance, per phase in order).
// getRedlightState and getApproachCountdown both walk this same list, so
// there's exactly one implementation of the phase timing math.
function buildRedlightSegments(signal) {
  const phases = (signal && signal.phases) || [];
  const allRed = Math.max(0, (signal && signal.allRedSec) || 0);
  const segments = [];
  let cursor = 0;
  phases.forEach((p, phaseIndex) => {
    const green = Math.max(0, p.greenSec || 0);
    const yellow = Math.max(0, p.yellowSec || 0);
    if (green > 0) { segments.push({ start: cursor, end: cursor + green, color: "green", phaseIndex, wayIds: p.wayIds }); cursor += green; }
    if (yellow > 0) { segments.push({ start: cursor, end: cursor + yellow, color: "yellow", phaseIndex, wayIds: p.wayIds }); cursor += yellow; }
    if (allRed > 0) { segments.push({ start: cursor, end: cursor + allRed, color: "red", phaseIndex: -1, wayIds: null }); cursor += allRed; }
  });
  return { segments, cycle: cursor };
}

function currentSegment(segments, t) {
  const idx = segments.findIndex((s) => t >= s.start && t < s.end);
  return idx === -1 ? segments.length - 1 : idx;
}

function getRedlightState(signal, clockSec) {
  const { segments, cycle } = buildRedlightSegments(signal);
  if (!segments.length || cycle <= 0) return { activePhaseIndex: -1, subState: "allred", colorFor: () => "red" };
  const t = ((clockSec % cycle) + cycle) % cycle;
  const cur = segments[currentSegment(segments, t)];
  return {
    activePhaseIndex: cur.phaseIndex,
    subState: cur.phaseIndex === -1 ? "allred" : cur.color,
    colorFor: (wayId) => (cur.wayIds && cur.wayIds.includes(wayId)) ? cur.color : "red",
  };
}

// Per-approach color plus seconds remaining in that state, for ONE signal in
// isolation (no group awareness) - while green/yellow, how long until it
// changes; while red, how long until it next turns green.
function getApproachCountdown(signal, clockSec, wayId) {
  const { segments, cycle } = buildRedlightSegments(signal);
  if (!segments.length || cycle <= 0) return { color: "red", remainingSec: 0 };
  const t = ((clockSec % cycle) + cycle) % cycle;
  const curIdx = currentSegment(segments, t);
  const cur = segments[curIdx];
  if (cur.wayIds && cur.wayIds.includes(wayId)) {
    return { color: cur.color, remainingSec: cur.end - t };
  }
  for (let step = 0; step < segments.length; step++) {
    const seg = segments[(curIdx + step) % segments.length];
    if (seg.color === "green" && seg.wayIds && seg.wayIds.includes(wayId)) {
      let untilStart = seg.start - t;
      if (untilStart <= 0) untilStart += cycle;
      return { color: "red", remainingSec: untilStart };
    }
  }
  return { color: "red", remainingSec: cycle }; // not assigned to any phase
}

// Group-aware per-approach color + countdown: if this node is in a group and
// it isn't currently its turn, every approach is red until the turn arrives;
// otherwise defers to the node's own phase plan, restarted at the top for
// each turn (via a clock local to that turn) so a turn always begins at
// phase 1 rather than wherever the raw clock happens to land.
function getRedlightCountdown(node, nodeId, clockSec, wayId) {
  const signal = node && node.signal;
  if (!signal) return { color: "red", remainingSec: 0 };
  if (signal.groupId) {
    const info = getGroupTurnInfo(signal.groupId, clockSec);
    if (info) {
      if (info.activeNodeId !== nodeId) {
        return { color: "red", remainingSec: nodeGroupWaitSec(signal.groupId, nodeId, clockSec) };
      }
      return getApproachCountdown(signal, info.localClock, wayId);
    }
  }
  return getApproachCountdown(signal, clockSec, wayId);
}

/* ---------------- Simulation clock ---------------- */

const Sim = { running: false, clockSec: 0, lastTs: null };

function simTick(ts) {
  if (Sim.running) {
    if (Sim.lastTs != null) {
      const dt = Math.max(0, Math.min(0.25, (ts - Sim.lastTs) / 1000));
      if (dt > 0) { Sim.clockSec += dt; markDirty(); }
    }
    Sim.lastTs = ts;
  } else {
    Sim.lastTs = null;
  }
}

function toggleSim() {
  Sim.running = !Sim.running;
  updateSimButton();
  markDirty();
}

function resetSim() {
  Sim.clockSec = 0;
  Sim.lastTs = null;
  markDirty();
}

function updateSimButton() {
  const btn = $("#simPlayBtn");
  if (btn) btn.textContent = Sim.running ? "⏸ Pause" : "▶ Play";
}

/* ---------------- Rendering ---------------- */

function drawRedlights() {
  // The plain "a signal exists here" node marker (the flat red dot drawn in
  // render()'s node loop) is zoom-gated like any other intersection marker.
  // The colored per-approach lamps drawn here are a separate layer: they
  // keep trying to render at any zoom, but LAMP_MIN_RADIUS_PX shrinks them
  // toward a speck rather than letting them balloon and cover the map.
  for (const [nodeId, node] of State.nodes) {
    if (!node.signal) continue;
    // An approach not referenced by any phase is deliberately left
    // unlit/open (no lamp at all) rather than shown as permanently red -
    // this is what lets a directional light on one side of a two-way road
    // (see addDirectionalRedlightOnWay) leave the other side unlit.
    const litWayIds = new Set();
    for (const p of node.signal.phases) for (const wid of p.wayIds) litWayIds.add(wid);
    for (const a of approachableWaysSorted(nodeId)) {
      if (!litWayIds.has(a.wayId)) continue;
      const cd = getRedlightCountdown(node, nodeId, Sim.clockSec, a.wayId);
      // The stop line acts like a wall: present while this approach is
      // stopped (red/yellow), gone the instant it turns green - rather than
      // a fixed marking regardless of colour.
      if (cd.color !== "green") drawStopLine(node, nodeId, a);
      drawLampGlyph(node, a, cd.color, cd.remainingSec);
    }
  }
}

// A thin stop-bar across the lane a lit approach governs - same idea as the
// dashed lane dividers, but solid and always present regardless of the
// signal's current colour, since (like a real painted stop line) it marks
// WHERE traffic must stop, not whether it currently has to. This is what
// makes a directional light's hitbox legible: it's drawn across only the
// lane the approach controls (see the lateral-offset comment in
// drawLampGlyph for why that's the LEFT half on a two-way road), not the
// whole road, so it's visually obvious which side is blocked and which is
// open.
function drawStopLine(node, nodeId, approach) {
  const way = State.ways.get(approach.wayId);
  if (!way) return;

  const halfWidthWorld = wayPhysicalWidth(way) / 2;

  // This approach's OWN home node - not necessarily the same node the
  // signal itself is stored on (a joined group's light lives on one
  // primary member - see junctionPrimary - but each approach still meets
  // the road network at its own real point, via connectedWaysSorted's
  // homeNodeId). junctionClearance is likewise asked about that same real
  // node, never the signal-holder, since that's the id its own per-leg
  // radius data is keyed on.
  const homeId = approach.homeNodeId || nodeId;
  const home = State.nodes.get(homeId) || node;

  // Positioned at exactly the same distance the road itself is clipped back
  // to at this junction (see junctionClearance) - a pure function of the
  // roads' physical widths with no dependency on zoom, so the line sits
  // right at the road's visible edge at any zoom instead of drifting
  // relative to it or floating somewhere inside the open junction.
  const offsetWorld = junctionClearance(homeId, way);
  const cx = home.x + approach.dirX * offsetWorld;
  const cy = home.y + approach.dirY * offsetWorld;

  const leftX = approach.dirY, leftY = -approach.dirX;
  const isTwoWay = !(way.tags && isYes(way.tags.oneway));

  let ax, ay, bx, by;
  if (isTwoWay) {
    // Two-way: line spans only the half the signal governs (centre → left kerb)
    ax = cx; ay = cy;
    bx = cx + leftX * halfWidthWorld; by = cy + leftY * halfWidthWorld;
  } else {
    // One-way: line spans the full road width
    ax = cx - leftX * halfWidthWorld; ay = cy - leftY * halfWidthWorld;
    bx = cx + leftX * halfWidthWorld; by = cy + leftY * halfWidthWorld;
  }
  const spA = worldToScreen(ax, ay), spB = worldToScreen(bx, by);

  ctx.save();
  // Subtle backing line for contrast on light roads
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(spA.x, spA.y);
  ctx.lineTo(spB.x, spB.y);
  ctx.stroke();
  // Main stop line
  ctx.strokeStyle = "#3d3846";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(spA.x, spA.y);
  ctx.lineTo(spB.x, spB.y);
  ctx.stroke();
  ctx.restore();
}

const LAMP_COLORS = { green: "#06d6a0", yellow: "#ffd166", red: "#ef476f" };

// The lamp glyph's SIZE (radius) is a real-world metre value scaled by zoom
// and by Config.signalLampSizeMultiplier (the "Signal lamp size" slider in
// Settings), then clamped in screen-px so it shrinks/grows smoothly with
// zoom but never vanishes zoomed way out nor balloons past a sane size
// zoomed way in.
//
// Its POSITION, by contrast, is deliberately NOT px-clamped: it's placed a
// fixed real-world distance out from the node (past the stop line, itself at
// wayPhysicalWidth(way) - see drawStopLine) and a fixed real-world distance
// sideways onto the verge (past the road's physical half-width). Since both
// are plain world-space offsets with no scale-dependent clamp, the lamp
// keeps one true position relative to the road at every zoom level instead
// of sliding toward the node as you zoom in (which is what happens if a
// px-clamped offset gets converted back to world units by dividing by the
// *current* zoom).
//
// Config.signalLampFixedSize (also a Settings toggle, on by default) pins
// the SIZE math to Config.intersectionZoomThreshold instead of the live
// zoom - so a lamp always renders at the size it would have at that
// reference zoom (75% by default), even while you're actually placing it
// zoomed in much further. Turning it off makes lamp size track live zoom
// again (the earlier behaviour), kept around for whenever that's wanted.
const LAMP_RADIUS_M = 5;
const LAMP_MIN_RADIUS_PX = 3;
const LAMP_MAX_RADIUS_PX = 12;
const LAMP_FORWARD_OFFSET_M = 5;   // extra stand-off beyond the stop line, along the road
const LAMP_LATERAL_MARGIN_M = 0.8; // extra margin beyond the kerb edge (two-way roads only)

function drawLampGlyph(node, approach, color, remainingSec) {
  const liveScale = State.view.scale;
  const mult = Config.signalLampSizeMultiplier || 1;
  // sizingScale drives how big the glyph renders (in px) - it has no bearing
  // on where it's placed, which is pure world-space (see comment above).
  const sizingScale = Config.signalLampFixedSize ? Config.intersectionZoomThreshold : liveScale;
  const radius = Math.min(LAMP_MAX_RADIUS_PX * mult, Math.max(LAMP_MIN_RADIUS_PX * mult, LAMP_RADIUS_M * mult * sizingScale));

  const way = State.ways.get(approach.wayId);
  if (!way) return;
  const halfWidthWorld = wayPhysicalWidth(way) / 2;

  // "Inward" (default) = near-side signal, standing before the stop line,
  // facing oncoming traffic - signal.facing = "outward" puts it on the far
  // side of the junction instead (a far-side head, facing back at approach
  // traffic across the intersection).
  const facingSign = (node.signal && node.signal.facing === "outward") ? -1 : 1;
  const forwardOffsetWorld = (halfWidthWorld * 2 + LAMP_FORWARD_OFFSET_M) * facingSign;

  // On a two-way road, offset the lamp sideways onto the near-side verge
  // rather than sitting on the road's centreline - specifically the LEFT
  // side of the lane it governs, as seen by a driver arriving at this node
  // along the approach, per India's left-hand traffic (right-hand-drive
  // cars keep left). A one-way approach has no "wrong side" to avoid, so it
  // stays centred on the approach line.
  let lateralOffsetWorld = 0, leftX = 0, leftY = 0;
  const isTwoWay = !(way.tags && isYes(way.tags.oneway));
  if (isTwoWay) {
    leftX = approach.dirY;
    leftY = -approach.dirX;
    lateralOffsetWorld = halfWidthWorld + LAMP_LATERAL_MARGIN_M;
  }

  // This approach's own home node, same as drawStopLine - a joined group's
  // signal lives on one primary member, but the lamp for each approach must
  // still stand at ITS OWN real road, not the primary's point.
  const home = State.nodes.get(approach.homeNodeId) || node;
  const wx = home.x + approach.dirX * forwardOffsetWorld + leftX * lateralOffsetWorld;
  const wy = home.y + approach.dirY * forwardOffsetWorld + leftY * lateralOffsetWorld;
  const sp = worldToScreen(wx, wy);
  if (sp.x < -20 || sp.x > cssW() + 20 || sp.y < -20 || sp.y > cssH() + 20) return;
  ctx.save();
  // Outer dark ring
  ctx.beginPath();
  ctx.arc(sp.x, sp.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = "#1a1a2e";
  ctx.fill();
  // White gap ring
  ctx.beginPath();
  ctx.arc(sp.x, sp.y, radius * 0.78, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  // Inner colored fill
  ctx.beginPath();
  ctx.arc(sp.x, sp.y, radius * 0.6, 0, Math.PI * 2);
  ctx.fillStyle = LAMP_COLORS[color] || LAMP_COLORS.red;
  ctx.fill();
  ctx.restore();

  // Countdown label
  if (Config.showSignalTimers && radius >= LAMP_MAX_RADIUS_PX * mult * 0.5) {
    ctx.save();
    ctx.font = `bold ${Math.round(Math.min(13, Math.max(9, radius + 2)))}px 'Space Grotesk', sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const label = String(Math.max(0, Math.ceil(remainingSec)));
    const ty = sp.y + radius + 2;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.strokeText(label, sp.x, ty);
    ctx.fillStyle = "#1a1a2e";
    ctx.fillText(label, sp.x, ty);
    ctx.restore();
  }
}

/* ---------------- Inspector: single intersection ---------------- */

function renderRedlightSection(node, nodeId) {
  const wrap = el("div", {});
  wrap.append(el("div", { class: "section-title" }, "Traffic light"));

  const approaches = approachableWaysSorted(nodeId);

  if (!node.signal) {
    wrap.append(el("div", { class: "readonly" }, `${approaches.length} connected road(s)`));
    wrap.append(el("button", {
      onclick: () => {
        pushUndo();
        addRedlight(nodeId);
        markDirty(); scheduleAutosave(); renderInspector();
      },
    }, "Add traffic light"));
    return wrap;
  }

  const signal = node.signal;
  const typeLabel = approaches.length === 3 || approaches.length === 4
    ? `${approaches.length}-way` : `${approaches.length}-way (custom)`;

  wrap.append(el("div", { class: "field" }, el("label", {}, "Intersection type"), el("div", { class: "readonly" }, typeLabel)));

  const facingLabel = (signal.facing === "outward") ? "Outward (far side) ⇥" : "Inward (near side) ⇤";
  wrap.append(el("div", { class: "field" },
    el("label", {}, "Lamp placement"),
    el("button", {
      title: "Near side (default): lamp stands before the stop line, facing oncoming traffic. Far side: lamp stands across the junction. Either way, each lamp stays on the left of the lane it governs, per India's left-hand traffic.",
      onclick: () => {
        pushUndo();
        signal.facing = (signal.facing === "outward") ? "inward" : "outward";
        markDirty(); scheduleAutosave(); renderInspector();
      },
    }, facingLabel)));

  if (signal.groupId) {
    const g = State.redlightGroups.get(signal.groupId);
    if (g) {
      const turnInput = el("input", { type: "number", min: "1", value: g.turnSec });
      turnInput.addEventListener("change", () => {
        const v = parseFloat(turnInput.value);
        if (!Number.isFinite(v) || v < 1) { turnInput.value = g.turnSec; return; }
        pushUndo(); g.turnSec = v; markDirty(); scheduleAutosave();
      });
      const dirLabel = (g.direction === "ccw") ? "Anticlockwise ⟲" : "Clockwise ⟳";
      wrap.append(
        el("div", { class: "field" },
          el("label", {}, "Grouped with"),
          el("div", { class: "readonly" }, `${g.memberIds.length - 1} other light(s) - takes turns, one green at a time`)),
        el("div", { class: "field" }, el("label", {}, "Seconds per turn"), turnInput),
        el("div", { class: "field" },
          el("label", {}, "Cycle direction"),
          el("button", {
            onclick: () => { pushUndo(); toggleRedlightGroupDirection(g.id); markDirty(); scheduleAutosave(); renderInspector(); },
          }, dirLabel)),
        el("button", {
          onclick: () => { pushUndo(); leaveRedlightGroup(nodeId); markDirty(); scheduleAutosave(); renderInspector(); },
        }, "Leave group"),
      );
    }
  }

  const allRedInput = el("input", { type: "number", min: "0", value: signal.allRedSec });
  allRedInput.addEventListener("change", () => {
    const v = parseFloat(allRedInput.value);
    if (!Number.isFinite(v) || v < 0) { allRedInput.value = signal.allRedSec; return; }
    pushUndo(); signal.allRedSec = v; markDirty(); scheduleAutosave(); renderInspector();
  });
  wrap.append(el("div", { class: "field" }, el("label", {}, "All-red clearance (s)"), allRedInput));

  const phaseList = el("div", {});
  wrap.append(phaseList);

  function redrawPhases() {
    phaseList.innerHTML = "";
    signal.phases.forEach((phase, pi) => {
      const phaseBox = el("div", { class: "phase-box" });
      phaseBox.append(el("div", { class: "phase-title" }, phase.label || `Phase ${pi + 1}`));

      const greenInput = el("input", { type: "number", min: "1", value: phase.greenSec });
      greenInput.addEventListener("change", () => {
        const v = parseFloat(greenInput.value);
        if (!Number.isFinite(v) || v < 1) { greenInput.value = phase.greenSec; return; }
        pushUndo(); phase.greenSec = v; markDirty(); scheduleAutosave();
      });
      const yellowInput = el("input", { type: "number", min: "0", value: phase.yellowSec });
      yellowInput.addEventListener("change", () => {
        const v = parseFloat(yellowInput.value);
        if (!Number.isFinite(v) || v < 0) { yellowInput.value = phase.yellowSec; return; }
        pushUndo(); phase.yellowSec = v; markDirty(); scheduleAutosave();
      });
      phaseBox.append(
        el("div", { class: "field" }, el("label", {}, "Green (s)"), greenInput),
        el("div", { class: "field" }, el("label", {}, "Yellow (s)"), yellowInput),
        el("div", { class: "field" }, el("label", {}, "Approaches (roads)")),
      );

      approaches.forEach((a) => {
        const chk = el("input", { type: "checkbox" });
        chk.checked = phase.wayIds.includes(a.wayId);
        chk.addEventListener("change", () => {
          pushUndo();
          if (chk.checked) { if (!phase.wayIds.includes(a.wayId)) phase.wayIds.push(a.wayId); }
          else phase.wayIds = phase.wayIds.filter((id) => id !== a.wayId);
          markDirty(); scheduleAutosave();
        });
        phaseBox.append(el("div", { class: "checkrow" }, chk, el("label", {}, a.wayId)));
      });

      if (signal.phases.length > 1) {
        phaseBox.append(el("button", {
          class: "danger-btn",
          onclick: () => { pushUndo(); signal.phases.splice(pi, 1); markDirty(); scheduleAutosave(); renderInspector(); },
        }, "Remove phase"));
      }

      phaseList.append(phaseBox);
    });
  }
  redrawPhases();

  wrap.append(el("button", {
    onclick: () => {
      pushUndo();
      signal.phases.push({ id: `ph_${signal.phases.length + 1}`, label: `Phase ${signal.phases.length + 1}`, wayIds: [], greenSec: 20, yellowSec: 3 });
      markDirty(); scheduleAutosave(); renderInspector();
    },
  }, "+ Add phase"));

  wrap.append(el("div", { class: "field" }, el("label", {}, "Cycle length"), el("div", { class: "readonly" }, `${redlightCycleLength(signal)} s`)));

  wrap.append(el("button", {
    class: "danger-btn",
    onclick: () => { pushUndo(); removeRedlight(nodeId); markDirty(); scheduleAutosave(); renderInspector(); },
  }, "Remove traffic light"));

  return wrap;
}

/* ---------------- Inspector: bulk selection ---------------- */

// Appended into the bulk-selection panel (editor.js's renderBulkInspector)
// when 2+ of the selected nodes already have a redlight instance.
function renderRedlightGroupControls(nodeIds) {
  const wrap = el("div", {});
  const sameGroup = nodeIds.length > 1 && nodeIds.every((id) => {
    const n = State.nodes.get(id);
    return n && n.signal && n.signal.groupId && n.signal.groupId === State.nodes.get(nodeIds[0]).signal.groupId;
  });

  wrap.append(el("div", { class: "section-title" }, "Traffic light group"));
  wrap.append(el("div", { class: "readonly" },
    `${nodeIds.length} traffic lights selected - grouping makes them take turns, only one green at a time.`));

  if (sameGroup) {
    const g = State.redlightGroups.get(State.nodes.get(nodeIds[0]).signal.groupId);
    const dirLabel = (g && g.direction === "ccw") ? "Anticlockwise ⟲" : "Clockwise ⟳";
    const turnInput = el("input", { type: "number", min: "1", value: g.turnSec });
    turnInput.addEventListener("change", () => {
      const v = parseFloat(turnInput.value);
      if (!Number.isFinite(v) || v < 1) { turnInput.value = g.turnSec; return; }
      pushUndo(); g.turnSec = v; markDirty(); scheduleAutosave();
    });
    wrap.append(
      el("div", { class: "field" }, el("label", {}, "Seconds per turn"), turnInput),
      el("div", { class: "field" },
        el("label", {}, "Cycle direction"),
        el("button", {
          onclick: () => { pushUndo(); toggleRedlightGroupDirection(g.id); markDirty(); scheduleAutosave(); renderInspector(); },
        }, dirLabel)),
      el("button", {
        onclick: () => {
          pushUndo();
          for (const id of nodeIds) leaveRedlightGroup(id);
          markDirty(); scheduleAutosave(); renderInspector();
        },
      }, "Ungroup"),
    );
    return wrap;
  }

  const turnIn = el("input", { type: "number", min: "1", value: "30" });
  const dirSel = el("select", {},
    el("option", { value: "cw" }, "Clockwise ⟳"),
    el("option", { value: "ccw" }, "Anticlockwise ⟲"));
  const groupBtn = el("button", {
    onclick: () => {
      const v = parseFloat(turnIn.value);
      pushUndo();
      createRedlightGroup(nodeIds, Number.isFinite(v) && v > 0 ? v : 30, dirSel.value);
      markDirty(); scheduleAutosave(); renderInspector();
    },
  }, "Group selected traffic lights");
  wrap.append(el("div", { class: "tag-add" }, el("label", {}, "Seconds per turn"), turnIn, dirSel, groupBtn));
  return wrap;
}
