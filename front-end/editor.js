"use strict";

/* ============================================================
   Traffic Map Editor (editing-only)
   Loaded by editor.html, after map-core.js/settings.js/redlight.js
   have already defined State/rendering/selection - see map-core.js's
   own header comment for the full split rationale. This file owns
   every MUTATION: add/delete/move/rotate roads, buildings, amenities
   and their fleets; undo/redo; the tool system and all canvas
   pointer/keyboard handling; the editing inspector; save/load/reset.
   ============================================================ */

const AUTOSAVE_KEY = "trafficMapEditor.autosave.v1";
const AUTOSAVE_DEBOUNCE_MS = 900;
const MAX_UNDO = 60;

// BUILDING_TYPES/AMENITY_TYPES live in map-core.js (shared with simulation.js's
// read-only page) - renderSelectionFilters() there needs them for the
// per-type filter rows even though only editor.js edits building/amenity tags.

const AMENITY_DEFAULT_VEHICLE_TYPE = {
  hospital: "ambulance", clinic: "ambulance", doctors: "ambulance",
  fire_station: "fire_truck",
  police: "police_car",
  school: "bus", university: "bus",
};

function newId(prefix) {
  return `${prefix}_${State.nextIdCounter++}`;
}

// Tag values are free-text (editable via the generic tag editor, not just the
// dedicated checkboxes), so treat "yes"/"Yes"/" yes "/etc. as equivalent
// rather than requiring an exact "yes" match - otherwise a boolean-ish tag
// typed by hand silently fails to take effect.
function serializeState() {
  const nodesOut = {};
  for (const [id, n] of State.nodes) {
    nodesOut[id] = {
      x: n.x, y: n.y,
      tags: n.tags && Object.keys(n.tags).length ? n.tags : undefined,
      signal: n.signal || undefined,
    };
  }
  const waysOut = [];
  for (const w of State.ways.values()) {
    waysOut.push({ id: w.id, tags: w.tags, nodes: w.nodes.slice(), curve: w.curve });
  }
  const buildingsOut = [];
  for (const b of State.buildings.values()) {
    buildingsOut.push({ id: b.id, tags: b.tags, polygon: b.polygon.map(p => ({ x: p.x, y: p.y })) });
  }
  const amenitiesOut = [];
  for (const a of State.amenities.values()) {
    amenitiesOut.push({
      id: a.id, x: a.x, y: a.y, tags: a.tags,
      fleets: a.fleets && a.fleets.length ? a.fleets : undefined,
      buildingId: a.buildingId || undefined,
    });
  }
  return {
    meta: { ...(State.meta || {}), nextIdCounter: State.nextIdCounter, savedAt: new Date().toISOString() },
    nodes: nodesOut,
    ways: waysOut,
    buildings: buildingsOut,
    amenities: amenitiesOut,
    redlightGroups: Array.from(State.redlightGroups.values()),
  };
}

/* ---------------- Undo / Redo ---------------- */

function snapshot() {
  return JSON.stringify({
    nodes: Array.from(State.nodes.entries()),
    ways: Array.from(State.ways.entries()),
    buildings: Array.from(State.buildings.entries()),
    amenities: Array.from(State.amenities.entries()),
    redlightGroups: Array.from(State.redlightGroups.entries()),
    nextIdCounter: State.nextIdCounter,
  });
}

function restoreSnapshot(json) {
  const obj = JSON.parse(json);
  State.nodes = new Map(obj.nodes);
  State.ways = new Map(obj.ways);
  State.buildings = new Map(obj.buildings || []);
  State.amenities = new Map(obj.amenities || []);
  State.redlightGroups = new Map(obj.redlightGroups || []);
  State.nextIdCounter = obj.nextIdCounter;
  rebuildIndex();
  clearSelection();
  updateStatusCounts();
  markDirty();
}

function pushUndo() {
  State.undoStack.push(snapshot());
  if (State.undoStack.length > MAX_UNDO) State.undoStack.shift();
  State.redoStack = [];
  updateUndoButtons();
  scheduleAutosave();
}

function undo() {
  if (!State.undoStack.length) return;
  State.redoStack.push(snapshot());
  const prev = State.undoStack.pop();
  restoreSnapshot(prev);
  updateUndoButtons();
  scheduleAutosave();
}

function redo() {
  if (!State.redoStack.length) return;
  State.undoStack.push(snapshot());
  const next = State.redoStack.pop();
  restoreSnapshot(next);
  updateUndoButtons();
  scheduleAutosave();
}

// Defensive about #undoBtn/#redoBtn not existing: this is called
// unconditionally from loadData (shared - see map-core.js), which also runs
// on the read-only simulation page that has no undo/redo UI at all.
let autosaveTimer = null;
function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serializeState()));
    } catch (e) { /* storage full/unavailable - ignore */ }
  }, AUTOSAVE_DEBOUNCE_MS);
}

/* ================================================================
   VIEW / CAMERA
   ================================================================ */

function selectNode(id) {
  setSelection([{ type: "node", id }]);
}

function selectWay(id) {
  setSelection([{ type: "way", id }]);
}

function deleteSelected() {
  if (!State.selected.length) return;
  pushUndo();
  const items = State.selected.slice();
  State.selected = [];
  for (const s of items) {
    if (s.type === "node") deleteNodeSilent(s.id);
    else if (s.type === "way") deleteWaySilent(s.id);
    else if (s.type === "building") deleteBuildingSilent(s.id);
    else if (s.type === "amenity") deleteAmenitySilent(s.id);
    // deleteNodeSilent's pass-through merge (see mergeWaysAtSharedNode) can
    // delete a way id mid-batch - rebuild the index after every item so a
    // later node in this same selection never reads a stale
    // State.nodeWayIndex still listing a way id that a previous iteration
    // already merged away.
    rebuildIndex();
  }
  clearSelection();
  updateStatusCounts();
  markDirty();
  scheduleAutosave();
  toast(items.length > 1 ? `Deleted ${items.length} items` : "Deleted");
}

const COMMON_TAG_KEYS = [
  "highway", "name", "ref", "maxspeed", "lanes", "lane_width", "oneway", "divider",
  "surface", "bridge", "layer", "avg_min_speed", "avg_max_speed", "access", "junction", "width",
];

function renderInspector() {
  const panel = $("#inspector");
  const body = $("#inspBody");

  // Only ever show the panel in the Select tool - in every other tool it
  // would sit on top of the canvas and swallow clicks meant for the map.
  if (State.tool !== "select" || !State.selected.length) {
    panel.hidden = true;
    return;
  }

  if (State.selected.length > 1) {
    renderBulkInspector(State.selected);
    return;
  }

  const sel = State.selected[0];
  body.innerHTML = "";

  if (sel.type === "node") {
    const node = State.nodes.get(sel.id);
    if (!node) { panel.hidden = true; return; }
    panel.hidden = false;
    const vType0 = node.tags && node.tags.vertex_type;
    $("#inspTitle").textContent = (vType0 === "angle" || vType0 === "curve")
      ? `${vType0 === "angle" ? "Angle" : "Curve"} Point · ${sel.id}`
      : `Intersection · ${sel.id}`;

    const latlon = projectInverse(node.x, node.y);
    body.append(
      el("div", { class: "field" },
        el("label", {}, "Position"),
        el("div", { class: "readonly" }, `lat ${latlon.lat.toFixed(6)}, lon ${latlon.lon.toFixed(6)}`)),
      el("div", { class: "field" },
        el("label", {}, "Connected roads"),
        el("div", { class: "readonly" }, String(connectedWaysSorted(sel.id).length))),
    );
    if (node.tags && node.tags.join_group) {
      const groupSize = (State.joinGroupIndex.get(node.tags.join_group) || []).length;
      body.append(el("div", { class: "section-title" }, "Joined intersection"));
      body.append(el("div", { class: "readonly" },
        `This is the central point for ${groupSize} joined intersections - one traffic light here governs every approach across all of them. Ungrouping does not restore any connecting road absorbed at join time.`));
      body.append(el("button", {
        onclick: () => {
          pushUndo();
          ungroupJunction(sel.id);
          markDirty(); scheduleAutosave(); renderInspector();
          toast("Split back into separate intersections");
        },
      }, "Ungroup"));
    }

    body.append(renderRedlightSection(node, sel.id));
    body.append(renderUturnSection(node, sel.id));
    const vertexSection = renderVertexTypeSection(node, sel.id);
    if (vertexSection) body.append(vertexSection);

    const hereWayIds = Array.from(State.nodeWayIndex.get(sel.id) || []);
    if (hereWayIds.length >= 2) {
      body.append(el("div", { class: "section-title" }, "Disconnect roads"));
      body.append(el("div", { class: "readonly" },
        "Pull a road off this intersection so it no longer joins the others here - use this to turn an accidental join into a separate flyover (mark the road Flyover/bridge afterwards) or to stop two roads intersecting at all."));
      for (const wid of hereWayIds) {
        const w = State.ways.get(wid);
        if (!w) continue;
        const label = `${(w.tags && w.tags.highway) || "road"} · ${wid}`;
        body.append(el("button", {
          onclick: () => {
            pushUndo();
            detachWayFromNode(wid, sel.id);
            markDirty(); scheduleAutosave(); renderInspector();
            toast("Detached");
          },
        }, `Detach ${label}`));
      }
    }

    body.append(tagEditor(node.tags, () => { pushUndo(); markDirty(); scheduleAutosave(); }, () => renderInspector(), { skipKeys: ["join_group", "vertex_type"] }));
    body.append(el("button", {
      class: "danger-btn",
      onclick: () => deleteNode(sel.id),
    }, "Delete intersection"));
  } else if (sel.type === "way") {
    const way = State.ways.get(sel.id);
    if (!way) { panel.hidden = true; return; }
    panel.hidden = false;
    $("#inspTitle").textContent = `Road · ${sel.id}`;

    const currentHw = (way.tags && way.tags.highway) || "";
    const hwOptions = HIGHWAY_TYPES.includes(currentHw) ? HIGHWAY_TYPES : [currentHw, ...HIGHWAY_TYPES];
    const hwSel = el("select", {
      onchange: (e) => { pushUndo(); way.tags.highway = e.target.value; markDirty(); scheduleAutosave(); renderInspector(); },
    }, ...hwOptions.map(hw => el("option", { value: hw, selected: hw === currentHw ? "selected" : null }, hw || "(none)")));
    body.append(el("div", { class: "field" }, el("label", {}, "Road type"), hwSel));

    const curveSel = el("select", {
      onchange: (e) => { pushUndo(); way.curve = e.target.value; markDirty(); scheduleAutosave(); },
    },
      el("option", { value: "line", selected: way.curve === "line" ? "selected" : null }, "Straight line"),
      el("option", { value: "spline", selected: way.curve === "spline" ? "selected" : null }, "Smooth spline"));

    body.append(
      el("div", { class: "field" }, el("label", {}, "Shape"), curveSel),
      el("div", { class: "field" }, el("label", {}, "Points"), el("div", { class: "readonly" }, String(way.nodes.length))),
    );

    // Session-only mode toggle (State.roadMoveMode - see its own comment on
    // State) that repurposes the existing "drag the road's body" gesture:
    // off (default) reshapes by pulling out a new point, exactly as before;
    // on, the same drag instead translates every point of this road as a
    // rigid whole (reusing the multi-select "group" drag mechanics - see
    // mousedown's hitType==="way" branch and translateSelected). An endpoint
    // shared with a joined intersection moves right along with the road,
    // same as dragging that node directly would - the rest of the group's
    // own members, and any other road attached there, stay exactly put.
    body.append(el("div", { class: "section-title" }, "Move"));
    const moveChk = el("input", { type: "checkbox" });
    moveChk.checked = State.roadMoveMode;
    moveChk.addEventListener("change", () => {
      State.roadMoveMode = moveChk.checked;
      toast(State.roadMoveMode ? "Move mode on — drag this road to move it" : "Move mode off — dragging reshapes again");
    });
    body.append(el("div", { class: "checkrow" }, moveChk,
      el("label", {}, "Move whole road (drag body to move instead of reshape)")));

    if (way.tags.circle_cx != null) {
      const radiusInput = el("input", { type: "number", min: String(CIRCLE_MIN_RADIUS_M), step: "0.5", value: way.tags.circle_radius });
      radiusInput.addEventListener("change", () => {
        const v = parseFloat(radiusInput.value);
        if (!Number.isFinite(v) || v < CIRCLE_MIN_RADIUS_M) { radiusInput.value = way.tags.circle_radius; return; }
        pushUndo();
        setCircleRadius(sel.id, v);
        scheduleAutosave(); renderInspector();
      });
      body.append(el("div", { class: "field" }, el("label", {}, "Radius (m)"), radiusInput));
    }

    const onewayChk = el("input", { type: "checkbox" });
    onewayChk.checked = isYes(way.tags.oneway);
    onewayChk.addEventListener("change", () => {
      pushUndo();
      if (onewayChk.checked) way.tags.oneway = "yes"; else delete way.tags.oneway;
      markDirty(); scheduleAutosave(); renderInspector();
    });
    const bridgeChk = el("input", { type: "checkbox" });
    bridgeChk.checked = isYes(way.tags.bridge);
    bridgeChk.addEventListener("change", () => {
      pushUndo();
      if (bridgeChk.checked) { way.tags.bridge = "yes"; way.tags.layer = "1"; }
      else { delete way.tags.bridge; delete way.tags.layer; }
      markDirty(); scheduleAutosave(); renderInspector();
    });
    body.append(
      el("div", { class: "checkrow" }, onewayChk, el("label", {}, "One-way")),
      el("div", { class: "checkrow" }, bridgeChk, el("label", {}, "Flyover / bridge")),
    );

    body.append(laneAndSpeedFields(way));

    // Endpoints of this road that are actually shared with other roads -
    // detaching here pulls just THIS road off that junction, e.g. to turn an
    // accidental at-grade join into a separate flyover, or to stop it
    // intersecting another road there at all.
    const endpointDescs = [];
    if (way.nodes.length >= 2) {
      const startId = way.nodes[0], endId = way.nodes[way.nodes.length - 1];
      if (nodeDegree(startId) >= 2) endpointDescs.push({ label: "start", nodeId: startId });
      if (endId !== startId && nodeDegree(endId) >= 2) endpointDescs.push({ label: "end", nodeId: endId });
    }
    if (endpointDescs.length) {
      body.append(el("div", { class: "section-title" }, "Disconnect roads"));
      body.append(el("div", { class: "readonly" },
        "Pull this road off a shared intersection at one of its ends so it no longer joins the others there - use this to turn an accidental join into a separate flyover (mark Flyover/bridge afterwards) or to stop two roads intersecting at all."));
      for (const ep of endpointDescs) {
        const deg = nodeDegree(ep.nodeId);
        body.append(el("button", {
          onclick: () => {
            pushUndo();
            detachWayFromNode(way.id, ep.nodeId);
            markDirty(); scheduleAutosave(); renderInspector();
            toast("Detached");
          },
        }, `Detach at ${ep.label} (${deg}-way junction · ${ep.nodeId})`));
      }
    }

    body.append(el("button", {
      onclick: () => {
        pushUndo();
        way.nodes.reverse();
        markDirty(); scheduleAutosave();
        toast("Direction reversed");
      },
    }, "Reverse direction"));

    body.append(tagEditor(way.tags, () => { pushUndo(); markDirty(); scheduleAutosave(); }, () => renderInspector(), { skipKeys: ["highway", "circle_cx", "circle_cy", "circle_radius"] }));
    body.append(el("button", {
      class: "danger-btn",
      onclick: () => deleteWay(sel.id),
    }, "Delete road"));
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
      body.append(el("div", { class: "field" }, el("label", {}, "Linked amenity"),
        el("div", { class: "readonly" }, `${linkedAmenity.id} - deleting or moving one carries the other with it`)));
    }

    const currentBt = building.tags.building || "";
    const btOptions = currentBt && !BUILDING_TYPES.includes(currentBt) ? [currentBt, ...BUILDING_TYPES] : BUILDING_TYPES;
    const btSel = el("select", {
      onchange: (e) => { pushUndo(); building.tags.building = e.target.value; markDirty(); scheduleAutosave(); renderInspector(); },
    }, ...btOptions.map(bt => el("option", { value: bt, selected: bt === currentBt ? "selected" : null }, bt)));
    body.append(el("div", { class: "field" }, el("label", {}, "Building type"), btSel));

    body.append(tagEditor(building.tags, () => { pushUndo(); markDirty(); scheduleAutosave(); }, () => renderInspector(), { skipKeys: ["building"] }));
    body.append(el("button", {
      class: "danger-btn",
      onclick: () => deleteBuilding(sel.id),
    }, "Delete building"));
  } else if (sel.type === "amenity") {
    const amenity = State.amenities.get(sel.id);
    if (!amenity) { panel.hidden = true; return; }
    panel.hidden = false;
    $("#inspTitle").textContent = `Amenity · ${sel.id}`;

    const latlon = projectInverse(amenity.x, amenity.y);
    body.append(el("div", { class: "field" }, el("label", {}, "Position"),
      el("div", { class: "readonly" }, `lat ${latlon.lat.toFixed(6)}, lon ${latlon.lon.toFixed(6)}`)));

    if (amenity.buildingId && State.buildings.has(amenity.buildingId)) {
      body.append(el("div", { class: "field" }, el("label", {}, "Linked building"),
        el("div", { class: "readonly" }, `${amenity.buildingId} - deleting or moving one carries the other with it`)));
    }

    const currentAt = amenity.tags.amenity || "";
    const atOptions = currentAt && !AMENITY_TYPES.includes(currentAt) ? [currentAt, ...AMENITY_TYPES] : AMENITY_TYPES;
    const atSel = el("select", {
      onchange: (e) => { pushUndo(); amenity.tags.amenity = e.target.value; markDirty(); scheduleAutosave(); renderInspector(); },
    }, ...atOptions.map(at => el("option", { value: at, selected: at === currentAt ? "selected" : null }, at)));
    body.append(el("div", { class: "field" }, el("label", {}, "Amenity type"), atSel));

    body.append(tagEditor(amenity.tags, () => { pushUndo(); markDirty(); scheduleAutosave(); }, () => renderInspector(), { skipKeys: ["amenity", "icon_image", "icon_emoji"] }));
    body.append(renderIconSection(amenity));
    body.append(renderFleetsSection(amenity));
    body.append(el("button", {
      class: "danger-btn",
      onclick: () => deleteAmenity(sel.id),
    }, "Delete amenity"));
  } else {
    panel.hidden = true;
  }
}

