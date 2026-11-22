/* ============================================================
   Add a map area from an OpenStreetMap export - editor only.

   Area imports change map_data.json underneath everything, so they live in
   the editor, where the map is edited: while one runs, this editor is
   paused (no edits, no Save), and when it finishes the editor reloads the
   new map from the server - so nobody ever keeps editing (and later saves) a
   copy from before the import. serve.py's Save also refuses a stale copy
   from any other tab (see editor.js's serverBase).

   The import itself runs in fear_backend (super admin only): the uploaded
   .osm goes through the same processing as osm_to_json.py and is merged in
   (backend/map_import.py), then the routing index is rebuilt and the traffic
   engine restarted on the new map.
   ============================================================ */

(function () {
  const API = `${location.protocol}//${location.hostname}:8080`;
  const MI = { busy: false, job: null, token: null, user: null, info: null, error: null };
  window.MapImport = MI;

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Same browser-tab session as the viewer's FEAR Command panel.
  function loadSession() {
    try {
      MI.token = localStorage.getItem("fearCmd.token");
      MI.user = JSON.parse(localStorage.getItem("fearCmd.user") || "null");
    } catch (_) {}
  }
  function saveSession() {
    try {
      if (MI.token) { localStorage.setItem("fearCmd.token", MI.token); localStorage.setItem("fearCmd.user", JSON.stringify(MI.user)); }
      else { localStorage.removeItem("fearCmd.token"); localStorage.removeItem("fearCmd.user"); }
    } catch (_) {}
  }

  async function api(method, path, body, raw) {
    const res = await fetch(API + path, {
      method,
      headers: { ...(raw ? { "Content-Type": "application/octet-stream" } : { "Content-Type": "application/json" }),
                 ...(MI.token ? { Authorization: "Bearer " + MI.token } : {}) },
      body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && MI.token) { MI.token = null; MI.user = null; saveSession(); }
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `request failed (${res.status})`);
    return data;
  }

  let root = null;

  function setPaused(paused) {
    MI.busy = paused;
    const saveBtn = document.querySelector("#saveBtn");
    if (saveBtn) saveBtn.disabled = paused;
    let veil = document.querySelector("#mapImportVeil");
    if (paused && !veil) {
      veil = document.createElement("div");
      veil.id = "mapImportVeil";
      veil.innerHTML = `<div class="mi-veil-box"><b>Adding a map area…</b><br>Editing is paused until the import finishes,
        then this editor loads the new map.</div>`;
      document.querySelector("#workspace").appendChild(veil);
    } else if (!paused && veil) {
      veil.remove();
    }
  }

  async function loadInfo() {
    if (!MI.token) return;
    try { MI.info = await api("GET", "/gov/map/info"); } catch (e) { MI.error = e.message; }
    render();
  }

  function render() {
    if (!root) return;
    if (!MI.token || !MI.user) {
      root.innerHTML = `
        <div class="sidebar-section-title">Add map area (OSM)</div>
        <div class="mi-hint">Adds a new area from an OpenStreetMap export to the live map. FEAR super admin only.</div>
        <input class="mi-input" id="miUser" placeholder="Username (fear-admin)" autocomplete="username">
        <input class="mi-input" id="miPass" type="password" placeholder="Password" autocomplete="current-password">
        ${MI.error ? `<div class="mi-err">${esc(MI.error)}</div>` : ""}
        <button id="miSignIn">Sign in</button>`;
      root.querySelector("#miSignIn").onclick = signIn;
      root.querySelector("#miPass").onkeydown = (e) => { if (e.key === "Enter") signIn(); };
      return;
    }
    if (MI.user.role !== "super_admin") {
      root.innerHTML = `<div class="sidebar-section-title">Add map area (OSM)</div>
        <div class="mi-hint">Signed in as ${esc(MI.user.displayName)}. Only FEAR's super admin can add map areas.</div>
        <button id="miOut">Sign out</button>`;
      root.querySelector("#miOut").onclick = signOut;
      return;
    }
    const m = MI.info;
    const j = MI.job;
    let h = `<div class="sidebar-section-title">Add map area (OSM)</div>
      <div class="mi-hint">Signed in as ${esc(MI.user.displayName)} · <a href="#" id="miOut">sign out</a></div>`;
    if (m) {
      h += `<div class="mi-hint">Map: ${m.roads} road segments, ${m.signals} signals. Areas: ${(m.sources || []).map((s) => esc(s.file)).join(", ")}</div>`;
    }
    h += `<div class="mi-hint">Export the area from openstreetmap.org (Export → .osm). Roads, buildings, amenities and OSM traffic
      signals are merged in; the routing index is rebuilt and the engine restarted. Save your own edits first - this editor
      reloads the map afterwards.</div>
      <input class="mi-input" type="file" id="miFile" accept=".osm,application/xml,text/xml" ${MI.busy ? "disabled" : ""}>
      <button id="miGo" ${MI.busy ? "disabled" : ""}>⬆ Import area</button>`;
    if (j) {
      h += `<div class="mi-job"><div><b>${esc(j.file)}</b> - ${esc(j.status)}</div>
        ${(j.log || []).slice(-12).map((l) => `<div class="mi-line">${esc(l)}</div>`).join("")}</div>`;
    }
    root.innerHTML = h;
    root.querySelector("#miOut").onclick = (e) => { e.preventDefault(); signOut(); };
    root.querySelector("#miGo").onclick = startImport;
  }

  async function signIn() {
    MI.error = null;
    try {
      const r = await api("POST", "/gov/auth/login", { username: root.querySelector("#miUser").value.trim(), password: root.querySelector("#miPass").value });
      MI.token = r.token; MI.user = r.user; saveSession();
      await loadInfo();
    } catch (e) { MI.error = e.message; render(); }
  }

  function signOut() {
    if (MI.token) api("POST", "/gov/auth/logout").catch(() => {});
    MI.token = null; MI.user = null; MI.info = null; saveSession(); render();
  }

  async function startImport() {
    const file = root.querySelector("#miFile").files[0];
    if (!file) { toast("Pick a .osm file first"); return; }
    if (!confirm(`Add "${file.name}" (${(file.size / 1048576).toFixed(1)} MB) to the map?\n\nThis editor will reload the map when the import `
        + `finishes - any changes you have not saved with 💾 Save will be lost. Cancel now to save them first.`)) return;
    setPaused(true);
    MI.job = { file: file.name, status: "uploading", log: [] };
    render();
    try {
      const r = await api("POST", `/gov/map/import?filename=${encodeURIComponent(file.name)}`, file, true);
      MI.job = { id: r.jobId, file: file.name, status: "running", log: [] };
      render();
      await poll();
    } catch (e) {
      MI.job = { file: file.name, status: "failed", log: [String(e.message)] };
      setPaused(false);
      render();
    }
  }

  async function poll() {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      try { MI.job = await api("GET", `/gov/map/import/${MI.job.id}`); } catch (_) { continue; }
      render();
      if (MI.job.status !== "running") break;
    }
    if (MI.job.status === "done") {
      // Load the new map into this editor and drop the now-stale local autosave.
      try { localStorage.removeItem(AUTOSAVE_KEY); } catch (_) {}
      try {
        await loadFromUrl(DATA_URL);
        serverBase = (State.meta && State.meta.savedAt) || "none";
        if (typeof refreshAreaPanels === "function") refreshAreaPanels();
        markDirty();
        toast("New area added - the editor now shows the updated map");
      } catch (e) {
        toast("Import finished - reload the editor to see the new area");
      }
    } else {
      toast("Map import failed - see the log in the sidebar. The map was not changed.");
    }
    setPaused(false);
    loadInfo();
  }

  function boot() {
    const sidebar = document.querySelector("#sidebar");
    if (!sidebar) return;
    root = document.createElement("div");
    root.className = "sidebar-section";
    root.id = "mapImportSection";
    const view = [...sidebar.querySelectorAll(".sidebar-section")].pop();
    sidebar.insertBefore(root, view || null);
    loadSession();
    render();
    if (MI.token) loadInfo();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
