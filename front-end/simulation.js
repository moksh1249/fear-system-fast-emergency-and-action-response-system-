"use strict";

/* ============================================================
   Traffic Simulation (read-only viewer)
   Loaded by simulation.html, after map-core.js/settings.js/
   redlight.js have already defined State/rendering/selection/the
   fixed-time traffic-light simulation clock - see map-core.js's own
   header comment for the full editor/simulation split rationale.

   This file owns nothing that mutates the map: no tools, no
   add/delete/move, no undo/redo, no save. It only:
     - boots the page (loads map_data.json read-only)
     - drives the camera (drag-to-pan; wheel-zoom/rotation/Play/
       Reset/Settings/Selection-Filters are already wired by
       map-core.js, shared with the editor)
     - turns a plain click into a read-only selection via the same
       hit-testing map-core.js already exposes, then displays it
       through this file's own renderInspector() (setSelection, in
       map-core.js, calls that name directly - editor.js defines the
       real editing version on the editor page; this is the display
       counterpart for this page, matched by name rather than by any
       module import since these are plain global-scope scripts)
   ============================================================ */

function renderInspector() {
  const panel = $("#inspector");
  const body = $("#inspBody");

  if (!State.selected.length) { panel.hidden = true; return; }
  body.innerHTML = "";

  if (State.selected.length > 1) {
    panel.hidden = false;
    $("#inspTitle").textContent = `${State.selected.length} items selected`;
    body.append(el("div", { class: "readonly" }, "Multiple items selected."));
    return;
  }

  function tagsReadout(tags) {
    const wrap = el("div", {});
    wrap.append(el("div", { class: "section-title" }, "Tags"));
    const keys = Object.keys(tags || {}).sort();
    if (!keys.length) wrap.append(el("div", { class: "readonly" }, "(none)"));
    for (const k of keys) {
      wrap.append(el("div", { class: "field" }, el("label", {}, k), el("div", { class: "readonly" }, String(tags[k]))));
    }
    return wrap;
  }

  const sel = State.selected[0];

  if (sel.type === "node") {
    const node = State.nodes.get(sel.id);
    if (!node) { panel.hidden = true; return; }
    panel.hidden = false;
    $("#inspTitle").textContent = `Intersection · ${sel.id}`;
    const latlon = projectInverse(node.x, node.y);
    body.append(
      el("div", { class: "field" }, el("label", {}, "Position"),
        el("div", { class: "readonly" }, `lat ${latlon.lat.toFixed(6)}, lon ${latlon.lon.toFixed(6)}`)),
      el("div", { class: "field" }, el("label", {}, "Connected roads"),
        el("div", { class: "readonly" }, String(connectedWaysSorted(sel.id).length))),
    );
    if (node.signal) {
      body.append(el("div", { class: "field" }, el("label", {}, "Traffic light"), el("div", { class: "readonly" }, "Yes")));
    }
    body.append(tagsReadout(node.tags));
  } else if (sel.type === "way") {
    const way = State.ways.get(sel.id);
    if (!way) { panel.hidden = true; return; }
    panel.hidden = false;
    $("#inspTitle").textContent = `Road · ${sel.id}`;
    body.append(
      el("div", { class: "field" }, el("label", {}, "Type"),
        el("div", { class: "readonly" }, (way.tags && way.tags.highway) || "(none)")),
      el("div", { class: "field" }, el("label", {}, "Points"),
        el("div", { class: "readonly" }, String(way.nodes.length))),
    );
    body.append(tagsReadout(way.tags));
  } else if (sel.type === "building") {
    const building = State.buildings.get(sel.id);
    if (!building) { panel.hidden = true; return; }
    panel.hidden = false;
    $("#inspTitle").textContent = `Building · ${sel.id}`;
    const centroid = polygonCentroid(building.polygon);
    const latlon = projectInverse(centroid.x, centroid.y);
    body.append(
      el("div", { class: "field" }, el("label", {}, "Position (centroid)"),
        el("div", { class: "readonly" }, `lat ${latlon.lat.toFixed(6)}, lon ${latlon.lon.toFixed(6)}`)),
      el("div", { class: "field" }, el("label", {}, "Vertices"),
        el("div", { class: "readonly" }, String(building.polygon.length))),
    );
    const linkedAmenity = Array.from(State.amenities.values()).find(a => a.buildingId === sel.id);
    if (linkedAmenity) {
      body.append(el("div", { class: "field" }, el("label", {}, "Linked amenity"), el("div", { class: "readonly" }, linkedAmenity.id)));
    }
    body.append(tagsReadout(building.tags));
  } else if (sel.type === "amenity") {
    const amenity = State.amenities.get(sel.id);
    if (!amenity) { panel.hidden = true; return; }
    panel.hidden = false;
    $("#inspTitle").textContent = `Amenity · ${sel.id}`;
    const latlon = projectInverse(amenity.x, amenity.y);
    body.append(el("div", { class: "field" }, el("label", {}, "Position"),
      el("div", { class: "readonly" }, `lat ${latlon.lat.toFixed(6)}, lon ${latlon.lon.toFixed(6)}`)));
    if (amenity.buildingId && State.buildings.has(amenity.buildingId)) {
      body.append(el("div", { class: "field" }, el("label", {}, "Linked building"), el("div", { class: "readonly" }, amenity.buildingId)));
    }
    body.append(tagsReadout(amenity.tags));

    if (amenity.fleets && amenity.fleets.length) {
      body.append(el("div", { class: "section-title" }, "Fleets"));
      for (const fleet of amenity.fleets) {
        const card = el("div", { class: "fleet-card" });
        card.append(
          el("div", { class: "field" }, el("label", {}, "Vehicle type"), el("div", { class: "readonly" }, fleet.vehicleType)),
          el("div", { class: "field" }, el("label", {}, "Count"), el("div", { class: "readonly" }, String(fleet.vehicles.length))),
        );
        for (const veh of fleet.vehicles) {
          card.append(el("div", { class: "vehicle-row" },
            el("div", { class: "field" }, el("label", {}, "ID"), el("div", { class: "readonly" }, veh.id)),
            el("div", { class: "field" }, el("label", {}, "Dimensions"),
              el("div", { class: "readonly" }, `${veh.length}m × ${veh.width}m × ${veh.height}m, ${veh.weight}kg, max ${veh.maxSpeed}km/h`)),
          ));
        }
        body.append(card);
      }
    }
  } else {
    panel.hidden = true;
  }
}