function laneAndSpeedFields(way) {
  const wrap = el("div", {});
  wrap.append(el("div", { class: "section-title" }, "Speed (km/h)"));

  function speedField(labelText, key, fallback) {
    const input = el("input", { type: "number", min: "0", value: way.tags[key] != null ? way.tags[key] : fallback });
    input.addEventListener("change", () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v) || v < 0) { input.value = way.tags[key] != null ? way.tags[key] : fallback; return; }
      pushUndo(); way.tags[key] = String(v); markDirty(); scheduleAutosave();
    });
    return el("div", { class: "field" }, el("label", {}, labelText), input);
  }
  wrap.append(
    speedField("Maximum speed", "maxspeed", Config.defaultMaxSpeed),
    speedField("Average minimum speed", "avg_min_speed", Config.defaultAvgMinSpeed),
    speedField("Average maximum speed", "avg_max_speed", Config.defaultAvgMaxSpeed),
  );

  wrap.append(el("div", { class: "section-title" }, "Lanes"));
  const lanesInput = el("input", { type: "number", min: "1", step: "1", value: way.tags.lanes != null ? way.tags.lanes : Config.defaultLanes });
  lanesInput.addEventListener("change", () => {
    const v = parseInt(lanesInput.value, 10);
    if (!Number.isFinite(v) || v < 1) { lanesInput.value = way.tags.lanes; return; }
    pushUndo();
    way.tags.lanes = String(v);
    if (v < 2) way.tags.divider = "no";
    markDirty(); scheduleAutosave(); renderInspector();
  });
  const widthInput = el("input", { type: "number", min: "0.5", step: "0.1", value: way.tags.lane_width != null ? way.tags.lane_width : Config.defaultLaneWidth });
  widthInput.addEventListener("change", () => {
    const v = parseFloat(widthInput.value);
    if (!Number.isFinite(v) || v < 0.5) { widthInput.value = way.tags.lane_width; return; }
    pushUndo(); way.tags.lane_width = String(v); markDirty(); scheduleAutosave();
  });
  wrap.append(
    el("div", { class: "field" }, el("label", {}, "Number of lanes"), lanesInput),
    el("div", { class: "field" }, el("label", {}, "Lane width (m)"), widthInput),
  );

  const lanes = parseInt(way.tags.lanes, 10) || Config.defaultLanes;
  const dividerChk = el("input", { type: "checkbox" });
  dividerChk.checked = isYes(way.tags.divider);
  dividerChk.disabled = isYes(way.tags.oneway) || lanes < 2;
  dividerChk.addEventListener("change", () => {
    pushUndo();
    way.tags.divider = dividerChk.checked ? "yes" : "no";
    markDirty(); scheduleAutosave();
  });
  wrap.append(el("div", { class: "checkrow" }, dividerChk, el("label", {}, "Median divider (2-way)")));

  return wrap;
}

function renderBulkInspector(items) {
  const panel = $("#inspector");
  const body = $("#inspBody");
  panel.hidden = false;
  $("#inspTitle").textContent = `${items.length} items selected`;
  body.innerHTML = "";

  const wayCount = items.filter(i => i.type === "way").length;
  const nodeCount = items.filter(i => i.type === "node").length;
  const buildingCount = items.filter(i => i.type === "building").length;
  const amenityCount = items.filter(i => i.type === "amenity").length;
  body.append(el("div", { class: "field" },
    el("label", {}, "Selection"),
    el("div", { class: "readonly" },
      `${wayCount} road(s), ${nodeCount} intersection(s), ${buildingCount} building(s), ${amenityCount} amenity(ies)`)));

  // ── Filter selection by type ──────────────────────────────────
  body.append(el("div", { class: "section-title" }, "Filter selection"));
  const filterWrap = el("div", { class: "bulk-filter" });

  // Intersections checkbox
  if (nodeCount > 0) {
    const chk = el("input", { type: "checkbox" });
    chk.checked = true;
    chk.addEventListener("change", () => {
      if (!chk.checked) {
        setSelection(State.selected.filter(s => s.type !== "node"));
      }
    });
    filterWrap.append(el("div", { class: "checkrow" }, chk, el("label", {}, `Intersections (${nodeCount})`)));
  }

  // Per-highway-type checkboxes for ways
  const wayItems = items.filter(i => i.type === "way");
  if (wayItems.length > 0) {
    // Group ways by highway type
    const byType = new Map();
    for (const it of wayItems) {
      const way = State.ways.get(it.id);
      const hw = (way && way.tags && way.tags.highway) || "unknown";
      if (!byType.has(hw)) byType.set(hw, []);
      byType.get(hw).push(it);
    }
    // Sort by count descending for convenience
    const sorted = Array.from(byType.entries()).sort((a, b) => b[1].length - a[1].length);
    for (const [hw, hwItems] of sorted) {
      const chk = el("input", { type: "checkbox" });
      chk.checked = true;
      chk.addEventListener("change", () => {
        if (!chk.checked) {
          const removeIds = new Set(hwItems.map(i => i.id));
          setSelection(State.selected.filter(s => !(s.type === "way" && removeIds.has(s.id))));
        }
      });
      filterWrap.append(el("div", { class: "checkrow" }, chk, el("label", {}, `${hw} (${hwItems.length})`)));
    }
  }

  // Per-building-type checkboxes
  const buildingItems = items.filter(i => i.type === "building");
  if (buildingItems.length > 0) {
    const byType = new Map();
    for (const it of buildingItems) {
      const b = State.buildings.get(it.id);
      const bt = (b && b.tags && b.tags.building) || "unknown";
      if (!byType.has(bt)) byType.set(bt, []);
      byType.get(bt).push(it);
    }
    const sorted = Array.from(byType.entries()).sort((a, b) => b[1].length - a[1].length);
    for (const [bt, btItems] of sorted) {
      const chk = el("input", { type: "checkbox" });
      chk.checked = true;
      chk.addEventListener("change", () => {
        if (!chk.checked) {
          const removeIds = new Set(btItems.map(i => i.id));
          setSelection(State.selected.filter(s => !(s.type === "building" && removeIds.has(s.id))));
        }
      });
      filterWrap.append(el("div", { class: "checkrow" }, chk, el("label", {}, `Building: ${bt} (${btItems.length})`)));
    }
  }

  // Per-amenity-type checkboxes
  const amenityItems = items.filter(i => i.type === "amenity");
  if (amenityItems.length > 0) {
    const byType = new Map();
    for (const it of amenityItems) {
      const a = State.amenities.get(it.id);
      const at = (a && a.tags && a.tags.amenity) || "unknown";
      if (!byType.has(at)) byType.set(at, []);
      byType.get(at).push(it);
    }
    const sorted = Array.from(byType.entries()).sort((a, b) => b[1].length - a[1].length);
    for (const [at, atItems] of sorted) {
      const chk = el("input", { type: "checkbox" });
      chk.checked = true;
      chk.addEventListener("change", () => {
        if (!chk.checked) {
          const removeIds = new Set(atItems.map(i => i.id));
          setSelection(State.selected.filter(s => !(s.type === "amenity" && removeIds.has(s.id))));
        }
      });
      filterWrap.append(el("div", { class: "checkrow" }, chk, el("label", {}, `Amenity: ${at} (${atItems.length})`)));
    }
  }

  body.append(filterWrap);

  // ── Connect roads ──────────────────────────────────────────────
  if (wayCount === 2 && nodeCount === 0) {
    const [wayIdA, wayIdB] = wayItems.map(i => i.id);
    body.append(el("div", { class: "section-title" }, "Connect roads"));
    body.append(el("div", { class: "readonly" },
      "Joins these two roads into a shared intersection everywhere their paths currently cross, so they open into each other properly instead of just overlapping."));
    body.append(el("button", {
      onclick: () => {
        pushUndo();
        const shared = connectWays(wayIdA, wayIdB);
        if (shared.length) {
          markDirty(); scheduleAutosave();
          toast(`Connected at ${shared.length} point${shared.length > 1 ? "s" : ""}`);
          setSelection(shared.map(id => ({ type: "node", id })));
        } else {
          State.undoStack.pop(); // nothing changed - drop the empty snapshot
          toast("These roads don't cross - nothing to connect");
        }
      },
    }, "Connect where they cross"));
  }

  // ── Join intersections ────────────────────────────────────────
  if (nodeCount >= 2) {
    const nodeIds = items.filter(i => i.type === "node").map(i => i.id);
    body.append(el("div", { class: "section-title" }, "Join intersections"));
    body.append(el("div", { class: "readonly" },
      "Combines these intersections into one bigger, dynamically-sized junction spanning their real footprint - every road keeps its own exact position and width, nothing converges onto a single point. A short road that purely connects two of them becomes junction surface (deleted); everything else is only ever added to, never shrunk. (Dragging one intersection exactly onto another still fully merges them into a single point instead - use that when you mean literally the same point.)"));
    body.append(el("button", {
      onclick: () => {
        pushUndo();
        const { memberCount, dissolvedRoads } = joinNodesIntoGroup(nodeIds);

        markDirty(); scheduleAutosave();
        toast(`Joined ${memberCount} intersections into one` + (dissolvedRoads ? ` (${dissolvedRoads} connecting road${dissolvedRoads > 1 ? "s" : ""} absorbed)` : ""));
        setSelection(nodeIds.map(id => ({ type: "node", id })));
      },
    }, "Join into one intersection"));
  }

  // ── Redlight group controls ───────────────────────────────────
  const redlightNodeIds = items.filter(i => i.type === "node")
    .map(i => i.id)
    .filter(id => { const n = State.nodes.get(id); return n && n.signal; });
  if (redlightNodeIds.length > 1) {
    body.append(renderRedlightGroupControls(redlightNodeIds));
  }

  body.append(el("div", { class: "section-title" }, "Bulk set tag"));
  const bulkKeyOptions = [
    ...(buildingCount > 0 ? ["building"] : []),
    ...(amenityCount > 0 ? ["amenity"] : []),
    ...COMMON_TAG_KEYS,
  ];
  const keySel = el("select", {}, ...bulkKeyOptions.map(k => el("option", { value: k }, k)));
  const tagAddWrap = el("div", { class: "tag-add" });
  let valIn = el("input", { type: "text", placeholder: "value" });
  const applyBtn = el("button", {
    onclick: () => {
      const k = keySel.value;
      if (!k) return;
      pushUndo();
      for (const it of items) {
        const obj = it.type === "way" ? State.ways.get(it.id)
          : it.type === "node" ? State.nodes.get(it.id)
          : it.type === "building" ? State.buildings.get(it.id)
          : it.type === "amenity" ? State.amenities.get(it.id)
          : null;
        if (obj) { obj.tags = obj.tags || {}; obj.tags[k] = valIn.value; }
      }
      markDirty(); scheduleAutosave(); renderInspector();
    },
  }, "Apply to all");
  function rebuildValueField() {
    const isHighway = keySel.value === "highway";
    const isBuildingType = keySel.value === "building";
    const isAmenityType = keySel.value === "amenity";
    const next = isHighway
      ? el("select", {}, ...HIGHWAY_TYPES.map(hw => el("option", { value: hw }, hw)))
      : isBuildingType
      ? el("select", {}, ...BUILDING_TYPES.map(t => el("option", { value: t }, t)))
      : isAmenityType
      ? el("select", {}, ...AMENITY_TYPES.map(t => el("option", { value: t }, t)))
      : el("input", { type: "text", placeholder: "value" });
    tagAddWrap.replaceChild(next, valIn);
    valIn = next;
  }
  keySel.addEventListener("change", rebuildValueField);
  tagAddWrap.append(keySel, valIn, applyBtn);
  rebuildValueField(); // the initially-selected key may already need the select field, not the default text input
  body.append(tagAddWrap);

  body.append(el("div", { class: "section-title" }, "Quick actions (roads only)"));
  function quickWayTag(label, key, value) {
    return el("button", {
      onclick: () => {
        pushUndo();
        for (const it of items) {
          if (it.type !== "way") continue;
          const way = State.ways.get(it.id);
          if (way) { way.tags = way.tags || {}; way.tags[key] = String(value); }
        }
        markDirty(); scheduleAutosave(); renderInspector();
      },
    }, label);
  }
  body.append(el("div", { class: "quick-actions" },
    quickWayTag("Max speed → default", "maxspeed", Config.defaultMaxSpeed),
    quickWayTag("Lanes → default", "lanes", Config.defaultLanes),
    quickWayTag("Set one-way", "oneway", "yes"),
  ));

  body.append(el("div", { class: "section-title" }, "Danger zone"));
  body.append(el("button", {
    class: "danger-btn",
    onclick: () => deleteSelected(),
  }, `Delete ${items.length} selected item(s)`));
}

