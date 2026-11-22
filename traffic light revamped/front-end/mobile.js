"use strict";

/* ============================================================
   Phone map mode (simulation.html?mobile=1).

   fear_system_deployable's map is this very page in a WebView, so the road
   network, junctions, signals, buildings and live vehicles are drawn by
   exactly the same code as the laptop viewer. This file only adds what a
   phone needs on top of it, and does nothing at all without ?mobile=1:

   - touch: one-finger pan, two-finger pinch zoom, long-press to drop a pin.
     A plain tap still reaches simulation.js's click-to-inspect, through the
     mouse events the browser synthesizes for a tap.
   - the driver's own position (blue dot + heading), which the camera follows
     until the map is dragged away.
   - search: areas-ui.js's fuzzy place search, restyled as a floating bar,
     plus "nearest hospital / police / fire station / fuel" chips. A picked
     place or a dropped pin gets a Directions button.
   - the route the app plans for it.
   - nearby emergency vehicles: every ambulance, fire truck and police car
     within MOBILE_NEARBY_RADIUS_M, listed by distance and ringed on the map,
     with an alert when a responding one is closing in.
   - telling fear_backend's relay (its sim_relay.py) what is on screen, so
     it only sends the vehicles this phone can use.

   The app and this page talk through window.FearMobile (app -> page) and the
   webview's "FearApp" JavaScript channel (page -> app, JSON strings):
     page -> app  {type:"ready"}
                  {type:"routeTo", from:[x,y], to:[x,y], name}
                  {type:"clearRoute"}
                  {type:"emergencyAlert", vehicleType, distanceM}
     app -> page  FearMobile.setIdentity({vehicleId, vehicleType})
                  FearMobile.setMyPosition({lat, lon, headingDeg, speedKmh, accuracyM})
                  FearMobile.setTracking({tracking, forwarded})
                  FearMobile.setRoute({points: [[x,y], ...], distanceSec, name})
                  FearMobile.clearRoute()
                  FearMobile.showError(message)
   Everything is in the same local x/y metre space as the rest of the page;
   only setMyPosition takes lat/lon, projected here once.
   ============================================================ */

const MOBILE_NEARBY_RADIUS_M = 1500;
const MOBILE_ALERT_RADIUS_M = 400;         // a responding vehicle this close and heading this way raises the alert
const MOBILE_ALERT_REPEAT_MS = 30000;      // per vehicle, so one ambulance doesn't buzz the phone every tick
const MOBILE_FOLLOW_SCALE = 2.2;           // px per metre when the camera first snaps to the driver
const MOBILE_OFF_MAP_MARGIN_M = 2000;      // further than this outside the road network = "not on this map"
const MOBILE_LONG_PRESS_MS = 550;
const MOBILE_TAP_SLOP_PX = 10;

const MOBILE_EMERGENCY_ICON = { ambulance: "🚑", firetruck: "🚒", police: "🚓" };
const MOBILE_EMERGENCY_LABEL = { ambulance: "Ambulance", firetruck: "Fire truck", police: "Police car" };

// "Nearest ..." chips: amenity tag values that count as each kind.
const MOBILE_NEAREST_KINDS = [
  { key: "hospital", label: "Hospital", icon: "🏥", amenity: ["hospital", "clinic", "doctors"] },
  { key: "police", label: "Police", icon: "🚓", amenity: ["police"] },
  { key: "fire", label: "Fire station", icon: "🚒", amenity: ["fire_station"] },
  { key: "fuel", label: "Fuel", icon: "⛽", amenity: ["fuel"] },
];

const Mobile = {
  me: null,            // {x, y, headingDeg, speedKmh, accuracyM} in world metres, or null before the first fix
  follow: true,        // camera tracks `me` until the user drags the map
  identity: null,      // {vehicleId, vehicleType}
  tracking: null,      // {tracking, forwarded} - the app's GPS -> fear_backend state
  pin: null,           // {x, y, name, level, context} - a picked place / dropped pin, not yet routed to
  route: null,         // {points, distanceSec, name, lengthM}
  routeLoading: false,
  nearby: [],          // [{v, d, rel, approaching}] - see mobileComputeNearby
  nearbyOpen: false,
  alertedAt: new Map(), // vehicle id -> performance.now() of its last alert
  alert: null,         // the nearby[] entry currently shown in the alert banner
  mapBounds: null,     // road network bbox, world metres
  ready: false,
  lastViewMsg: "",
  lastViewWs: null,
  flashTimer: null,
};

