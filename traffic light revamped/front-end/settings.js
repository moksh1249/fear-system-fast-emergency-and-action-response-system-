"use strict";

/* ============================================================
   Editor-wide configuration (defaults for new roads, zoom
   behaviour, etc.) - persisted separately from the map data
   itself, since these are user/editor preferences, not part
   of a particular map file.
   ============================================================ */

const SETTINGS_KEY = "trafficMapEditor.settings.v1";

const CONFIG_DEFAULTS = {
  defaultMaxSpeed: 60,
  defaultAvgMinSpeed: 20,
  defaultAvgMaxSpeed: 60,
  defaultLanes: 1,
  defaultLaneWidth: 3.2,
  zoomSensitivity: 1.0,
  intersectionZoomThreshold: 0.75,
  showDirectionArrows: true,
  showSignalTimers: true,
  showBuildings: true,
  showAmenities: true,
  signalLampSizeMultiplier: 1,
  signalLampFixedSize: false,
  buildingZoomThreshold: 0.15,
  amenityZoomThreshold: 0.35,
  // Road-level zoom (map-core.js roadLodVisible): zoomed out, only the roads
  // that matter at that scale are drawn - motorway/trunk/primary always,
  // secondary and tertiary below their own fixed scales, and every smaller
  // road only from minorRoadZoomThreshold up.
  roadLevelZoom: true,
  minorRoadZoomThreshold: 0.2,
  // Area classification layers (areas.js). The two layers toggle
  // independently, and jurisdictionLevels gates the 5 hierarchy levels
  // within the first one - a per-level map rather than a single flag, so a
  // city/district view can be left on while the country border is hidden.
  showJurisdictions: true,
  showZones: true,
  showAreaLabels: true,
  jurisdictionLevels: { country: true, state: true, city: true, district: true, locality: true },
  iconSizeMultiplier: 1,
  inspectorWidth: 340,
  settingsPanelWidth: 340,
  simSpeedMultiplier: 1,   // 1x-24x fast-forward, see redlight.js's Sim.speedMultiplier
  simDurationHours: 0,     // 0 = unlimited; otherwise auto-pause once the sim clock reaches this
};

// Every spread/assign of CONFIG_DEFAULTS below is SHALLOW, so any nested
// object in it (jurisdictionLevels) would otherwise be shared by reference
// with Config - and unticking a level in the UI would quietly rewrite the
// defaults themselves. freshDefaults() hands out its own copy of the nested
// parts instead, so the defaults stay the defaults.
function freshDefaults() {
  return { ...CONFIG_DEFAULTS, jurisdictionLevels: { ...CONFIG_DEFAULTS.jurisdictionLevels } };
}

const Config = freshDefaults();

function loadConfig() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    Object.assign(Config, freshDefaults(), saved);
    // A settings blob saved before this key existed (or a partial one) must
    // still end up with every level present, rather than an object missing
    // the levels the panel expects to render a row for.
    Config.jurisdictionLevels = {
      ...CONFIG_DEFAULTS.jurisdictionLevels,
      ...(saved.jurisdictionLevels || {}),
    };
  } catch (e) { /* ignore corrupt settings */ }
}

function saveConfig() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(Config));
  } catch (e) { /* storage full/unavailable - ignore */ }
}

/* ---------------- Settings panel UI ---------------- */

function numberSetting(labelText, key, opts = {}) {
  const input = el("input", {
    type: "number",
    value: Config[key],
    step: opts.step != null ? opts.step : "1",
    min: opts.min != null ? opts.min : null,
  });
  input.addEventListener("change", () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) { input.value = Config[key]; return; }
    Config[key] = v;
    saveConfig();
    markDirty();
  });
  return el("div", { class: "field" }, el("label", {}, labelText), input);
}

function boolSetting(labelText, key, title) {
  const input = el("input", { type: "checkbox" });
  input.checked = !!Config[key];
  input.addEventListener("change", () => {
    Config[key] = input.checked;
    saveConfig();
    // The Areas sidebar panel mirrors some of these same flags as its own
    // checkboxes - re-render it so the two never disagree about what is on.
    if (typeof renderAreasPanel === "function") renderAreasPanel();
    markDirty();
  });
  const row = el("div", { class: "checkrow" }, input, el("label", {}, labelText));
  if (title) row.title = title;
  return row;
}