// Point-only highway values (traffic signals, crossings, etc.) offered
// alongside the road HIGHWAY_TYPES when editing a node's "highway" tag.
const NODE_HIGHWAY_TYPES = ["traffic_signals", "crossing", "stop", "mini_roundabout"];

function tagEditor(tags, onBeforeChange, onAfterChange, opts = {}) {
  const skipKeys = opts.skipKeys || [];
  const wrap = el("div", {});
  wrap.append(el("div", { class: "section-title" }, "Tags"));
  const list = el("div", {});
  wrap.append(list);

  function redraw() {
    list.innerHTML = "";
    const keys = Object.keys(tags).filter(k => !skipKeys.includes(k)).sort();
    for (const k of keys) {
      let valInput;
      if (k === "highway") {
        const current = tags[k];
        const options = [...NODE_HIGHWAY_TYPES, ...HIGHWAY_TYPES];
        if (current && !options.includes(current)) options.unshift(current);
        valInput = el("select", {},
          ...options.map(v => el("option", { value: v, selected: v === current ? "selected" : null }, v)));
        valInput.addEventListener("change", () => { onBeforeChange(); tags[k] = valInput.value; onAfterChange(); });
      } else {
        valInput = el("input", { type: "text", value: tags[k] });
        valInput.addEventListener("change", () => {
          onBeforeChange();
          tags[k] = valInput.value;
        });
      }
      const delBtn = el("button", {
        onclick: () => { onBeforeChange(); delete tags[k]; redraw(); onAfterChange(); },
        title: "Remove tag",
      }, "×");
      list.append(el("div", { class: "tag-row" }, el("span", { class: "tag-key" }, k), valInput, delBtn));
    }
  }
  redraw();

  const keySel = el("select", {},
    ...COMMON_TAG_KEYS.map(k => el("option", { value: k }, k)),
    el("option", { value: "__custom__" }, "Custom…"));
  const customKeyIn = el("input", { type: "text", placeholder: "key", hidden: true });
  keySel.addEventListener("change", () => {
    customKeyIn.hidden = keySel.value !== "__custom__";
  });
  const valIn = el("input", { type: "text", placeholder: "value" });
  const addBtn = el("button", {
    onclick: () => {
      const k = (keySel.value === "__custom__" ? customKeyIn.value : keySel.value).trim();
      if (!k) return;
      onBeforeChange();
      tags[k] = valIn.value;
      customKeyIn.value = ""; valIn.value = "";
      redraw();
      onAfterChange();
    },
  }, "+ Add");
  wrap.append(el("div", { class: "tag-add" }, keySel, customKeyIn, valIn, addBtn));
  return wrap;
}

/* ---- amenity icon (image upload / emoji) ---- */

function renderIconSection(amenity) {
  const wrap = el("div", {});
  wrap.append(el("div", { class: "section-title" }, "Icon"));

  const icon = resolveAmenityIcon(amenity.tags);
  const preview = el("div", { class: "icon-preview" });
  if (icon.image) preview.append(el("img", { src: icon.image, alt: "icon" }));
  else preview.textContent = icon.emoji;
  wrap.append(preview);

  const fileInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp" });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error("file read failed"));
        reader.readAsDataURL(file);
      });
      const dataBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const res = await fetch("/api/upload-icon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, dataBase64 }),
      });
      const out = await res.json();
      if (!out.ok) throw new Error(out.error || "upload failed");
      pushUndo();
      amenity.tags.icon_image = out.path;
      markDirty(); scheduleAutosave(); renderInspector();
      toast("Icon image uploaded");
    } catch (e) {
      toast("Icon upload failed: " + e.message);
    }
  });
  wrap.append(el("div", { class: "field" }, el("label", {}, "Upload image"), fileInput));

  const emojiIn = el("input", { type: "text", maxlength: "4", value: amenity.tags.icon_emoji || "", placeholder: "e.g. 🚑" });
  emojiIn.addEventListener("change", () => {
    pushUndo();
    if (emojiIn.value.trim()) amenity.tags.icon_emoji = emojiIn.value.trim();
    else delete amenity.tags.icon_emoji;
    markDirty(); scheduleAutosave(); renderInspector();
  });
  wrap.append(el("div", { class: "field" }, el("label", {}, "Emoji"), emojiIn));

  wrap.append(el("button", {
    onclick: () => {
      pushUndo();
      delete amenity.tags.icon_image;
      delete amenity.tags.icon_emoji;
      markDirty(); scheduleAutosave(); renderInspector();
    },
  }, "Reset to default icon"));

  return wrap;
}

/* ---- amenity vehicle fleets ---- */

// Vehicle IDs are unique across the WHOLE map (every amenity's every fleet),
// not just within one fleet - a 10-digit id (1000000000-9999999999),
// regenerated on collision (astronomically rare, but checked for
// correctness rather than assumed).
function collectAllVehicleIds() {
  const ids = new Set();
  for (const a of State.amenities.values()) {
    for (const f of (a.fleets || [])) {
      for (const v of (f.vehicles || [])) ids.add(v.id);
    }
  }
  return ids;
}

function generateUniqueVehicleId() {
  const used = collectAllVehicleIds();
  let id;
  do {
    id = String(Math.floor(1000000000 + Math.random() * 9000000000));
  } while (used.has(id));
  return id;
}

function renderFleetsSection(amenity) {
  const wrap = el("div", {});
  wrap.append(el("div", { class: "section-title" }, "Fleets"));
  if (!amenity.fleets) amenity.fleets = [];

  for (const fleet of amenity.fleets) wrap.append(renderFleetCard(amenity, fleet));

  wrap.append(el("button", {
    onclick: () => {
      pushUndo();
      amenity.fleets.push({
        id: newId("fleet"),
        vehicleType: AMENITY_DEFAULT_VEHICLE_TYPE[amenity.tags.amenity] || "vehicle",
        defaultDims: { length: 5, width: 2, height: 2, weight: 2000, maxSpeed: 100 },
        vehicles: [],
      });
      markDirty(); scheduleAutosave(); renderInspector();
    },
  }, "+ Add fleet"));

  return wrap;
}

function dimFields(target, onChange) {
  function field(labelText, key, step) {
    const input = el("input", { type: "number", min: "0", step: step || "0.1", value: target[key] });
    input.addEventListener("change", () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v) || v < 0) { input.value = target[key]; return; }
      pushUndo(); target[key] = v; onChange();
    });
    return el("div", { class: "field" }, el("label", {}, labelText), input);
  }
  return [
    field("Length (m)", "length"),
    field("Width (m)", "width"),
    field("Height (m)", "height"),
    field("Weight (kg)", "weight", "10"),
    field("Max speed (km/h)", "maxSpeed", "1"),
  ];
}

function renderFleetCard(amenity, fleet) {
  const card = el("div", { class: "fleet-card" });

  const typeInput = el("input", { type: "text", value: fleet.vehicleType });
  typeInput.addEventListener("change", () => {
    pushUndo(); fleet.vehicleType = typeInput.value; markDirty(); scheduleAutosave();
  });
  card.append(el("div", { class: "field" }, el("label", {}, "Vehicle type"), typeInput));

  card.append(el("div", { class: "section-title" }, "Default dimensions (seeds new vehicles)"));
  card.append(...dimFields(fleet.defaultDims, () => { markDirty(); scheduleAutosave(); }));

  // Resizing the count is the primary "the amount I specify" control - it
  // adds new vehicles (each with a freshly generated unique id, seeded from
  // the current defaultDims) or trims from the end. Each vehicle's own dims
  // still stay independently editable afterwards below (see renderVehicleRow).
  const countInput = el("input", { type: "number", min: "0", step: "1", value: fleet.vehicles.length });
  countInput.addEventListener("change", () => {
    const n = parseInt(countInput.value, 10);
    if (!Number.isFinite(n) || n < 0) { countInput.value = fleet.vehicles.length; return; }
    pushUndo();
    while (fleet.vehicles.length < n) fleet.vehicles.push({ id: generateUniqueVehicleId(), ...fleet.defaultDims });
    while (fleet.vehicles.length > n) fleet.vehicles.pop();
    markDirty(); scheduleAutosave(); renderInspector();
  });
  card.append(el("div", { class: "field" }, el("label", {}, "Count"), countInput));

  if (fleet.vehicles.length) {
    card.append(el("div", { class: "section-title" }, "Vehicles"));
    for (const veh of fleet.vehicles) card.append(renderVehicleRow(fleet, veh));
  }

  card.append(el("button", {
    class: "danger-btn",
    onclick: () => {
      pushUndo();
      amenity.fleets.splice(amenity.fleets.indexOf(fleet), 1);
      markDirty(); scheduleAutosave(); renderInspector();
    },
  }, "Remove fleet"));

  return card;
}

