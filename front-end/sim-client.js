"use strict";

/* ============================================================
   Live Vehicle Simulation client (Phase 3).

   Connects to backend/sim/sim_engine.cpp's websocket server (started via
   serve.py's /api/sim/start, which compiles+launches it as a background
   subprocess - see start_sim_engine() there) and renders its per-tick
   vehicle snapshots directly on top of the existing map view, reusing
   map-core.js's own worldToScreen()/State.view so pan/zoom/rotation work
   for the live vehicles exactly like every other layer.

   This file owns nothing about the simulation ITSELF (routing, physics,
   signals - all server-side); it only manages the socket connection, the
   Start/Stop lifecycle calls to serve.py, and drawing whatever the server
   last reported. Exposes window.LiveSim = { draw } for map-core.js's
   render() to call (see the "Live vehicle positions" hook there), matching
   the same no-op-if-absent pattern already used for routetest.js.

   Signal rendering while connected, Default mode: the engine runs the
   EXACT SAME fixed-time math redlight.js already runs client-side (see
   front-end/redlight.js) - so rather than also streaming lamp colors over
   the wire, this just keeps Sim.clockSec synced to the server's own clock
   each tick and leaves Sim.running=false (so the local
   requestAnimationFrame loop's own clock advancement in map-core.js's
   loop() doesn't fight it) - the existing traffic-light rendering then
   "just works", in lockstep with the server.

   Signal rendering, EmergencyOnly/Density mode (Phase 4): lamp colors are
   NOT a function of the clock in these two modes - they follow live,
   per-tick arbitration server-side (see sim_engine.cpp's SignalMode) - so
   the clock trick above isn't enough. Those two modes' state ticks instead
   carry an explicit "lamps" array, which this file loads into
   State.simLampOverrides (nodeId -> Map("wayId|movement" -> color));
   redlight.js's getRedlightCountdown checks that ahead of its own
   fixed-time math (see its own comment) and defers to it whenever present.
   ============================================================ */

const LiveSim = {
  ws: null,
  connected: false,
  vehicles: new Map(), // id -> {x, y, h, s, ty, ln}
  lastMeta: { t: 0, spawned: 0, completed: 0, total: 0, mode: "default" },
  lastStats: null,        // most recent {completedTotal, avgTripSec, byType, emergency} - see buildStateJson
  approachWeights: new Map(), // nodeId -> Map(wayId -> weight) - Auto/Density mode only, see buildStateJson's "approachWeights" field
  reconnectAttempts: 0,
  selectedId: null,      // vehicle id whose path is shown, or null
  selectedRoute: null,   // [[x,y], ...] once the server has answered getRoute, else null
  selectedInfo: null,    // static tag set once the server has answered getVehicleInfo, else null
  pickingEmergencyForId: null, // set while waiting for a map click to place an emergency's incident location - see liveSimBeginIncidentPick
  pickingIncidentKind: null, // set (a catalog kind, or "random") while waiting for a map click to place a manually-created incident - see liveSimBeginIncidentCreatePick
  nextIncidentAt: null,  // sim-clock seconds the next incident should spawn at - see liveSimCheckIncidentTimer
  incidents: new Map(),  // id -> {id, kind, icon, label, describe, types, defaults, x, y, createdAt, announceUntil} - see liveSimSpawnIncident
  nextIncidentId: 1,     // client-side incrementing id for LiveSim.incidents - never sent to the server
  selectedIncidentId: null, // id of the incident shown in #inspector, or null - see liveSimSelectIncident
  _lastIncidentTickSec: -1, // throttles the incident age/sidebar refresh to once per sim-second - see ws.onmessage
  // vehicle id -> {homeAmenityId, homeDepotName, vehicleType} for every
  // vehicle EVER dispatched this session whose destination depot is known -
  // populated at dispatch time (liveSimHandleDispatchAck for the auto
  // incident-preset flow, liveSimCompleteIncidentPick for manual dispatch),
  // not just while its originating incident card still exists, since that
  // card is deliberately torn down the moment the vehicle reaches the
  // incident (see liveSimCheckIncidentArrivals) - exactly the moment "the
  // hospital it's taking the patient to" becomes relevant. Consulted by
  // liveSimDrawHospitalDestinations only for a vehicle currently in
  // emergencyPhase 2 (picked up, en route home); a stale entry for a
  // finished/recalled trip is harmless and pruned lazily below.
  depotDestinations: new Map(),
  // Set by liveSimStart() right before connecting, cleared once applied in
  // liveSimConnect()'s onopen - see that field's own comment for why this
  // exists: /api/sim/start is a no-op (by design - see serve.py's
  // start_sim_engine) whenever an engine from an earlier Start is already
  // running, so the CLI args a fresh launch would have used (signal mode,
  // advanced lane AI, speed) are silently NOT applied to it. Without this,
  // picking e.g. "Auto (traffic-weighted)" in the dropdown and clicking
  // Start against an already-running engine left it connected but still
  // silently running in whatever mode it originally started in - looked
  // exactly like "the dropdown doesn't do anything." Re-sending these once
  // connected is harmless even against a genuinely freshly-launched engine
  // (same values it already started with) and is deliberately NOT applied
  // on the passive/automatic reconnect path (liveSimScheduleReconnect,
  // page-load resume) - only an explicit Start click should ever override a
  // possibly-already-running engine's live settings.
  pendingStartSync: null,
};

const LIVE_SIM_PORT = 8766;
const LIVE_SIM_RECONNECT_MAX_ATTEMPTS = 20;
const LIVE_SIM_RECONNECT_DELAY_MS = 500;

// The 3 vehicle types the engine will accept for triggerEmergency/
// dispatchIncident (see sim_engine.cpp's isEmergencyCapable) - shared by the
// manual dispatch button's gate, the incident-preset system, and rendering.
const EMERGENCY_VEHICLE_TYPES = new Set(["ambulance", "firetruck", "police"]);

/* ---------------- Connection lifecycle ---------------- */