function mobilePostToApp(msg) {
  if (window.FearApp && window.FearApp.postMessage) window.FearApp.postMessage(JSON.stringify(msg));
}

function mobileFormatDistance(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

/* ---------------- Geometry ---------------- */

// Same equirectangular projection as osm_to_json.py / road_graph.hpp's
// latLonToXY - the inverse of map-core.js's projectInverse.
function mobileProject(lat, lon) {
  const origin = (State.meta && State.meta.origin) || { lat: 0, lon: 0 };
  const R = 6378137;
  const x = (lon - origin.lon) * (Math.PI / 180) * Math.cos(origin.lat * Math.PI / 180) * R;
  const y = (lat - origin.lat) * (Math.PI / 180) * R;
  return { x, y };
}

function mobileComputeMapBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of State.nodes.values()) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// How far `p` is outside the road network's bounding box (0 when inside).
function mobileDistanceOffMap(p) {
  const b = Mobile.mapBounds;
  if (!b) return 0;
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY);
  return Math.hypot(dx, dy);
}

function mobileMeOnMap() {
  return !!Mobile.me && mobileDistanceOffMap(Mobile.me) <= MOBILE_OFF_MAP_MARGIN_M;
}

// Where "near me" is measured from: the driver when they're on this map,
// otherwise whatever the screen is centred on.
function mobileReferencePoint() {
  if (mobileMeOnMap()) return { x: Mobile.me.x, y: Mobile.me.y };
  return { x: State.view.cx, y: State.view.cy };
}