function renderVehicleRow(fleet, veh) {
  const row = el("div", { class: "vehicle-row" });
  row.append(el("div", { class: "field" }, el("label", {}, "ID"), el("div", { class: "readonly" }, veh.id)));
  row.append(...dimFields(veh, () => { markDirty(); scheduleAutosave(); }));
  row.append(el("button", {
    onclick: () => {
      pushUndo();
      fleet.vehicles.splice(fleet.vehicles.indexOf(veh), 1);
      markDirty(); scheduleAutosave(); renderInspector();
    },
  }, "Remove vehicle"));
  return row;
}

function addNodeAt(world, tags = {}) {
  const id = newId("n");
  State.nodes.set(id, { x: world.x, y: world.y, tags });
  rebuildIndex();
  updateStatusCounts();
  return id;
}

// Marks/unmarks a node as a U-turn point: a deliberate gap in a two-way
// road's centre divider and in the junction wall on that side, for a median
// crossover that lets traffic turn back rather than a real closed junction
// corner - see UTURN_GAP_M (drawLaneDecorations) and the U-turn skip in
// drawJunctionShapes.
function setUturn(nodeId, on) {
  const node = State.nodes.get(nodeId);
  if (!node) return;
  node.tags = node.tags || {};
  if (on) node.tags.uturn = "yes"; else delete node.tags.uturn;
}

function renderUturnSection(node, nodeId) {
  const wrap = el("div", {});
  wrap.append(el("div", { class: "section-title" }, "U-turn"));
  const isUturn = isYes(node.tags && node.tags.uturn);
  const deg = nodeDegree(nodeId);

  if (isUturn) {
    wrap.append(
      el("div", { class: "readonly" }, "This intersection is a U-turn point - no median divider or junction wall here."),
      el("button", {
        class: "danger-btn",
        onclick: () => { pushUndo(); setUturn(nodeId, false); markDirty(); scheduleAutosave(); renderInspector(); },
      }, "Remove U-turn"),
    );
  } else if (deg === 2) {
    wrap.append(el("button", {
      onclick: () => { pushUndo(); setUturn(nodeId, true); markDirty(); scheduleAutosave(); renderInspector(); },
    }, "Mark as U-turn point"));
  } else {
    wrap.append(el("div", { class: "readonly" }, `Needs exactly 2 connected roads (this one has ${deg})`));
  }
  return wrap;
}

// Inspector section for an Angle Point / Curve Point (see
// insertShapingNodeOnWay) - returns null for any ordinary node so callers
// can just skip appending it. Lets the point be flipped between the two
// types in place, without removing/re-adding it.
function renderVertexTypeSection(node, nodeId) {
  const vType = node.tags && node.tags.vertex_type;
  if (vType !== "angle" && vType !== "curve") return null;
  const wrap = el("div", {});
  wrap.append(el("div", { class: "section-title" }, "Road shape point"));
  wrap.append(el("div", { class: "readonly" }, vType === "angle"
    ? "Forces a sharp corner here, even on an otherwise smooth (spline) road."
    : "Rounds the road smoothly here, even on an otherwise straight (line) road."));
  wrap.append(el("button", {
    onclick: () => {
      pushUndo();
      node.tags.vertex_type = vType === "angle" ? "curve" : "angle";
      markDirty(); scheduleAutosave(); renderInspector();
    },
  }, vType === "angle" ? "Switch to Curve" : "Switch to Angle"));
  return wrap;
}

// Reverses a way's node order for an internal topology edit (merging two
// ways at a shared pass-through node - see mergeWaysAtSharedNode) without
// changing its real-world meaning. A plain array reversal would silently
// flip which direction a oneway="yes"/"-1" road travels - that's exactly
// what the user-facing "Reverse direction" button relies on to let someone
// flip a one-way road ON PURPOSE, but reorienting purely as an internal step
// of an unrelated edit must not have that side effect, so this compensates
// by flipping the oneway tag too, leaving the tagged direction of travel on
// the ground unchanged.
function reverseWayForMerge(way) {
  way.nodes.reverse();
  const ow = ((way.tags && way.tags.oneway) || "").trim().toLowerCase();
  if (ow === "yes") way.tags.oneway = "-1";
  else if (ow === "-1") way.tags.oneway = "yes";
}

// Merges two ways that meet end-to-end at `sharedId` into one continuous way
// - wayA survives (keeping its own id/tags/curve) spanning both original
// paths, wayB is deleted. Used by deleteNodeSilent's pass-through case so
// "delete this intersection" removes the JOINT only, never any road's own
// geometry. Any redlight phase elsewhere that still names wayB's id is
// repointed to wayA's id (deduped) so a traffic light at some other,
// unrelated intersection never silently loses an approach just because the
// road it referenced got merged away here.
function mergeWaysAtSharedNode(wayA, wayB, sharedId) {
  if (wayA.nodes[wayA.nodes.length - 1] !== sharedId) reverseWayForMerge(wayA);
  if (wayB.nodes[0] !== sharedId) reverseWayForMerge(wayB);
  wayA.nodes = wayA.nodes.concat(wayB.nodes.slice(1));
  State.ways.delete(wayB.id);
  for (const node of State.nodes.values()) {
    if (!node.signal) continue;
    for (const phase of node.signal.phases) {
      if (!phase.wayIds.includes(wayB.id)) continue;
      const remapped = phase.wayIds.map(wid => (wid === wayB.id ? wayA.id : wid));
      phase.wayIds = remapped.filter((wid, i) => remapped.indexOf(wid) === i);
    }
  }
}

function deleteNodeSilent(id) {
  if (!State.nodes.has(id)) return;
  const node = State.nodes.get(id);

  // Deleting ANY member of a joined group (see joinNodesIntoGroup) deletes
  // the WHOLE junction, not just the one leg the click happened to land on
  // - osm_to_json.py's auto-grouping (SHORTEN_M) means almost every real
  // junction is now several private per-road endpoint nodes tied together
  // purely by this tag, not one shared node, so "delete this intersection"
  // has to mean the whole pooled group or it'd take one click per approach
  // road to actually remove a junction (see TOOL_HINTS.delNode).
  const groupId = node.tags && node.tags.join_group;
  const members = groupId ? junctionCluster(id) : [id];

  const isMeaningful = (mid) => {
    const mn = State.nodes.get(mid);
    return !!(mn && (mn.signal || (mn.tags && isYes(mn.tags.uturn))));
  };

  // Pass-through case: the whole group (however many member nodes it's
  // split across) only ever touches exactly two distinct, non-looped ways
  // meeting end-to-end - not a real branching junction at all, just the
  // auto-grouping's own private-endpoint split of what is, functionally,
  // one continuous road (or a manually-joined 2-road connector). Merge the
  // two ways into one instead of shortening/deleting either. A signal or
  // U-turn flag on any member would make silently merging it away a real
  // data loss, not a topology cleanup, so that falls through to the
  // strip-and-maybe-delete behaviour below instead, same as any other
  // topology (3+ distinct ways, a closed loop).
  if (!members.some(isMeaningful)) {
    const wayIdSet = new Set();
    for (const mid of members) for (const wid of (State.nodeWayIndex.get(mid) || [])) wayIdSet.add(wid);
    if (wayIdSet.size === 2) {
      const [wayIdA, wayIdB] = [...wayIdSet];
      const wayA = State.ways.get(wayIdA), wayB = State.ways.get(wayIdB);
      const isLoop = (w) => w.nodes[0] === w.nodes[w.nodes.length - 1];
      const isEndpoint = (w, mid) => w.nodes[0] === mid || w.nodes[w.nodes.length - 1] === mid;
      const jointA = wayA && members.find(mid => isEndpoint(wayA, mid));
      const jointB = wayB && members.find(mid => isEndpoint(wayB, mid));
      if (wayA && wayB && jointA && jointB && !isLoop(wayA) && !isLoop(wayB)) {
        // Every member is within a couple of metres of the real crossing it
        // was pulled back from (see SHORTEN_M) - collapse every OTHER
        // member onto jointA's own position first, so the merge below (see
        // mergeWaysAtSharedNode) walks one single, consistent shared point
        // instead of stitching across several nearby-but-distinct ones.
        if (jointB !== jointA) {
          for (const w of State.ways.values()) {
            w.nodes = w.nodes.map(n => (n === jointB ? jointA : n));
          }
        }
        for (const mid of members) {
          if (mid !== jointA) State.nodes.delete(mid);
        }
        mergeWaysAtSharedNode(wayA, wayB, jointA);
        return;
      }
    }
  }

  for (const mid of members) {
    const affected = Array.from(State.nodeWayIndex.get(mid) || []);
    for (const wid of affected) {
      const way = State.ways.get(wid);
      if (!way) continue;
      way.nodes = way.nodes.filter(n => n !== mid);
      if (way.nodes.length < 2) State.ways.delete(wid);
    }
    State.nodes.delete(mid);
  }
}

function deleteWaySilent(id) {
  State.ways.delete(id);
}

function deleteNode(id) {
  if (!State.nodes.has(id)) return;
  pushUndo();
  deleteNodeSilent(id);
  rebuildIndex();
  clearSelection();
  updateStatusCounts();
  markDirty();
  scheduleAutosave();
  toast("Intersection deleted");
}

function deleteWay(id) {
  if (!State.ways.has(id)) return;
  pushUndo();
  deleteWaySilent(id);
  rebuildIndex();
  clearSelection();
  updateStatusCounts();
  markDirty();
  scheduleAutosave();
  toast("Road deleted");
}

// Every amenity is linked to a building (see addAmenityAt's own comment) -
// deleting either one deletes its linked counterpart too, so a building
// never survives as a pointless empty shell after its amenity is gone, and
// an amenity never survives floating with no building under it.
function deleteBuildingSilent(id) {
  State.buildings.delete(id);
  for (const [aid, a] of State.amenities) {
    if (a.buildingId === id) State.amenities.delete(aid);
  }
}

function deleteAmenitySilent(id) {
  const a = State.amenities.get(id);
  State.amenities.delete(id);
  if (a && a.buildingId) State.buildings.delete(a.buildingId);
}

function deleteBuilding(id) {
  if (!State.buildings.has(id)) return;
  pushUndo();
  deleteBuildingSilent(id);
  clearSelection();
  markDirty();
  scheduleAutosave();
  toast("Building deleted");
}

function deleteAmenity(id) {
  if (!State.amenities.has(id)) return;
  pushUndo();
  deleteAmenitySilent(id);
  clearSelection();
  markDirty();
  scheduleAutosave();
  toast("Amenity deleted");
}

// Projects `world` onto the way's nearest segment and inserts a node there,
// splitting the way in two - the original id keeps the "before" half (up to
// and including the new node), a new way id gets the "after" half (from the
// new node onward), both carrying a copy of the original tags. Used to place
// a traffic light mid-road rather than only at an existing junction node
// (see addDirectionalRedlightOnWay in redlight.js).
//
// Returns null - WITHOUT mutating anything - if `world` projects onto (or
// past) the way's own first/last node, since that would split off a
// degenerate single-node half; callers should already be routing a
// near-endpoint click to findNodeAt instead of here.
function splitWayAt(wayId, world) {
  const way = State.ways.get(wayId);
  if (!way || way.nodes.length < 2) return null;
  const pts = wayPoints(way);
  if (pts.length !== way.nodes.length) return null;

  let bestI = -1, bestD = Infinity, bestT = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const abx = b.x - a.x, aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    let t = lenSq > 1e-9 ? ((world.x - a.x) * abx + (world.y - a.y) * aby) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + abx * t, cy = a.y + aby * t;
    const d = Math.hypot(world.x - cx, world.y - cy);
    if (d < bestD) { bestD = d; bestI = i; bestT = t; }
  }
  if (bestI === -1) return null;

  const a = pts[bestI], b = pts[bestI + 1];
  const EPS = 1e-4;

  // Snap to an existing node instead of creating a near-duplicate when the
  // projection lands essentially on one. If that existing node turns out to
  // be the way's own first or last node, splitting there is degenerate (one
  // side would be a single point) - bail out before mutating anything. A
  // freshly-created id can never equal an existing node's id, so this check
  // alone is enough; nothing below it needs re-checking for that case.
  let midId = null;
  if (bestT <= EPS) midId = way.nodes[bestI];
  else if (bestT >= 1 - EPS) midId = way.nodes[bestI + 1];
  if (midId === way.nodes[0] || midId === way.nodes[way.nodes.length - 1]) return null;

  if (midId === null) {
    midId = newId("n");
    State.nodes.set(midId, { x: a.x + (b.x - a.x) * bestT, y: a.y + (b.y - a.y) * bestT, tags: {} });
  }

  const idx = way.nodes.indexOf(midId);
  let beforeNodes, afterNodes;
  if (idx !== -1) {
    beforeNodes = way.nodes.slice(0, idx + 1);
    afterNodes = way.nodes.slice(idx);
  } else {
    beforeNodes = way.nodes.slice(0, bestI + 1).concat(midId);
    afterNodes = [midId].concat(way.nodes.slice(bestI + 1));
  }

  way.nodes = beforeNodes;
  const afterWayId = newId("w");
  State.ways.set(afterWayId, { id: afterWayId, tags: { ...way.tags }, nodes: afterNodes, curve: way.curve });

  rebuildIndex();
  updateStatusCounts();
  return { nodeId: midId, beforeWayId: way.id, afterWayId };
}

