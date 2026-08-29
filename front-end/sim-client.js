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
  approachWeights: new Map(), // nodeId -> Map(wayId -> weight) - Density mode only, see buildStateJson's "approachWeights" field
  reconnectAttempts: 0,
  selectedId: null,      // vehicle id whose path is shown, or null
  selectedRoute: null,   // [[x,y], ...] once the server has answered getRoute, else null
  selectedInfo: null,    // static tag set once the server has answered getVehicleInfo, else null
  pickingEmergencyForId: null, // set while waiting for a map click to place an emergency's incident location - see liveSimBeginIncidentPick
};

const LIVE_SIM_PORT = 8766;
const LIVE_SIM_RECONNECT_MAX_ATTEMPTS = 20;
const LIVE_SIM_RECONNECT_DELAY_MS = 500;

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
    if (msg.type === "vehicleInfo") {
      if (msg.id === LiveSim.selectedId) {
        LiveSim.selectedInfo = msg;
        liveSimRenderInfoPanel();
      }
      return;
    }
    if (msg.type !== "state") return;

    LiveSim.lastMeta = { t: msg.t, spawned: msg.spawned, completed: msg.completed, total: msg.total, mode: msg.mode || "default" };
    const seen = new Set();
    for (const v of msg.vehicles) {
      LiveSim.vehicles.set(v.id, v);
      seen.add(v.id);
    }
    // A vehicle missing from this snapshot has finished its trip (or failed
    // to route at spawn) - the server only ever sends active vehicles, so
    // absence IS the removal signal, no separate "remove" message needed.
    for (const id of LiveSim.vehicles.keys()) {
      if (!seen.has(id)) { LiveSim.vehicles.delete(id); LiveSim.renderedLaneOffset.delete(id); }
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

    // Density mode's live per-approach "red dot" weight (nodeId -> Map(wayId
    // -> weight) - see sim_engine.cpp's buildStateJson) for the node
    // inspector's "Traffic-density weight" section (see
    // liveSimRenderApproachWeights) - same clear-when-absent pattern as the
    // lamp overrides above.
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
}