// Compass bearing (0 = north, clockwise) from a to b - world y points north.
function mobileBearing(a, b) {
  return (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360;
}

function mobileRelativeDirection(bearing) {
  const heading = mobileMeOnMap() ? Mobile.me.headingDeg : null;
  if (heading == null) {
    const labels = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
    return `to the ${labels[Math.round(bearing / 45) % 8]}`;
  }
  const rel = (bearing - heading + 360) % 360;
  if (rel < 45 || rel >= 315) return "ahead";
  if (rel < 135) return "to your right";
  if (rel < 225) return "behind you";
  return "to your left";
}

// Where a search result (or chip pick) actually is, for routing to it.
function mobileEntryPoint(entry) {
  if (entry.kind === "amenity") {
    const a = State.amenities.get(entry.id);
    return a ? { x: a.x, y: a.y } : null;
  }
  if (entry.kind === "building") {
    const b = State.buildings.get(entry.id);
    return b ? polygonCentroid(b.polygon) : null;
  }
  if (entry.kind === "road") {
    const way = State.ways.get((entry.wayIds || [entry.id])[0]);
    const n = way && State.nodes.get(way.nodes[Math.floor(way.nodes.length / 2)]);
    return n ? { x: n.x, y: n.y } : null;
  }
  if (entry.kind === "area") {
    const c = areaCentroid(entry.id);
    return c ? { x: c.x, y: c.y } : null;
  }
  return null;
}

/* ---------------- Camera ---------------- */

function mobileCenterOn(p, scale) {
  State.view.cx = p.x;
  State.view.cy = p.y;
  if (scale != null) State.view.scale = scale;
  updateZoomReadout();
  markDirty();
}

function mobileRecenter() {
  if (mobileMeOnMap()) {
    Mobile.follow = true;
    mobileCenterOn(Mobile.me, Math.max(State.view.scale, MOBILE_FOLLOW_SCALE));
  } else {
    fitView();
    if (Mobile.me) toast("Your GPS position isn't on this map - showing the whole map");
  }
  mobileRenderUI();
}

/* ---------------- Touch ---------------- */

const MobileTouch = {
  mode: null,       // "maybeTap" | "pan" | "pinch" | "longPressed"
  last: null,       // {sx, sy} single-finger position
  start: null,
  pinch: null,      // {dist, mid}
  timer: null,
};

function mobileTouchPoint(t) {
  const rect = canvas.getBoundingClientRect();
  return { sx: t.clientX - rect.left, sy: t.clientY - rect.top };
}

function mobilePinchState(touches) {
  const a = mobileTouchPoint(touches[0]), b = mobileTouchPoint(touches[1]);
  return { dist: Math.max(1, Math.hypot(a.sx - b.sx, a.sy - b.sy)), mid: { sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 } };
}

function mobilePanBy(from, to) {
  const before = screenToWorld(from.sx, from.sy);
  const after = screenToWorld(to.sx, to.sy);
  State.view.cx += before.x - after.x;
  State.view.cy += before.y - after.y;
  markDirty();
}

function mobileStopFollowing() {
  if (!Mobile.follow) return;
  Mobile.follow = false;
  mobileRenderUI();
}

function mobileInitTouch() {
  canvas.addEventListener("touchstart", (e) => {
    clearTimeout(MobileTouch.timer);
    if (e.touches.length >= 2) {
      MobileTouch.mode = "pinch";
      MobileTouch.pinch = mobilePinchState(e.touches);
      e.preventDefault();
      return;
    }
    const p = mobileTouchPoint(e.touches[0]);
    MobileTouch.mode = "maybeTap";
    MobileTouch.start = p;
    MobileTouch.last = p;
    MobileTouch.timer = setTimeout(() => {
      if (MobileTouch.mode !== "maybeTap") return;
      MobileTouch.mode = "longPressed";
      mobileDropPin(screenToWorld(p.sx, p.sy));
    }, MOBILE_LONG_PRESS_MS);
  }, { passive: false });

  canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (MobileTouch.mode === "pinch" && e.touches.length >= 2) {
      const next = mobilePinchState(e.touches);
      const prev = MobileTouch.pinch;
      zoomAt(next.mid.sx, next.mid.sy, next.dist / prev.dist);
      mobilePanBy(prev.mid, next.mid);
      MobileTouch.pinch = next;
      mobileStopFollowing();
      return;
    }
    if (e.touches.length !== 1 || MobileTouch.mode === "pinch") return;
    const p = mobileTouchPoint(e.touches[0]);
    if (MobileTouch.mode === "maybeTap") {
      if (Math.hypot(p.sx - MobileTouch.start.sx, p.sy - MobileTouch.start.sy) < MOBILE_TAP_SLOP_PX) return;
      clearTimeout(MobileTouch.timer);
      MobileTouch.mode = "pan";
    }
    if (MobileTouch.mode === "pan") {
      mobilePanBy(MobileTouch.last, p);
      MobileTouch.last = p;
      mobileStopFollowing();
    }
  }, { passive: false });

  const end = (e) => {
    clearTimeout(MobileTouch.timer);
    // A plain tap is left alone, so the browser's synthesized mouse events
    // reach simulation.js's click-to-inspect. Anything else (a drag, a pinch,
    // a long-press) cancels them - it isn't a click on whatever is underneath.
    if (MobileTouch.mode !== "maybeTap") e.preventDefault();
    if (e.touches.length === 1 && MobileTouch.mode === "pinch") {
      // One finger lifted mid-pinch: carry on as a pan from the remaining one.
      MobileTouch.mode = "pan";
      MobileTouch.last = mobileTouchPoint(e.touches[0]);
      return;
    }
    if (e.touches.length === 0) MobileTouch.mode = null;
  };
  canvas.addEventListener("touchend", end, { passive: false });
  canvas.addEventListener("touchcancel", end, { passive: false });
}

/* ---------------- Places, pins and routes ---------------- */

function mobileDropPin(world) {
  const latlon = projectInverse(world.x, world.y);
  mobileSetPin({
    x: world.x, y: world.y,
    name: "Dropped pin",
    level: "Pin",
    context: `${latlon.lat.toFixed(5)}, ${latlon.lon.toFixed(5)}`,
  });
}

function mobileSetPin(pin) {
  Mobile.pin = pin;
  Mobile.follow = false;
  mobileRenderUI();
  markDirty();
}