// Inserts a new road-shaping vertex into an existing way's own node list, at
// whichever segment it projects closest to - unlike splitWayAt, this never
// creates a second way: the road stays one single selectable entity, just
// with one more point in its path that can be dragged. `vertexType` is
// "angle" or "curve" for an explicit Angle/Curve Point (see vertexTreatment
// - controls whether it locally sharpens or rounds the road right there);
// falsy (used by the select tool's own road-body-drag reshape) leaves the
// point untagged, so it just follows the way's own whole-way curve setting.
// Never snaps onto an existing node (rejects a projection landing on one,
// same as splitWayAt's own endpoint bail-out) - tagging a real junction node
// would be inert, since drawWayBase always splits sub-paths at a junction
// (nodeDegree >= 2) and shortenPath always clips it away as a synthetic
// endpoint before any interior-vertex shaping logic ever runs.
function insertShapingNodeOnWay(wayId, world, vertexType) {
  const way = State.ways.get(wayId);
  if (!way || way.nodes.length < 2) return null;
  const pts = wayPoints(way);
  if (pts.length !== way.nodes.length) return null;

  let bestI = -1, bestD = Infinity, bestT = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const abx = b.x - a.x, aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    let t = lenSq > 1e-9 ? ((world.x - a.x) * abx + (world.y - a.y) * aby) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + abx * t, cy = a.y + aby * t;
    const d = Math.hypot(world.x - cx, world.y - cy);
    if (d < bestD) { bestD = d; bestI = i; bestT = t; }
  }
  if (bestI === -1) return null;

  const a = pts[bestI], b = pts[bestI + 1];
  const EPS = 1e-4;
  if (bestT <= EPS || bestT >= 1 - EPS) return null; // reject snapping onto an existing node

  const midId = newId("n");
  const tags = vertexType ? { vertex_type: vertexType } : {};
  State.nodes.set(midId, { x: a.x + (b.x - a.x) * bestT, y: a.y + (b.y - a.y) * bestT, tags });
  way.nodes.splice(bestI + 1, 0, midId);

  rebuildIndex();
  updateStatusCounts();
  return midId;
}

/* ---- road connecting / disconnecting (topology) ---- */

// Merges `fromId` into `intoId`: every way that referenced fromId now
// references intoId instead, fromId's tags/signal are carried over onto
// intoId wherever intoId didn't already have its own value, and fromId is
// deleted. Used both for "snap this dragged node onto that other node" and
// as the last step of connectWays() when a crossing lands on an existing
// endpoint rather than mid-way. A way that ends up with the same node
// repeated consecutively (its two ends both got merged onto one point) or
// collapses to under 2 distinct nodes is cleaned up/dropped, same as any
// other edit that can degenerate a way.
function mergeNodes(fromId, intoId) {
  if (fromId === intoId) return intoId;
  const fromNode = State.nodes.get(fromId);
  const intoNode = State.nodes.get(intoId);
  if (!fromNode || !intoNode) return intoId;

  for (const [wid, way] of Array.from(State.ways)) {
    const mapped = way.nodes.map(nid => (nid === fromId ? intoId : nid));
    const dedup = mapped.filter((nid, i) => i === 0 || nid !== mapped[i - 1]);
    way.nodes = dedup;
    if (way.nodes.length < 2) State.ways.delete(wid);
  }

  if (fromNode.tags) intoNode.tags = { ...fromNode.tags, ...intoNode.tags };
  if (fromNode.signal && !intoNode.signal) intoNode.signal = fromNode.signal;
  State.nodes.delete(fromId);
  rebuildIndex();
  return intoId;
}

// "Join into one intersection", for two or more real junctions that should
// read as one bigger intersection - unlike mergeNodes (used for actually
// dragging one node onto another), this never moves or deletes any of the
// selected nodes and never re-points any OTHER road's endpoint: every
// road's own dimensions stay exactly as drawn. The nodes are tagged into a
// shared join_group (see junctionCluster) so getJunctionData pools all of
// their legs into one dynamically-sized ring spanning their real footprint
// (via buildJunctionRing's clockwise corner sweep) instead of collapsing to
// a single point.
// The only thing actually deleted is a short connecting road that purely
// links two group members with no other branch along it - it becomes
// junction surface, per "fills the road as intersection deleting the road
// but preserving other dimensions"; a connector with a branch (so deleting
// it would strand a real third road) is left alone.
function joinNodesIntoGroup(nodeIds) {
  let groupId = null;
  for (const id of nodeIds) {
    const n = State.nodes.get(id);
    const g = n && n.tags && n.tags.join_group;
    if (g) { groupId = g; break; }
  }
  if (!groupId) groupId = newId("jg");

  const allMembers = new Set(nodeIds);
  for (const id of nodeIds) {
    const n = State.nodes.get(id);
    const prevGroup = n && n.tags && n.tags.join_group;
    if (!prevGroup) continue;
    for (const [oid, on] of State.nodes) {
      if (on.tags && on.tags.join_group === prevGroup) allMembers.add(oid);
    }
  }
  for (const id of allMembers) {
    const n = State.nodes.get(id);
    if (!n) continue;
    n.tags = n.tags || {};
    n.tags.join_group = groupId;
  }

  let dissolvedRoads = 0;
  for (const [wid, way] of Array.from(State.ways)) {
    if (way.nodes.length < 2) continue;
    const startId = way.nodes[0], endId = way.nodes[way.nodes.length - 1];
    if (startId === endId) continue;
    if (!allMembers.has(startId) || !allMembers.has(endId)) continue;
    // Every interior vertex must be a plain pass-through point on this same
    // way (no other road branches off it) for the whole way to be a pure
    // connector safely absorbed into the junction surface.
    let pureConnector = true;
    for (let i = 1; i < way.nodes.length - 1; i++) {
      if (nodeDegree(way.nodes[i]) !== 2) { pureConnector = false; break; }
    }
    if (!pureConnector) continue;
    for (let i = 1; i < way.nodes.length - 1; i++) {
      const midId = way.nodes[i];
      if (!allMembers.has(midId)) State.nodes.delete(midId);
    }
    State.ways.delete(wid);
    dissolvedRoads++;
  }

  rebuildIndex();
  return { groupId, memberCount: allMembers.size, dissolvedRoads };
}

// Reverses a join (see joinNodesIntoGroup): every member goes back to being
// its own separate intersection, each with its own marker again. Any
// connecting road that was absorbed into junction surface at join time is
// NOT restored (that deletion already happened as real data) - this only
// stops treating the survivors as one signal/marker.
function ungroupJunction(nodeId) {
  const n = State.nodes.get(nodeId);
  const groupId = n && n.tags && n.tags.join_group;
  if (!groupId) return 0;
  const members = (State.joinGroupIndex.get(groupId) || []).slice();
  for (const id of members) {
    const mn = State.nodes.get(id);
    if (mn && mn.tags) delete mn.tags.join_group;
  }
  rebuildIndex();
  return members.length;
}

// Inserts an EXISTING node into a way at whichever segment it projects
// closest to, splitting the way in two there - the shared-node counterpart
// to splitWayAt (which always creates a brand-new node). Used to connect two
// ways at a crossing point without ending up with two separate, merely
// coincident nodes there.
//
// Returns one of three distinct shapes so callers can tell WHY it didn't
// split without having to re-derive that themselves:
//   - null                                  - hard failure (bad ids, or the
//                                              node's already on this way) -
//                                              nothing a caller should react to.
//   - { endpointId }                        - the node's projection lands at
//                                              or past the way's own first/last
//                                              node, where splitting would be
//                                              degenerate - callers should
//                                              merge onto endpointId instead.
//   - { nodeId, beforeWayId, afterWayId }   - success.
function insertExistingNodeIntoWay(wayId, nodeId) {
  const way = State.ways.get(wayId);
  const node = State.nodes.get(nodeId);
  if (!way || !node || way.nodes.length < 2) return null;
  if (way.nodes.includes(nodeId)) return null;

  const pts = wayPoints(way);
  if (pts.length !== way.nodes.length) return null;
  let bestI = -1, bestD = Infinity, bestT = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const abx = b.x - a.x, aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    let t = lenSq > 1e-9 ? ((node.x - a.x) * abx + (node.y - a.y) * aby) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + abx * t, cy = a.y + aby * t;
    const d = Math.hypot(node.x - cx, node.y - cy);
    if (d < bestD) { bestD = d; bestI = i; bestT = t; }
  }
  if (bestI === -1) return null;

  // If the projection lands essentially on an existing vertex of the way -
  // an endpoint, or (rarer) an internal one - report that vertex rather than
  // splitting: a split there would be degenerate (an endpoint) or a
  // pointless zero-length segment (an internal vertex already at this spot).
  const EPS = 1e-4;
  if (bestT <= EPS) return { endpointId: way.nodes[bestI] };
  if (bestT >= 1 - EPS) return { endpointId: way.nodes[bestI + 1] };

  const beforeNodes = way.nodes.slice(0, bestI + 1).concat(nodeId);
  const afterNodes = [nodeId].concat(way.nodes.slice(bestI + 1));
  way.nodes = beforeNodes;
  const afterWayId = newId("w");
  State.ways.set(afterWayId, { id: afterWayId, tags: { ...way.tags }, nodes: afterNodes, curve: way.curve });

  rebuildIndex();
  updateStatusCounts();
  return { nodeId, beforeWayId: way.id, afterWayId };
}

// Segment-segment intersection point (proper crossing only, not touching at
// an endpoint or overlapping/parallel), used by findWayCrossings.
function segSegIntersection(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null; // parallel/collinear
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + d1x * t, y: p1.y + d1y * t };
}

// All points where wayA's and wayB's drawn paths cross (evaluated along
// their splines where relevant, so a curved road's actual crossing points
// are found, not just its straight control polygon's).
function findWayCrossings(wayA, wayB) {
  const ptsA = wayEvaluationPoints(wayA);
  const ptsB = wayEvaluationPoints(wayB);
  const hits = [];
  for (let i = 0; i < ptsA.length - 1; i++) {
    for (let j = 0; j < ptsB.length - 1; j++) {
      const pt = segSegIntersection(ptsA[i], ptsA[i + 1], ptsB[j], ptsB[j + 1]);
      if (pt) hits.push(pt);
    }
  }
  return hits;
}

// Joins two roads into a real shared intersection everywhere their paths
// currently cross, so the usual junction clipping/blending (see
// junctionClearance/drawJunctionShapes) kicks in there instead of the two
// surfaces just overlapping. This is a manual, explicit action (pick exactly
// the 2 roads you mean) rather than an automatic "snap any road that gets
// near another one" pass - which is what makes it safe to use right through
// a flyover: connect the ramp to the road it actually joins, and leave the
// roads it merely passes over alone.
//
// Returns the list of node ids now shared between the two roads (one per
// crossing found), or [] if their paths don't currently cross at all.
function connectWays(wayIdA, wayIdB) {
  const wayA0 = State.ways.get(wayIdA), wayB0 = State.ways.get(wayIdB);
  if (!wayA0 || !wayB0) return [];
  const crossings = findWayCrossings(wayA0, wayB0);
  if (!crossings.length) return [];

  let aIds = [wayIdA];
  let bIds = [wayIdB];
  const sharedNodes = [];

  function findContaining(ids, point) {
    for (const id of ids) {
      const way = State.ways.get(id);
      if (!way) continue;
      const pts = wayEvaluationPoints(way);
      for (let i = 0; i < pts.length - 1; i++) {
        if (distPointToSegment(point, pts[i], pts[i + 1]) < 1e-2) return id;
      }
    }
    return ids[0];
  }

  function nearestEndpoint(wayId, point) {
    const way = State.ways.get(wayId);
    const pts = wayPoints(way);
    const d0 = Math.hypot(point.x - pts[0].x, point.y - pts[0].y);
    const d1 = Math.hypot(point.x - pts[pts.length - 1].x, point.y - pts[pts.length - 1].y);
    return d0 <= d1 ? way.nodes[0] : way.nodes[way.nodes.length - 1];
  }

  for (const pt of crossings) {
    const curA = findContaining(aIds, pt);
    const splitA = splitWayAt(curA, pt);
    let nodeId;
    if (splitA) {
      aIds = aIds.filter(id => id !== curA).concat([splitA.beforeWayId, splitA.afterWayId]);
      nodeId = splitA.nodeId;
    } else {
      nodeId = nearestEndpoint(curA, pt);
    }

    const curB = findContaining(bIds, pt);
    const resB = insertExistingNodeIntoWay(curB, nodeId);
    if (resB && resB.beforeWayId) {
      bIds = bIds.filter(id => id !== curB).concat([resB.beforeWayId, resB.afterWayId]);
    } else if (resB && resB.endpointId && resB.endpointId !== nodeId) {
      mergeNodes(resB.endpointId, nodeId);
    }
    sharedNodes.push(nodeId);
  }
  rebuildIndex();
  updateStatusCounts();
  return sharedNodes;
}