function rangeSetting(labelText, key, min, max, step, formatFn) {
  const readout = el("span", { class: "range-readout" }, formatFn ? formatFn(Config[key]) : String(Config[key]));
  const input = el("input", { type: "range", min: String(min), max: String(max), step: String(step), value: Config[key] });
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    Config[key] = v;
    readout.textContent = formatFn ? formatFn(v) : String(v);
    markDirty();
  });
  input.addEventListener("change", () => saveConfig());
  return el("div", { class: "field" }, el("label", {}, labelText), el("div", { class: "range-row" }, input, readout));
}

function renderSettingsPanel() {
  const panel = $("#settingsPanel");
  const body = $("#settingsBody");
  body.innerHTML = "";

  body.append(
    el("div", { class: "section-title" }, "Road speed defaults (km/h)"),
    numberSetting("Maximum speed", "defaultMaxSpeed", { min: 0 }),
    numberSetting("Average minimum speed", "defaultAvgMinSpeed", { min: 0 }),
    numberSetting("Average maximum speed", "defaultAvgMaxSpeed", { min: 0 }),

    el("div", { class: "section-title" }, "Lane defaults"),
    numberSetting("Lanes for new 2-way roads", "defaultLanes", { min: 1 }),
    numberSetting("Lane width (m)", "defaultLaneWidth", { min: 0.5, step: "0.1" }),

    el("div", { class: "section-title" }, "View"),
    rangeSetting("Zoom / touchpad sensitivity", "zoomSensitivity", 0.3, 3, 0.1, v => v.toFixed(1) + "x"),
    rangeSetting("Intersection marker zoom threshold", "intersectionZoomThreshold", 0.25, 2, 0.05, v => Math.round(v * 100) + "%"),
    boolSetting("Road-level zoom (hide smaller roads when zoomed out)", "roadLevelZoom",
      "Zoomed out, residential and service streets are left off the map (and can't be clicked), then tertiary and secondary roads too as you zoom further out. Major roads always stay."),
    rangeSetting("Smaller roads appear from zoom", "minorRoadZoomThreshold", 0.02, 0.75, 0.01, v => Math.round(v * 100) + "%"),

    el("div", { class: "section-title" }, "Traffic lights"),
    rangeSetting("Signal lamp size", "signalLampSizeMultiplier", 0.5, 3, 0.1, v => v.toFixed(1) + "x"),
    boolSetting("Fixed lamp size (ignore current zoom)", "signalLampFixedSize",
      "When on, every lamp renders at the size/offset it would have at the Intersection marker zoom threshold above, no matter how zoomed in you actually are - so lamps stay a consistent size while you're placing them. Turn off to have lamp size scale with your live zoom instead."),

    el("div", { class: "section-title" }, "Area classification"),
    boolSetting("Show jurisdictions (country → locality)", "showJurisdictions",
      "The administrative hierarchy layer. Which of its 5 levels are drawn is controlled per level in the sidebar's Areas panel."),
    boolSetting("Show land-use zones", "showZones",
      "The residential/commercial/industrial classification layer - independent of the jurisdiction hierarchy, and freely overlapping it."),
    boolSetting("Show area names on the map", "showAreaLabels",
      "Names are only painted over an area once its polygon is big enough on screen to carry one, so zooming out never turns the map into a pile of overlapping labels."),

    el("div", { class: "section-title" }, "Buildings & amenities"),
    rangeSetting("Building zoom threshold", "buildingZoomThreshold", 0.02, 1, 0.01, v => Math.round(v * 100) + "%"),
    rangeSetting("Amenity icon zoom threshold", "amenityZoomThreshold", 0.02, 1, 0.01, v => Math.round(v * 100) + "%"),
    rangeSetting("Amenity icon size", "iconSizeMultiplier", 0.5, 3, 0.1, v => v.toFixed(1) + "x"),
  );
}

function toggleSettingsPanel() {
  const panel = $("#settingsPanel");
  if (panel.hidden) renderSettingsPanel();
  panel.hidden = !panel.hidden;
}