function mobileOnPlacePicked(entry) {
  const p = mobileEntryPoint(entry);
  if (!p) return;
  // The goto* helpers also select the feature, which opens the inspector -
  // on a phone that sheet would cover this card, and the card already shows
  // what was found. The search highlight stays.
  clearSelection();
  mobileSetPin({ x: p.x, y: p.y, name: entry.name, level: entry.level, context: entry.context || "" });
}

function mobileFindNearest(kind) {
  const from = mobileReferencePoint();
  let best = null, bestD = Infinity;
  for (const a of State.amenities.values()) {
    const t = a.tags || {};
    if (!kind.amenity.includes(t.amenity)) continue;
    const d = Math.hypot(a.x - from.x, a.y - from.y);
    if (d < bestD) { bestD = d; best = a; }
  }
  if (!best) { toast(`No ${kind.label.toLowerCase()} on this map`); return; }
  const t = best.tags || {};
  const entry = {
    kind: "amenity", id: best.id,
    name: t.name || t.designation || `Nearest ${kind.label.toLowerCase()}`,
    level: t.amenity ? zoneLabel(t.amenity) : kind.label,
    context: `${mobileFormatDistance(bestD)} away`,
  };
  gotoAmenity(entry);
  mobileOnPlacePicked(entry);
}

function mobileRequestRoute() {
  const pin = Mobile.pin;
  if (!pin) return;
  // Off this map (or no fix yet) there is nowhere real to route from, so the
  // map centre stands in - the card says so, rather than routing silently
  // from somewhere the driver isn't.
  const from = mobileMeOnMap() ? Mobile.me : { x: State.view.cx, y: State.view.cy };
  Mobile.routeLoading = true;
  mobileRenderUI();
  mobilePostToApp({ type: "routeTo", from: [from.x, from.y], to: [pin.x, pin.y], name: pin.name });
}

function mobileClearAll() {
  Mobile.pin = null;
  Mobile.route = null;
  Mobile.routeLoading = false;
  hidePlaceBanner();
  clearSearchHighlight();
  const input = $("#placeSearchInput");
  if (input) input.value = "";
  mobilePostToApp({ type: "clearRoute" });
  mobileRenderUI();
  markDirty();
}

function mobileRouteLength(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return m;
}

/* ---------------- Nearby emergency vehicles ---------------- */

function mobileComputeNearby() {
  const origin = mobileReferencePoint();
  const out = [];
  const myId = Mobile.identity && Mobile.identity.vehicleId;
  for (const v of LiveSim.vehicles.values()) {
    if (!EMERGENCY_VEHICLE_TYPES.has(v.ty)) continue;
    if (v.live && myId && v.vid === myId) continue; // this phone's own vehicle
    const d = Math.hypot(v.x - origin.x, v.y - origin.y);
    if (d > MOBILE_NEARBY_RADIUS_M) continue;
    // Heading towards us: its direction of travel points within ~60° of us
    // and it is actually moving. v.h is radians, world frame (x east, y north).
    const toUsX = origin.x - v.x, toUsY = origin.y - v.y;
    const len = Math.max(1e-6, Math.hypot(toUsX, toUsY));
    const approaching = (v.s || 0) > 5 && (Math.cos(v.h) * toUsX + Math.sin(v.h) * toUsY) / len > 0.5;
    out.push({ v, d, approaching, rel: mobileRelativeDirection(mobileBearing(origin, v)) });
  }
  // Responding vehicles first (they're the ones to get out of the way of),
  // then nearest.
  out.sort((a, b) => (!!b.v.em - !!a.v.em) || a.d - b.d);
  Mobile.nearby = out;

  const now = performance.now();
  const threat = out.find(n => n.v.em && n.approaching && n.d <= MOBILE_ALERT_RADIUS_M);
  Mobile.alert = threat || null;
  if (threat && now - (Mobile.alertedAt.get(threat.v.id) || -Infinity) > MOBILE_ALERT_REPEAT_MS) {
    Mobile.alertedAt.set(threat.v.id, now);
    mobilePostToApp({ type: "emergencyAlert", vehicleType: threat.v.ty, distanceM: Math.round(threat.d) });
  }
}

/* ---------------- Relay view ---------------- */