function liveSimConnect() {
  if (LiveSim.ws) return;
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${LIVE_SIM_PORT}`);
  } catch (e) {
    liveSimScheduleReconnect();
    return;
  }
  LiveSim.ws = ws;

  ws.onopen = () => {
    LiveSim.connected = true;
    LiveSim.reconnectAttempts = 0;
    liveSimApplyPendingStartSync();
    updateLiveSimStatusUI();
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }

    if (msg.type === "route") {
      if (msg.id === LiveSim.selectedId) {
        LiveSim.selectedRoute = msg.points;
        liveSimRenderInfoPanel();
        markDirty();
      }
      return;
    }
    if (msg.type === "dispatchAck") {
      liveSimHandleDispatchAck(msg);
      return;
    }
    if (msg.type === "vehicleInfo") {
      if (msg.id === LiveSim.selectedId) {
        LiveSim.selectedInfo = msg;
        liveSimRenderInfoPanel();
      }
      return;
    }
    if (msg.type !== "state") return;

    LiveSim.lastMeta = { t: msg.t, spawned: msg.spawned, completed: msg.completed, total: msg.total, mode: msg.mode || "default" };
    liveSimCheckIncidentTimer(msg.t);
    const seen = new Set();
    for (const v of msg.vehicles) {
      LiveSim.vehicles.set(v.id, v);
      seen.add(v.id);
    }
    // A vehicle missing from this snapshot has finished its trip (or failed
    // to route at spawn) - the server only ever sends active vehicles, so
    // absence IS the removal signal, no separate "remove" message needed.
    for (const id of LiveSim.vehicles.keys()) {
      if (!seen.has(id)) { LiveSim.vehicles.delete(id); LiveSim.renderedLaneOffset.delete(id); LiveSim.depotDestinations.delete(id); }
    }
    // The selected vehicle finished its trip (or was never valid) - drop the
    // stale selection/path rather than leave a frozen ghost overlay on screen.
    if (LiveSim.selectedId != null && !LiveSim.vehicles.has(LiveSim.selectedId)) {
      liveSimClearVehicleSelection();
    } else if (LiveSim.selectedId != null) {
      // Keep the detail panel's live-state fields (speed/heading/position)
      // current every tick, same cadence as the canvas overlay - see
      // liveSimRenderInfoPanel's own comment on why a full rebuild here is
      // cheap enough to not bother diffing.
      liveSimRenderInfoPanel();
    }

    // Refresh every incident card's live text (age, responder arrived/en
    // route status) and check whether any responding incident is fully
    // resolved, throttled to once per sim-second (not the engine's full
    // 20Hz tick rate - nobody needs sub-second precision here). Targeted
    // per-card text updates, not a list rebuild - see
    // liveSimRefreshIncidentLiveFields' own comment for why.
    const nowSec = Math.floor(msg.t);
    if (nowSec !== LiveSim._lastIncidentTickSec) {
      LiveSim._lastIncidentTickSec = nowSec;
      liveSimRefreshIncidentLiveFields();
      liveSimCheckIncidentArrivals();
    }

    // Keep the shared Sim clock (front-end/redlight.js) in lockstep with the
    // server's own clock - see file header for why this is enough to keep
    // fixed-time (Default mode) signal rendering correct without streaming
    // lamp colors. EmergencyOnly/Density mode's lamp colors are NOT a
    // function of the clock (they follow live arbitration server-side - see
    // sim_engine.cpp's SignalMode), so those two modes' state ticks instead
    // carry an explicit "lamps" field that redlight.js's getRedlightCountdown
    // consults via State.simLampOverrides (see its own comment) ahead of the
    // fixed-time math.
    if (typeof Sim !== "undefined") {
      Sim.running = false;
      Sim.clockSec = msg.t;
    }
    if (Array.isArray(msg.lamps)) {
      State.simLampOverrides.clear();
      for (const lamp of msg.lamps) {
        let m = State.simLampOverrides.get(lamp.nodeId);
        if (!m) { m = new Map(); State.simLampOverrides.set(lamp.nodeId, m); }
        m.set(`${lamp.wayId}|${lamp.movement}`, { color: lamp.color, reason: lamp.r });
      }
    } else if (State.simLampOverrides.size) {
      State.simLampOverrides.clear(); // switched back to Default mode - let the fixed-time math take back over
    }

    // Auto/Density mode's live per-approach weight (nodeId -> Map(wayId
    // -> weight) - see sim_engine.cpp's buildStateJson/redlights.hpp's
    // AutoWeightBoard) for the node inspector's "Auto signal weight" section
    // (see liveSimRenderApproachWeights) - same clear-when-absent pattern as
    // the lamp overrides above.
    if (Array.isArray(msg.approachWeights)) {
      LiveSim.approachWeights.clear();
      for (const aw of msg.approachWeights) {
        let m = LiveSim.approachWeights.get(aw.nodeId);
        if (!m) { m = new Map(); LiveSim.approachWeights.set(aw.nodeId, m); }
        m.set(aw.wayId, aw.weight);
      }
    } else if (LiveSim.approachWeights.size) {
      LiveSim.approachWeights.clear();
    }

    // Latest aggregate run stats (avg trip time per type, emergency
    // response/transport times - see sim_engine.cpp's buildStateJson) -
    // cached here so the "Stop engine" popup (see liveSimStop) can show the
    // final numbers even though the engine process is about to be killed,
    // with no extra round trip needed at stop time.
    if (msg.stats) LiveSim.lastStats = msg.stats;

    // The engine sends one extra state tick with final:true right before it
    // actually stops (see sim_engine.cpp's main()) - covers a run ending
    // NATURALLY (--sim-seconds elapsed, or every trip completed) as well as
    // a manual Stop, since liveSimStop's own showSimStatsModal call only
    // ever fired for the latter. Both paths calling this is harmless -
    // showSimStatsModal replaces any existing overlay rather than stacking.
    if (msg.final && msg.stats) showSimStatsModal(msg.stats);

    // Keep a selected signalized node's inspector panel (see
    // liveSimRenderApproachWeights) current every tick, same reasoning as
    // liveSimRenderInfoPanel's own live refresh for a selected vehicle -
    // approach weights change every tick under Density mode, so a static
    // render would go stale the instant it's drawn.
    if (State.selected.length === 1 && State.selected[0].type === "node") {
      const n = State.nodes.get(State.selected[0].id);
      if (n && n.signal) renderInspector();
    }

    updateLiveSimReadout();
    markDirty();
  };

  ws.onclose = () => {
    LiveSim.ws = null;
    LiveSim.connected = false;
    LiveSim.vehicles.clear();
    State.simLampOverrides.clear();
    updateLiveSimStatusUI();
    markDirty();
    // The engine may still be starting up (compiling + binding its socket
    // takes a moment right after /api/sim/start returns) - keep trying for
    // a while rather than requiring the user to notice and retry by hand.
    liveSimScheduleReconnect();
  };

  ws.onerror = () => { /* onclose always follows; nothing extra to do here */ };
}

function liveSimScheduleReconnect() {
  if (LiveSim.reconnectAttempts >= LIVE_SIM_RECONNECT_MAX_ATTEMPTS) return;
  LiveSim.reconnectAttempts++;
  setTimeout(() => {
    // Only keep trying while the engine is (or should be) actually running -
    // liveSimRefreshStatus() re-arms this via connect() once it sees
    // running:true, so a manual Stop doesn't spawn an infinite retry loop.
    if (LiveSim.engineShouldBeRunning) liveSimConnect();
  }, LIVE_SIM_RECONNECT_DELAY_MS);
}

function liveSimDisconnect() {
  LiveSim.engineShouldBeRunning = false;
  if (LiveSim.ws) { LiveSim.ws.onclose = null; LiveSim.ws.close(); LiveSim.ws = null; }
  LiveSim.connected = false;
  LiveSim.vehicles.clear();
  LiveSim.renderedLaneOffset.clear();
  LiveSim.approachWeights.clear();
  State.simLampOverrides.clear();
  liveSimClearVehicleSelection();
  liveSimClearIncidentSelection();
  LiveSim.incidents.clear();
  LiveSim.nextIncidentAt = null;
  liveSimRenderIncidentsList();
}

function liveSimSendCommand(obj) {
  if (LiveSim.ws && LiveSim.connected) LiveSim.ws.send(JSON.stringify(obj));
}

// Flushes LiveSim.pendingStartSync (see its own comment) onto a now-open
// connection - called from liveSimConnect()'s onopen (the normal case), and
// also directly from liveSimStart() for the rare edge case where a socket
// was somehow already open at the moment Start was clicked (onopen won't
// fire again for an already-open socket).
function liveSimApplyPendingStartSync() {
  if (!LiveSim.pendingStartSync) return;
  const sync = LiveSim.pendingStartSync;
  LiveSim.pendingStartSync = null;
  liveSimSendCommand({ cmd: "setSignalMode", value: sync.signalMode });
  liveSimSendCommand({ cmd: "setAdvancedLaneAI", value: sync.advancedLaneAI });
  liveSimSendCommand({ cmd: "setSpeed", value: sync.speed });
}

/* ---------------- Click-to-select a vehicle + show its planned path ---------------- */

// Mirrors map-core.js's findNodeAtWithDist (world-space hit test, tolerance
// given in screen pixels) so a vehicle click behaves like every other
// clickable map entity - see simulation.js's mouseup handler.
function liveSimFindVehicleAt(world, tolerancePx) {
  const tol = tolerancePx / State.view.scale;
  let best = null, bestD = tol;
  for (const v of LiveSim.vehicles.values()) {
    const d = Math.hypot(v.x - world.x, v.y - world.y);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

// Clicking the already-selected vehicle again deselects it (same toggle feel
// as the rest of this page's click-to-inspect). Selecting a new vehicle
// always (re)requests its route - the server holds the authoritative,
// once-computed path (see sim_engine.cpp's resolveRoute/handleCommand), this
// client never guesses it from a couple of position samples.
function liveSimSelectVehicle(id) {
  if (LiveSim.selectedId === id) {
    liveSimClearVehicleSelection();
    return;
  }
  // Vehicles, incidents, and ordinary map features (node/way/building/
  // amenity) share one detail panel (#inspector) - selecting a vehicle
  // takes it over, so drop the other two first (mirrors the reverse
  // directions handled in simulation.js's mouseup handler and
  // liveSimSelectIncident).
  if (typeof clearSelection === "function") clearSelection();
  liveSimClearIncidentSelection();
  LiveSim.selectedId = id;
  LiveSim.selectedRoute = null;
  LiveSim.selectedInfo = null;
  liveSimSendCommand({ cmd: "getRoute", id });
  liveSimSendCommand({ cmd: "getVehicleInfo", id });
  liveSimRenderInfoPanel();
  markDirty();
}

function liveSimClearVehicleSelection() {
  LiveSim.selectedId = null;
  LiveSim.selectedRoute = null;
  LiveSim.selectedInfo = null;
  const panel = $("#inspector");
  if (panel && panel.dataset.owner === "vehicle") {
    panel.hidden = true;
    delete panel.dataset.owner;
  }
  markDirty();
}

/* ---------------- Emergency dispatch (click-to-place an incident) ---------------- */

// Arms "the next map click places this vehicle's incident location"
// instead of the ordinary select/pan click handling - see simulation.js's
// mouseup handler, which checks LiveSim.pickingEmergencyForId before falling
// through to its normal hit-testing. Cancels an in-progress incident-CREATE
// pick (see liveSimBeginIncidentCreatePick below) since only one armed pick
// can meaningfully own the next click.
function liveSimBeginIncidentPick(id) {
  liveSimCancelIncidentCreatePick();
  LiveSim.pickingEmergencyForId = id;
  toast("Click a point on the map to dispatch this vehicle there.");
}

function liveSimCancelIncidentPick() {
  LiveSim.pickingEmergencyForId = null;
}

// Called by simulation.js's mouseup handler once the armed pick actually
// lands on a map click - sends the dispatch and returns to normal selection
// behavior. `world` is the same {x,y} projected map point every other
// click-to-inspect hit test already uses.
function liveSimCompleteIncidentPick(world) {
  const id = LiveSim.pickingEmergencyForId;
  LiveSim.pickingEmergencyForId = null;
  liveSimSendCommand({ cmd: "triggerEmergency", id, x: world.x, y: world.y });
  toast(`Emergency dispatch sent for vehicle #${id}.`);
  // Manual dispatch has no dispatchAck of its own to carry this - but the
  // vehicle being dispatched is always the currently-selected one, so its
  // home depot is already sitting in LiveSim.selectedInfo (see
  // LiveSim.depotDestinations's own comment for why this is registered now
  // rather than waited on).
  const info = LiveSim.selectedInfo;
  if (info && info.id === id && info.homeAmenityId) {
    LiveSim.depotDestinations.set(id, { homeAmenityId: info.homeAmenityId, homeDepotName: info.homeDepotName || "", vehicleType: info.vehicleType });
  }
  if (LiveSim.selectedId === id) liveSimRenderInfoPanel();
}

/* ---------------- Incident preset system (Phase 5) ----------------
   Periodically spawns a random emergency (fire/medical/accident/crime) as a
   marker directly on the map - a brief "announce" ring, then it settles
   into a small steady red pin - and lists it in the left sidebar
   (#incidentsList) alongside every other still-pending incident, so the
   operator can see everything outstanding at a glance and choose which one
   to act on rather than being forced through them one at a time in a
   blocking dialog. Clicking an incident (its map pin, or its sidebar row -
   both call liveSimSelectIncident) opens the same per-type quantity inputs
   the old modal had, now in the shared #inspector panel (the same one
   vehicle/node/way/building selection already uses), and hands the request
   to the engine's dispatchIncident command (see sim_engine.cpp's
   handleCommand), which auto-picks the nearest available (not already
   responding) vehicles of each type - the manual single-vehicle path above
   (triggerEmergency) is unaffected and still works. */

