/* ============================================================
   FEAR Command - the government control room, inside the simulation viewer.

   One GUI, two vehicle sources, switched with the Simulation | Realistic
   toggle at the top of the sidebar (only one is ever active - it drives the
   engine's own setSimMode, same as the "Vehicle source" select):

     Simulation  the engine drives the synthetic vehicles.json traffic; the
                 viewer's own Emergency Control dispatches simulated vehicles.
     Realistic   only real phones move on the map - FEAR Command drivers and
                 citizens who share anonymous traffic - reporting GPS through
                 fear_backend. Incidents come from public SOS / reports /
                 this panel, and dispatch goes to real phones.

   The traffic lights are simulated in both modes.

   Talks to fear_backend (port 8080, same machine) with a FEAR Command
   account - every action is checked and audited there. Draws its overlays
   through map-core.js's render() hook (window.FearCmd.draw) and takes map
   clicks first through simulation.js (window.FearCmd.handleMapClick).
   ============================================================ */

(function () {
  if (window.FEAR_MOBILE) return; // the phone map mode has its own overlay

  const API = `${location.protocol}//${location.hostname}:8080`;
  const KIND_ICON = { medical: "🚑", fire: "🔥", crime: "🚨", accident: "💥", hazard: "⚠️", road_blocked: "⛔", congestion: "🚦", other: "❗" };
  const CAT_ICON = { ambulance: "🚑", firetruck: "🚒", police: "🚓", bus: "🚌", municipal: "🚛", government: "🚙", commercial: "🚚" };
  const CAT_COLOR = { ambulance: "#e53935", firetruck: "#f4511e", police: "#1e88e5", bus: "#43a047", municipal: "#8d6e63", government: "#7e57c2", commercial: "#546e7a" };
  const OPEN = new Set(["reported", "open", "dispatched", "on_scene"]);

  const F = {
    token: null, user: null, meta: {},
    ws: null, wsRetry: null, tick: null, version: null,
    incidents: [], alerts: [], phones: [], network: null, phoneOptions: null,
    tab: "incidents", selectedId: null, detail: null, suggest: {},
    picking: false, pendingPoint: null, error: null,
  };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDur = (s) => s == null ? "--" : s < 60 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`;
  const fmtDist = (m) => m == null ? "--" : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
  const ago = (iso) => { if (!iso) return "--"; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? `${Math.max(0, Math.round(s))} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  const label = (table, key) => (F.meta[table] && F.meta[table][key]) || String(key || "").replace(/_/g, " ");

  async function api(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { "Content-Type": "application/json", ...(F.token ? { Authorization: "Bearer " + F.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (res.status === 401 && F.token) { signOut(true); }
    if (!res.ok) {
      const d = data && data.detail;
      throw new Error(typeof d === "string" ? d : Array.isArray(d) && d[0] ? `${(d[0].loc || []).slice(-1)[0]}: ${d[0].msg}` : `Request failed (${res.status})`);
    }
    return data;
  }
  async function act(fn, ok) {
    try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast("FEAR: " + e.message); return null; }
  }

  /* ---------------- world <-> lat/lon (same projection as projectInverse) ---------------- */
  function toWorld(lat, lon) {
    const o = (State.meta && State.meta.origin) || { lat: 0, lon: 0 };
    const R = 6378137, k = Math.PI / 180;
    return { x: (lon - o.lon) * k * Math.cos(o.lat * k) * R, y: (lat - o.lat) * k * R };
  }

  /* ---------------- vehicle-source mode ---------------- */
  function currentMode() {
    if (window.LiveSim && LiveSim.connected && LiveSim.engineSimMode) return LiveSim.engineSimMode;
    const sel = document.querySelector("#liveSimModeSelect");
    return sel ? sel.value : "simulation";
  }

  async function setMode(mode) {
    const sel = document.querySelector("#liveSimModeSelect");
    if (!sel) return;
    sel.value = mode;
    // Emergency corridors need a preemption-capable signal mode.
    const sig = document.querySelector("#liveSimSignalModeSelect");
    if (mode === "realistic" && sig && sig.value === "default") {
      sig.value = "emergency";
      sig.dispatchEvent(new Event("change"));
    }
    if (window.LiveSim && LiveSim.connected) {
      sel.dispatchEvent(new Event("change")); // sends setSimMode to the running engine
      toast(mode === "realistic" ? "Realistic mode: only real GPS phones move on the map" : "Simulation mode: synthetic traffic");
    } else if (typeof liveSimStart === "function") {
      if (typeof liveSimRenderModeHint === "function") liveSimRenderModeHint();
      toast(`Starting the engine in ${mode} mode...`);
      await liveSimStart();
    }
    applyModeVisibility(mode);
    render();
  }

  function applyModeVisibility(mode) {
    const realistic = mode === "realistic";
    const simIncidents = document.querySelector("#incidentsSection");
    if (simIncidents) simIncidents.hidden = realistic; // simulated dispatch belongs to simulation mode only
    const randomChk = document.querySelector("#liveSimIncidentsChk");
    if (randomChk) { randomChk.disabled = realistic; if (realistic) randomChk.checked = false; }
  }

  /* ---------------- session ---------------- */
  function loadSession() {
    try {
      F.token = localStorage.getItem("fearCmd.token");
      F.user = JSON.parse(localStorage.getItem("fearCmd.user") || "null");
    } catch (_) {}
  }
  function saveSession() {
    try {
      if (F.token) { localStorage.setItem("fearCmd.token", F.token); localStorage.setItem("fearCmd.user", JSON.stringify(F.user)); }
      else { localStorage.removeItem("fearCmd.token"); localStorage.removeItem("fearCmd.user"); }
    } catch (_) {}
  }

  async function signIn(username, password) {
    F.error = null;
    try {
      const r = await api("POST", "/gov/auth/login", { username, password });
      if (r.user.role === "driver") throw new Error("driver accounts sign in on the phone app");
      F.token = r.token; F.user = r.user; saveSession();
      await afterSignIn();
    } catch (e) { F.error = e.message; render(); }
  }

  function signOut(expired) {
    if (F.token && !expired) api("POST", "/gov/auth/logout").catch(() => {});
    F.token = null; F.user = null; F.incidents = []; F.tick = null; F.detail = null; F.selectedId = null;
    F.error = expired ? "Session ended - sign in again." : null;
    saveSession();
    if (F.ws) { try { F.ws.close(); } catch (_) {} F.ws = null; }
    render(); markDirty();
  }

  async function afterSignIn() {
    try { F.meta = await api("GET", "/gov/meta"); } catch (_) {}
    connectWs();
    await refreshLists();
    render();
  }

  const can = (p) => !!(F.user && F.user.permissions && F.user.permissions[p]);
  const canEnroll = () => F.user && (F.user.role === "super_admin" || F.user.role === "org_admin" || F.user.authority === "iccc");
  const isCommand = () => F.user && (F.user.role === "super_admin" || F.user.role === "operator");

  /* ---------------- live feed ---------------- */
  function connectWs() {
    if (!F.token) return;
    clearTimeout(F.wsRetry);
    const ws = new WebSocket(API.replace(/^http/, "ws") + "/v2/ws");
    F.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", app: "gov", token: F.token }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== "tick") return;
      F.tick = msg;
      if (msg.version !== F.version) { F.version = msg.version; refreshLists(); }
      if (F.selectedId) refreshDetail(false);
      renderLive();
      markDirty();
    };
    ws.onclose = (ev) => {
      if (F.ws !== ws) return;
      F.ws = null;
      if (ev.code === 4401) { signOut(true); return; }
      if (F.token) F.wsRetry = setTimeout(connectWs, 3000);
    };
  }

  async function refreshLists() {
    if (!F.token) return;
    try {
      if (isCommand()) {
        F.incidents = await api("GET", "/gov/incidents");
        F.ai = await api("GET", "/gov/ai");
      }
      F.alerts = await api("GET", "/gov/alerts");
      if (canEnroll()) F.phones = await api("GET", "/gov/phones");
      F.network = await api("GET", "/gov/network");
    } catch (_) {}
    if (F.selectedId) await refreshDetail(true);
    render(); markDirty();
  }

  let detailBusy = false, detailAt = 0;
  async function refreshDetail(force) {
    if (!F.selectedId || detailBusy) return;
    if (!force && Date.now() - detailAt < 4000) return;
    detailBusy = true;
    try { F.detail = await api("GET", `/gov/incidents/${F.selectedId}`); detailAt = Date.now(); } catch (_) {}
    detailBusy = false;
    renderDetailOnly();
  }

  /* ---------------- map overlays ---------------- */
  function draw() {
    if (!F.token || typeof ctx === "undefined") return;
    const scale = State.view.scale;
    ctx.save();
    // public alerts
    for (const a of F.alerts) {
      const w = toWorld(a.lat, a.lon), sp = worldToScreen(w.x, w.y);
      ctx.beginPath(); ctx.arc(sp.x, sp.y, Math.max(6, a.radiusM * scale), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(249,168,37,0.14)"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "#f9a825"; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    // emergency corridors (the route an authorized vehicle is being given priority along)
    for (const c of (F.tick && F.tick.corridors) || []) {
      const pts = (c.points || []).map((p) => { const w = toWorld(p[0], p[1]); return worldToScreen(w.x, w.y); });
      if (pts.length < 2) continue;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
      // dark-blue route with a bright highlight: a glow, a dark-blue body and a
      // light centre line, so a dispatched vehicle's path stands out from every road colour
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.lineWidth = 14; ctx.strokeStyle = "rgba(79,195,247,0.45)"; ctx.stroke();
      ctx.lineWidth = 8; ctx.strokeStyle = "#0b2e83"; ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = "#8fd3ff"; ctx.setLineDash([10, 8]); ctx.stroke(); ctx.setLineDash([]);
    }
    // incidents
    for (const i of F.incidents) {
      if (!OPEN.has(i.status)) continue;
      const w = toWorld(i.lat, i.lon), sp = worldToScreen(w.x, w.y);
      const sel = i.id === F.selectedId;
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 16 + pulse * 6, 0, Math.PI * 2);
      ctx.fillStyle = i.status === "reported" ? "rgba(255,209,102,0.35)" : "rgba(239,71,111,0.30)"; ctx.fill();
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 13, 0, Math.PI * 2);
      ctx.fillStyle = "#fff"; ctx.fill();
      ctx.lineWidth = sel ? 4 : 2.5; ctx.strokeStyle = sel ? "#ffd166" : (i.status === "reported" ? "#f9a825" : "#e63946"); ctx.stroke();
      ctx.font = "15px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(KIND_ICON[i.kind] || "❗", sp.x, sp.y + 1);
    }
    // unit labels (vehicle identity only) above the engine's live vehicles -
    // zoomed out, just the category icon, so labels never bury the city
    const fullLabels = scale >= 0.35;
    const labelPx = Math.round(Math.max(9, Math.min(11, 8 + scale * 2)));
    for (const u of (F.tick && F.tick.units) || []) {
      if (u.lat == null || !u.onDuty) continue;
      const w = toWorld(u.lat, u.lon), sp = worldToScreen(w.x, w.y);
      const text = fullLabels ? `${CAT_ICON[u.category] || ""} ${u.vehicleId}${u.emergency ? " ⚡" : ""}${u.demo ? " (demo)" : ""}`
        : `${CAT_ICON[u.category] || "•"}${u.emergency ? "⚡" : ""}`;
      ctx.font = `bold ${labelPx}px 'Space Grotesk', sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.strokeText(text, sp.x, sp.y - 12);
      ctx.fillStyle = u.stale ? "#9e9e9e" : (CAT_COLOR[u.category] || "#1a1a2e"); ctx.fillText(text, sp.x, sp.y - 12);
      if (u.stale || currentMode() !== "realistic") {
        // not in the engine right now (no fresh GPS, or simulation mode) - mark where it last was
        ctx.beginPath(); ctx.arc(sp.x, sp.y, Math.max(3, Math.min(6, 2 + scale * 4)), 0, Math.PI * 2);
        ctx.fillStyle = "rgba(158,158,158,0.7)"; ctx.fill();
      }
    }
    ctx.restore();
    if (F.incidents.some((i) => OPEN.has(i.status)) || ((F.tick && F.tick.corridors) || []).length) markDirty();
  }

  function handleMapClick(world) {
    if (!F.token) return false;
    const ll = projectInverse(world.x, world.y);
    if (F.picking) {
      F.picking = false;
      F.pendingPoint = ll;
      F.tab = "incidents";
      render();
      return true;
    }
    const sp = worldToScreen(world.x, world.y);
    for (const i of F.incidents) {
      if (!OPEN.has(i.status)) continue;
      const w = toWorld(i.lat, i.lon), ip = worldToScreen(w.x, w.y);
      if (Math.hypot(ip.x - sp.x, ip.y - sp.y) <= 16) { select(i.id); return true; }
    }
    return false;
  }

  function select(id) {
    F.selectedId = id; F.detail = null; F.suggest = {}; F.tab = "incidents";
    render(); refreshDetail(true); markDirty();
  }

  function focus(lat, lon) {
    const w = toWorld(lat, lon);
    State.view.cx = w.x; State.view.cy = w.y;
    if (State.view.scale < 1.2) State.view.scale = 1.6;
    markDirty();
  }

  /* ---------------- panel ---------------- */
  let root = null;

  function build() {
    const sidebar = document.querySelector("#sidebar");
    if (!sidebar) return;
    root = document.createElement("div");
    root.className = "sidebar-section";
    root.id = "fearSection";
    sidebar.insertBefore(root, sidebar.firstChild);
    root.addEventListener("focusout", () => setTimeout(() => { if (F.renderPending && !typing()) render(); }, 0));
  }

  function typing() {
    const a = document.activeElement;
    return !!(root && a && root.contains(a) && a.matches("input, textarea, select"));
  }

  function render() {
    if (!root) return;
    // Don't throw away what someone is typing; catch up once they leave the field.
    if (typing()) { F.renderPending = true; return; }
    F.renderPending = false;
    const mode = currentMode();
    applyModeVisibility(mode);
    const modeHtml = `
      <div class="fear-mode">
        <button data-mode="simulation" class="sim ${mode === "simulation" ? "on" : ""}">🧪 Simulation</button>
        <button data-mode="realistic" class="real ${mode === "realistic" ? "on" : ""}">📡 Realistic</button>
      </div>
      <div class="fear-mode-note">${mode === "realistic"
        ? "Real phones only. Lights stay simulated; vehicles are live GPS."
        : "Synthetic traffic from vehicles.json. Phone GPS is paused."}</div>`;

    if (!F.token) {
      root.innerHTML = `
        <div class="sidebar-section-title fear-title"><span>FEAR Command</span><span class="fear-badge">GOV</span></div>
        ${modeHtml}
        <div class="fear-hint">Sign in with a FEAR Command account for incidents, real dispatch, phone logins and network sharing.</div>
        <input class="fear-input" id="fearUser" placeholder="Username (e.g. cmd-iccc)" autocomplete="username">
        <input class="fear-input" id="fearPass" type="password" placeholder="Password" autocomplete="current-password">
        ${F.error ? `<div class="fear-err">${esc(F.error)}</div>` : ""}
        <button id="fearSignIn">Sign in</button>`;
      root.querySelector("#fearSignIn").onclick = () => signIn(root.querySelector("#fearUser").value.trim(), root.querySelector("#fearPass").value);
      root.querySelector("#fearPass").onkeydown = (e) => { if (e.key === "Enter") root.querySelector("#fearSignIn").click(); };
      bindMode();
      return;
    }

    const who = F.user.role === "operator" ? (F.user.authorityLabel || "Operator") : F.user.role === "super_admin" ? "Super admin" : "Org admin";
    const tabs = [["incidents", "Incidents"], ["units", "Units"], ["phones", "Phones"], ["requests", "Requests"], ["network", "Network"], ["map", "Map"]];
    root.innerHTML = `
      <div class="sidebar-section-title fear-title"><span>FEAR Command</span><button id="fearOut" title="Sign out">Sign out</button></div>
      <div class="fear-user">${esc(F.user.displayName)} · ${esc(who)}</div>
      ${modeHtml}
      <div id="fearLive" class="fear-hint"></div>
      <div class="fear-tabs">${tabs.map(([k, t]) => `<button data-tab="${k}" class="${F.tab === k ? "active" : ""}">${t}</button>`).join("")}</div>
      <div id="fearBody"></div>`;
    root.querySelector("#fearOut").onclick = () => signOut(false);
    root.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { F.tab = b.dataset.tab; render(); if (F.tab === "phones") loadPhoneOptions(); if (F.tab === "map") loadMapInfo(); if (F.tab === "requests") loadRequests(); }));
    bindMode();
    renderLive();
    const body = root.querySelector("#fearBody");
    if (F.tab === "incidents") renderIncidents(body);
    else if (F.tab === "units") renderUnits(body);
    else if (F.tab === "phones") renderPhones(body);
    else if (F.tab === "map") renderMapAdmin(body);
    else if (F.tab === "requests") renderRequests(body);
    else renderNetwork(body);
  }

  function bindMode() {
    root.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => { if (b.dataset.mode !== currentMode()) setMode(b.dataset.mode); }));
  }

  function renderLive() {
    const el = root && root.querySelector("#fearLive");
    if (!el) return;
    const e = (F.tick && F.tick.engine) || {};
    const units = (F.tick && F.tick.units) || [];
    const onDuty = units.filter((u) => u.onDuty && !u.stale).length;
    const prio = units.filter((u) => u.emergency).length;
    const feed = F.ws && F.ws.readyState === 1 ? "🟢" : "🔴";
    const t = F.tick && F.tick.traffic;
    const traffic = t ? ` · traffic: ${t.count} vehicle(s)${t.live ? " sending GPS" : ""}${t.avgKmh != null ? `, avg ${t.avgKmh} km/h` : ""}${t.slowShare != null ? `, ${Math.round(t.slowShare * 100)}% slow` : ""}` : "";
    el.textContent = `${feed} engine ${e.connected ? (e.simMode || "?") : "offline"} · ${onDuty} unit(s) reporting · ${prio} with signal priority · ${(e.preempted || []).length} junction(s) held green${traffic}`;
  }

  /* ---------------- incidents ---------------- */
  function renderIncidents(body) {
    if (!isCommand()) { body.innerHTML = `<div class="fear-hint">Incidents are handled by Command seats (e.g. cmd-iccc).</div>`; return; }
    const open = F.incidents.filter((i) => OPEN.has(i.status));
    const kinds = (F.user.permissions.incidentKinds || []);
    let html = "";
    if (F.pendingPoint) {
      html += `<div class="fear-detail"><h4>New incident</h4>
        <div class="fear-hint">at ${F.pendingPoint.lat.toFixed(5)}, ${F.pendingPoint.lon.toFixed(5)}</div>
        <select class="fear-input" id="fearNewKind">${kinds.map((k) => `<option value="${k}">${KIND_ICON[k] || ""} ${esc(label("incidentKinds", k))}</option>`).join("")}</select>
        <select class="fear-input" id="fearNewSev"><option value="normal">Normal</option><option value="high">High</option><option value="critical">Critical</option><option value="low">Low</option></select>
        <textarea class="fear-input" id="fearNewDesc" placeholder="Details"></textarea>
        <button id="fearNewOk">Create</button><button id="fearNewCancel">Cancel</button></div>`;
    } else {
      html += `<div class="fear-row"><button id="fearPick">${F.picking ? "Click the map… (cancel)" : "+ Incident on map"}</button></div>`;
    }
    html += aiBarHtml();
    if (F.selectedId && F.detail) html += detailHtml(F.detail);
    else if (F.selectedId) html += `<div class="fear-detail">Loading…</div>`;
    html += `<div class="fear-hint">${open.length} open · SOS and reports from the public app arrive here.</div>`;
    open.sort((a, b) => (b.severityScore || 0) - (a.severityScore || 0) || b.createdAt.localeCompare(a.createdAt));
    for (const i of open) {
      const u = i.units || {};
      const active = ["assigned", "en_route", "on_scene", "transporting"].reduce((a, k) => a + (u[k] || 0), 0);
      html += `<div class="fear-card ${i.id === F.selectedId ? "sel" : ""}" data-inc="${i.id}">
        <div class="h"><span>${KIND_ICON[i.kind] || ""} ${esc(i.kindLabel)}</span><span class="fear-pill ${i.status}">${esc(i.status.replace("_", " "))}</span></div>
        <div class="s">${sevChip(i)}${i.voice ? " 🎙️" : ""} ${esc(i.place || "")} · ${esc(i.source)} · ${ago(i.createdAt)}${active ? ` · ${active} unit(s)` : ""}${i.demo ? ' · <span class="fear-pill demo">demo</span>' : ""}</div>
        ${i.triage && i.triage.terms && i.triage.terms.length ? `<div class="s">${termsHtml(i.triage.terms.slice(0, 5))}</div>` : ""}
        ${!active ? aiLineHtml(i) : ""}</div>`;
    }
    body.innerHTML = html;
    const pick = body.querySelector("#fearPick");
    if (pick) pick.onclick = () => { F.picking = !F.picking; render(); toast(F.picking ? "Click the map where the incident is" : "Cancelled"); };
    const ok = body.querySelector("#fearNewOk");
    if (ok) {
      ok.onclick = async () => {
        const r = await act(() => api("POST", "/gov/incidents", {
          kind: body.querySelector("#fearNewKind").value, severity: body.querySelector("#fearNewSev").value,
          description: body.querySelector("#fearNewDesc").value.trim() || null, lat: F.pendingPoint.lat, lon: F.pendingPoint.lon,
        }), "Incident created");
        F.pendingPoint = null;
        if (r) { await refreshLists(); select(r.id); } else render();
      };
      body.querySelector("#fearNewCancel").onclick = () => { F.pendingPoint = null; render(); };
    }
    body.querySelectorAll("[data-inc]").forEach((c) => (c.onclick = () => { const i = F.incidents.find((x) => x.id === c.dataset.inc); select(c.dataset.inc); if (i) focus(i.lat, i.lon); }));
    body.querySelectorAll("[data-ai]").forEach((b) => (b.onclick = async () => {
      const v = b.dataset.ai;
      if (v === "off" && !confirm("Turn the AI dispatch agent off? Emergencies nobody responds to will then wait for a person.")) return;
      const r = await act(() => api("PUT", "/gov/ai", v === "off" ? { enabled: false } : { enabled: true, mode: v }),
        v === "off" ? "AI dispatch agent off" : v === "advise" ? "AI agent: advise only" : "AI agent: dispatches automatically");
      if (r) { F.ai = { ...F.ai, ...r }; render(); }
    }));
    bindDetail(body);
  }

  /* severity, key terms and the AI dispatch agent */
  const SEV_LABEL = { 1: "Minor", 2: "Moderate", 3: "Serious", 4: "Severe", 5: "Critical" };
  function sevChip(i) {
    return i.severityScore ? `<span class="fear-sev s${i.severityScore}" title="Severity ${i.severityScore}/5">${SEV_LABEL[i.severityScore]}</span>` : "";
  }
  function termsHtml(terms) {
    return terms.map((t) => `<span class="fear-term">${esc(t)}</span>`).join(" ");
  }
  function countdown(iso) {
    const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
    if (s <= 0) return "now";
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  function aiLineHtml(i) {
    const st = i.ai && i.ai.status;
    if (st === "dispatched") return `<div class="s fear-ai">🤖 AI agent dispatched ${esc((i.ai.vehicles || []).join(", "))}</div>`;
    if (st === "advised") return `<div class="s fear-ai">🤖 AI agent recommends ${esc((i.ai.vehicles || []).join(", "))}</div>`;
    if (st === "no_units") return `<div class="s fear-ai warn">🤖 AI agent found no unit: ${esc(i.ai.note || "")}</div>`;
    if (st === "possible_duplicate" || st === "left_for_command") return `<div class="s fear-ai warn">🤖 ${esc(i.ai.note || "")}</div>`;
    if (i.aiDueAt && !i.respondedAt) return `<div class="s fear-ai">🤖 AI ${F.ai && F.ai.mode === "advise" ? "advice" : "dispatch"} in <b data-due="${i.aiDueAt}">${countdown(i.aiDueAt)}</b> unless someone responds</div>`;
    return "";
  }
  function aiBarHtml() {
    const a = F.ai;
    if (!a) return "";
    const state = !a.enabled ? "off" : a.mode;
    const text = !a.enabled ? "Off - emergencies wait for a person"
      : a.mode === "advise" ? `Advise only - recommends units after ${Math.round(a.windowSec / 60)} min without a response`
      : `Dispatches automatically after ${Math.round(a.windowSec / 60)} min without a response`;
    let h = `<div class="fear-aibar"><div><b>🤖 AI dispatch agent</b> · ${esc(text)}${a.model ? "" : " (rules only - no AI model configured)"}</div>`;
    if (a.canConfigure) {
      h += `<div class="fear-mode" style="margin:4px 0 0">${[["dispatch", "Auto"], ["advise", "Advise"], ["off", "Off"]]
        .map(([v, l]) => `<button data-ai="${v}" class="${state === v ? "on real" : ""}">${l}</button>`).join("")}</div>`;
    }
    return h + `</div>`;
  }

  function renderDetailOnly() {
    if (F.tab !== "incidents" || !root) return;
    const body = root.querySelector("#fearBody");
    if (!body) return;
    const el = body.querySelector("#fearDetail");
    if (el && F.detail) {
      // swap just the detail card, leaving any half-filled form above it alone
      const tmp = document.createElement("div");
      tmp.innerHTML = detailHtml(F.detail);
      el.replaceWith(tmp.firstElementChild);
      bindDetail(body);
    } else if (!typing()) {
      renderIncidents(body);
    }
  }

  function detailHtml(d) {
    const live = new Map((((F.tick && F.tick.units) || [])).map((u) => [u.vehicleId, u]));
    let h = `<div class="fear-detail" id="fearDetail">
      <div class="fear-row"><h4 style="flex:1">${KIND_ICON[d.kind] || ""} ${esc(d.kindLabel)}</h4><button data-a="close-panel">✕</button></div>
      <div class="fear-hint">${esc(d.id)} · <span class="fear-pill ${d.status}">${esc(d.status.replace("_", " "))}</span> · ${esc(d.place || "")}</div>
      ${d.description ? `<div style="font-style:italic;margin:4px 0">${d.voice ? "🎙️ " : ""}"${esc(d.description)}"</div>` : ""}
      ${d.voice && d.voice.original ? `<div class="fear-hint">As spoken (${esc(d.voice.language || "")}): "${esc(d.voice.original)}"</div>` : ""}`;
    const t = d.triage;
    if (d.severityScore || t) {
      const needs = t && t.needs ? Object.entries(t.needs).map(([c, n]) => `${n} ${esc(label("vehicleCategories", c))}`).join(", ") : "";
      h += `<div class="fear-triage">${sevChip(d)} <span class="fear-hint">${d.severityScore || "?"}/5 · ${t && t.method === "ai+rules" ? "AI + key terms" : "key terms"}${t && t.injured != null ? ` · ${t.injured} people affected` : ""}</span>
        ${t && t.summary ? `<div>${esc(t.summary)}</div>` : ""}
        ${t && t.terms && t.terms.length ? `<div>${termsHtml(t.terms)}</div>` : ""}
        ${needs ? `<div class="fear-hint">Likely needs: ${needs}</div>` : ""}</div>`;
    }
    const iv = d.interview;
    if (iv) {
      const f = iv.facts || {};
      const yn = (v) => (v === "yes" ? "yes" : v === "no" ? "no" : "not said");
      h += `<div class="fear-triage"><b>🎙️ Responder interview</b>${iv.done ? "" : " (in progress)"} · ${esc(iv.lang || "")}
        <div>Hurt: <b>${f.injured ?? "not said"}</b> · Unconscious/not breathing/heavy bleeding: <b>${yn(f.critical)}</b> · Trapped/fire/fuel: <b>${yn(f.hazard)}</b>
        ${(f.vehicles || []).length ? ` · Vehicles: <b>${esc(f.vehicles.join(", "))}</b>` : ""}${f.landmark ? ` · Landmark: <b>${esc(f.landmark)}</b>` : ""} · Caller safe: <b>${yn(f.callerSafe)}</b></div>
        ${(iv.turns || []).map((t) => `<div class="fear-hint">Q: ${esc(t.qEn || t.q)}<br>A: ${esc(t.a || "-")}${t.aOrig ? ` <i>(${esc(t.aOrig)})</i>` : ""}</div>`).join("")}</div>`;
    }
    const recNeeds = t && t.needs ? Object.entries(t.needs).filter(([c]) => (d.dispatchCategories || []).includes(c)) : [];
    if (recNeeds.length && OPEN.has(d.status) && d.status !== "reported") {
      h += `<button data-a="dispatch-rec" style="background:#0b2e83;color:#fff">⚡ Dispatch recommended: ${recNeeds.map(([c, n]) => `${n} ${esc(label("vehicleCategories", c))}`).join(", ")}</button>`;
    }
    const ai = d.ai;
    if (ai && ai.status) {
      h += `<div class="fear-aibox"><b>🤖 AI agent: ${esc(ai.status.replace("_", " "))}</b>${ai.vehicles && ai.vehicles.length ? ` - ${esc(ai.vehicles.join(", "))}` : ""}
        ${ai.reason ? `<div>${esc(ai.reason)}</div>` : ""}${ai.note ? `<div class="fear-hint">${esc(ai.note)}</div>` : ""}</div>`;
    } else if (d.aiDueAt && !d.respondedAt && !d.units.length) {
      h += `<div class="fear-aibox">🤖 AI ${F.ai && F.ai.mode === "advise" ? "advice" : "dispatch"} in <b data-due="${d.aiDueAt}">${countdown(d.aiDueAt)}</b> - acknowledge to handle it yourself</div>`;
    }
    h += `<div>`;
    if (!d.respondedAt && OPEN.has(d.status)) h += `<button data-a="ack">✋ Acknowledge</button>`;
    if (d.canVerify) h += `<button data-a="verify">✔ Verify</button><button data-a="reject">✖ Reject</button>`;
    if (d.canViewCallerContact) h += `<button data-a="contact">📞 Caller contact</button>`;
    if (d.canClose) h += `<button data-a="close">Close incident</button>`;
    h += `</div><div style="margin-top:6px;font-weight:700">Responding</div>`;
    if (!d.units.length) h += `<div class="fear-hint">No unit dispatched yet.</div>`;
    for (const u of d.units) {
      const l = live.get(u.vehicleId) || u;
      const eta = l.etaSec != null && ["assigned", "en_route", "transporting"].includes(u.status) ? ` · ETA ${fmtDur(l.etaSec)}` : "";
      h += `<div class="fear-sugg"><span>${CAT_ICON[u.category] || ""} ${esc(u.vehicleId)} <span class="fear-pill ${u.status}">${esc(u.statusLabel)}</span>${eta}${l.emergency ? ' <span class="fear-pill prio">priority</span>' : ""}${u.destKind === "hospital" ? ` → ${esc(u.destName)}` : ""}</span>
        ${u.canRecall ? `<button data-a="recall" data-unit="${u.unitId}">Recall</button>` : ""}</div>`;
    }
    const cats = d.dispatchCategories || [];
    if (OPEN.has(d.status) && d.status !== "reported" && cats.length) {
      h += `<div style="margin-top:6px;font-weight:700">Dispatch</div><div>`;
      for (const c of cats) h += `<button data-a="suggest" data-cat="${c}">${CAT_ICON[c] || ""} Nearest ${esc(label("vehicleCategories", c))}</button>`;
      h += `</div>`;
      for (const c of cats) {
        const list = F.suggest[c];
        if (!list) continue;
        if (!list.length) h += `<div class="fear-hint">No ${esc(label("vehicleCategories", c))} on duty with live GPS.</div>`;
        for (const s of list) {
          h += `<div class="fear-sugg"><span>${CAT_ICON[c] || ""} <b>${esc(s.vehicleId)}</b> ${s.etaSec != null ? `${fmtDur(s.etaSec)} by road (${fmtDist(s.roadM)})` : "no road route"}${s.demo ? ' <span class="fear-pill demo">demo gps</span>' : ""}</span>
            <button data-a="dispatch" data-veh="${s.vehicleId}" data-cat="${c}">Dispatch</button></div>`;
        }
      }
    }
    h += `<div style="margin-top:6px;font-weight:700">Timeline</div>`;
    for (const e of d.events.slice().reverse().slice(0, 8)) h += `<div class="tl">${new Date(e.at).toLocaleTimeString()} · ${esc(e.text)}</div>`;
    return h + `</div>`;
  }

  function bindDetail(body) {
    const d = F.detail;
    if (!d) return;
    body.querySelectorAll("#fearDetail [data-a]").forEach((b) => (b.onclick = async (ev) => {
      ev.stopPropagation();
      const a = b.dataset.a, id = d.id;
      if (a === "close-panel") { F.selectedId = null; F.detail = null; render(); markDirty(); return; }
      if (a === "suggest") {
        const r = await act(() => api("GET", `/gov/incidents/${id}/suggest?category=${b.dataset.cat}`));
        if (r) { F.suggest[b.dataset.cat] = r; renderDetailOnly(); }
        return;
      }
      if (a === "dispatch") {
        const r = await act(() => api("POST", `/gov/incidents/${id}/dispatch`, { vehicle_id: b.dataset.veh }), `${b.dataset.veh} dispatched - waiting for the driver to accept`);
        if (r) { delete F.suggest[b.dataset.cat]; await refreshDetail(true); }
        return;
      }
      if (a === "dispatch-rec") {
        const r = await act(() => api("POST", `/gov/incidents/${id}/dispatch-recommended`));
        if (r) toast(r.sent.length ? `Dispatched ${r.sent.join(", ")}${r.notes.length ? " · " + r.notes.join("; ") : ""}` : `Nothing sent: ${r.notes.join("; ")}`);
      } else if (a === "ack") {
        await act(() => api("POST", `/gov/incidents/${id}/ack`), "Acknowledged - the AI agent stands down on this one");
      } else if (a === "recall") {
        if (!confirm("Recall this unit? Its signal priority ends.")) return;
        await act(() => api("POST", `/gov/incidents/${id}/units/${b.dataset.unit}/recall`), "Unit recalled");
      } else if (a === "verify" || a === "reject") {
        const accept = a === "verify";
        const alert = accept && confirm("Also warn the public within 400 m of it?");
        await act(() => api("POST", `/gov/incidents/${id}/verify`, { accept, alert, alert_radius_m: 400 }), accept ? "Report verified" : "Report rejected");
      } else if (a === "contact") {
        const reason = prompt("Reason for opening the caller's contact (recorded in the audit log, at least 10 characters):");
        if (!reason || reason.trim().length < 10) return;
        const c = await act(() => api("POST", `/gov/incidents/${id}/caller-contact`, { reason: reason.trim() }));
        if (c) alert(`Caller: ${c.name || "not given"}\nPhone: ${c.phone}\n\n(This access was audited.)`);
        return;
      } else if (a === "close") {
        const note = prompt("Closing note (optional). Closing releases all units and ends the caller's contact sharing.", "");
        if (note === null) return;
        await act(() => api("POST", `/gov/incidents/${id}/close`, { note: note || null }), "Incident closed");
      }
      await refreshLists();
    }));
  }

  /* ---------------- units ---------------- */
  function renderUnits(body) {
    const units = ((F.tick && F.tick.units) || []).slice().sort((a, b) => (b.onDuty - a.onDuty) || a.vehicleId.localeCompare(b.vehicleId));
    let h = `<div class="fear-hint">${units.length} vehicle(s) visible to this account. Command sees vehicle identities, not drivers.</div>`;
    for (const u of units) {
      h += `<div class="fear-card" data-u="${u.vehicleId}">
        <div class="h"><span>${CAT_ICON[u.category] || ""} ${esc(u.vehicleId)}</span><span class="fear-pill ${u.status}">${esc(u.status.replace("_", " "))}</span></div>
        <div class="s">${esc(u.plate)} · ${u.onDuty ? (u.stale ? "GPS lost" : `${Math.round(u.speedKmh || 0)} km/h · ${ago(u.updatedAt)}`) : "off duty"}
        ${u.emergency ? ' <span class="fear-pill prio">priority</span>' : ""}${u.demo ? ' <span class="fear-pill demo">demo</span>' : ""}
        ${u.etaSec != null && u.task ? ` · ETA ${fmtDur(u.etaSec)}` : ""}</div></div>`;
    }
    body.innerHTML = h;
    body.querySelectorAll("[data-u]").forEach((c) => (c.onclick = () => { const u = units.find((x) => x.vehicleId === c.dataset.u); if (u && u.lat != null) focus(u.lat, u.lon); }));
  }

  /* ---------------- phones (QR logins) ---------------- */
  async function loadPhoneOptions() {
    if (!canEnroll()) return;
    try { F.phoneOptions = await api("GET", "/gov/phones/options"); F.phones = await api("GET", "/gov/phones"); } catch (e) { toast("FEAR: " + e.message); }
    if (F.tab === "phones") render();
  }

  const PUBLIC_TYPE_LABELS = { car: "Car", motorcycle: "Bike / motorcycle", scooter: "Scooter", auto_rickshaw: "Auto-rickshaw",
                               bus: "Bus", truck: "Truck", other: "Other" };

  function renderPhones(body) {
    if (!canEnroll()) { body.innerHTML = `<div class="fear-hint">Phone logins are issued by the ICCC seat, FEAR's admin or an organization admin.</div>`; return; }
    const o = F.phoneOptions;
    if (!o) { body.innerHTML = `<div class="fear-hint">Loading…</div>`; return; }
    const mode = F.phoneMode || "gov";
    const f = (F.phoneForm = F.phoneForm || {});
    const val = (k) => esc(f[k] || "");
    let h = `<div style="font-weight:700">Add a phone</div>
      <div class="fear-mode" style="margin-top:4px">
        <button data-pmode="gov" class="real ${mode === "gov" ? "on" : ""}">🛡️ Government</button>
        <button data-pmode="public" class="sim ${mode === "public" ? "on" : ""}">📱 Public</button>
        <button data-pmode="existing" class="real ${mode === "existing" ? "on" : ""}">🔑 Existing</button>
      </div>`;
    const person = `
      <input class="fear-input" data-f="name" placeholder="Full name" value="${val("name")}">
      <input class="fear-input" data-f="phone" placeholder="Mobile number" inputmode="tel" value="${val("phone")}">
      <textarea class="fear-input" data-f="address" placeholder="Address">${val("address")}</textarea>
      <input class="fear-input" data-f="plate" placeholder="Vehicle plate (e.g. UP14 AB 1234)" value="${val("plate")}">`;
    if (mode === "existing") {
      const sub = F.phoneExistKind || "self";
      h += `<select class="fear-input" id="fearExistKind">
          <option value="self" ${sub === "self" ? "selected" : ""}>Sign in on my own phone (${esc(F.user.username || "")})</option>
          <option value="existing_user" ${sub === "existing_user" ? "selected" : ""}>An existing employee or driver (username)</option>
          <option value="existing_citizen" ${sub === "existing_citizen" ? "selected" : ""}>An existing FEAR app user (mobile number)</option>
        </select>`;
      if (sub === "existing_user") h += `<input class="fear-input" data-f="username" placeholder="Their username" value="${val("username")}">`;
      if (sub === "existing_citizen") h += `<input class="fear-input" data-f="phone" placeholder="Their mobile number" inputmode="tel" value="${val("phone")}">`;
      h += `<div class="fear-hint">No new account is created: the QR signs the phone in to the existing account and points it at this server.</div>`;
    } else if (mode === "gov") {
      const sub = F.phoneGovKind || "driver";
      h += `<select class="fear-input" id="fearGovKind">
          <option value="driver" ${sub === "driver" ? "selected" : ""}>New emergency / government vehicle + driver</option>
          <option value="existing_driver" ${sub === "existing_driver" ? "selected" : ""}>Phone for an existing vehicle's driver</option>
        </select>`;
      if (sub === "driver") {
        const cats = [];
        for (const org of o.orgs) for (const c of org.categories) if (!cats.find((x) => x.id === c.id)) cats.push(c);
        const cat = cats.find((c) => c.id === f.category) || cats[0];
        const orgs = o.orgs.filter((org) => org.categories.some((c) => cat && c.id === cat.id));
        const org = orgs.find((x) => x.id === f.org_id) || orgs[0];
        h += person + `
          <select class="fear-input" data-f="category" id="fearPhoneCat">${cats.map((c) => `<option value="${c.id}" ${cat && c.id === cat.id ? "selected" : ""}>${CAT_ICON[c.id] || ""} ${esc(c.label)}</option>`).join("")}</select>
          <select class="fear-input" data-f="org_id" id="fearPhoneOrg">${orgs.map((x) => `<option value="${x.id}" ${org && x.id === org.id ? "selected" : ""}>${esc(x.name)}${x.verified ? "" : " (awaiting verification)"}</option>`).join("")}</select>
          <div class="fear-hint">Creates the vehicle (FEAR ID), the driver and the assignment; the FEAR Command app signs straight in.</div>`;
        f.category = cat && cat.id; f.org_id = org && org.id;
      } else {
        h += `<select class="fear-input" data-f="vehicle_id" id="fearPhoneVeh">${o.vehicles.map((v) => `<option value="${v.id}" ${f.vehicle_id === v.id ? "selected" : ""}>${CAT_ICON[v.category] || ""} ${esc(v.id)} · ${esc(v.plate)}${v.full_name ? " · " + esc(v.full_name) : ""}</option>`).join("")}</select>
          <div class="fear-hint">Signs a phone in as the driver already assigned to that vehicle.</div>`;
      }
    } else {
      const sub = F.phonePubKind || "citizen";
      h += `<select class="fear-input" id="fearPubKind">
          <option value="citizen" ${sub === "citizen" ? "selected" : ""}>New public user with their vehicle</option>
          <option value="connect" ${sub === "connect" ? "selected" : ""}>Only connect the FEAR app to this server</option>
        </select>`;
      if (sub === "citizen") {
        const types = o.publicVehicleTypes || Object.keys(PUBLIC_TYPE_LABELS);
        h += person + `<select class="fear-input" data-f="vehicle_type">${types.map((t) => `<option value="${t}" ${f.vehicle_type === t ? "selected" : ""}>${esc(PUBLIC_TYPE_LABELS[t] || t)}</option>`).join("")}</select>
          <div class="fear-hint">Signs the FEAR app in (no OTP needed), registers the vehicle for RTO verification and turns on anonymous traffic sharing.</div>`;
        f.vehicle_type = f.vehicle_type || types[0];
      } else {
        h += `<div class="fear-hint">For anyone with the FEAR app: the QR only sets this server's address; they sign in with their own number.</div>`;
      }
    }
    h += `<button id="fearPhoneGo">Create QR code</button>
      <div class="fear-hint">Every QR works on this Wi-Fi (${esc((o.network.lan || [])[0] || "the LAN address")}) and anywhere on the internet: making one switches on the public link if it isn't on yet (takes a few seconds the first time).</div>
      <button id="fearIssuedToggle" class="fear-collapse">${F.showIssued ? "▾" : "▸"} Issued QR codes (${F.phones.length})</button>`;
    for (const p of F.showIssued ? F.phones.slice(0, 12) : []) {
      h += `<div class="fear-card"><div class="h"><span>${p.app === "gov" ? "🛡️" : "📱"} ${esc(p.label)}</span><span class="fear-pill ${p.status === "used" ? "available" : p.status === "waiting" ? "dispatched" : "closed"}">${esc(p.status)}</span></div>
        <div class="s">${ago(p.createdAt)}${p.usedAt ? ` · scanned ${ago(p.usedAt)}` : ""}</div></div>`;
    }
    body.innerHTML = h;
    body.querySelector("#fearIssuedToggle").onclick = () => { F.showIssued = !F.showIssued; render(); };
    body.querySelectorAll("[data-pmode]").forEach((b) => (b.onclick = () => { F.phoneMode = b.dataset.pmode; render(); }));
    const gk = body.querySelector("#fearGovKind");
    if (gk) gk.onchange = (e) => { F.phoneGovKind = e.target.value; render(); };
    const pk = body.querySelector("#fearPubKind");
    if (pk) pk.onchange = (e) => { F.phonePubKind = e.target.value; render(); };
    const ek = body.querySelector("#fearExistKind");
    if (ek) ek.onchange = (e) => { F.phoneExistKind = e.target.value; render(); };
    body.querySelectorAll("[data-f]").forEach((el) => {
      el.oninput = () => { f[el.dataset.f] = el.value; };
      if (el.tagName === "SELECT") el.onchange = () => { f[el.dataset.f] = el.value; if (el.dataset.f === "category") { f.org_id = null; render(); } };
    });
    body.querySelector("#fearPhoneGo").onclick = async () => {
      let req;
      if (mode === "existing") {
        const sub = F.phoneExistKind || "self";
        req = sub === "self" ? { kind: "self" } : sub === "existing_user" ? { kind: "existing_user", username: f.username } : { kind: "existing_citizen", phone: f.phone };
      } else if (mode === "gov" && (F.phoneGovKind || "driver") === "driver") {
        req = { kind: "driver", org_id: f.org_id, category: f.category, name: f.name, phone: f.phone, address: f.address, plate: f.plate };
      } else if (mode === "gov") {
        req = { kind: "existing_driver", vehicle_id: f.vehicle_id || (o.vehicles[0] && o.vehicles[0].id) };
      } else if ((F.phonePubKind || "citizen") === "citizen") {
        req = { kind: "citizen", name: f.name, phone: f.phone, address: f.address, plate: f.plate, vehicle_type: f.vehicle_type };
      } else {
        req = { kind: "connect" };
      }
      const r = await act(() => api("POST", "/gov/phones", req));
      if (!r) return;
      F.phoneForm = {};
      showQr(r);
      loadPhoneOptions();
    };
  }

  function showQr(r) {
    const e = r.enrollment;
    const old = document.querySelector("#fearQrModal");
    if (old) old.remove();
    const m = document.createElement("div");
    m.id = "fearQrModal";
    m.innerHTML = `<div class="box">
      <h3>${e.app === "gov" ? "FEAR Command app" : "FEAR app"}: scan to ${e.payload.code ? "sign in" : "connect"}</h3>
      <div>${esc(e.label)}</div>
      <div class="qr">${e.qrSvg}</div>
      ${r.username ? `<div class="creds">Typed login instead: <code>${esc(r.username)}</code>${r.password ? ` / <code>${esc(r.password)}</code> (shown once)` : ""}</div>` : ""}
      ${e.expiresAt ? `<div class="servers">Single use · expires ${new Date(e.expiresAt).toLocaleTimeString()}</div>` : ""}
      <div class="servers">Server: ${e.servers.map(esc).join(" · ")}</div>
      ${e.publicError ? `<div class="servers" style="color:#ef476f">Internet link unavailable (${esc(e.publicError)}) - this QR works on the same Wi-Fi only.</div>`
        : `<div class="servers">Works on this Wi-Fi or anywhere on the internet.</div>`}
      <button>Done</button></div>`;
    m.querySelector("button").onclick = () => m.remove();
    m.onclick = (ev) => { if (ev.target === m) m.remove(); };
    document.body.appendChild(m);
  }

  /* ---------------- network ---------------- */
  function renderNetwork(body) {
    const n = F.network;
    if (!n) { body.innerHTML = `<div class="fear-hint">Loading…</div>`; return; }
    const t = n.tunnel || {};
    let h = `<div style="font-weight:700">Same Wi-Fi</div>`;
    for (const u of n.lan || []) h += `<div class="fear-hint">📶 ${esc(u)}</div>`;
    h += `<div class="fear-hint">Phones on this network reach the server at the first address. They find it from a QR code (Phones tab), by themselves, or by typing it.</div>
      <div style="font-weight:700;margin-top:8px">Internet (any network)</div>`;
    if (t.running && t.url && t.permanent) h += `<div class="fear-hint">🌐 <b>${esc(t.url)}</b></div><div class="fear-hint">Permanent address: the same after every restart, built into both apps. Other computers open <b>${esc(t.url)}/command/</b> in a browser.</div>`;
    else if (t.running && t.url) h += `<div class="fear-hint">🌐 <b>${esc(t.url)}</b></div><div class="fear-hint">Public while on: anyone with this link reaches the sign-in screens. QR codes issued now include it.</div>`;
    else h += `<div class="fear-hint">Off. Turning it on opens the internet link so phones on mobile data or other Wi-Fi can connect.</div>`;
    const appsAt = (t.running && t.url ? t.url : ((n.lan || [])[0] || "")) + "/get";
    h += `<div style="font-weight:700;margin-top:8px">Phone apps</div>
      <div class="fear-hint">A phone without the app opens <b>${esc(appsAt)}</b>, or scans the code on <a href="http://127.0.0.1:8080/get" target="_blank" rel="noopener">the download page</a> with its camera.</div>`;
    if (t.error) h += `<div class="fear-err">${esc(t.error)}</div>`;
    if (!t.available) h += `<div class="fear-err">cloudflared is missing (tools/cloudflared/cloudflared.exe).</div>`;
    if (n.canManage && t.available) h += `<button id="fearPublic">${t.running ? "⏹ Stop public link" : "🌐 Go public"}</button>`;
    if (canEnroll()) h += `<button id="fearConnectQr">QR: connect the FEAR app</button>`;
    body.innerHTML = h;
    const pub = body.querySelector("#fearPublic");
    if (pub) pub.onclick = async () => {
      pub.disabled = true; pub.textContent = t.running ? "Stopping…" : "Opening… (up to 25 s)";
      const r = await act(() => api("POST", "/gov/network/public", { enabled: !t.running }));
      if (r) F.network = r;
      render();
    };
    const cq = body.querySelector("#fearConnectQr");
    if (cq) cq.onclick = async () => { const r = await act(() => api("POST", "/gov/phones", { kind: "connect" })); if (r) showQr(r); };
  }

  /* ---------------- map: add an area from an OSM export (super admin) ---------------- */
  async function loadMapInfo() {
    try { F.mapInfo = await api("GET", "/gov/map/info"); } catch (e) { toast("FEAR: " + e.message); }
    if (F.tab === "map") render();
  }

  function renderMapAdmin(body) {
    const m = F.mapInfo;
    if (!m) { body.innerHTML = `<div class="fear-hint">Loading…</div>`; return; }
    const b = m.bounds || {};
    let h = `<div style="font-weight:700">Current map</div>
      <div class="fear-hint">${m.roads} road segments · ${m.nodes} nodes · ${m.signals} signalised junctions</div>
      <div class="fear-hint">Covers ${(+b.minlat).toFixed(4)}–${(+b.maxlat).toFixed(4)} N, ${(+b.minlon).toFixed(4)}–${(+b.maxlon).toFixed(4)} E</div>
      <div style="font-weight:700;margin-top:6px">Areas</div>`;
    for (const s of m.sources || []) h += `<div class="fear-hint">🗺️ ${esc(s.file || "?")}${s.importedAt ? ` · added ${ago(s.importedAt)} · ${s.roads} roads, ${s.signals} signals` : " · original map"}</div>`;
    h += `<div class="fear-hint" style="margin-top:8px">${m.canImport
      ? "To add an area, open the ✏️ Editor (top bar) and use <b>Add map area (OSM)</b> in its sidebar - imports are done there, where the map is edited, so nobody keeps editing an old copy while it changes."
      : "New areas are added by FEAR's super admin from the map editor."}</div>`;
    body.innerHTML = h;
  }

  /* ---------------- requests: account deletion, vehicle transfer ---------------- */
  const REQ_LABEL = { delete_account: "Delete account", transfer_vehicle: "Transfer vehicle" };

  async function loadRequests() {
    try { F.requests = await api("GET", `/gov/requests?status=${F.reqStatus || "pending"}`); } catch (e) { F.requests = []; toast("FEAR: " + e.message); }
    if (F.tab === "requests") render();
  }

  function renderRequests(body) {
    const st = F.reqStatus || "pending";
    let h = `<div class="fear-row">${["pending", "approved", "rejected"].map((x) => `<button data-rs="${x}" class="${st === x ? "active" : ""}" style="${st === x ? "background:#e63946;color:#fff" : ""}">${x}</button>`).join("")}</div>
      <div class="fear-hint">People ask from the Me screen of their app. Citizens' account deletions go to FEAR's admin, vehicle transfers to the RTO desk, drivers' requests to their organization's admin.</div>`;
    const list = F.requests || [];
    if (!list.length) h += `<div class="fear-hint">Nothing ${st}.</div>`;
    for (const r of list) {
      h += `<div class="fear-card"><div class="h"><span>${r.app === "gov" ? "🛡️" : "📱"} ${esc(REQ_LABEL[r.kind] || r.kind)}</span><span class="fear-pill ${r.status === "approved" ? "available" : r.status === "rejected" ? "closed" : "reported"}">${esc(r.status)}</span></div>
        <div class="s">${esc(r.who)}${r.phone ? " · " + esc(r.phone) : ""}${r.username ? " · " + esc(r.username) : ""} · ${ago(r.createdAt)}</div>
        ${r.vehicle ? `<div class="s">Vehicle ${esc(r.vehicle.plate)} (${esc(r.vehicle.type)}) → ${esc(r.targetPhone)}</div>` : ""}
        ${r.note ? `<div class="s">"${esc(r.note)}"</div>` : ""}
        ${r.reviewNote ? `<div class="s">Review: ${esc(r.reviewNote)}</div>` : ""}
        ${r.status === "pending" ? `<button data-rq="${r.id}" data-ok="1">Approve</button><button data-rq="${r.id}" data-ok="0">Reject</button>` : ""}</div>`;
    }
    body.innerHTML = h;
    body.querySelectorAll("[data-rs]").forEach((b) => (b.onclick = () => { F.reqStatus = b.dataset.rs; loadRequests(); }));
    body.querySelectorAll("[data-rq]").forEach((b) => (b.onclick = async () => {
      const approve = b.dataset.ok === "1";
      const r = list.find((x) => x.id === b.dataset.rq);
      if (approve && r.kind === "delete_account" && !confirm(`Delete ${r.who}'s account? Their personal details are removed; this can't be undone.`)) return;
      const note = approve ? null : prompt("Reason for rejecting (shown to the person):", "");
      if (!approve && note === null) return;
      await act(() => api("POST", `/gov/requests/${r.id}`, { approve, note }), approve ? "Approved" : "Rejected");
      loadRequests();
    }));
  }

  /* ---------------- boot ---------------- */
  const FearCmd = { draw, handleMapClick, render };
  window.FearCmd = FearCmd;

  function boot() {
    build();
    loadSession();
    render();
    if (F.token) afterSignIn();
    // keep the toggle in step with the engine (it can be switched from the "Vehicle source" select too)
    let lastMode = currentMode();
    setInterval(() => {
      const m = currentMode();
      if (m !== lastMode) { lastMode = m; render(); }
    }, 1000);
    setInterval(() => { if (F.token) refreshLists(); }, 20000);
    // the AI agent countdowns tick every second without re-rendering anything else
    setInterval(() => document.querySelectorAll("[data-due]").forEach((el) => { el.textContent = countdown(el.dataset.due); }), 1000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