// The inverse of connecting: pulls ONE connected way off a shared
// intersection node, giving it its own copy of the node at the same
// position so it's no longer topologically joined to the others there - e.g.
// to turn an accidental at-grade join into a proper flyover-over-street (mark
// the detached way bridge:yes afterwards) or just to stop two roads from
// intersecting at all.
function detachWayFromNode(wayId, nodeId) {
  const way = State.ways.get(wayId);
  const node = State.nodes.get(nodeId);
  if (!way || !node) return null;
  const newNodeId = newId("n");
  State.nodes.set(newNodeId, { x: node.x, y: node.y, tags: {} });
  way.nodes = way.nodes.map(nid => (nid === nodeId ? newNodeId : nid));
  rebuildIndex();
  updateStatusCounts();
  return newNodeId;
}

function cleanupOrphanNodes() {
  pushUndo();
  let removed = 0;
  for (const [id, n] of Array.from(State.nodes)) {
    const deg = nodeDegree(id);
    const hasTags = n.tags && Object.keys(n.tags).length > 0;
    if (deg === 0 && !hasTags) { State.nodes.delete(id); removed++; }
  }
  rebuildIndex();
  updateStatusCounts();
  markDirty();
  scheduleAutosave();
  toast(removed ? `Removed ${removed} unused point(s)` : "Nothing to clean up");
}

/* ---- road drawing (straight / spline) ---- */

function startRoadDrawing(curve) {
  State.drawingWay = { nodeIds: [], curve, createdNodeIds: new Set() };
  State.ghostPoint = null;
  markDirty();
}

function addRoadVertex(world) {
  const hit = findNodeAt(world, 10);
  let id;
  if (hit) {
    id = hit;
  } else {
    id = newId("n");
    State.nodes.set(id, { x: world.x, y: world.y, tags: {} });
    State.drawingWay.createdNodeIds.add(id);
  }
  State.drawingWay.nodeIds.push(id);
  markDirty();
}

function finishRoadDrawing() {
  const dw = State.drawingWay;
  if (!dw) return;
  if (dw.nodeIds.length >= 2) {
    pushUndo();
    const wid = newId("w");
    State.ways.set(wid, {
      id: wid,
      tags: {
        highway: "residential",
        maxspeed: String(Config.defaultMaxSpeed),
        avg_min_speed: String(Config.defaultAvgMinSpeed),
        avg_max_speed: String(Config.defaultAvgMaxSpeed),
        lanes: String(Config.defaultLanes),
        lane_width: String(Config.defaultLaneWidth),
        divider: Config.defaultLanes >= 2 ? "yes" : "no",
      },
      nodes: dw.nodeIds.slice(),
      curve: dw.curve,
    });
    rebuildIndex();
    State.drawingWay = null;
    State.ghostPoint = null;
    updateStatusCounts();
    setTool("select");
    selectWay(wid);
    markDirty();
    scheduleAutosave();
    toast("Road created — set its type in the inspector");
  } else {
    cancelRoadDrawing();
  }
}

function cancelRoadDrawing() {
  const dw = State.drawingWay;
  if (!dw) return;
  for (const id of dw.createdNodeIds) {
    if (nodeDegree(id) === 0) State.nodes.delete(id);
  }
  State.drawingWay = null;
  State.ghostPoint = null;
  rebuildIndex();
  markDirty();
}

/* ---- building polygon drawing ---- */
// Mirrors startRoadDrawing/addRoadVertex/finishRoadDrawing/cancelRoadDrawing
// above, minus the "snap to an existing node" behaviour (a building's own
// vertices aren't part of the road graph, so there's nothing to snap to) -
// just a plain list of world points, closed into a polygon on finish.

function startBuildingDrawing() {
  State.drawingBuilding = { points: [] };
  State.ghostPoint = null;
  markDirty();
}

function addBuildingVertex(world) {
  State.drawingBuilding.points.push({ x: world.x, y: world.y });
  markDirty();
}

function finishBuildingDrawing() {
  const db = State.drawingBuilding;
  if (!db) return;
  if (db.points.length >= 3) {
    pushUndo();
    const bid = newId("b");
    State.buildings.set(bid, { id: bid, tags: { building: "yes" }, polygon: db.points.slice() });
    State.drawingBuilding = null;
    State.ghostPoint = null;
    setTool("select");
    setSelection([{ type: "building", id: bid }]);
    markDirty();
    scheduleAutosave();
    toast("Building created — set its type in the inspector");
  } else {
    cancelBuildingDrawing();
  }
}

function cancelBuildingDrawing() {
  if (!State.drawingBuilding) return;
  State.drawingBuilding = null;
  State.ghostPoint = null;
  markDirty();
}

// An amenity is never a bare point with nothing built there - every amenity
// is linked to a building (see buildingId), so placing one also creates its
// own small placeholder footprint, centred on the click, same convention
// osm_to_json.py's extract_buildings_and_amenities uses for a standalone
// amenity node with no existing building way. The two stay linked for
// deletion and move (see deleteAmenitySilent/deleteBuildingSilent and
// translateSelected) - moving or deleting one carries the other along.
const AMENITY_PLACEHOLDER_HALF_M = 4;

function addAmenityAt(world) {
  pushUndo();
  const bid = newId("b");
  const half = AMENITY_PLACEHOLDER_HALF_M;
  State.buildings.set(bid, {
    id: bid,
    tags: { building: "yes" },
    polygon: [
      { x: world.x - half, y: world.y - half },
      { x: world.x + half, y: world.y - half },
      { x: world.x + half, y: world.y + half },
      { x: world.x - half, y: world.y + half },
    ],
  });
  const aid = newId("a");
  State.amenities.set(aid, { id: aid, x: world.x, y: world.y, tags: {}, fleets: [], buildingId: bid });
  setTool("select");
  setSelection([{ type: "amenity", id: aid }]);
  markDirty();
  scheduleAutosave();
  return aid;
}

/* ---- circular roads (roundabouts) ---- */

function createCircularRoad(center, radius) {
  const nodeIds = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const ang = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    const id = newId("n");
    State.nodes.set(id, { x: center.x + Math.cos(ang) * radius, y: center.y + Math.sin(ang) * radius, tags: {} });
    nodeIds.push(id);
  }
  nodeIds.push(nodeIds[0]);

  const wid = newId("w");
  State.ways.set(wid, {
    id: wid,
    tags: {
      highway: "residential",
      maxspeed: String(Config.defaultMaxSpeed),
      avg_min_speed: String(Config.defaultAvgMinSpeed),
      avg_max_speed: String(Config.defaultAvgMaxSpeed),
      lanes: String(Config.defaultLanes),
      lane_width: String(Config.defaultLaneWidth),
      divider: Config.defaultLanes >= 2 ? "yes" : "no",
      circle_cx: String(center.x), circle_cy: String(center.y), circle_radius: String(radius),
    },
    nodes: nodeIds,
    curve: "line",
  });
  rebuildIndex();
  updateStatusCounts();
  return wid;
}

// Rescales every node of a circular road (see createCircularRoad) to a new
// radius, sliding each one out/in along its OWN current angle from the
// centre rather than resetting them to evenly-spaced angles - so a node
// that's since been moved (e.g. to snap another road onto the loop) keeps
// its relative position on the circle instead of snapping back to where it
// started.
function setCircleRadius(wayId, newRadius) {
  const way = State.ways.get(wayId);
  if (!way || way.tags.circle_cx == null) return;
  const cx = parseFloat(way.tags.circle_cx), cy = parseFloat(way.tags.circle_cy);
  const seen = new Set();
  for (const id of way.nodes) {
    if (seen.has(id)) continue;
    seen.add(id);
    const node = State.nodes.get(id);
    if (!node) continue;
    const ang = Math.atan2(node.y - cy, node.x - cx);
    node.x = cx + Math.cos(ang) * newRadius;
    node.y = cy + Math.sin(ang) * newRadius;
  }
  way.tags.circle_radius = String(newRadius);
  markDirty();
}

function moveNodeTo(id, world) {
  const n = State.nodes.get(id);
  if (n) { n.x = world.x; n.y = world.y; markDirty(); }
}

function rotateWay(way, pivot, angleDelta) {
  const cosA = Math.cos(angleDelta), sinA = Math.sin(angleDelta);
  const touched = new Set();
  for (const nid of way.nodes) {
    if (touched.has(nid)) continue;
    touched.add(nid);
    const n = State.nodes.get(nid);
    if (!n) continue;
    const dx = n.x - pivot.x, dy = n.y - pivot.y;
    n.x = pivot.x + dx * cosA - dy * sinA;
    n.y = pivot.y + dx * sinA + dy * cosA;
  }
  markDirty();
}

// Spins every member of a joined intersection group around a shared pivot
// (the group's own centroid - see clusterRotateHandleWorld) by angleDelta -
// each member is a real, separate node (its own road's private endpoint,
// see buildClusterLegs), so this only ever repositions those member nodes
// themselves; it never touches any other node further along any road, and
// never touches the join_group tag that ties them together. Mirrors
// rotateWay's own math, applied to a plain list of node ids instead of a
// way's node list.
function rotateClusterMembers(members, pivot, angleDelta) {
  const cosA = Math.cos(angleDelta), sinA = Math.sin(angleDelta);
  for (const id of members) {
    const n = State.nodes.get(id);
    if (!n) continue;
    const dx = n.x - pivot.x, dy = n.y - pivot.y;
    n.x = pivot.x + dx * cosA - dy * sinA;
    n.y = pivot.y + dx * sinA + dy * cosA;
  }
  markDirty();
}

/* ================================================================
   TOOLBAR / STATUS
   ================================================================ */

const TOOL_HINTS = {
  pan: "",
  select: "",
  addNode: "",
  delNode: "",
  addRoadLine: "",
  addRoadSpline: "",
  addRoadCircle: "",
  delWay: "",
  addSignal: "",
  addUturn: "",
  addAnglePoint: "",
  addCurvePoint: "",
  addBuilding: "Add Building: click to place polygon points, double-click / Enter to close the shape (needs at least 3 points), Esc to cancel.",
  addAmenity: "Add Amenity: click to place a point amenity, then set its type/icon/fleet in the inspector.",
  delBuilding: "Delete Building: click a building to remove it.",
  delAmenity: "Delete Amenity: click an amenity to remove it.",
};

function setTool(tool) {
  if (State.drawingWay) cancelRoadDrawing();
  if (State.drawingBuilding) cancelBuildingDrawing();
  State.tool = tool;
  State.drag = null;
  document.querySelectorAll(".tool-btn").forEach(b => b.classList.toggle("active", b.dataset.tool === tool));
  canvas.className = "tool-" + tool;
  $("#hint").textContent = TOOL_HINTS[tool] || "";
  const activeBtn = $(`.tool-btn[data-tool="${tool}"]`);
  $("#statTool").textContent = "Tool: " + (activeBtn ? activeBtn.textContent.trim() : tool);
  if (tool === "addRoadLine") startRoadDrawing("line");
  else if (tool === "addRoadSpline") startRoadDrawing("spline");
  else if (tool === "addBuilding") startBuildingDrawing();
  renderInspector();
  markDirty();
}

let isPanning = false;
let panLast = null;

canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const world = screenToWorld(sx, sy);

  if (State.tool === "pan" || e.button === 1 || e.button === 2) {
    isPanning = true;
    panLast = { sx, sy };
    canvas.classList.add("dragging");
    return;
  }

  if (State.tool === "select") {
    // rotate handle has priority when exactly one way is selected
    const primary = primarySelection();
    if (State.selected.length === 1 && primary.type === "way") {
      const way = State.ways.get(primary.id);
      const h = way && wayRotateHandleWorld(way);
      if (h) {
        const hsp = worldToScreen(h.x, h.y);
        if (Math.hypot(hsp.x - sx, hsp.y - sy) < 10) {
          pushUndo();
          const startAngle = Math.atan2(world.y - h.pivot.y, world.x - h.pivot.x);
          State.drag = { type: "rotate", wayId: way.id, pivot: { ...h.pivot }, lastAngle: startAngle };
          canvas.classList.add("dragging");
          return;
        }
      }
    }

    // Same priority, for a joined intersection group's own rotate handle
    // when exactly one (grouped) node is selected - see
    // clusterRotateHandleWorld/rotateClusterMembers.
    if (State.selected.length === 1 && primary.type === "node") {
      const pn = State.nodes.get(primary.id);
      const groupId = pn && pn.tags && pn.tags.join_group;
      const members = groupId ? State.joinGroupIndex.get(groupId) : null;
      const h = members && members.length > 1 ? clusterRotateHandleWorld(members) : null;
      if (h) {
        const hsp = worldToScreen(h.x, h.y);
        if (Math.hypot(hsp.x - sx, hsp.y - sy) < 10) {
          pushUndo();
          const startAngle = Math.atan2(world.y - h.pivot.y, world.x - h.pivot.x);
          State.drag = { type: "clusterRotate", members: members.slice(), pivot: { ...h.pivot }, lastAngle: startAngle };
          canvas.classList.add("dragging");
          return;
        }
      }
    }

    // A real node's own point and a joined group's centroid marker are two
    // DIFFERENT, both-legitimate things to grab near a junction - whichever
    // is actually closer to the click wins, rather than the marker always
    // taking priority regardless of distance (which used to make a group's
    // real member nodes - and any road ending at one - impossible to grab
    // at all whenever the marker's own centroid sat outside the click
    // tolerance, see the select tool's own TOOL_HINTS entry).
    const nodeHit = findNodeAtWithDist(world, 9);
    const markerHit = findClusterMarkerAt(world, 9);
    let nid = null, hitCluster = false;
    if (nodeHit && (!markerHit || nodeHit.d <= markerHit.d)) nid = nodeHit.id;
    else if (markerHit) { nid = markerHit.id; hitCluster = true; }
    if (nid && !isItemSelectable("node", nid)) { nid = null; hitCluster = false; }
    // Priority: node > amenity (a point feature, same tier as a node) > way >
    // building (an area fill - lowest priority so it never steals a click
    // meant for a point/road inside/near its own footprint).
    let aid = !nid ? findAmenityAt(world, 9) : null;
    if (aid && !isItemSelectable("amenity", aid)) aid = null;
    let wid = (!nid && !aid) ? findWayAt(world, 7) : null;
    if (wid && !isItemSelectable("way", wid)) wid = null;
    let bid = (!nid && !aid && !wid) ? findBuildingAt(world) : null;
    if (bid && !isItemSelectable("building", bid)) bid = null;
    const hitType = nid ? "node" : (aid ? "amenity" : (wid ? "way" : (bid ? "building" : null)));
    const hitId = nid || aid || wid || bid;

    if (hitType) {
      if (e.shiftKey) {
        toggleInSelection(hitType, hitId);
        return;
      }
      const partOfGroup = State.selected.length > 1 && isSelected(hitType, hitId);
      if (!partOfGroup) setSelection([{ type: hitType, id: hitId }]);
      pushUndo();
      if (State.selected.length > 1) {
        State.drag = { type: "group", last: world };
        canvas.classList.add("dragging");
      } else if (hitType === "node" && hitCluster) {
        // Grabbed a joined group's own drawn marker (its centroid, not any
        // one member's real position - see render()) rather than a specific
        // member node: move the WHOLE junction as a unit by translating
        // every real member together, preserving the group's shape. To
        // reshape/move just one member's own approach instead, grab that
        // node directly - see the nodeHit/markerHit distance comparison
        // above and the plain "node" branch below.
        const n = State.nodes.get(hitId);
        const groupId = n && n.tags && n.tags.join_group;
        const members = groupId ? State.joinGroupIndex.get(groupId) : null;
        if (members && members.length > 1) {
          State.drag = { type: "clusterMove", members: members.slice(), last: world };
          canvas.classList.add("dragging");
        } else {
          State.undoStack.pop();
        }
      } else if (hitType === "node") {
        const n = State.nodes.get(hitId);
        State.drag = { type: "node", nodeId: hitId, from: { x: n.x, y: n.y } };
        canvas.classList.add("dragging");
      } else if (hitType === "amenity" || hitType === "building") {
        // Buildings/amenities only ever move as a whole - no reshape-by-drag
        // concept like a road has - so a single one reuses the same "group"
        // translate mechanics a multi-select drag already uses (see
        // translateSelected's building/amenity branches above).
        State.drag = { type: "group", last: world };
        canvas.classList.add("dragging");
      } else if (State.roadMoveMode) {
        // "Move whole road" armed from the inspector (see renderInspector's
        // way branch) - drag this road's body to translate every one of its
        // points as a rigid whole instead of reshaping it. Reuses the exact
        // same mechanics as a multi-item "group" move (translateSelected),
        // which already moves every distinct node of a selected way by the
        // drag delta - a shared endpoint moves right along with the road
        // (and the intersection it's part of stays connected - see
        // translateSelected/State.roadMoveMode's own comments), everything
        // else the road isn't touching stays exactly where it was.
        State.drag = { type: "group", last: world };
        canvas.classList.add("dragging");
      } else {
        // Dragging a road's body RESHAPES it, rather than moving the whole
        // road: a plain reshape point (see insertShapingNodeOnWay - reused
        // here with no vertex_type tag, so it just follows the way's own
        // curve setting rather than forcing a sharp/smooth override) is
        // materialized right where the drag started, but only once the drag
        // has actually moved (see the "wayBend" mousemove/mouseup handling
        // below) - a plain click-to-select on a road must never leave a
        // stray point behind. The road's real endpoints, and whatever
        // intersections they're joined to, never move or detach. To reshape
        // a point that's already there, grab it directly - that hits the
        // node branch above, not this one, and drags it in place instead of
        // adding a new one. A whole shared junction (and every road on it)
        // still only ever moves together via a plain node-drag on the
        // junction's own point.
        State.drag = { type: "wayBend", wayId: hitId, startWorld: world, nodeId: null };
        canvas.classList.add("dragging");
      }
      return;
    }

    // empty space: start a rubber-band selection rectangle
    if (!e.shiftKey) clearSelection();
    State.drag = { type: "rubberband", startScreen: { x: sx, y: sy }, curScreen: { x: sx, y: sy }, additive: e.shiftKey };
    return;
  }

  if (State.tool === "addNode") {
    pushUndo();
    const id = addNodeAt(world);
    selectNode(id);
    toast("Intersection added");
    scheduleAutosave();
    return;
  }

  if (State.tool === "addSignal") {
    const nid = findJunctionMarkerAt(world, 12);
    if (nid) {
      pushUndo();
      addRedlight(nid);
      setTool("select");
      selectNode(nid);
      toast("Traffic light added");
      scheduleAutosave();
      return;
    }

    const wid = findWayAt(world, 7);
    if (wid) {
      pushUndo();
      const newNodeId = addDirectionalRedlightOnWay(wid, world);
      if (!newNodeId) {
        State.undoStack.pop(); // nothing changed - drop the empty snapshot
        toast("Can't place a light that close to the road's end - try further along it");
        return;
      }
      setTool("select");
      selectNode(newNodeId);
      toast("Traffic light added (one direction of this road only)");
      scheduleAutosave();
      return;
    }

    toast("Click an intersection or a road to add a traffic light");
    return;
  }

  if (State.tool === "addUturn") {
    const nid = findNodeAt(world, 12);
    if (nid) {
      const deg = nodeDegree(nid);
      if (deg !== 2) {
        toast(`U-turn needs exactly 2 connected roads (this one has ${deg})`);
        return;
      }
      pushUndo();
      setUturn(nid, true);
      setTool("select");
      selectNode(nid);
      toast("U-turn point added");
      scheduleAutosave();
      return;
    }

    const wid = findWayAt(world, 7);
    if (wid) {
      pushUndo();
      const split = splitWayAt(wid, world);
      if (!split) {
        State.undoStack.pop(); // nothing changed - drop the empty snapshot
        toast("Can't split that close to the road's end - try further along it");
        return;
      }
      setUturn(split.nodeId, true);
      setTool("select");
      selectNode(split.nodeId);
      toast("U-turn point added");
      scheduleAutosave();
      return;
    }

    toast("Click a road, or an intersection with exactly 2 connected roads");
    return;
  }

  if (State.tool === "addAnglePoint" || State.tool === "addCurvePoint") {
    const vertexType = State.tool === "addAnglePoint" ? "angle" : "curve";
    const wid = findWayAt(world, 7);
    if (wid) {
      pushUndo();
      const newNodeId = insertShapingNodeOnWay(wid, world, vertexType);
      if (!newNodeId) {
        State.undoStack.pop(); // nothing changed - drop the empty snapshot
        toast("Can't place a point that close to the road's end - try further along it");
        return;
      }
      setTool("select");
      selectNode(newNodeId);
      toast(vertexType === "angle" ? "Angle point added" : "Curve point added");
      scheduleAutosave();
      return;
    }

    toast("Click a road to add a shape point");
    return;
  }

  if (State.tool === "addRoadCircle") {
    State.drag = { type: "drawCircle", center: world, radius: 0 };
    canvas.classList.add("dragging");
    return;
  }

  // Routing hook - delegates entirely to window.RouteTest (routetest.js) so
  // this file stays a no-op if that script is ever removed. Tries an
  // existing node first (snap to a real intersection, exactly like every
  // other node-targeting tool) - but ONLY if it's actually a way endpoint
  // (a real crossing point or dead end), not a purely interior shape vertex:
  // clicking exactly on one of those is physically no different from
  // clicking just beside it, so it must go through the same mid-road/side-
  // of-road resolution as any other point, or a divided road's direction
  // restriction (see ch_preprocess.cpp's #fwd/#bwd split) could be
  // bypassed just by clicking precisely on one of its shape points.
  if (State.tool === "routeStart" || State.tool === "routeEnd") {
    if (!window.RouteTest) return;
    const nid = findJunctionMarkerAt(world, 12) || findNodeAt(world, 12);
    if (nid && window.RouteTest.isWayEndpointNode(nid)) {
      const node = State.nodes.get(nid);
      window.RouteTest.markPoint(State.tool, { x: node.x, y: node.y, spec: { kind: "node", id: nid } });
      return;
    }
    const way = (nid && window.RouteTest.wayContainingInteriorNode(nid))
      || (() => { const wid = findWayAt(world, 7); return wid ? State.ways.get(wid) : null; })();
    if (way) {
      const vp = window.RouteTest.resolveVirtualPoint(way, nid ? State.nodes.get(nid) : world);
      if (vp) {
        window.RouteTest.markPoint(State.tool, {
          x: vp.x, y: vp.y,
          spec: { kind: "virtual", nodeA: vp.nodeA, nodeB: vp.nodeB, distToA: vp.distToA, distToB: vp.distToB, directions: vp.directions },
        });
        return;
      }
    }
    toast("Click an intersection or a road to set the route point");
    return;
  }

  if (State.tool === "delNode") {
    const nid = findJunctionMarkerAt(world, 9);
    if (nid) deleteNode(nid);
    return;
  }

  if (State.tool === "delWay") {
    const wid = findWayAt(world, 7);
    if (wid) deleteWay(wid);
    return;
  }

  if (State.tool === "delBuilding") {
    const bid = findBuildingAt(world);
    if (bid) deleteBuilding(bid);
    else toast("Click a building to delete it");
    return;
  }

  if (State.tool === "delAmenity") {
    const aid = findAmenityAt(world, 9);
    if (aid) deleteAmenity(aid);
    else toast("Click an amenity to delete it");
    return;
  }

  if (State.tool === "addRoadLine" || State.tool === "addRoadSpline") {
    addRoadVertex(world);
    return;
  }

  if (State.tool === "addBuilding") {
    addBuildingVertex(world);
    return;
  }

  if (State.tool === "addAmenity") {
    addAmenityAt(world);
    toast("Amenity added — set its type in the inspector");
    return;
  }
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
    return;
  }

  if (State.drag) {
    if (State.drag.type === "node") {
      moveNodeTo(State.drag.nodeId, world);
    } else if (State.drag.type === "wayBend") {
      if (State.drag.nodeId == null) {
        const moved = Math.hypot(world.x - State.drag.startWorld.x, world.y - State.drag.startWorld.y) > 3 / State.view.scale;
        if (!moved) return;
        const bendId = insertShapingNodeOnWay(State.drag.wayId, State.drag.startWorld, null);
        if (!bendId) { State.drag = null; canvas.classList.remove("dragging"); return; } // too close to the road's own end
        State.drag.nodeId = bendId;
        setSelection([{ type: "node", id: bendId }]);
      }
      moveNodeTo(State.drag.nodeId, world);
    } else if (State.drag.type === "rotate") {
      const way = State.ways.get(State.drag.wayId);
      if (way) {
        const angle = Math.atan2(world.y - State.drag.pivot.y, world.x - State.drag.pivot.x);
        const delta = angle - State.drag.lastAngle;
        rotateWay(way, State.drag.pivot, delta);
        State.drag.lastAngle = angle;
      }
    } else if (State.drag.type === "group") {
      const dx = world.x - State.drag.last.x, dy = world.y - State.drag.last.y;
      translateSelected(dx, dy);
      State.drag.last = world;
    } else if (State.drag.type === "clusterMove") {
      const dx = world.x - State.drag.last.x, dy = world.y - State.drag.last.y;
      for (const mid of State.drag.members) {
        const mn = State.nodes.get(mid);
        if (mn) { mn.x += dx; mn.y += dy; }
      }
      State.drag.last = world;
      markDirty();
    } else if (State.drag.type === "clusterRotate") {
      const angle = Math.atan2(world.y - State.drag.pivot.y, world.x - State.drag.pivot.x);
      const delta = angle - State.drag.lastAngle;
      rotateClusterMembers(State.drag.members, State.drag.pivot, delta);
      State.drag.lastAngle = angle;
    } else if (State.drag.type === "drawCircle") {
      State.drag.radius = Math.hypot(world.x - State.drag.center.x, world.y - State.drag.center.y);
      markDirty();
    } else if (State.drag.type === "rubberband") {
      State.drag.curScreen = { x: sx, y: sy };
      markDirty();
    }
    return;
  }

  if (State.drawingWay || State.drawingBuilding) {
    State.ghostPoint = world;
    markDirty();
  }
});