// Picks a random building's centroid, preferring one whose building tag is
// in `preferredTypes` (a Set) if any exist, else any building at all. Used
// for incident kinds that make more sense tied to a structure (fire, crime)
// than a bare road point.
function liveSimPickRandomBuilding(preferredTypes) {
  const all = Array.from(State.buildings.values());
  if (!all.length) return null;
  const preferred = preferredTypes ? all.filter((b) => preferredTypes.has((b.tags && b.tags.building) || "")) : all;
  const pool = preferred.length ? preferred : all;
  const b = pool[Math.floor(Math.random() * pool.length)];
  let sx = 0, sy = 0;
  for (const p of b.polygon) { sx += p.x; sy += p.y; }
  return { x: sx / b.polygon.length, y: sy / b.polygon.length };
}

// Picks a random point along a random road edge - for incident kinds tied
// to the road itself (a traffic accident) rather than a building.
function liveSimPickRandomRoadPoint() {
  const candidates = Array.from(State.ways.values()).filter((w) => w.nodes && w.nodes.length >= 2);
  if (!candidates.length) return null;
  const w = candidates[Math.floor(Math.random() * candidates.length)];
  const i = Math.floor(Math.random() * (w.nodes.length - 1));
  const a = State.nodes.get(w.nodes[i]), b = State.nodes.get(w.nodes[i + 1]);
  if (!a || !b) return null;
  const t = Math.random();
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// kind/icon/label/describe are purely cosmetic (the prompt UI); `types`
// controls which quantity inputs are shown (in order) and `defaults` seeds
// them; `locate` picks a world {x,y} for the incident, with a same-kind
// fallback (see each entry) for the rare case its preferred source (e.g. no
// buildings loaded yet) comes up empty.
const INCIDENT_CATALOG = [
  {
    kind: "fire", icon: "🔥", label: "Fire",
    describe: "A fire has broken out and needs an immediate response.",
    types: ["firetruck", "ambulance"], defaults: { firetruck: 2, ambulance: 1 },
    locate: () => liveSimPickRandomBuilding(new Set(["residential", "commercial", "industrial", "retail"])) || liveSimPickRandomBuilding(null),
  },
  {
    kind: "medical", icon: "🚑", label: "Medical emergency",
    describe: "Someone urgently needs medical attention.",
    types: ["ambulance"], defaults: { ambulance: 1 },
    locate: () => liveSimPickRandomBuilding(null) || liveSimPickRandomRoadPoint(),
  },
  {
    kind: "accident", icon: "💥", label: "Traffic accident",
    describe: "A multi-vehicle collision has been reported on the road.",
    types: ["ambulance", "police"], defaults: { ambulance: 1, police: 1 },
    locate: () => liveSimPickRandomRoadPoint() || liveSimPickRandomBuilding(null),
  },
  {
    kind: "crime", icon: "🚨", label: "Crime in progress",
    describe: "A crime in progress needs a police response.",
    types: ["police"], defaults: { police: 2 },
    locate: () => liveSimPickRandomBuilding(new Set(["civic", "commercial"])) || liveSimPickRandomBuilding(null),
  },
];

// How long a freshly-spawned incident shows the expanding/fading "announce"
// ring (see liveSimDrawIncidents) before settling into its steady marker.
// Wall-clock, not sim-clock, like the beacon flasher below - a burst that
// takes 1.2 real seconds to play out regardless of fast-forward speed.
const INCIDENT_ANNOUNCE_MS = 1200;
// Caps how many incidents can pile up unaddressed - without this, an
// operator who ignores the sidebar for a long stretch at high fast-forward
// would accumulate an unbounded, unusable list. Spawning just pauses (and
// retries next interval) once at the cap, rather than dropping the oldest
// unresolved one - the whole point is the operator decides what gets
// resolved, not the timer.
const INCIDENT_MAX_PENDING = 8;

// Called every state tick with the server's own sim clock (see ws.onmessage)
// so cadence tracks simulated time, not wall-clock - the same clock
// redlight.js already stays in lockstep with, meaning fast-forward
// naturally makes incidents spawn more often in real time too (confirmed
// intentional).
function liveSimCheckIncidentTimer(simClock) {
  const chk = $("#liveSimIncidentsChk");
  if (!chk || !chk.checked) { LiveSim.nextIncidentAt = null; return; }
  if (LiveSim.nextIncidentAt == null) { liveSimScheduleNextIncident(simClock); return; }
  if (simClock < LiveSim.nextIncidentAt) return;
  if (LiveSim.incidents.size < INCIDENT_MAX_PENDING) liveSimSpawnIncident(simClock);
  liveSimScheduleNextIncident(simClock);
}

function liveSimScheduleNextIncident(simClock) {
  const input = $("#liveSimIncidentIntervalInput");
  const minutes = input ? (parseFloat(input.value) || 2) : 2;
  LiveSim.nextIncidentAt = simClock + minutes * 60;
}

// Adds a new incident to LiveSim.incidents - a marker on the map (see
// liveSimDrawIncidents) plus a fully self-contained card in the sidebar
// list (see liveSimRenderIncidentsList) - and announces it with a toast.
// `forcedKind` (an INCIDENT_CATALOG kind string) is set for an
// operator-created incident (see the sidebar's "Create incident" control in
// initLiveSimUI); omitted (undefined/null) for the random timer, which
// picks any kind. `forcedLoc` ({x,y}) is set when the operator pinpointed a
// map location themselves (see liveSimCompleteIncidentCreatePick below);
// omitted for both the random timer and an operator create that skipped
// picking a spot, either of which fall back to the catalog entry's own
// `locate()` (a plausible on-theme random spot).
function liveSimSpawnIncident(simClock, forcedKind, forcedLoc) {
  const entry = (forcedKind && INCIDENT_CATALOG.find((e) => e.kind === forcedKind))
    || INCIDENT_CATALOG[Math.floor(Math.random() * INCIDENT_CATALOG.length)];
  const loc = forcedLoc || entry.locate();
  if (!loc) return false; // nothing to place it on this attempt - random-timer callers just retry next interval

  const id = LiveSim.nextIncidentId++;
  LiveSim.incidents.set(id, {
    id, kind: entry.kind, icon: entry.icon, label: entry.label, describe: entry.describe,
    types: entry.types, defaults: entry.defaults, x: loc.x, y: loc.y,
    createdAt: simClock, announceUntil: Date.now() + INCIDENT_ANNOUNCE_MS,
    // "pending" (default quantity inputs + Dispatch/Dismiss) until a
    // dispatchAck actually lands a vehicle on it, then "responding" (see
    // liveSimHandleDispatchAck) - stays visible/on the map either way until
    // every dispatched vehicle arrives (liveSimCheckIncidentArrivals) or the
    // operator recalls them (liveSimRecallIncident).
    status: "pending",
    dispatched: [], // [{id, type}, ...] once responding - see liveSimHandleDispatchAck
  });
  liveSimRenderIncidentsList();
  toast(`${entry.icon} New incident: ${entry.label}`);
  markDirty();
  return true;
}

/* ---------------- Manual incident creation (click-to-place) ----------------
   Arms "the next map click places a newly-created incident there" - the
   same pattern as liveSimBeginIncidentPick above (a manual ambulance/
   firetruck/police dispatch), just placing a fresh incident instead of
   rerouting an existing vehicle. See simulation.js's mouseup handler, which
   checks LiveSim.pickingIncidentKind before falling through to its normal
   hit-testing. */

function liveSimBeginIncidentCreatePick(kind) {
  LiveSim.pickingEmergencyForId = null; // an armed vehicle-dispatch pick and this would race for the same next click
  LiveSim.pickingIncidentKind = kind;
  const label = kind === "random" ? "a random incident" : `a ${(INCIDENT_CATALOG.find((e) => e.kind === kind) || {}).label || "incident"}`;
  toast(`Click a point on the map to place ${label} there.`);
  liveSimUpdateIncidentCreateUI();
}

function liveSimCancelIncidentCreatePick() {
  if (LiveSim.pickingIncidentKind == null) return;
  LiveSim.pickingIncidentKind = null;
  liveSimUpdateIncidentCreateUI();
}

// Called by simulation.js's mouseup handler once the armed pick actually
// lands on a map click. `world` is the same {x,y} projected map point every
// other click-to-inspect hit test already uses - passed straight through as
// the incident's exact location (see liveSimSpawnIncident's `forcedLoc`),
// no locate()-based guessing.
function liveSimCompleteIncidentCreatePick(world) {
  const kind = LiveSim.pickingIncidentKind;
  LiveSim.pickingIncidentKind = null;
  liveSimUpdateIncidentCreateUI();
  const spawned = liveSimSpawnIncident(LiveSim.lastMeta.t || 0, kind === "random" ? null : kind, { x: world.x, y: world.y });
  if (!spawned) toast("Couldn't place an incident there - try again.");
}

// Toggles the "+ Create" button between its normal label and its armed
// "click the map..." state (mirrors the vehicle-dispatch button's own
// picking-state toggle in liveSimRenderInfoPanel) - also locks the kind
// picker while armed so the kind can't change out from under an in-flight
// pick.
function liveSimUpdateIncidentCreateUI() {
  const btn = $("#incidentCreateBtn"), select = $("#incidentCreateKind");
  if (!btn) return;
  const picking = LiveSim.pickingIncidentKind != null;
  btn.textContent = picking ? "Click the map... (cancel)" : "+ Create";
  if (select) select.disabled = picking;
}

// A dispatched vehicle counts as "arrived" (see liveSimCheckIncidentArrivals
// and each responder row's live status) once its own emergencyPhase moves
// past 1 (see sim_engine.cpp's buildStateJson "ep" field) - or, failing
// that, once it's no longer a live emergency vehicle at all (trip ended,
// recalled some other way, or simply aged out of the last snapshot) so a
// card can never get stuck waiting forever on a vehicle that's gone.
function liveSimResponderArrived(id) {
  const live = LiveSim.vehicles.get(id);
  return !live || !live.em || (live.ep || 1) >= 2;
}

// Builds one incident's card - a pending one shows its per-type quantity
// inputs + Dispatch/Dismiss (unchanged from before); a responding one
// (status set by liveSimHandleDispatchAck once a dispatchAck actually lands
// a vehicle on it) instead shows each dispatched vehicle with a live
// arrived/en-route status and a "Trace path" link (liveSimSelectVehicle -
// the existing click-a-vehicle route display, reused as-is) plus a single
// "Recall" that frees all of them (liveSimRecallIncident). Factored out of
// liveSimRenderIncidentsList so liveSimHandleDispatchAck can also call it to
// swap a single card's DOM in place.
function liveSimBuildIncidentCard(inc, nowT) {
  const card = el("div", {
    class: "incident-card" + (LiveSim.selectedIncidentId === inc.id ? " selected" : ""),
    id: `incidentCard_${inc.id}`,
  },
    el("div", { class: "incident-card-head" },
      el("span", { class: "incident-card-icon" }, inc.icon),
      el("span", { class: "incident-card-label" }, inc.label),
      el("span", { class: "incident-card-age", id: `incidentCardAge_${inc.id}` }, fmtSec(Math.max(0, nowT - inc.createdAt)))),
  );

  if (inc.status === "responding") {
    card.append(el("div", { class: "incident-card-status" }, "🚨 Responding - stays listed until arrival"));
    const respList = el("div", { class: "incident-responders" });
    for (const r of inc.dispatched) {
      respList.append(el("div", { class: "incident-responder-row" },
        el("span", { class: "incident-responder-label", title: `${LIVE_SIM_TYPE_LABELS[r.type] || r.type} #${r.id}` }, `${LIVE_SIM_TYPE_LABELS[r.type] || r.type} #${r.id}`),
        el("span", { class: "incident-responder-status", id: `incidentResponderStatus_${inc.id}_${r.id}` },
          liveSimResponderArrived(r.id) ? "arrived" : "en route"),
        el("button", { class: "incident-trace-btn", onclick: () => liveSimSelectVehicle(r.id) }, "Trace path"),
      ));
    }
    card.append(respList);
    card.append(el("div", { class: "incident-actions" },
      el("button", { onclick: () => liveSimRecallIncident(inc.id) }, "🔓 Recall")));
    return card;
  }

  card.append(el("div", { class: "incident-card-desc" }, inc.describe));
  const qtyInputs = {};
  for (const type of inc.types) {
    const inputId = `incidentQty_${inc.id}_${type}`;
    qtyInputs[type] = el("input", {
      type: "number", id: inputId, class: "sim-number-input incident-qty-input",
      min: "0", max: "20", step: "1", value: String(inc.defaults[type] || 0),
    });
    card.append(el("div", { class: "incident-qty-row" },
      el("label", { for: inputId }, LIVE_SIM_TYPE_LABELS[type] || type), qtyInputs[type]));
  }

  // The command is answered by a dispatchAck (see liveSimHandleDispatchAck)
  // that actually flips this card to "responding" once vehicles are
  // confirmed dispatched - disabling + relabeling the button immediately
  // (rather than waiting for that round trip, or the old behavior of
  // removing the card outright) is what fixes "the dispatch button feels
  // laggy": the click was already being handled promptly, it just gave no
  // feedback in between.
  const dispatchBtn = el("button", {
    onclick: () => {
      dispatchBtn.disabled = true;
      dispatchBtn.textContent = "Dispatching...";
      const counts = {};
      for (const type of inc.types) counts[type] = parseInt(qtyInputs[type].value, 10) || 0;
      liveSimSendCommand({ cmd: "dispatchIncident", x: inc.x, y: inc.y, counts, incidentId: inc.id });
    },
  }, "🚨 Dispatch");
  card.append(el("div", { class: "incident-actions" },
    el("button", { onclick: () => liveSimRemoveIncident(inc.id) }, "Dismiss"),
    dispatchBtn,
  ));
  return card;
}

// Same list pattern as redlight.js's updateExternalControlStatus
// (#extControlCount/#extControlList) - oldest first, so the operator can
// work top-down through a queue.
//
// Only called on an actual structural change (spawn/dispatch-confirmed/
// recall/dismiss) - each card's live text (age, and a responding card's
// per-responder arrived/en-route status) instead gets a targeted per-second
// refresh (liveSimRefreshIncidentLiveFields) that doesn't touch the rest of
// the card, and deliberately NEVER a full rebuild on a timer: a pending
// card holds live editable quantity inputs, and rebuilding it out from
// under the operator while they're mid-typing (or just about to click
// Dispatch) would wipe the value/steal the click - the exact bug an earlier
// (panel-based) version of this feature had to work around the same way.
function liveSimRenderIncidentsList() {
  const countEl = $("#incidentsCount"), listEl = $("#incidentsList");
  if (!countEl || !listEl) return;
  const items = Array.from(LiveSim.incidents.values()).sort((a, b) => a.createdAt - b.createdAt);
  countEl.textContent = items.length ? `${items.length} active incident${items.length > 1 ? "s" : ""}` : "No active incidents";
  listEl.innerHTML = "";
  const nowT = LiveSim.lastMeta.t || 0;
  for (const inc of items) listEl.append(liveSimBuildIncidentCard(inc, nowT));
}

// Targeted per-second refresh of every card's age (and, for a responding
// card, each responder's live arrived/en-route status) in place - see
// liveSimRenderIncidentsList's own comment on why this doesn't just call
// that function again.
function liveSimRefreshIncidentLiveFields() {
  if (!LiveSim.incidents.size) return;
  const nowT = LiveSim.lastMeta.t || 0;
  for (const inc of LiveSim.incidents.values()) {
    const ageEl = document.getElementById(`incidentCardAge_${inc.id}`);
    if (ageEl) ageEl.textContent = fmtSec(Math.max(0, nowT - inc.createdAt));
    if (inc.status !== "responding") continue;
    for (const r of inc.dispatched) {
      const statusEl = document.getElementById(`incidentResponderStatus_${inc.id}_${r.id}`);
      if (statusEl) statusEl.textContent = liveSimResponderArrived(r.id) ? "arrived" : "en route";
    }
  }
}

// Once every vehicle dispatched to a responding incident has arrived (see
// liveSimResponderArrived), the incident is done - satisfies "stays visible
// until the emergency vehicle reaches the position": remove its marker and
// card automatically rather than leaving a stale "Responding" card around
// forever. Called from the same throttled per-sim-second tick as
// liveSimRefreshIncidentLiveFields.
function liveSimCheckIncidentArrivals() {
  for (const inc of Array.from(LiveSim.incidents.values())) {
    if (inc.status !== "responding") continue;
    if (!inc.dispatched.every((r) => liveSimResponderArrived(r.id))) continue;
    toast(`✅ ${inc.icon} ${inc.label} resolved - responder(s) arrived.`);
    liveSimRemoveIncident(inc.id);
  }
}

// The dispatchIncident command's reply (see sim_engine.cpp's handleCommand)
// - correlated back to the incident that sent it via the incidentId echoed
// straight through in the request (see liveSimBuildIncidentCard's Dispatch
// button). No vehicles actually went out (nothing available nearby): revert
// to an interactive pending card rather than leaving it stuck showing
// "Dispatching..." forever. At least one did: flip to "responding" so it
// sticks around (map marker + sidebar card, both) until arrival or recall.
function liveSimHandleDispatchAck(msg) {
  liveSimShowDispatchAckToast(msg.dispatched);
  if (msg.incidentId == null) return; // a manual per-vehicle triggerEmergency has no incident card to update
  const inc = LiveSim.incidents.get(msg.incidentId);
  if (!inc) return; // dismissed/recalled locally before this ack came back

  const dispatched = [];
  for (const [type, info] of Object.entries(msg.dispatched || {})) {
    for (const d of info.ids || []) {
      dispatched.push({ id: d.id, type });
      // See LiveSim.depotDestinations's own comment - registered now
      // (dispatch time) rather than waiting for phase 2, since the
      // incident card (and thus this data's only other source) is gone by
      // the time phase 2 actually arrives.
      if (d.homeAmenityId) LiveSim.depotDestinations.set(d.id, { homeAmenityId: d.homeAmenityId, homeDepotName: d.homeDepotName || "", vehicleType: type });
    }
  }
  if (!dispatched.length) { liveSimRenderIncidentsList(); return; }
  inc.status = "responding";
  inc.dispatched = dispatched;
  liveSimRenderIncidentsList();
}

// Frees every vehicle dispatched to this incident (see sim_engine.cpp's
// cancelEmergency - clears its emergency flag and reroutes it home) and
// removes the incident itself, same as a plain Dismiss. Optimistic like
// every other incident action here - no ack needed to know it worked.
function liveSimRecallIncident(id) {
  const inc = LiveSim.incidents.get(id);
  if (!inc) return;
  for (const r of inc.dispatched) liveSimSendCommand({ cmd: "cancelEmergency", id: r.id });
  toast(`Recalled ${inc.dispatched.length} vehicle${inc.dispatched.length === 1 ? "" : "s"} from ${inc.label}.`);
  liveSimRemoveIncident(id);
}

// A map-marker click (see simulation.js's mouseup handler) highlights and
// scrolls to the matching card - every card is already fully visible with
// its own controls (see liveSimRenderIncidentsList's own comment), so
// there's no panel to open here, just a "here it is in the list" pointer.
// A targeted class toggle + scrollIntoView, not a full list rebuild.
function liveSimSelectIncident(id) {
  if (LiveSim.selectedIncidentId === id) return;
  const prevCard = LiveSim.selectedIncidentId != null && document.getElementById(`incidentCard_${LiveSim.selectedIncidentId}`);
  if (prevCard) prevCard.classList.remove("selected");
  LiveSim.selectedIncidentId = id;
  const card = document.getElementById(`incidentCard_${id}`);
  if (card) { card.classList.add("selected"); card.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
  markDirty();
}

function liveSimClearIncidentSelection() {
  if (LiveSim.selectedIncidentId == null) return;
  const card = document.getElementById(`incidentCard_${LiveSim.selectedIncidentId}`);
  if (card) card.classList.remove("selected");
  LiveSim.selectedIncidentId = null;
  markDirty();
}

// Shared by both "Dismiss" and "Dispatch" (and by liveSimDisconnect on
// engine stop) - either way the incident is done with, so drop its marker
// and its card.
function liveSimRemoveIncident(id) {
  LiveSim.incidents.delete(id);
  if (LiveSim.selectedIncidentId === id) LiveSim.selectedIncidentId = null;
  liveSimRenderIncidentsList();
  markDirty();
}

// Hit-test for a click landing on an incident's map marker - mirrors
// liveSimFindVehicleAt exactly (world-space, screen-pixel tolerance).
function liveSimFindIncidentAt(world, tolerancePx) {
  const tol = tolerancePx / State.view.scale;
  let best = null, bestD = tol;
  for (const inc of LiveSim.incidents.values()) {
    const d = Math.hypot(inc.x - world.x, inc.y - world.y);
    if (d < bestD) { bestD = d; best = inc; }
  }
  return best;
}

// dispatchAck's "dispatched" field: {type: {requested, ids: [...]}} - see
// sim_engine.cpp's dispatchIncident handler.
function liveSimShowDispatchAckToast(dispatched) {
  if (!dispatched) return;
  const parts = [];
  let shortfall = false;
  for (const [type, info] of Object.entries(dispatched)) {
    const got = (info.ids || []).length, want = info.requested || 0;
    if (!want) continue;
    const label = LIVE_SIM_TYPE_LABELS[type] || type;
    parts.push(`${got} ${label}${got === 1 ? "" : "s"}`);
    if (got < want) shortfall = true;
  }
  if (!parts.length) return;
  toast(`Dispatched ${parts.join(", ")}.${shortfall ? " (fewer than requested were available)" : ""}`);
}

// Field key -> either a plain readonly label, or [label, formatter] for
// anything numeric/unit-bearing. Matches whatever buildVehicleInfoJson in
// sim_engine.cpp actually sent - a field simply doesn't appear (see that
// function's own comment: zero/absent generated values are omitted) so
// there's nothing to guard against missing keys beyond the `in` check below.
const LIVE_SIM_INFO_FIELDS = {
  startNodeId: "Start node",
  endNodeId: "End node",
  length: ["Length", (v) => `${v.toFixed(2)} m`],
  width: ["Width", (v) => `${v.toFixed(2)} m`],
  height: ["Height", (v) => `${v.toFixed(2)} m`],
  weightKg: ["Weight", (v) => `${Math.round(v)} kg`],
  maxSpeedKmh: ["Max speed", (v) => `${v.toFixed(1)} km/h`],
  accelMps2: ["Acceleration", (v) => `${v.toFixed(2)} m/s²`],
  driverAge: ["Driver age", (v) => `${Math.round(v)}`],
  responseTimeSec: ["Driver response time", (v) => `${v.toFixed(2)} s`],
  homeAmenityId: "Home depot ID",
  homeDepotName: "Home depot",
};

// Renders the selected vehicle's full tag set + live state + planned route
// into the SAME #inspector/#inspBody panel simulation.js's renderInspector
// uses for map features (node/way/building/amenity) - see the "owner"
// dataset marker in both files for how the two sides hand the panel back and
// forth without stomping on each other. Called on selection, and again every
// time either getRoute/getVehicleInfo answers or a fresh state tick arrives
// (see ws.onmessage) so the live fields (speed/heading/position) stay
// current - a full innerHTML rebuild here is a handful of small text nodes,
// cheap even at the engine's 20Hz tick rate.
function liveSimRenderInfoPanel() {
  if (LiveSim.selectedId == null) return;
  const panel = $("#inspector"), body = $("#inspBody"), title = $("#inspTitle");
  if (!panel || !body || !title) return;
  const live = LiveSim.vehicles.get(LiveSim.selectedId);
  const info = LiveSim.selectedInfo;

  panel.hidden = false;
  panel.dataset.owner = "vehicle";
  body.innerHTML = "";
  title.textContent = `Vehicle #${LiveSim.selectedId}${info ? " · " + info.vehicleType : ""}`;

  body.append(el("div", { class: "section-title" }, "Live state"));
  if (live) {
    const latlon = projectInverse(live.x, live.y);
    body.append(
      el("div", { class: "field" }, el("label", {}, "Position"),
        el("div", { class: "readonly" }, `lat ${latlon.lat.toFixed(6)}, lon ${latlon.lon.toFixed(6)}`)),
      el("div", { class: "field" }, el("label", {}, "Speed"),
        el("div", { class: "readonly" }, `${live.s.toFixed(1)} km/h`)),
      el("div", { class: "field" }, el("label", {}, "Heading"),
        el("div", { class: "readonly" }, `${((live.h * 180 / Math.PI + 360) % 360).toFixed(1)}°`)),
    );
  } else {
    body.append(el("div", { class: "readonly" }, "(vehicle has finished its trip)"));
  }

  // Manual "emergency state" toggle (see sim_engine.cpp's Vehicle::emergency/
  // triggerEmergency) - offered for any of the 3 emergency-capable types
  // (EMERGENCY_VEHICLE_TYPES), since that's the whole point of the flag
  // being separate from isEmergencyCapable(vehicleType): a plain, non-
  // dispatched trip does NOT preempt signals, only one actually dispatched
  // to an incident does (EmergencyOnly/Density mode - see SignalMode).
  // Dispatching hands off to the home depot automatically once the incident
  // is reached (see the engine's edge-transition step), so there's nothing
  // further to click once it's responding.
  if (info && EMERGENCY_VEHICLE_TYPES.has(info.vehicleType)) {
    body.append(el("div", { class: "section-title" }, "Emergency dispatch"));
    if (live && live.em && (live.ep || 1) >= 2) {
      // Phase 2 (see sim_engine.cpp's Vehicle::emergencyPhase): reached the
      // incident, now carrying whatever/whoever it picked up back to its
      // home depot - the destination itself never changes mid-trip, so
      // info.homeDepotName (already loaded with every other static tag) is
      // exactly it. Also marked on the map for as long as this holds - see
      // liveSimDrawHospitalDestinations.
      const dest = info.homeDepotName || "its home depot";
      const verb = info.vehicleType === "ambulance" ? "Taking patient to" : "Returning to";
      body.append(el("div", { class: "readonly" },
        `${LIVE_SIM_DEPOT_ICON[info.vehicleType] || "🏥"} ${verb} ${dest} - forces signals green along the way (EmergencyOnly/Density mode).`));
    } else if (live && live.em) {
      body.append(el("div", { class: "readonly" },
        "🚨 Responding - en route to the incident, forces every signal it approaches green for its own approach (EmergencyOnly/Density mode)."));
    } else {
      const picking = LiveSim.pickingEmergencyForId === LiveSim.selectedId;
      body.append(el("button", {
        onclick: () => {
          if (picking) liveSimCancelIncidentPick();
          else liveSimBeginIncidentPick(LiveSim.selectedId);
          liveSimRenderInfoPanel();
        },
      }, picking ? "Click the map to place the incident... (cancel)" : "🚨 Dispatch to incident"));
      if (!picking) {
        body.append(el("div", { class: "readonly" },
          "Click, then click a point on the map: sends this vehicle there, then on to its home depot, preempting signals along the way."));
      }
    }
  }

  body.append(el("div", { class: "section-title" }, "Tags"));
  if (!info) {
    body.append(el("div", { class: "readonly" }, "Loading..."));
  } else {
    for (const [key, spec] of Object.entries(LIVE_SIM_INFO_FIELDS)) {
      if (!(key in info)) continue;
      const [label, fmt] = Array.isArray(spec) ? spec : [spec, String];
      body.append(el("div", { class: "field" }, el("label", {}, label), el("div", { class: "readonly" }, fmt(info[key]))));
    }
  }

  if (LiveSim.selectedRoute && LiveSim.selectedRoute.length >= 2) {
    let distM = 0;
    for (let i = 1; i < LiveSim.selectedRoute.length; i++) {
      const [ax, ay] = LiveSim.selectedRoute[i - 1], [bx, by] = LiveSim.selectedRoute[i];
      distM += Math.hypot(bx - ax, by - ay);
    }
    body.append(el("div", { class: "section-title" }, "Routing path"));
    body.append(
      el("div", { class: "field" }, el("label", {}, "Waypoints"),
        el("div", { class: "readonly" }, String(LiveSim.selectedRoute.length))),
      el("div", { class: "field" }, el("label", {}, "Path length"),
        el("div", { class: "readonly" }, `${(distM / 1000).toFixed(2)} km`)),
    );
  } else {
    body.append(el("div", { class: "section-title" }, "Routing path"));
    body.append(el("div", { class: "readonly" }, "Loading..."));
  }
}

// Auto/Density mode's live per-approach weight (rewritten from scratch
// 2026-09-02 - see sim_engine.cpp's buildStateJson "approachWeights" field
// and redlights.hpp's AutoWeightBoard: each approach's total is every
// queued vehicle's OWN elapsed seconds times its vehicle-type weight - car
// 1x, motorcycle 0.5x, bus 10x, truck 0.1x) for a selected SIGNALIZED node -
// called from simulation.js's renderInspector right alongside the
// external-control panel, so selecting a traffic light shows not just what
// it's doing but WHY (which approach is currently winning, and by how much).
// Returns a DOM node to append, matching renderExternalControlPanel's own
// calling convention; never throws/returns null even with no live data,
// just explains why.
function liveSimRenderApproachWeights(nodeId) {
  const wrap = el("div", {});
  wrap.append(el("div", { class: "section-title" }, "Auto signal weight (live)"));
  if (!LiveSim.connected || LiveSim.lastMeta.mode !== "density") {
    wrap.append(el("div", { class: "readonly" },
      "Only tracked while the live engine is running in Auto (traffic-weighted) signal mode."));
    return wrap;
  }
  const weightByWayId = LiveSim.approachWeights.get(nodeId);
  if (!weightByWayId || !weightByWayId.size) {
    wrap.append(el("div", { class: "readonly" }, "No approach currently has a vehicle queued here."));
    return wrap;
  }
  const ranked = Array.from(weightByWayId.entries()).sort((a, b) => b[1] - a[1]);
  const leadingWayId = ranked[0][1] > 0 ? ranked[0][0] : null;
  for (const [wayId, weight] of ranked) {
    const isLeading = wayId === leadingWayId;
    const row = el("div", { class: "field" },
      el("label", {}, `${wayId}${isLeading ? " — leading" : ""}`),
      el("div", { class: "readonly" }, weight.toFixed(1)));
    if (isLeading) row.style.fontWeight = "700";
    wrap.append(row);
  }
  return wrap;
}

/* ---------------- serve.py lifecycle (start/stop the subprocess) ---------------- */

async function liveSimRefreshStatus() {
  try {
    const res = await fetch("/api/sim/status");
    const data = await res.json();
    if (data.ok && data.running) {
      LiveSim.engineShouldBeRunning = true;
      if (!LiveSim.ws) liveSimConnect();
    }
    updateLiveSimStatusUI(data);
  } catch (e) {
    // serve.py not reachable for some reason - leave status as "not running", nothing to retry here
  }
}

async function liveSimStart() {
  const btn = $("#liveSimStartBtn");
  btn.disabled = true;
  btn.textContent = "Starting...";
  try {
    const concurrency = parseInt($("#liveSimConcurrencyInput").value, 10) || 500;
    const speed = parseFloat($("#liveSimSpeedInput").value) || 1;
    const advancedLaneAI = !!$("#liveSimAdvancedAiChk").checked;
    const signalMode = $("#liveSimSignalModeSelect").value;
    const res = await fetch("/api/sim/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ concurrency, speed, simSeconds: 3600, advancedLaneAI, signalMode }),
    });
    const data = await res.json();
    if (!data.ok) { toast(data.error || "Could not start the simulation engine"); return; }
    LiveSim.engineShouldBeRunning = true;
    LiveSim.reconnectAttempts = 0;
    // See LiveSim.pendingStartSync's own comment: /api/sim/start is a no-op
    // (by design - see serve.py's start_sim_engine) when an engine from an
    // earlier Start is already running, silently ignoring this call's
    // concurrency/signalMode/etc - so explicitly re-push the settings this
    // click actually asked for once connected, covering that case (harmless
    // no-op against a genuinely freshly-launched engine, which already got
    // the same values via its CLI args).
    LiveSim.pendingStartSync = { signalMode, advancedLaneAI, speed };
    liveSimConnect();
    if (LiveSim.connected) liveSimApplyPendingStartSync(); // ws was already open (see that function's own comment)
  } catch (e) {
    toast("Could not reach the server to start the simulation engine");
  } finally {
    updateLiveSimStatusUI();
  }
}

async function liveSimStop() {
  const btn = $("#liveSimStopBtn");
  btn.disabled = true;
  btn.textContent = "Stopping...";
  // Snapshot before liveSimDisconnect() below - it doesn't touch lastStats
  // itself, but the engine process is about to be killed, so this is the
  // last set of numbers there will ever be for this run.
  const finalStats = LiveSim.lastStats;
  try {
    liveSimSendCommand({ cmd: "stop" }); // best-effort graceful stop; serve.py's terminate() below is the real guarantee
    await fetch("/api/sim/stop", { method: "POST" });
  } catch (e) {
    toast("Could not reach the server to stop the simulation engine");
  } finally {
    liveSimDisconnect();
    updateLiveSimStatusUI();
    if (finalStats) showSimStatsModal(finalStats);
  }
}

/* ---------------- End-of-run stats popup ---------------- */

const LIVE_SIM_TYPE_LABELS = {
  car: "Car", motorcycle: "Motorcycle", bus: "Bus", truck: "Truck",
  ambulance: "Ambulance", firetruck: "Fire truck", police: "Police car",
};

function fmtSec(sec) {
  sec = Math.max(0, sec || 0);
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

// A plain overlay+card built straight from DOM calls (no existing modal
// component in this codebase to reuse - #inspector/#settingsPanel are both
// side panels, not centered dialogs) - shown once, when the engine stops, so
// the run's headline numbers (average trip time, and average emergency
// response/transport time - see sim_engine.cpp's buildStateJson "stats"
// field) are visible without having to have been watching the sidebar
// readout or the server's own stderr log the whole time.
function showSimStatsModal(stats) {
  const old = document.getElementById("simStatsOverlay");
  if (old) old.remove();

  const overlay = el("div", { id: "simStatsOverlay", class: "sim-stats-overlay" });
  const card = el("div", { class: "sim-stats-modal" });
  overlay.append(card);

  card.append(
    el("div", { class: "sim-stats-head" },
      el("span", {}, "Simulation run summary"),
      el("button", { class: "sim-stats-close", onclick: () => overlay.remove() }, "×")),
  );

  const body = el("div", { class: "sim-stats-body" });
  card.append(body);

  body.append(
    el("div", { class: "sim-stats-row sim-stats-highlight" },
      el("span", {}, "Trips completed"), el("span", {}, String(stats.completedTotal || 0))),
    el("div", { class: "sim-stats-row sim-stats-highlight" },
      el("span", {}, "Average trip time"), el("span", {}, fmtSec(stats.avgTripSec))),
    // Two distinct numbers (see sim_engine.cpp's buildStateJson "stuckNow"/
    // "stuckTotal" fields) - stuckNow is a snapshot of how many were stuck
    // (magenta-dot, >5s stopped) at the exact moment this run ended;
    // stuckTotal is how many DISTINCT vehicles were ever stuck at some
    // point during the whole run, which is normally the larger number.
    el("div", { class: "sim-stats-row" },
      el("span", {}, "Vehicles stuck when the run ended"), el("span", {}, String(stats.stuckNow || 0))),
    el("div", { class: "sim-stats-row" },
      el("span", {}, "Vehicles stuck at some point"), el("span", {}, String(stats.stuckTotal || 0))),
  );

  const byType = stats.byType || {};
  const typeKeys = Object.keys(byType).filter((k) => byType[k].count > 0);
  if (typeKeys.length) {
    body.append(el("div", { class: "sim-stats-section-title" }, "By vehicle type"));
    for (const ty of typeKeys) {
      const t = byType[ty];
      body.append(el("div", { class: "sim-stats-row" },
        el("span", {}, `${LIVE_SIM_TYPE_LABELS[ty] || ty} (${t.count})`), el("span", {}, fmtSec(t.avgTripSec))));
    }
  }

  const em = stats.emergency;
  body.append(el("div", { class: "sim-stats-section-title" }, "Emergency dispatches"));
  if (em && em.count > 0) {
    body.append(
      el("div", { class: "sim-stats-row" }, el("span", {}, "Dispatches completed"), el("span", {}, String(em.count))),
      el("div", { class: "sim-stats-row" },
        el("span", {}, "Avg response time (dispatch → incident)"), el("span", {}, fmtSec(em.avgResponseSec))),
      el("div", { class: "sim-stats-row" },
        el("span", {}, "Avg transport time (incident → hospital)"), el("span", {}, fmtSec(em.avgTransportSec))),
    );
  } else {
    body.append(el("div", { class: "readonly" }, "No emergency dispatches were completed this run."));
  }

  document.body.append(overlay);
}

/* ---------------- UI wiring ---------------- */

function initLiveSimUI() {
  $("#liveSimStartBtn").addEventListener("click", liveSimStart);
  $("#liveSimStopBtn").addEventListener("click", liveSimStop);
  // Once the engine is running, this box no longer just sets the speed it
  // starts at (liveSimStart already reads it for that) - changing it also
  // pushes a live setSpeed command, same as the shared "Fast-forward speed"
  // control (see redlight.js's setSimSpeed) so either control actually
  // speeds up the running simulation, not just the one that was used first.
  $("#liveSimSpeedInput").addEventListener("change", () => {
    const v = parseFloat($("#liveSimSpeedInput").value) || 1;
    liveSimSendCommand({ cmd: "setSpeed", value: v });
  });
  // Only reaches a running engine (liveSimSendCommand no-ops otherwise) -
  // liveSimStart already reads this checkbox's value for a fresh launch.
  $("#liveSimAdvancedAiChk").addEventListener("change", () => {
    liveSimSendCommand({ cmd: "setAdvancedLaneAI", value: $("#liveSimAdvancedAiChk").checked });
  });
  // Only reaches a running engine (liveSimStart already reads this select's
  // value for a fresh launch) - see SignalMode in sim_engine.cpp for what
  // each mode actually does.
  $("#liveSimSignalModeSelect").addEventListener("change", () => {
    liveSimSendCommand({ cmd: "setSignalMode", value: $("#liveSimSignalModeSelect").value });
  });
  // Collapses/expands the whole Emergency Control section (create-incident
  // control + the incident card list) - purely a local UI preference, no
  // engine round trip. Defaults open; state isn't persisted across reloads,
  // same as every other sidebar section in this app.
  $("#incidentsToggle").addEventListener("click", () => {
    const body = $("#incidentsBody"), chevron = $("#incidentsChevron");
    body.hidden = !body.hidden;
    chevron.classList.toggle("collapsed", body.hidden);
  });
  // Manual incident creation - arms a map-click pick (see
  // liveSimBeginIncidentCreatePick) so the operator pinpoints exactly where
  // it lands, rather than the random-timer's own locate()-based guess.
  // Clicking again while armed cancels it, same toggle feel as the vehicle
  // dispatch button.
  $("#incidentCreateBtn").addEventListener("click", () => {
    if (LiveSim.pickingIncidentKind != null) { liveSimCancelIncidentCreatePick(); return; }
    liveSimBeginIncidentCreatePick($("#incidentCreateKind").value);
  });
  LiveSim.engineShouldBeRunning = false;
  liveSimRefreshStatus();
  updateLiveSimStatusUI();
}

function updateLiveSimStatusUI(status) {
  const startBtn = $("#liveSimStartBtn");
  const stopBtn = $("#liveSimStopBtn");
  const statusEl = $("#liveSimStatus");
  if (!startBtn || !stopBtn || !statusEl) return;

  const running = status ? !!status.running : LiveSim.engineShouldBeRunning;
  startBtn.disabled = running;
  startBtn.textContent = "▶ Start engine";
  stopBtn.disabled = !running;
  stopBtn.textContent = "◼ Stop engine";

  if (!running) {
    statusEl.textContent = "Engine: not running";
  } else if (LiveSim.connected) {
    statusEl.textContent = `Engine: running, connected (port ${status ? status.port : LIVE_SIM_PORT})`;
  } else {
    statusEl.textContent = "Engine: running, connecting...";
  }
}

function updateLiveSimReadout() {
  const readoutEl = $("#liveSimReadout");
  if (!readoutEl) return;
  const m = LiveSim.lastMeta;
  const mins = Math.floor(m.t / 60), secs = Math.floor(m.t % 60);
  const modeLabel = { default: "default", density: "auto", emergency: "emergency-only" }[m.mode] || m.mode;
  readoutEl.textContent = `t=${mins}:${String(secs).padStart(2, "0")} · ${LiveSim.vehicles.size} active · `
    + `${m.completed}/${m.total} trips completed · signals: ${modeLabel}`;
}

/* ---------------- Rendering ---------------- */

// Per-type color only now - real length/width ride along per vehicle (v.l/
// v.w, see buildStateJson in sim_engine.cpp, generated per-vehicle by
// backend/generate_vehicles.py) so a rendered vehicle is its own actual
// hitbox, not a fixed type-average guess. These are only a fallback for the
// rare case a field is missing. Clamped to a min/max on-screen pixel size so
// vehicles stay visible zoomed far out without ballooning into blobs zoomed
// far in.
const LIVE_SIM_STYLE = {
  car: { length: 4.5, width: 1.8, color: "#2f6fed" },
  motorcycle: { length: 2.0, width: 0.8, color: "#6c757d" },
  bus: { length: 10.5, width: 2.5, color: "#f4a300" },
  truck: { length: 8.0, width: 2.4, color: "#8a5a44" },
  ambulance: { length: 6.0, width: 2.1, color: "#e63946" },
  firetruck: { length: 9.5, width: 2.5, color: "#c1121f" },
  police: { length: 4.8, width: 1.9, color: "#14213d" },
};
// The engine sends each vehicle's lateral offset directly (v.o, metres,
// positive = left of its own heading - see buildStateJson in
// sim_engine.cpp) already accounting for its own carriageway side (so it
// doesn't render on top of a two-way road's centreline/divider) and which
// of that carriageway's lanes it's using. The engine flips a vehicle's lane
// instantly (a discrete model), which would otherwise make an overtake
// look like a sideways teleport; this smooths the RENDERED offset toward
// whatever the engine just reported, purely a client-side visual nicety
// with no bearing on the actual simulation. Per-vehicle so each one eases
// independently; entries are dropped once a vehicle leaves (see
// ws.onmessage's removal loop) so this never grows unbounded.
const LIVE_SIM_LANE_LERP = 0.12;
LiveSim.renderedLaneOffset = new Map(); // id -> current eased offset, metres

function liveSimVehicleWorldPos(v) {
  const target = v.o || 0;
  let cur = LiveSim.renderedLaneOffset.get(v.id);
  cur = cur == null ? target : cur + (target - cur) * LIVE_SIM_LANE_LERP;
  LiveSim.renderedLaneOffset.set(v.id, cur);
  if (cur === 0) return { x: v.x, y: v.y };
  // v.o is positive = LEFT of heading (see its own comment above) - this
  // MUST use the left normal, not the right one, or every offset the
  // engine computes gets mirrored onto the wrong side of the road (this
  // was, in fact, exactly the bug behind a report of vehicles hugging the
  // right side of a two-way road instead of the left).
  const leftX = -Math.sin(v.h), leftY = Math.cos(v.h);
  return { x: v.x + leftX * cur, y: v.y + leftY * cur };
}

LiveSim.draw = function () {
  if (!LiveSim.vehicles.size) return;

  // Batched by type: one beginPath()+fill() per type instead of per vehicle,
  // since a fill can cover multiple disjoint quads added to the same path.
  const groups = new Map(); // type -> vehicle[]
  const emergencyVehicles = []; // ambulance/firetruck/police - EMERGENCY_VEHICLE_TYPES
  const waiting = []; // Auto/Density mode's green queue-chain dot - see v.aw (seconds this vehicle has been queued)
  const stuck = []; // stopped >5s - see v.stk
  for (const v of LiveSim.vehicles.values()) {
    const ty = LIVE_SIM_STYLE[v.ty] ? v.ty : "car";
    let arr = groups.get(ty);
    if (!arr) { arr = []; groups.set(ty, arr); }
    arr.push(v);
    if (EMERGENCY_VEHICLE_TYPES.has(ty)) emergencyVehicles.push(v);
    if (v.aw) waiting.push(v);
    if (v.stk) stuck.push(v);
  }

  const halfW = cssW() + 40, halfH = cssH() + 40;

  for (const [ty, arr] of groups) {
    const style = LIVE_SIM_STYLE[ty];
    ctx.beginPath();
    for (const v of arr) {
      const wp = liveSimVehicleWorldPos(v);
      const sp = worldToScreen(wp.x, wp.y);
      if (sp.x < -40 || sp.x > halfW || sp.y < -40 || sp.y > halfH) continue;
      const tip = worldToScreen(wp.x + Math.cos(v.h), wp.y + Math.sin(v.h));
      const dx = tip.x - sp.x, dy = tip.y - sp.y;
      const dlen = Math.max(1e-6, Math.hypot(dx, dy));
      const ux = dx / dlen, uy = dy / dlen;     // forward unit vector, screen space
      const px = -uy, py = ux;                   // perpendicular (left) unit vector

      // Pure world-metres * scale, no min/max pixel clamp - a clamp here
      // would make every vehicle the same on-screen size regardless of zoom
      // once past its floor/ceiling, i.e. exactly the "non-scalable, looks
      // bigger than it really is when zoomed out" bug reported against the
      // previous version of this code.
      const hl = ((v.l || style.length) / 2) * State.view.scale;
      const hw = ((v.w || style.width) / 2) * State.view.scale;

      const c1x = sp.x + ux * hl + px * hw, c1y = sp.y + uy * hl + py * hw;
      const c2x = sp.x + ux * hl - px * hw, c2y = sp.y + uy * hl - py * hw;
      const c3x = sp.x - ux * hl - px * hw, c3y = sp.y - uy * hl - py * hw;
      const c4x = sp.x - ux * hl + px * hw, c4y = sp.y - uy * hl + py * hw;
      ctx.moveTo(c1x, c1y);
      ctx.lineTo(c2x, c2y);
      ctx.lineTo(c3x, c3y);
      ctx.lineTo(c4x, c4y);
      ctx.closePath();
    }
    ctx.fillStyle = style.color;
    ctx.fill();
  }

  // Emergency-capable vehicles (ambulance/firetruck/police -
  // EMERGENCY_VEHICLE_TYPES) get a marker on top so they read as distinct
  // even at a glance among a dense crowd of same-colored ordinary vehicles -
  // cheap since they're only ever a small fraction of the fleet. An idle one
  // (not currently dispatched) gets a plain white centre dot, same treatment
  // ambulances always got. One actually responding (v.em - see
  // sim_engine.cpp's Vehicle::emergency) instead gets two small dots either
  // side of its centreline that swap red/blue on a fast wall-clock toggle -
  // the alternating light-bar look a real emergency vehicle runs while
  // responding, a much stronger "look here" signal than a single dot, and
  // (per the project ask) applied to any of the 3 types, not just ambulance.
  if (emergencyVehicles.length) {
    ctx.beginPath();
    let anyIdle = false;
    for (const v of emergencyVehicles) {
      if (v.em) continue;
      const wp = liveSimVehicleWorldPos(v);
      const sp = worldToScreen(wp.x, wp.y);
      if (sp.x < -40 || sp.x > halfW || sp.y < -40 || sp.y > halfH) continue;
      const r = Math.max(1.2, Math.min(4, 2.2 * (State.view.scale / 10)));
      ctx.moveTo(sp.x + r, sp.y);
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      anyIdle = true;
    }
    if (anyIdle) { ctx.fillStyle = "#ffffff"; ctx.fill(); }

    // Wall-clock toggle (no bearing on the simulation itself, same "client-
    // side nicety" spirit as LIVE_SIM_LANE_LERP above) - side===1 and
    // side===-1 swap which color they draw every ~300ms, producing the
    // alternating strobe.
    const flip = Math.floor(Date.now() / 300) % 2 === 0;
    for (const side of [1, -1]) {
      ctx.beginPath();
      let any = false;
      for (const v of emergencyVehicles) {
        if (!v.em) continue;
        const wp = liveSimVehicleWorldPos(v);
        const sp = worldToScreen(wp.x, wp.y);
        if (sp.x < -40 || sp.x > halfW || sp.y < -40 || sp.y > halfH) continue;
        const tip = worldToScreen(wp.x + Math.cos(v.h), wp.y + Math.sin(v.h));
        const dx = tip.x - sp.x, dy = tip.y - sp.y;
        const dlen = Math.max(1e-6, Math.hypot(dx, dy));
        const ux = dx / dlen, uy = dy / dlen;
        const px = -uy, py = ux; // left-perpendicular, same convention as the main quad loop above
        const r = Math.max(1.1, Math.min(3.5, 2.0 * (State.view.scale / 10)));
        const bx = sp.x + px * r * 1.8 * side, by = sp.y + py * r * 1.8 * side;
        ctx.moveTo(bx + r, by);
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        any = true;
      }
      if (any) {
        ctx.fillStyle = (side === 1) === flip ? "#ff2222" : "#2f6fff";
        ctx.fill();
      }
    }
  }

  // Floating dot just above a vehicle's own on-screen rotated rectangle -
  // shared by the Auto/Density-mode queue-chain dot (green, v.aw - the
  // vehicle's own elapsed queued seconds, rewritten from scratch 2026-09-02)
  // and the "stuck in traffic >5s" dot (magenta, v.stk - see
  // sim_engine.cpp's Vehicle::stoppedDurationSec/buildStateJson's "stk"
  // field). Uses each vehicle's OWN rotated half-extent (not just half its
  // length, which only matches when it's heading straight up/down on
  // screen) so the dot sits right on top of the vehicle at any heading -
  // for a vehicle heading east/west, "half length" would overshoot the
  // real rendered body by a lot (its on-screen height is its WIDTH, not its
  // length). Same forward/left screen-vector construction the main
  // vehicle-quad loop above uses.
  function liveSimDrawFloatingDots(vehiclesArr, color) {
    if (!vehiclesArr.length) return;
    ctx.beginPath();
    for (const v of vehiclesArr) {
      const wp = liveSimVehicleWorldPos(v);
      const sp = worldToScreen(wp.x, wp.y);
      if (sp.x < -40 || sp.x > halfW || sp.y < -40 || sp.y > halfH) continue;
      const tip = worldToScreen(wp.x + Math.cos(v.h), wp.y + Math.sin(v.h));
      const dx = tip.x - sp.x, dy = tip.y - sp.y;
      const dlen = Math.max(1e-6, Math.hypot(dx, dy));
      const forwardY = dy / dlen, leftY = dx / dlen; // forward = (dx,dy)/dlen; left = (-forwardY, forwardX), so left.y = forwardX = dx/dlen
      const style = LIVE_SIM_STYLE[v.ty] || LIVE_SIM_STYLE.car;
      const halfLenPx = ((v.l || style.length) / 2) * State.view.scale;
      const halfWidPx = ((v.w || style.width) / 2) * State.view.scale;
      const halfExtentPx = Math.abs(forwardY) * halfLenPx + Math.abs(leftY) * halfWidPx;
      const r = Math.max(1.5, Math.min(4.5, 2.4 * (State.view.scale / 10)));
      const dotY = sp.y - halfExtentPx - r - 2;
      ctx.moveTo(sp.x + r, dotY);
      ctx.arc(sp.x, dotY, r, 0, Math.PI * 2);
    }
    ctx.fillStyle = color;
    ctx.fill();
  }
  // Green, not red, so the Auto/Density-mode queue-chain dot doesn't read as
  // another red lamp/stop indicator next to the actual (red) signal glyphs -
  // "the first car that starts waiting gets a green dot on top, any car
  // that stops behind it gets its own dot too."
  liveSimDrawFloatingDots(waiting, "#06d6a0");
  // Magenta - a distinct color from every other live-sim marker (emergency
  // white/red-blue, waiting green, selection gold) so a genuinely stuck
  // vehicle (not just briefly queued at a light) stands out at a glance.
  liveSimDrawFloatingDots(stuck, "#ff00ff");

  liveSimDrawIncidents();
  liveSimDrawHospitalDestinations();
  liveSimDrawSelection();
};

// Icon shown at a responding vehicle's home-depot marker (see
// liveSimDrawHospitalDestinations) - matches the request literally
// ("the hospital ambulances are taking patients to") for ambulance, and
// generalizes the same treatment to firetruck/police returning to their own
// station, since the underlying data (LiveSim.depotDestinations) already
// covers all 3 emergency-capable types uniformly.
const LIVE_SIM_DEPOT_ICON = { ambulance: "🏥", firetruck: "🚒", police: "🚓" };

// A small marker + name label at the map location of every depot a
// currently-responding vehicle is ACTUALLY en route to right now - only once
// it's reached emergencyPhase 2 (picked up at the incident, see
// sim_engine.cpp's Vehicle::emergencyPhase), matching "after picking them
// up" - a phase-1 vehicle is still heading to the incident, not the depot,
// so nothing is shown for it yet. Deduplicated by amenityId per frame so two
// vehicles converging on the same hospital don't stack two identical labels.
// Deliberately independent of whether the originating incident card still
// exists (see LiveSim.depotDestinations's own comment) and of vehicle
// selection (unlike liveSimDrawSelection's traced route) - this is meant to
// answer "where is it going" for every ambulance doing so right now, not
// just one the operator happened to click.
function liveSimDrawHospitalDestinations() {
  if (!LiveSim.depotDestinations.size) return;
  const seenAmenity = new Set();
  for (const [id, dest] of LiveSim.depotDestinations) {
    const live = LiveSim.vehicles.get(id);
    if (!live || !live.em || (live.ep || 1) !== 2) continue;
    const amenity = State.amenities && State.amenities.get(dest.homeAmenityId);
    if (!amenity) continue;
    if (seenAmenity.has(amenity.id)) continue;
    seenAmenity.add(amenity.id);

    const sp = worldToScreen(amenity.x, amenity.y);
    ctx.save();
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = "#06d6a0";
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#0a3d2e";
    ctx.fillText(LIVE_SIM_DEPOT_ICON[dest.vehicleType] || "🏥", sp.x, sp.y);
    if (dest.homeDepotName) {
      ctx.font = "bold 11px 'Space Grotesk', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const ty = sp.y - 13;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(10,20,15,0.85)";
      ctx.strokeText(dest.homeDepotName, sp.x, ty);
      ctx.fillStyle = "#06d6a0";
      ctx.fillText(dest.homeDepotName, sp.x, ty);
    }
    ctx.restore();
  }
}

// Every still-pending incident's map marker (see liveSimSpawnIncident/
// LiveSim.incidents) - a freshly-spawned one plays a brief expanding, fading
// ring (INCIDENT_ANNOUNCE_MS - "shows itself"), then every incident,
// announcing or not, gets a small steady red pin + its icon ("becomes a red
// marker") for as long as it stays unaddressed. The selected one (if any -
// see liveSimSelectIncident) gets a gold ring, same visual language as
// liveSimDrawSelection's vehicle highlight.
function liveSimDrawIncidents() {
  if (!LiveSim.incidents.size) return;
  const now = Date.now();
  for (const inc of LiveSim.incidents.values()) {
    const sp = worldToScreen(inc.x, inc.y);

    if (now < inc.announceUntil) {
      const t = 1 - (inc.announceUntil - now) / INCIDENT_ANNOUNCE_MS; // 0 (just spawned) -> 1 (about to settle)
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 8 + t * 28, 0, Math.PI * 2);
      ctx.strokeStyle = "#ff2222";
      ctx.lineWidth = 3;
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const selected = LiveSim.selectedIncidentId === inc.id;
    const r = selected ? 11 : 9;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#e63946";
    ctx.fill();
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeStyle = selected ? "#ffd166" : "#7a0000";
    ctx.stroke();

    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(inc.icon, sp.x, sp.y - 1);
  }
}

// Selected vehicle's full planned route (server-resolved, requested once on
// selection - see liveSimSelectVehicle) as a dashed line, plus a highlight
// ring around the vehicle's own current position so it's easy to keep track
// of among a dense crowd of same-colored vehicles.
function liveSimDrawSelection() {
  if (LiveSim.selectedId == null) return;
  const v = LiveSim.vehicles.get(LiveSim.selectedId);
  if (!v) return;

  if (LiveSim.selectedRoute && LiveSim.selectedRoute.length >= 2) {
    ctx.save();
    ctx.strokeStyle = "#ffd166";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash([9, 6]);
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    LiveSim.selectedRoute.forEach((pt, i) => {
      const sp = worldToScreen(pt[0], pt[1]);
      if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  const wp = liveSimVehicleWorldPos(v);
  const sp = worldToScreen(wp.x, wp.y);
  ctx.save();
  ctx.beginPath();
  ctx.arc(sp.x, sp.y, Math.max(9, 7 * (State.view.scale / 8)), 0, Math.PI * 2);
  ctx.strokeStyle = "#ffd166";
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.restore();
}

// A top-level `const` does NOT become a window property (unlike a plain
// `function` declaration or `var`) - map-core.js's render() hook checks
// `window.LiveSim.draw`, the same no-op-if-absent pattern routetest.js uses
// (see its own `window.RouteTest = RouteTest` at the bottom), so this needs
// to be explicit or that hook silently never fires.
window.LiveSim = LiveSim;
