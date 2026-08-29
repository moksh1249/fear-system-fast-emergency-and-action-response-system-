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

   Signal rendering while connected: this phase's engine only implements the
   "default" fixed-time mode, which is the EXACT SAME math redlight.js
   already runs client-side (see front-end/redlight.js) - so rather than
   also streaming lamp colors over the wire, this just keeps Sim.clockSec
   synced to the server's own clock each tick and leaves Sim.running=false
   (so the local requestAnimationFrame loop's own clock advancement in
   map-core.js's loop() doesn't fight it) - the existing traffic-light
   rendering then "just works", in lockstep with the server. Once a later
   phase adds signal-control modes that depend on live server-only state
   (density/emergency preemption), lamp colors will need to be sent
   explicitly instead - not needed yet since default-mode is deterministic
   from the clock alone.
   ============================================================ */

const LiveSim = {
  ws: null,
  connected: false,
  vehicles: new Map(), // id -> {x, y, h, s, ty}
  lastMeta: { t: 0, spawned: 0, completed: 0, total: 0 },
  reconnectAttempts: 0,
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
    if (msg.type !== "state") return;

    LiveSim.lastMeta = { t: msg.t, spawned: msg.spawned, completed: msg.completed, total: msg.total };
    const seen = new Set();
    for (const v of msg.vehicles) {
      LiveSim.vehicles.set(v.id, v);
      seen.add(v.id);
    }
    // A vehicle missing from this snapshot has finished its trip (or failed
    // to route at spawn) - the server only ever sends active vehicles, so
    // absence IS the removal signal, no separate "remove" message needed.
    for (const id of LiveSim.vehicles.keys()) {
      if (!seen.has(id)) LiveSim.vehicles.delete(id);
    }

    // Keep the shared Sim clock (front-end/redlight.js) in lockstep with the
    // server's own clock - see file header for why this is enough to keep
    // fixed-time signal rendering correct without streaming lamp colors too.
    if (typeof Sim !== "undefined") {
      Sim.running = false;
      Sim.clockSec = msg.t;
    }

    updateLiveSimReadout();
    markDirty();
  };

  ws.onclose = () => {
    LiveSim.ws = null;
    LiveSim.connected = false;
    LiveSim.vehicles.clear();
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
  markDirty();
}

function liveSimSendCommand(obj) {
  if (LiveSim.ws && LiveSim.connected) LiveSim.ws.send(JSON.stringify(obj));
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
    const res = await fetch("/api/sim/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ concurrency, speed, simSeconds: 3600 }),
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
  try {
    liveSimSendCommand({ cmd: "stop" }); // best-effort graceful stop; serve.py's terminate() below is the real guarantee
    await fetch("/api/sim/stop", { method: "POST" });
  } catch (e) {
    toast("Could not reach the server to stop the simulation engine");
  } finally {
    liveSimDisconnect();
    updateLiveSimStatusUI();
  }
}

/* ---------------- UI wiring ---------------- */

function initLiveSimUI() {
  $("#liveSimStartBtn").addEventListener("click", liveSimStart);
  $("#liveSimStopBtn").addEventListener("click", liveSimStop);
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
  readoutEl.textContent = `t=${mins}:${String(secs).padStart(2, "0")} · ${LiveSim.vehicles.size} active · `
    + `${m.completed}/${m.total} trips completed`;
}

/* ---------------- Rendering ---------------- */

// Fixed-in-world-metres footprints per vehicle type (real dimensions aren't
// streamed over the wire to keep the per-tick payload small - see
// buildStateJson in sim_engine.cpp - so this is a per-type approximation,
// not each vehicle's own generated length/width). Clamped to a min/max
// on-screen pixel size so vehicles stay visible zoomed far out without
// ballooning into blobs zoomed far in.
const LIVE_SIM_STYLE = {
  car: { length: 4.2, width: 1.8, color: "#2f6fed" },
  motorcycle: { length: 2.0, width: 0.8, color: "#6c757d" },
  bus: { length: 10.5, width: 2.5, color: "#f4a300" },
  truck: { length: 8.0, width: 2.4, color: "#8a5a44" },
  ambulance: { length: 6.0, width: 2.1, color: "#e63946" },
};
const LIVE_SIM_MIN_PX = 3.2;
const LIVE_SIM_MAX_PX = 22;

LiveSim.draw = function () {
  if (!LiveSim.vehicles.size) return;

  // Batched by type: one beginPath()+fill() per type instead of per vehicle,
  // since a fill can cover multiple disjoint quads added to the same path.
  const groups = new Map(); // type -> vehicle[]
  const ambulances = [];
  for (const v of LiveSim.vehicles.values()) {
    const ty = LIVE_SIM_STYLE[v.ty] ? v.ty : "car";
    let arr = groups.get(ty);
    if (!arr) { arr = []; groups.set(ty, arr); }
    arr.push(v);
    if (ty === "ambulance") ambulances.push(v);
  }

  const halfW = cssW() + 40, halfH = cssH() + 40;

  for (const [ty, arr] of groups) {
    const style = LIVE_SIM_STYLE[ty];
    ctx.beginPath();
    for (const v of arr) {
      const sp = worldToScreen(v.x, v.y);
      if (sp.x < -40 || sp.x > halfW || sp.y < -40 || sp.y > halfH) continue;
      const tip = worldToScreen(v.x + Math.cos(v.h), v.y + Math.sin(v.h));
      const dx = tip.x - sp.x, dy = tip.y - sp.y;
      const dlen = Math.max(1e-6, Math.hypot(dx, dy));
      const ux = dx / dlen, uy = dy / dlen;     // forward unit vector, screen space
      const px = -uy, py = ux;                   // perpendicular (left) unit vector

      let hl = (style.length / 2) * State.view.scale;
      let hw = (style.width / 2) * State.view.scale;
      hl = Math.max(LIVE_SIM_MIN_PX / 2, Math.min(LIVE_SIM_MAX_PX / 2, hl));
      hw = Math.max(LIVE_SIM_MIN_PX * 0.55 / 2, Math.min(LIVE_SIM_MAX_PX * 0.55 / 2, hw));

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

  // Ambulances get a small white centre dot on top so they read as distinct
  // even at a glance among a dense crowd of same-colored cars - cheap since
  // there are only ever a handful active at once (~2% of the fleet).
  if (ambulances.length) {
    ctx.beginPath();
    for (const v of ambulances) {
      const sp = worldToScreen(v.x, v.y);
      if (sp.x < -40 || sp.x > halfW || sp.y < -40 || sp.y > halfH) continue;
      const r = Math.max(1.2, Math.min(4, 2.2 * (State.view.scale / 10)));
      ctx.moveTo(sp.x + r, sp.y);
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    }
    ctx.fillStyle = "#ffffff";
    ctx.fill();
  }
};

// A top-level `const` does NOT become a window property (unlike a plain
// `function` declaration or `var`) - map-core.js's render() hook checks
// `window.LiveSim.draw`, the same no-op-if-absent pattern routetest.js uses
// (see its own `window.RouteTest = RouteTest` at the bottom), so this needs
// to be explicit or that hook silently never fires.
window.LiveSim = LiveSim;