// Tells fear_backend's relay what this phone can see, so it only sends those
// vehicles (see sim_relay.py). Re-sent on every change, and straight after a
// reconnect - a fresh relay connection knows nothing about this page yet.
function mobileSendRelayView() {
  const ws = LiveSim.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const b = visibleWorldBounds();
  const ref = mobileReferencePoint();
  const msg = JSON.stringify({
    type: "relayView",
    bbox: [b.minX, b.minY, b.maxX, b.maxY].map(n => Math.round(n)),
    me: [Math.round(ref.x), Math.round(ref.y)],
    nearbyRadius: MOBILE_NEARBY_RADIUS_M,
  });
  if (ws === Mobile.lastViewWs && msg === Mobile.lastViewMsg) return;
  ws.send(msg);
  Mobile.lastViewWs = ws;
  Mobile.lastViewMsg = msg;
}

/* ---------------- Map overlay ---------------- */

function mobileDrawRoute() {
  const r = Mobile.route;
  if (!r || r.points.length < 2) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  r.points.forEach((pt, i) => {
    const sp = worldToScreen(pt[0], pt[1]);
    if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
  });
  ctx.strokeStyle = "#1a1a2e";
  ctx.lineWidth = 9;
  ctx.stroke();
  ctx.strokeStyle = "#4361ee";
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.restore();
}

function mobileDrawPin() {
  const p = Mobile.pin || (Mobile.route && Mobile.route.dest);
  if (!p) return;
  const sp = worldToScreen(p.x, p.y);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(sp.x, sp.y);
  ctx.lineTo(sp.x - 9, sp.y - 24);
  ctx.arc(sp.x, sp.y - 26, 9.5, Math.PI * 0.85, Math.PI * 0.15);
  ctx.closePath();
  ctx.fillStyle = "#ef476f";
  ctx.strokeStyle = "#1a1a2e";
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(sp.x, sp.y - 26, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.restore();
}

// A ring plus an emoji badge on each nearby emergency vehicle - a real car
// is a few pixels long once zoomed out, so without this they'd be invisible
// exactly when the driver most needs to see them coming.
function mobileDrawNearby() {
  if (!Mobile.nearby.length) return;
  const flash = Math.floor(performance.now() / 300) % 2 === 0;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const n of Mobile.nearby) {
    const wp = liveSimVehicleWorldPos(n.v);
    const sp = worldToScreen(wp.x, wp.y);
    if (sp.x < -40 || sp.x > cssW() + 40 || sp.y < -40 || sp.y > cssH() + 40) continue;
    const responding = !!n.v.em;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 15, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = responding ? (flash ? "#ef476f" : "#4361ee") : "#f8961e";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sp.x, sp.y - 24, 11, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#1a1a2e";
    ctx.stroke();
    ctx.font = "13px 'Space Grotesk', sans-serif";
    ctx.fillText(MOBILE_EMERGENCY_ICON[n.v.ty] || "🚨", sp.x, sp.y - 23);
  }
  ctx.restore();
  // Keep the responding vehicles' light-bar flashing between relay frames -
  // a timer at the flash rate, not a per-frame loop, since every redraw
  // repaints the whole map.
  if (Mobile.nearby.some(n => n.v.em) && !Mobile.flashTimer) {
    Mobile.flashTimer = setTimeout(() => { Mobile.flashTimer = null; markDirty(); }, 300);
  }
}

function mobileDrawMe() {
  const me = Mobile.me;
  if (!me) return;
  const sp = worldToScreen(me.x, me.y);
  if (sp.x < -60 || sp.x > cssW() + 60 || sp.y < -60 || sp.y > cssH() + 60) return;
  ctx.save();
  if (me.accuracyM) {
    const r = me.accuracyM * State.view.scale;
    if (r > 12) {
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(67, 97, 238, 0.12)";
      ctx.fill();
    }
  }
  if (me.headingDeg != null) {
    // Through worldToScreen, so the cone stays right on a rotated map.
    const h = me.headingDeg * Math.PI / 180;
    const tip = worldToScreen(me.x + Math.sin(h), me.y + Math.cos(h));
    const ang = Math.atan2(tip.y - sp.y, tip.x - sp.x);
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y);
    ctx.arc(sp.x, sp.y, 30, ang - 0.45, ang + 0.45);
    ctx.closePath();
    const grad = ctx.createRadialGradient(sp.x, sp.y, 4, sp.x, sp.y, 30);
    grad.addColorStop(0, "rgba(67, 97, 238, 0.55)");
    grad.addColorStop(1, "rgba(67, 97, 238, 0)");
    ctx.fillStyle = grad;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(sp.x, sp.y, 8, 0, Math.PI * 2);
  ctx.fillStyle = "#4361ee";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.restore();
}