const NODE_SNAP_TOLERANCE_PX = 14;

// After a plain node drag (moving a single, ungrouped intersection) ends,
// snap it onto whatever it landed close to: an existing node (merged into
// this one, joining their roads into a real shared intersection) if one is
// close enough, otherwise the nearest road it isn't already part of (spliced
// in at the projected point). This is what makes dragging an intersection
// onto a road actually connect the two, rather than just visually
// overlapping - see connectWays() for the equivalent explicit, pick-2-roads
// version used when dragging isn't the natural way to do it (e.g. joining a
// road you're not moving).
function trySnapDraggedNode(nodeId) {
  const node = State.nodes.get(nodeId);
  if (!node) return;
  const tolWorld = NODE_SNAP_TOLERANCE_PX / State.view.scale;

  let bestNode = null, bestNodeD = tolWorld;
  for (const [id, n] of State.nodes) {
    if (id === nodeId) continue;
    const d = Math.hypot(n.x - node.x, n.y - node.y);
    if (d < bestNodeD) { bestNodeD = d; bestNode = id; }
  }
  if (bestNode) {
    const otherNode = State.nodes.get(bestNode);
    // mergeNodes keeps the dragged (surviving) node's own signal untouched
    // when both sides already carry one - flag that here rather than
    // silently discarding whichever one lost, since a full phase plan just
    // vanished.
    const keptSignal = !!(node.signal && otherNode && otherNode.signal);
    mergeNodes(bestNode, nodeId);
    markDirty();
    toast(keptSignal ? "Snapped to intersection (kept existing traffic light)" : "Snapped to intersection");
    return;
  }

  const alreadyOn = State.nodeWayIndex.get(nodeId) || new Set();
  let bestWay = null, bestWayD = tolWorld, bestProj = null;
  for (const way of State.ways.values()) {
    if (alreadyOn.has(way.id)) continue;
    const pts = wayPoints(way);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const abx = b.x - a.x, aby = b.y - a.y;
      const lenSq = abx * abx + aby * aby;
      let t = lenSq > 1e-9 ? ((node.x - a.x) * abx + (node.y - a.y) * aby) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = a.x + abx * t, cy = a.y + aby * t;
      const d = Math.hypot(node.x - cx, node.y - cy);
      if (d < bestWayD) { bestWayD = d; bestWay = way.id; bestProj = { x: cx, y: cy }; }
    }
  }
  if (bestWay && bestProj) {
    node.x = bestProj.x; node.y = bestProj.y;
    const res = insertExistingNodeIntoWay(bestWay, nodeId);
    if (res && res.beforeWayId) {
      markDirty();
      toast("Snapped to road");
    } else if (res && res.endpointId) {
      if (res.endpointId !== nodeId) mergeNodes(res.endpointId, nodeId);
      markDirty();
      toast("Snapped to road");
    }
    // else: hard failure (e.g. this node is already on that way somehow) -
    // the node still moved onto the road's line above, just not joined to it.
  }
}

window.addEventListener("mouseup", () => {
  if (isPanning) { isPanning = false; panLast = null; canvas.classList.remove("dragging"); }
  if (State.drag) {
    if (State.drag.type === "rubberband") {
      finalizeRubberBand(State.drag);
    } else if (State.drag.type === "node") {
      const n = State.nodes.get(State.drag.nodeId);
      const from = State.drag.from;
      // Only snap if this drag actually moved the node - otherwise a plain
      // click-to-select on a node that merely happens to sit near another
      // one would unexpectedly merge them.
      if (n && from && Math.hypot(n.x - from.x, n.y - from.y) > 1e-6) {
        trySnapDraggedNode(State.drag.nodeId);
      }
    } else if (State.drag.type === "wayBend") {
      if (State.drag.nodeId != null) {
        trySnapDraggedNode(State.drag.nodeId);
      } else {
        State.undoStack.pop(); // never moved past the threshold - nothing was created, drop the empty snapshot
      }
    } else if (State.drag.type === "drawCircle") {
      if (State.drag.radius >= CIRCLE_MIN_RADIUS_M) {
        pushUndo();
        const wid = createCircularRoad(State.drag.center, State.drag.radius);
        setTool("select");
        selectWay(wid);
        toast("Circular road created — set its type and radius in the inspector");
        scheduleAutosave();
      } else {
        toast("Drag further out to set a radius");
      }
    }
    State.drag = null;
    canvas.classList.remove("dragging");
    scheduleAutosave();
  }
});

function translateSelected(dx, dy) {
  const touched = new Set();
  for (const s of State.selected) {
    if (s.type === "way") {
      const way = State.ways.get(s.id);
      if (!way) continue;
      for (const nid of way.nodes) {
        if (touched.has(nid)) continue;
        touched.add(nid);
        const n = State.nodes.get(nid);
        if (n) { n.x += dx; n.y += dy; }
      }
    } else if (s.type === "node") {
      if (touched.has(s.id)) continue;
      touched.add(s.id);
      const n = State.nodes.get(s.id);
      if (n) { n.x += dx; n.y += dy; }
    } else if (s.type === "building") {
      // "b:"/"a:" prefixes (rather than the bare id, like the node/way
      // branches above) since a building's move can also move its linked
      // amenity below and vice versa - without the prefix, a building id and
      // an unrelated amenity id could otherwise collide in the same Set.
      if (touched.has("b:" + s.id)) continue;
      touched.add("b:" + s.id);
      const b = State.buildings.get(s.id);
      if (b) {
        for (const p of b.polygon) { p.x += dx; p.y += dy; }
        for (const a of State.amenities.values()) {
          if (a.buildingId === s.id && !touched.has("a:" + a.id)) {
            touched.add("a:" + a.id);
            a.x += dx; a.y += dy;
          }
        }
      }
    } else if (s.type === "amenity") {
      if (touched.has("a:" + s.id)) continue;
      touched.add("a:" + s.id);
      const a = State.amenities.get(s.id);
      if (a) {
        a.x += dx; a.y += dy;
        if (a.buildingId && !touched.has("b:" + a.buildingId)) {
          touched.add("b:" + a.buildingId);
          const b = State.buildings.get(a.buildingId);
          if (b) for (const p of b.polygon) { p.x += dx; p.y += dy; }
        }
      }
    }
  }
  markDirty();
}

function finalizeRubberBand(drag) {
  const screenW = Math.abs(drag.curScreen.x - drag.startScreen.x);
  const screenH = Math.abs(drag.curScreen.y - drag.startScreen.y);
  if (screenW < 4 && screenH < 4) return; // treat as a plain click, not a drag

  // map the screen rectangle's corners into world space (handles rotation)
  // and use their bounding box - a superset of the exact rotated rectangle,
  // which is a fine approximation for a lasso-select convenience feature.
  const corners = [
    screenToWorld(drag.startScreen.x, drag.startScreen.y),
    screenToWorld(drag.curScreen.x, drag.startScreen.y),
    screenToWorld(drag.curScreen.x, drag.curScreen.y),
    screenToWorld(drag.startScreen.x, drag.curScreen.y),
  ];
  const minX = Math.min(...corners.map(c => c.x)), maxX = Math.max(...corners.map(c => c.x));
  const minY = Math.min(...corners.map(c => c.y)), maxY = Math.max(...corners.map(c => c.y));

  const hits = [];
  for (const [id, n] of State.nodes) {
    if (n.x >= minX && n.x <= maxX && n.y >= minY && n.y <= maxY) {
      if (isItemSelectable("node", id)) hits.push({ type: "node", id });
    }
  }
  for (const way of State.ways.values()) {
    const pts = wayEvaluationPoints(way);
    if (pts.some(p => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY)) {
      if (isItemSelectable("way", way.id)) hits.push({ type: "way", id: way.id });
    }
  }
  for (const b of State.buildings.values()) {
    if (b.polygon.some(p => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY)) {
      if (isItemSelectable("building", b.id)) hits.push({ type: "building", id: b.id });
    }
  }
  for (const a of State.amenities.values()) {
    if (a.x >= minX && a.x <= maxX && a.y >= minY && a.y <= maxY) {
      if (isItemSelectable("amenity", a.id)) hits.push({ type: "amenity", id: a.id });
    }
  }

  if (drag.additive) {
    const next = State.selected.slice();
    for (const h of hits) if (!next.some(s => s.type === h.type && s.id === h.id)) next.push(h);
    setSelection(next);
  } else {
    setSelection(hits);
  }
}

canvas.addEventListener("dblclick", (e) => {
  if (State.drawingWay) { e.preventDefault(); finishRoadDrawing(); }
  else if (State.drawingBuilding) { e.preventDefault(); finishBuildingDrawing(); }
});

window.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

  if (e.key === "Enter" && State.drawingWay) { finishRoadDrawing(); return; }
  if (e.key === "Enter" && State.drawingBuilding) { finishBuildingDrawing(); return; }
  if (e.key === "Escape") {
    if (State.drawingWay) { cancelRoadDrawing(); setTool("select"); }
    else if (State.drawingBuilding) { cancelBuildingDrawing(); setTool("select"); }
    else clearSelection();
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    deleteSelected();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (e.key === "+" || e.key === "=") { zoomAt(cssW() / 2, cssH() / 2, 1.2); return; }
  if (e.key === "-" || e.key === "_") { zoomAt(cssW() / 2, cssH() / 2, 1 / 1.2); return; }
});

document.querySelectorAll(".tool-btn").forEach(btn => {
  if (!btn.dataset.tool) return; // e.g. the "Add ▾" dropdown trigger, which only opens/closes its menu
  btn.addEventListener("click", () => { setTool(btn.dataset.tool); $("#addMenu").hidden = true; });
});
$("#undoBtn").addEventListener("click", undo);
$("#redoBtn").addEventListener("click", redo);
$("#cleanBtn").addEventListener("click", cleanupOrphanNodes);
$("#addMenuBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#addMenu").hidden = !$("#addMenu").hidden;
});
document.addEventListener("click", (e) => {
  const dropdown = $("#addDropdown");
  if (!dropdown.contains(e.target)) $("#addMenu").hidden = true;
});

$("#saveBtn").addEventListener("click", async () => {
  const btn = $("#saveBtn");
  const data = serializeState();
  btn.disabled = true;
  try {
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    toast(`Saved to ${DATA_URL}`);
  } catch (err) {
    alert(`Could not save to ${DATA_URL} (is serve.py the one hosting this page?): ` + err.message);
  } finally {
    btn.disabled = false;
  }
});

$("#loadBtn").addEventListener("click", () => $("#fileInput").click());
$("#fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.nodes || !data.ways) throw new Error("Not a recognised map file");
    loadData(data);
    toast(`Loaded ${file.name}`);
  } catch (err) {
    alert("Could not load that file: " + err.message);
  } finally {
    e.target.value = "";
  }
});

$("#resetBtn").addEventListener("click", async () => {
  if (!confirm(`Reload ${DATA_URL} from disk? Unsaved edits will be lost (autosave will be cleared). If you've used Save, this reloads your last saved version, not the original OSM conversion.`)) return;
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
    await loadFromUrl(DATA_URL);
    toast(`Reloaded ${DATA_URL}`);
  } catch (err) {
    alert(`Could not reload ${DATA_URL}: ` + err.message);
  }
});

$("#recalcChBtn").addEventListener("click", async () => {
  const btn = $("#recalcChBtn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "🛣 Recalculating…";
  try {
    const res = await fetch("/api/recalc-ch", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
    const meta = body.meta || {};
    const status = meta.verification && meta.verification.status;
    const nodeCount = meta.nodeCount, shortcutCount = meta.shortcutCount;
    const totalMs = meta.buildTimeMs && meta.buildTimeMs.total;
    toast(`CH recalculated${status ? ` (${status})` : ""}` +
      (nodeCount != null ? ` - ${nodeCount} nodes, ${shortcutCount} shortcuts` : "") +
      (totalMs != null ? ` in ${Math.round(totalMs)}ms` : ""));
  } catch (err) {
    alert("Could not recalculate the CH (is serve.py the one hosting this page?): " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

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
  setTool("pan");

  let autosaved = null;
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) autosaved = JSON.parse(raw);
  } catch (e) { autosaved = null; }

  try {
    await loadFromUrl(DATA_URL);
  } catch (err) {
    toast("Could not load map_data.json — run osm_to_json.py first, and serve this folder over http(s)://");
    console.error(err);
  }

  if (autosaved && autosaved.meta && autosaved.meta.savedAt) {
    $("#restoreBanner").hidden = false;
    $("#restoreText").textContent = `Autosaved changes from ${new Date(autosaved.meta.savedAt).toLocaleString()} were found.`;
    $("#restoreYes").onclick = () => {
      loadData(autosaved);
      $("#restoreBanner").hidden = true;
      toast("Restored autosaved session");
    };
    $("#restoreNo").onclick = () => {
      localStorage.removeItem(AUTOSAVE_KEY);
      $("#restoreBanner").hidden = true;
    };
  }

  requestAnimationFrame(loop);
}

boot();
