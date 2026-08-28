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
  iconSizeMultiplier: 1,
  inspectorWidth: 340,
  settingsPanelWidth: 340,
  simSpeedMultiplier: 1,   // 1x-24x fast-forward, see redlight.js's Sim.speedMultiplier
  simDurationHours: 0,     // 0 = unlimited; otherwise auto-pause once the sim clock reaches this
};

const Config = { ...CONFIG_DEFAULTS };

function loadConfig() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(Config, CONFIG_DEFAULTS, JSON.parse(raw));
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

    el("div", { class: "section-title" }, "Traffic lights"),
    rangeSetting("Signal lamp size", "signalLampSizeMultiplier", 0.5, 3, 0.1, v => v.toFixed(1) + "x"),
    boolSetting("Fixed lamp size (ignore current zoom)", "signalLampFixedSize",
      "When on, every lamp renders at the size/offset it would have at the Intersection marker zoom threshold above, no matter how zoomed in you actually are - so lamps stay a consistent size while you're placing them. Turn off to have lamp size scale with your live zoom instead."),

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