function mobileDrawOverlay() {
  mobileDrawRoute();
  mobileDrawNearby();
  mobileDrawPin();
  mobileDrawMe();
}

/* ---------------- UI (floating controls over the canvas) ---------------- */

// Two stacks over the canvas: the top one extends the (restyled) topbar's
// search with the chips, alert, notice and status; the bottom one holds the
// nearby-vehicles panel, the recenter button and the place/route card.
// Stacking them in normal flow means nothing overlaps whatever is showing.
function mobileBuildUI() {
  const input = $("#placeSearchInput");
  if (input) input.placeholder = "Search places, roads, buildings…";

  $("#topbar").append(
    el("div", { id: "mobileChips", class: "mobile-chips" },
      ...MOBILE_NEAREST_KINDS.map(k => el("button", {
        class: "mobile-chip", type: "button",
        onclick: () => mobileFindNearest(k),
      }, `${k.icon} ${k.label}`))),
    el("div", { id: "mobileAlert", class: "mobile-alert", hidden: "" }),
    el("div", { id: "mobileNotice", class: "mobile-notice", hidden: "" }),
    el("div", { id: "mobileStatus", class: "mobile-status" }),
  );

  $("#workspace").append(
    el("div", { class: "mobile-bottom" },
      el("div", { class: "mobile-bottom-row" },
        el("div", { id: "mobileNearby", class: "mobile-nearby" }),
        el("button", { id: "mobileRecenter", class: "mobile-fab", type: "button", title: "Show my position", onclick: mobileRecenter }, "◎")),
      el("div", { id: "mobileCard", class: "mobile-card", hidden: "" })),
  );
}

// Rebuilding a panel on every tick would swap its buttons out from under a
// finger mid-tap, so each panel only re-renders when what it shows changes.
const MobileRendered = new Map(); // panel id -> signature it was last rendered with

function mobileChanged(id, signature) {
  if (MobileRendered.get(id) === signature) return false;
  MobileRendered.set(id, signature);
  return true;
}

function mobileRenderStatus() {
  const box = $("#mobileStatus");
  let cls = "off", text = "Not sharing location";
  if (!LiveSim.connected) {
    cls = "warn"; text = "Live feed reconnecting…";
  } else if (Mobile.tracking && Mobile.tracking.forwarded) {
    cls = "ok"; text = "Live · tracked in the simulation";
  } else if (Mobile.tracking && Mobile.tracking.tracking) {
    cls = "warn"; text = "Tracking · simulation starting…";
  }
  box.className = `mobile-status ${cls}`;
  box.textContent = text;
}

function mobileRenderNotice() {
  const box = $("#mobileNotice");
  const off = Mobile.me ? mobileDistanceOffMap(Mobile.me) : 0;
  if (off <= MOBILE_OFF_MAP_MARGIN_M) { box.hidden = true; return; }
  box.hidden = false;
  box.textContent = `📍 You're ${mobileFormatDistance(off)} outside the mapped area - nearby vehicles are measured from the map centre.`;
}

function mobileRenderAlert() {
  const box = $("#mobileAlert");
  const a = Mobile.alert;
  if (!a) { box.hidden = true; return; }
  box.hidden = false;
  box.textContent = `${MOBILE_EMERGENCY_ICON[a.v.ty] || "🚨"} ${MOBILE_EMERGENCY_LABEL[a.v.ty] || "Emergency vehicle"} responding ${mobileFormatDistance(a.d)} ${a.rel} - give way`;
}