function liveSimSendCommand(obj) {
  if (LiveSim.ws && LiveSim.connected) LiveSim.ws.send(JSON.stringify(obj));
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
  // Vehicles and ordinary map features (node/way/building/amenity) share one
  // detail panel (#inspector) - selecting a vehicle takes it over, so drop
  // any map-feature selection first (mirrors the reverse direction handled
  // in simulation.js's mouseup handler).
  if (typeof clearSelection === "function") clearSelection();
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

// Arms "the next map click places this ambulance's incident location"
// instead of the ordinary select/pan click handling - see simulation.js's
// mouseup handler, which checks LiveSim.pickingEmergencyForId before falling
// through to its normal hit-testing.
function liveSimBeginIncidentPick(id) {
  LiveSim.pickingEmergencyForId = id;
  toast("Click a point on the map to dispatch this ambulance there.");
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
  if (LiveSim.selectedId === id) liveSimRenderInfoPanel();
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
  homeHospitalName: "Home hospital",
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
  // triggerEmergency) - only ever offered for ambulances, since that's the
  // whole point of the flag being separate from vehicleType=="ambulance": a
  // plain ambulance trip does NOT preempt signals, only one actually
  // dispatched to an incident does (EmergencyOnly/Density mode - see
  // SignalMode). Dispatching hands off to the home hospital automatically
  // once the incident is reached (see the engine's edge-transition step), so
  // there's nothing further to click once it's responding.
  if (info && info.vehicleType === "ambulance") {
    body.append(el("div", { class: "section-title" }, "Emergency dispatch"));
    if (live && live.em) {
      body.append(el("div", { class: "readonly" },
        "🚨 Responding - forces every signal it approaches green for its own approach (EmergencyOnly/Density mode)."));
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
          "Click, then click a point on the map: sends this ambulance there, then on to its home hospital, preempting signals along the way."));
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

// Density mode's live per-approach "red dot" weight (see sim_engine.cpp's
// buildStateJson "approachWeights" field and Vehicle::waitingLight) for a
// selected SIGNALIZED node - called from simulation.js's renderInspector
// right alongside the external-control panel, so selecting a traffic light
// shows not just what it's doing but WHY (which approach is currently
// winning under Density mode, and by how much). Returns a DOM node to
// append, matching renderExternalControlPanel's own calling convention;
// never throws/returns null even with no live data, just explains why.
function liveSimRenderApproachWeights(nodeId) {
  const wrap = el("div", {});
  wrap.append(el("div", { class: "section-title" }, "Traffic-density weight (live)"));
  if (!LiveSim.connected || LiveSim.lastMeta.mode !== "density") {
    wrap.append(el("div", { class: "readonly" },
      "Only tracked while the live engine is running in Traffic-density-based signal mode."));
    return wrap;
  }
  const weights = LiveSim.approachWeights.get(nodeId);
  if (!weights || !weights.size) {
    wrap.append(el("div", { class: "readonly" }, "No approach currently has a vehicle waiting here."));
    return wrap;
  }
  const rows = Array.from(weights.entries()).sort((a, b) => b[1] - a[1]);
  const topWayId = rows[0][1] > 0 ? rows[0][0] : null;
  for (const [wayId, weight] of rows) {
    const leading = wayId === topWayId;
    const row = el("div", { class: "field" },
      el("label", {}, `${wayId}${leading ? " — leading" : ""}`),
      el("div", { class: "readonly" }, weight.toFixed(1)));
    if (leading) row.style.fontWeight = "700";
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
    liveSimConnect();
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

const LIVE_SIM_TYPE_LABELS = { car: "Car", motorcycle: "Motorcycle", bus: "Bus", truck: "Truck", ambulance: "Ambulance" };

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
  const modeLabel = { default: "default", density: "density-based", emergency: "emergency-only" }[m.mode] || m.mode;
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
  const ambulances = [];
  const waiting = []; // Density mode's "red dot" queue state - see v.wt
  for (const v of LiveSim.vehicles.values()) {
    const ty = LIVE_SIM_STYLE[v.ty] ? v.ty : "car";
    let arr = groups.get(ty);
    if (!arr) { arr = []; groups.set(ty, arr); }
    arr.push(v);
    if (ty === "ambulance") ambulances.push(v);
    if (v.wt) waiting.push(v);
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

  // Ambulances get a small centre dot on top so they read as distinct even
  // at a glance among a dense crowd of same-colored cars - cheap since there
  // are only ever a handful active at once (~2% of the fleet). One currently
  // dispatched to an emergency (v.em - see sim_engine.cpp's Vehicle::
  // emergency) gets a brighter amber dot instead of plain white, so a
  // responding ambulance is visible even before clicking it to check.
  if (ambulances.length) {
    for (const color of ["#ffffff", "#ffb703"]) {
      ctx.beginPath();
      let any = false;
      for (const v of ambulances) {
        if ((color === "#ffb703") !== !!v.em) continue;
        const wp = liveSimVehicleWorldPos(v);
        const sp = worldToScreen(wp.x, wp.y);
        if (sp.x < -40 || sp.x > halfW || sp.y < -40 || sp.y > halfH) continue;
        const r = Math.max(1.2, Math.min(4, 2.2 * (State.view.scale / 10)));
        ctx.moveTo(sp.x + r, sp.y);
        ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        any = true;
      }
      if (any) { ctx.fillStyle = color; ctx.fill(); }
    }
  }

  // Density mode's "waiting for the light" dot (see sim_engine.cpp's
  // Vehicle::waitingLight/buildStateJson's "wt" field): floats just above
  // each waiting vehicle, chaining visually down a queue exactly as more
  // vehicles join it. Green, not red, so it doesn't read as another red
  // lamp/stop indicator next to the actual (red) signal glyphs.
  if (waiting.length) {
    ctx.beginPath();
    for (const v of waiting) {
      const wp = liveSimVehicleWorldPos(v);
      const sp = worldToScreen(wp.x, wp.y);
      if (sp.x < -40 || sp.x > halfW || sp.y < -40 || sp.y > halfH) continue;
      // On-screen vertical half-extent of the vehicle's OWN rotated
      // rectangle (not just half its length, which only matches when it's
      // heading straight up/down on screen) - otherwise, for a vehicle
      // heading east/west, "half length" overshoots the real rendered body
      // by a lot (its on-screen height is its WIDTH, not its length), which
      // left the dot floating well clear of the actual vehicle instead of
      // sitting on top of it. Same forward/left screen-vector construction
      // the main vehicle-quad loop above uses.
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
    ctx.fillStyle = "#06d6a0";
    ctx.fill();
  }

  liveSimDrawSelection();
};

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