/* ---------------- Pan (drag) + click-to-inspect ---------------- */

let isPanning = false;
let panLast = null;
let mouseDownScreen = null;

canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  isPanning = true;
  panLast = { sx, sy };
  mouseDownScreen = { sx, sy };
  canvas.classList.add("dragging");
});

canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const world = screenToWorld(sx, sy);
  const latlon = projectInverse(world.x, world.y);
  $("#statCoords").textContent = `lat ${latlon.lat.toFixed(5)}, lon ${latlon.lon.toFixed(5)}`;

  if (isPanning && panLast) {
    const before = screenToWorld(panLast.sx, panLast.sy);
    const after = screenToWorld(sx, sy);
    State.view.cx += before.x - after.x;
    State.view.cy += before.y - after.y;
    panLast = { sx, sy };
    markDirty();
  }
});

window.addEventListener("mouseup", (e) => {
  if (!isPanning) return;
  isPanning = false;
  panLast = null;
  canvas.classList.remove("dragging");

  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const moved = mouseDownScreen ? Math.hypot(sx - mouseDownScreen.sx, sy - mouseDownScreen.sy) : Infinity;
  mouseDownScreen = null;
  if (moved >= 4) return; // a real drag, not a click - leave selection alone

  const world = screenToWorld(sx, sy);
  const nodeHit = findNodeAtWithDist(world, 9);
  const markerHit = findClusterMarkerAt(world, 9);
  let nid = null;
  if (nodeHit && (!markerHit || nodeHit.d <= markerHit.d)) nid = nodeHit.id;
  else if (markerHit) nid = markerHit.id;
  if (nid && !isItemSelectable("node", nid)) nid = null;

  let aid = !nid ? findAmenityAt(world, 9) : null;
  if (aid && !isItemSelectable("amenity", aid)) aid = null;
  let wid = (!nid && !aid) ? findWayAt(world, 7) : null;
  if (wid && !isItemSelectable("way", wid)) wid = null;
  let bid = (!nid && !aid && !wid) ? findBuildingAt(world) : null;
  if (bid && !isItemSelectable("building", bid)) bid = null;

  if (nid) setSelection([{ type: "node", id: nid }]);
  else if (aid) setSelection([{ type: "amenity", id: aid }]);
  else if (wid) setSelection([{ type: "way", id: wid }]);
  else if (bid) setSelection([{ type: "building", id: bid }]);
  else clearSelection();
});

window.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.key === "Escape") { clearSelection(); return; }
  if (e.key === "+" || e.key === "=") { zoomAt(cssW() / 2, cssH() / 2, 1.2); return; }
  if (e.key === "-" || e.key === "_") { zoomAt(cssW() / 2, cssH() / 2, 1 / 1.2); return; }
});

/* ---------------- Bootstrap ---------------- */

async function boot() {
  loadConfig();
  updateArrowsButton();
  updateTimersButton();
  updateBuildingsButton();
  updateAmenitiesButton();
  updateSimButton();
  updateRotationReadout();
  initResizablePanel($("#inspector"), "inspectorWidth");
  initResizablePanel($("#settingsPanel"), "settingsPanelWidth");
  resizeCanvas();
  renderSelectionFilters();
  State.showEditingHandles = false;

  try {
    await loadFromUrl(DATA_URL);
  } catch (err) {
    toast("Could not load map_data.json — make sure this folder is served over http(s)://");
    console.error(err);
  }

  requestAnimationFrame(loop);
}

boot();