function mobileRenderNearby() {
  const count = Mobile.nearby.length;
  const responding = Mobile.nearby.filter(n => n.v.em).length;
  const rows = Mobile.nearbyOpen ? Mobile.nearby.slice(0, 8) : [];
  const signature = [count, responding, Mobile.nearbyOpen,
    ...rows.map(n => `${n.v.id}:${Math.round(n.d / 10)}:${n.v.em || 0}:${n.v.ep || 0}:${n.approaching}:${n.rel}`)].join("|");
  if (!mobileChanged("nearby", signature)) return;
  const box = $("#mobileNearby");
  box.innerHTML = "";
  const label = count === 0
    ? `🚨 No emergency vehicles within ${mobileFormatDistance(MOBILE_NEARBY_RADIUS_M)}`
    : `🚨 ${count} emergency vehicle${count === 1 ? "" : "s"} nearby${responding ? ` · ${responding} responding` : ""}`;
  box.classList.toggle("has-any", count > 0);
  box.classList.toggle("has-responding", responding > 0);
  box.append(el("button", {
    class: "mobile-nearby-head", type: "button",
    onclick: () => { Mobile.nearbyOpen = !Mobile.nearbyOpen; mobileRenderNearby(); },
  }, label, count ? (Mobile.nearbyOpen ? " ▾" : " ▸") : ""));
  if (!rows.length) return;
  const list = el("div", { class: "mobile-nearby-list" });
  for (const n of rows) {
    const status = n.v.em ? (n.v.ep === 2 ? "returning" : "responding") : "on patrol";
    list.append(el("button", {
      class: "mobile-nearby-row" + (n.v.em ? " responding" : ""), type: "button",
      onclick: () => { Mobile.follow = false; mobileCenterOn(liveSimVehicleWorldPos(n.v), Math.max(State.view.scale, 1.5)); mobileRenderUI(); },
    },
      el("span", { class: "mobile-nearby-icon" }, MOBILE_EMERGENCY_ICON[n.v.ty] || "🚨"),
      el("span", { class: "mobile-nearby-text" },
        el("b", {}, MOBILE_EMERGENCY_LABEL[n.v.ty] || n.v.ty),
        ` · ${status}${n.approaching ? " · heading your way" : ""}`),
      el("span", { class: "mobile-nearby-dist" }, `${mobileFormatDistance(n.d)} ${n.rel.replace(/^to (the|your) /, "")}`)));
  }
  box.append(list);
}

function mobileRenderCard() {
  const r = Mobile.route;
  const pin = Mobile.pin;
  const dist = pin && mobileMeOnMap() ? Math.hypot(pin.x - Mobile.me.x, pin.y - Mobile.me.y) : null;
  const signature = r ? `route|${r.name}|${r.distanceSec}|${r.lengthM}`
    : pin ? `pin|${pin.x}|${pin.y}|${pin.name}|${Mobile.routeLoading}|${dist == null ? "" : Math.round(dist / 10)}`
    : "none";
  if (!mobileChanged("card", signature)) return;
  const box = $("#mobileCard");
  box.innerHTML = "";
  if (!r && !pin) { box.hidden = true; return; }
  box.hidden = false;

  if (r) {
    const mins = r.distanceSec != null ? Math.max(1, Math.ceil(r.distanceSec / 60)) : null;
    box.append(
      el("div", { class: "mobile-card-text" },
        el("div", { class: "mobile-card-level" }, "Route"),
        el("div", { class: "mobile-card-name" }, r.name || "Destination"),
        el("div", { class: "mobile-card-context" }, [mins != null ? `~${mins} min` : null, mobileFormatDistance(r.lengthM)].filter(Boolean).join(" · "))),
      el("button", { class: "mobile-card-close", type: "button", title: "Clear route", onclick: mobileClearAll }, "×"));
    return;
  }

  const dirBtn = el("button", {
    class: "mobile-card-go", type: "button", onclick: mobileRequestRoute,
  }, Mobile.routeLoading ? "Routing…" : "🧭 Directions");
  if (Mobile.routeLoading) dirBtn.disabled = true;
  box.append(
    el("div", { class: "mobile-card-text" },
      el("div", { class: "mobile-card-level" }, pin.level || "Place"),
      el("div", { class: "mobile-card-name" }, pin.name),
      el("div", { class: "mobile-card-context" }, [dist != null ? `${mobileFormatDistance(dist)} away` : null, pin.context].filter(Boolean).join(" · ")),
      mobileMeOnMap() ? "" : el("div", { class: "mobile-card-hint" }, "Directions start from the map centre - your GPS position isn't on this map.")),
    el("div", { class: "mobile-card-actions" },
      dirBtn,
      el("button", { class: "mobile-card-close", type: "button", title: "Close", onclick: mobileClearAll }, "×")));
}

function mobileRenderUI() {
  if (!Mobile.ready) return;
  mobileRenderStatus();
  mobileRenderNotice();
  mobileRenderAlert();
  mobileRenderNearby();
  mobileRenderCard();
  $("#mobileRecenter").classList.toggle("following", Mobile.follow && mobileMeOnMap());
}

/* ---------------- App -> page API ---------------- */

const FearMobile = {
  setIdentity(identity) {
    Mobile.identity = identity || null;
  },

  setMyPosition(fix) {
    if (!fix || !State.meta) return;
    const p = mobileProject(fix.lat, fix.lon);
    const first = !Mobile.me;
    Mobile.me = {
      x: p.x, y: p.y,
      headingDeg: fix.headingDeg != null ? fix.headingDeg : null,
      speedKmh: fix.speedKmh != null ? fix.speedKmh : null,
      accuracyM: fix.accuracyM != null ? fix.accuracyM : null,
    };
    if (Mobile.follow && mobileMeOnMap()) {
      mobileCenterOn(Mobile.me, first ? Math.max(State.view.scale, MOBILE_FOLLOW_SCALE) : null);
    }
    if (first) mobileRenderUI();
    markDirty();
  },

  setTracking(state) {
    Mobile.tracking = state || null;
    mobileRenderStatus();
  },

  setRoute(route) {
    Mobile.routeLoading = false;
    if (!route || !Array.isArray(route.points) || route.points.length < 2) {
      toast("No route found to that point");
      mobileRenderUI();
      return;
    }
    const dest = Mobile.pin ? { x: Mobile.pin.x, y: Mobile.pin.y } : null;
    Mobile.route = {
      points: route.points,
      distanceSec: route.distanceSec,
      name: route.name || (Mobile.pin && Mobile.pin.name),
      lengthM: mobileRouteLength(route.points),
      dest,
    };
    Mobile.pin = null;
    Mobile.follow = false;
    const xs = route.points.map(p => p[0]), ys = route.points.map(p => p[1]);
    frameWorldBounds({ minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }, { padFrac: 0.18, maxScale: 4 });
    mobileRenderUI();
    markDirty();
  },

  clearRoute() {
    Mobile.route = null;
    Mobile.routeLoading = false;
    mobileRenderUI();
    markDirty();
  },

  showError(message) {
    Mobile.routeLoading = false;
    toast(message);
    mobileRenderUI();
  },
};

/* ---------------- Boot ---------------- */

function mobileTick() {
  if (!Mobile.ready) return;
  mobileComputeNearby();
  mobileSendRelayView();
  mobileRenderUI();
}

function mobileWaitForMap() {
  if (!State.nodes.size) { setTimeout(mobileWaitForMap, 150); return; }
  Mobile.mapBounds = mobileComputeMapBounds();
  Mobile.ready = true;
  mobileRenderUI();
  mobilePostToApp({ type: "ready" });
}

function initMobile() {
  // The random-incident generator lives in the laptop page's own client
  // state (see sim-client.js's liveSimCheckIncidentTimer) - a phone must
  // never run a second one.
  const incidents = $("#liveSimIncidentsChk");
  if (incidents) incidents.checked = false;

  mobileBuildUI();
  mobileInitTouch();
  document.addEventListener("placepicked", (e) => mobileOnPlacePicked(e.detail));
  window.MobileOverlay = { draw: mobileDrawOverlay };
  window.FearMobile = FearMobile;
  setInterval(mobileTick, 400);
  mobileWaitForMap();
}

if (window.FEAR_MOBILE) initMobile();
