# Graph Report - F.E.A.R. System  (2026-11-21)

## Corpus Check
- 132 files · ~242,569 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 61 file(s) not represented in the graph (top: .xml 16, (none) 12, .log 5)
- WARNING: 61 of 212 files seen (29%) have no supported extractor and are missing from this graph entirely. It may look complete while representing only part of the codebase.

## Summary
- 3374 nodes · 6746 edges · 138 communities (103 shown, 35 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 140 edges (avg confidence: 0.85)
- Token cost: 109,244 input · 0 output

## Community Hubs (Navigation)
- Map Editor Core
- Area Data Layer
- package:flutter/material.dart
- Signal Group UI
- Live Sim Client
- RoadGraph
- Area Search UI
- Mobile Driver View
- ContractionHierarchy
- Dev Server Orchestration
- Map Data Loading
- live.py
- Vehicle State Fields
- Implementation Docs & Pages
- Signal Control Example
- os
- Connection
- sim_engine.cpp
- phones_api.py
- Canvas Rendering
- get
- Sim Relay WebSocket
- SignalController
- generate_vehicles.py
- JSON Parser
- redlights.hpp
- responder.dart
- road_graph.hpp
- map.dart
- Way Drawing & Hit-Test
- project_map.dart
- add_buildings.py
- math
- Junction Selection
- CH Binary Reader
- location.dart
- navigation.dart
- public_api.py
- fear-command.js
- signals.py
- driver_home.dart
- Settings Panel
- main.py
- StatelessWidget
- Lane Decorations
- Route Test Tool
- shorten_and_group_junctions
- places.py
- voice.dart
- map_tab.dart
- Sim Bridge
- profile_api.py
- command_state.dart
- login_screen.dart
- login.dart
- LiveHub
- Rotate Handles
- Tunnel
- osm_to_json.py
- Selection Filters
- Graphify Instructions
- netinfo.py
- gov_api.py
- incident_panel.dart
- sos.dart
- registry_page.dart
- tabs.dart
- widgets.dart
- public_state.dart
- live_map_page.dart
- PreemptStatus
- aiosqlite
- realtime.dart
- command_shell.dart
- session.dart
- dependencies
- api.dart
- fear_gov/pubspec.yaml
- fear_public/pubspec.yaml
- State
- theme.dart
- format.dart
- map_import.py
- home.dart
- triage.py
- manifest.json
- responder.py
- ChGraph
- ChainEdge
- FEAR apps
- FEAR demo credentials
- fear_core/README.md
- fear_gov/analysis_options.yaml
- fear_public/analysis_options.yaml
- phone_qr.dart
- fear_gov/MainActivity.kt
- fear_gov
- fear_public/MainActivity.kt
- fear_public
- CHANGELOG.md
- discovery_stub.dart
- JctCandidate
- simulation.js
- json.hpp
- EndpointSpec
- map-import.js
- ch_preprocess.cpp
- driver_profile.dart
- EmergencyReport
- String?
- EndpointRegistry
- Type
- vehicles.hpp
- providers.py
- LanDiscoveryResponder
- _ProjectMapPainter

## God Nodes (most connected - your core abstractions)
1. `get()` - 60 edges
2. `Vehicle` - 53 edges
3. `now_iso()` - 45 edges
4. `audit()` - 44 edges
5. `RoadGraph` - 43 edges
6. `main()` - 38 edges
7. `handleCommand()` - 34 edges
8. `renderInspector()` - 29 edges
9. `ChGraph` - 28 edges
10. `scheduleAutosave()` - 28 edges

## Surprising Connections (you probably didn't know these)
- `graphify Knowledge Graph Usage Rules` --conceptually_related_to--> `graphify skill trigger (/graphify)`  [INFERRED]
  CLAUDE.md → .claude/CLAUDE.md
- `boot()` --indirect_call--> `loop()`  [INFERRED]
  traffic light revamped/front-end/editor.js → traffic light revamped/front-end/map-core.js
- `buildRoadGraph()` --calls--> `parseSignal()`  [INFERRED]
  traffic light revamped/backend/sim/road_graph.hpp → traffic light revamped/backend/sim/redlights.hpp
- `main()` --calls--> `loadChGraph()`  [INFERRED]
  traffic light revamped/backend/ch/ch_query.cpp → traffic light revamped/backend/ch/ch_graph.hpp
- `main()` --calls--> `edgeKey()`  [INFERRED]
  traffic light revamped/backend/sim/sim_engine.cpp → traffic light revamped/backend/sim/vehicles.hpp

## Import Cycles
- 2-file cycle: `traffic light revamped/backend/fear_backend/ai_dispatch.py -> traffic light revamped/backend/fear_backend/incidents.py -> traffic light revamped/backend/fear_backend/ai_dispatch.py`
- 2-file cycle: `traffic light revamped/backend/fear_backend/incidents.py -> traffic light revamped/backend/fear_backend/triage.py -> traffic light revamped/backend/fear_backend/incidents.py`
- 3-file cycle: `traffic light revamped/backend/fear_backend/ai_dispatch.py -> traffic light revamped/backend/fear_backend/triage.py -> traffic light revamped/backend/fear_backend/incidents.py -> traffic light revamped/backend/fear_backend/ai_dispatch.py`

## Hyperedges (group relationships)
- **Area classification feature set** — traffic_light_revamped_implementation_status_jurisdiction_hierarchy, traffic_light_revamped_implementation_status_land_use_zones, traffic_light_revamped_implementation_status_fuzzy_place_search, traffic_light_revamped_implementation_status_lod_area_loading, traffic_light_revamped_implementation_status_policing_station_assignment [EXTRACTED 1.00]
- **Emergency vehicle signal preemption flow** — traffic_light_revamped_implementation_status_emergency_flag, traffic_light_revamped_implementation_status_emergency_preemption, traffic_light_revamped_implementation_status_redlightcontroller_reportemergency, traffic_light_revamped_implementation_status_density_mode, traffic_light_revamped_implementation_status_emergency_only_mode, traffic_light_revamped_implementation_status_junction_conflict_compatibility [EXTRACTED 1.00]
- **Incident create/dispatch/recall lifecycle** — traffic_light_revamped_implementation_status_incident_preset_ui, traffic_light_revamped_implementation_status_dispatch_incident_command, traffic_light_revamped_implementation_status_cancel_emergency_command, traffic_light_revamped_implementation_status_emergency_depots, traffic_light_revamped_front_end_simulation_incidents_section [INFERRED 0.85]

## Communities (138 total, 35 thin omitted)

### Community 0 - "Map Editor Core"
Cohesion: 0.06
Nodes (78): addAmenityAt(), addNodeAt(), addRoadVertex(), AMENITY_DEFAULT_VEHICLE_TYPE, AREA_TOOL_HINTS, AreaDrawChoice, boot(), cancelBuildingDrawing() (+70 more)

### Community 1 - "Area Data Layer"
Cohesion: 0.06
Nodes (63): areaBBox(), AreaCache, areaCentroid(), areaDisplayName(), areaEditable(), AreaFocus, AreaIndex, areaPushUndo() (+55 more)

### Community 2 - "package:flutter/material.dart"
Cohesion: 0.08
Nodes (18): build, CommandLogo, createState, FearCommandApp, _FearCommandAppState, initState, main, session (+10 more)

### Community 3 - "Signal Group UI"
Cohesion: 0.07
Nodes (58): addRedlight(), applyOverrideSnapshot(), approachableWaysSorted(), buildRedlightSegments(), connectedWaysSorted(), convertToPairedScheme(), convertToPhaseScheme(), createRedlightGroup() (+50 more)

### Community 4 - "Live Sim Client"
Cohesion: 0.08
Nodes (48): EMERGENCY_VEHICLE_TYPES, fmtSec(), INCIDENT_CATALOG, initLiveSimUI(), LIVE_SIM_DEPOT_ICON, LIVE_SIM_INFO_FIELDS, LIVE_SIM_STYLE, LIVE_SIM_TYPE_LABELS (+40 more)

### Community 5 - "RoadGraph"
Cohesion: 0.08
Nodes (24): OutEdgeRef, index, isJunction, RoadGraph, chainEdgeLiveSpeed, chainEdges, indexOf, junctionEdges (+16 more)

### Community 6 - "Area Search UI"
Cohesion: 0.09
Nodes (45): areaLayerVisible(), areaVisible(), boundedLevenshtein(), childAreasOf(), clearSearchHighlight(), closeSearchResults(), drawAreaLabels(), drawAreas() (+37 more)

### Community 7 - "Mobile Driver View"
Cohesion: 0.09
Nodes (47): FearMobile, initMobile(), Mobile, MOBILE_EMERGENCY_ICON, MOBILE_EMERGENCY_LABEL, MOBILE_NEAREST_KINDS, mobileBearing(), mobileBuildUI() (+39 more)

### Community 8 - "ContractionHierarchy"
Cohesion: 0.11
Nodes (13): ContractionHierarchy, active, CN_WEIGHT, contractedNeighbors, ED_WEIGHT, EvalResult, edgesRemoved, shortcutsAdded (+5 more)

### Community 9 - "Dev Server Orchestration"
Cohesion: 0.09
Nodes (18): _ch_log(), ensure_ch_binary(), ensure_ch_query_binary(), ensure_sim_engine_binary(), fear_backend_already_running(), _fear_log(), Handler, lan_ipv4() (+10 more)

### Community 10 - "Map Data Loading"
Cohesion: 0.06
Nodes (28): AMENITY_TYPES, backfillRoadDefaults(), BUILDING_STYLE_DEFAULT, BUILDING_TYPES, canvas, ctx, DEFAULT_AMENITY_ICONS, findBuildingAt() (+20 more)

### Community 11 - "live.py"
Cohesion: 0.08
Nodes (14): can_view_traffic(), _availability(), bearer(), create_session(), current_citizen(), current_gov_user(), subject_for_token(), suggestions() (+6 more)

### Community 12 - "Vehicle State Fields"
Cohesion: 0.04
Nodes (53): visionGapIsSafe(), edgeKey(), laneVisionCost(), Vehicle, accel, active, aMax, arrivalAtStopLineTime (+45 more)

### Community 13 - "Implementation Docs & Pages"
Cohesion: 0.08
Nodes (33): Editor Add tools menu (roads, signals, buildings, amenities), Editor Area Classification + Load By Area sections, Traffic Map Editor Page, Recalculate CH button, Traffic Map Landing Page, Emergency Control section (#incidentsSection), Live Vehicle Simulation controls (#liveSimSection), Phone map mode bootstrap (FEAR_MOBILE token) (+25 more)

### Community 14 - "Signal Control Example"
Cohesion: 0.23
Nodes (11): bodySaysOk(), describeStep(), extractField(), httpPost(), jsonEscape(), Lamp, movement, wayId (+3 more)

### Community 15 - "os"
Cohesion: 0.17
Nodes (8): import_status(), _require_super(), _run_job(), start_import(), main(), new_id(), now(), user()

### Community 16 - "Connection"
Cohesion: 0.10
Nodes (44): audit(), can_manage_alerts(), now_iso(), require_roles(), ensure_super_admin(), ActiveReq, assign(), AssignReq (+36 more)

### Community 17 - "sim_engine.cpp"
Cohesion: 0.08
Nodes (30): latLonToXY(), appendJsonString(), base64Encode(), buildRouteJson(), buildVehicleInfoJson(), Clock, dispatchVehicleToIncident(), elapsedMs() (+22 more)

### Community 18 - "phones_api.py"
Cohesion: 0.11
Nodes (23): can_enroll_phones(), can_manage_network(), org_subtree(), load_gov_user(), v2_servers(), server_urls(), _allowed_orgs(), create_phone_login() (+15 more)

### Community 19 - "Canvas Rendering"
Cohesion: 0.18
Nodes (22): clearJunctionCache(), cssH(), cssW(), drawAmenities(), drawBuildings(), drawCirclePreview(), drawGrid(), drawJunctionShapes() (+14 more)

### Community 20 - "get"
Cohesion: 0.08
Nodes (38): can_dispatch(), can_handle_incident(), visible_incident_kinds(), acknowledge(), ai_configure(), ai_status(), AiSettingsReq, _can_configure() (+30 more)

### Community 22 - "Sim Relay WebSocket"
Cohesion: 0.13
Nodes (3): _Client, _finite(), SimRelay

### Community 23 - "SignalController"
Cohesion: 0.18
Nodes (4): _main(), _parse_lamp_arg(), SignalControlError, SignalController

### Community 24 - "generate_vehicles.py"
Cohesion: 0.17
Nodes (17): apportion_counts(), build_directed_edges(), dist(), find_depots(), find_emergency_depot_groups(), generate(), isRoutableHighway(), kosaraju_scc() (+9 more)

### Community 25 - "JSON Parser"
Cohesion: 0.19
Nodes (9): JsonParser, i, n, JsonValue, arrVal, boolVal, numVal, objVal (+1 more)

### Community 26 - "redlights.hpp"
Cohesion: 0.07
Nodes (44): autoVehicleWeight(), AutoWeightBoard, total_, computeLampColor(), getGroupTurnInfo(), getPairedColor(), getPlainColor(), GroupTurnInfo (+36 more)

### Community 27 - "responder.dart"
Cohesion: 0.04
Nodes (50): _ampSub, api, _apply, askReportMode, at, build, _close, _closing (+42 more)

### Community 28 - "road_graph.hpp"
Cohesion: 0.06
Nodes (46): buildRoadGraph(), classifyMovement(), dist2d(), fallbackSpeedKmh(), highwayPriorityRank(), isRoutableHighway(), JctFlight, arrDirX (+38 more)

### Community 29 - "map.dart"
Cohesion: 0.04
Nodes (50): animate, _arrow, build, _c, category, child, children, color (+42 more)

### Community 30 - "Way Drawing & Hit-Test"
Cohesion: 0.15
Nodes (17): buildClusterLegs(), distPointToSegment(), drawWayBase(), findWayAt(), getJunctionData(), junctionClearance(), nodeDegree(), roadLodVisible() (+9 more)

### Community 31 - "project_map.dart"
Cohesion: 0.02
Nodes (89): amenities, _amenityIcons, _apply, areas, _available, baseJunctions, baseRoads, _baseUrl (+81 more)

### Community 32 - "add_buildings.py"
Cohesion: 0.21
Nodes (6): build_major_road_grid(), classify_building_type(), main(), nearest_major_road(), polygon_area_centroid(), retag_yes_buildings()

### Community 33 - "math"
Cohesion: 0.33
Nodes (4): bearing_deg(), _approaches(), path_length(), shorten_points()

### Community 34 - "Junction Selection"
Cohesion: 0.19
Nodes (14): buildJunctionRing(), clearSelection(), clusterCentroid(), computeJunctionData(), findClusterMarkerAt(), findJunctionMarkerAt(), isRingWellFormed(), junctionCluster() (+6 more)

### Community 35 - "CH Binary Reader"
Cohesion: 0.33
Nodes (5): BinReader, data, pos, chReadFile(), loadChGraph()

### Community 36 - "location.dart"
Cohesion: 0.05
Nodes (39): accuracyM, at, backgroundText, backgroundTitle, blocked, demo, _demoHeading, demoMode (+31 more)

### Community 37 - "navigation.dart"
Cohesion: 0.05
Nodes (37): active, after, alongM, arrived, build, color, _cum, dispose (+29 more)

### Community 38 - "public_api.py"
Cohesion: 0.08
Nodes (37): citizen_view(), unit_live(), ensure_engine(), add_vehicle(), _ago(), alerts(), alerts_near(), cancel_sos() (+29 more)

### Community 39 - "fear-command.js"
Cohesion: 0.15
Nodes (42): act(), afterSignIn(), aiBarHtml(), aiLineHtml(), api(), applyModeVisibility(), bindDetail(), bindMode() (+34 more)

### Community 40 - "signals.py"
Cohesion: 0.11
Nodes (23): map_info(), _build(), _ensure(), _flat(), _gz(), gzipped(), gzipped_tile(), _hull() (+15 more)

### Community 41 - "driver_home.dart"
Cohesion: 0.04
Nodes (44): _alertNewTask, api, build, _busy, _camCenter, createState, _demoControls, _demoMenu (+36 more)

### Community 42 - "Settings Panel"
Cohesion: 0.33
Nodes (10): boolSetting(), Config, CONFIG_DEFAULTS, freshDefaults(), loadConfig(), numberSetting(), rangeSetting(), renderSettingsPanel() (+2 more)

### Community 43 - "main.py"
Cohesion: 0.09
Nodes (32): ActiveReq, create_session(), driver_login(), employee_login(), employer_login(), employer_register(), EmployerRegisterReq, ensure_sim_engine() (+24 more)

### Community 44 - "StatelessWidget"
Cohesion: 0.07
Nodes (28): FearMap, IncidentMarkerIcon, _MapControls, MeMarkerIcon, PreemptedSignalIcon, VehicleMarkerIcon, NavBanner, NavBottomBar (+20 more)

### Community 45 - "Lane Decorations"
Cohesion: 0.24
Nodes (10): drawArrowHead(), drawArrowsAlongPath(), drawLaneDecorations(), drawWayDecorations(), isUturnNode(), isYes(), offsetPolyline(), strokeOffsetPath() (+2 more)

### Community 46 - "Route Test Tool"
Cohesion: 0.36
Nodes (9): ROUTE_FALLBACK_SPEED_KMH, routeBaseNodeId(), routeDividedWayBetween(), routeIsWayEndpointNode(), RouteTest, routeWayContainingInteriorNode(), routeWayEffectiveSpeedMps(), routeWayLegalDirections() (+1 more)

### Community 47 - "shorten_and_group_junctions"
Cohesion: 0.19
Nodes (7): shorten_and_group_junctions(), find(), get_bbox(), group_id_for(), node_bbox(), union(), way_layer()

### Community 48 - "places.py"
Cohesion: 0.08
Nodes (30): centroid(), distance_m(), _origin(), polyline_length_m(), to_latlon(), to_xy(), _parse_engine_state(), _build() (+22 more)

### Community 49 - "voice.dart"
Cohesion: 0.06
Nodes (30): _ampSub, build, createState, describeByVoice, dispose, _error, initState, kind (+22 more)

### Community 50 - "map_tab.dart"
Cohesion: 0.03
Nodes (66): _arriveTimer, build, _center, _centeredOnce, _choose, _closePlanner, context, createState (+58 more)

### Community 52 - "profile_api.py"
Cohesion: 0.11
Nodes (32): anonymize_citizen(), _can_review(), _check_password(), citizen_password_login(), citizen_phone_change_request(), citizen_phone_change_verify(), citizen_request(), citizen_requests() (+24 more)

### Community 53 - "command_state.dart"
Cohesion: 0.06
Nodes (31): ai, alerts, api, can, corridors, dispatchCategories, dispose, engine (+23 more)

### Community 54 - "login_screen.dart"
Cohesion: 0.09
Nodes (16): defaultPort, locate, normalize, probe, ServerLocator, webOrigin, build, _busy (+8 more)

### Community 55 - "login.dart"
Cohesion: 0.10
Nodes (18): build, _busy, callEmergency, _code, createState, _devMode, dispose, _error (+10 more)

### Community 56 - "LiveHub"
Cohesion: 0.11
Nodes (5): nearest_on_polyline(), trim_polyline_ahead(), EngineView, LiveHub, Unit

### Community 57 - "Rotate Handles"
Cohesion: 0.29
Nodes (7): clusterRotateHandleWorld(), drawClusterRotateHandle(), drawRotateHandle(), drawRotateHandleAt(), wayEvaluationPoints(), wayPoints(), wayRotateHandleWorld()

### Community 59 - "osm_to_json.py"
Cohesion: 0.21
Nodes (7): import_osm(), apply_lane_policy(), extract_buildings_and_amenities(), main(), parse_osm(), project(), split_ways_at_junctions()

### Community 60 - "Selection Filters"
Cohesion: 0.60
Nodes (5): applySelectionFilters(), el(), isItemSelectable(), renderSelectionFilters(), createFilterRow()

### Community 62 - "netinfo.py"
Cohesion: 0.08
Nodes (17): detect_lan_ipv4(), _instance_id(), _load_supabase_config(), _score_candidate(), summary(), build_reply(), ensure_public(), lan_addresses() (+9 more)

### Community 63 - "gov_api.py"
Cohesion: 0.08
Nodes (47): can_control_signals(), can_verify_citizen_vehicles(), dispatch_categories(), visible_categories(), active_alerts(), _active_assignment(), AlertReq, citizen_vehicle_queue() (+39 more)

### Community 64 - "incident_panel.dart"
Cohesion: 0.05
Nodes (41): _ack, _addNote, askReason, _askReason, _askText, build, _callerContact, _close (+33 more)

### Community 65 - "sos.dart"
Cohesion: 0.06
Nodes (35): _addDetails, build, _Countdown, _CountdownState, createState, dispose, existing, f (+27 more)

### Community 66 - "registry_page.dart"
Cohesion: 0.07
Nodes (28): _assign, build, context, _createDriver, _createOrg, createState, _createUser, _createVehicle (+20 more)

### Community 67 - "tabs.dart"
Cohesion: 0.06
Nodes (29): ActivityTab, _addVehicle, AlertsTab, build, _changePhone, createState, _date, _editDetails (+21 more)

### Community 68 - "widgets.dart"
Cohesion: 0.04
Nodes (41): _addr, appName, build, caps, confirm, createState, ctls, dense (+33 more)

### Community 69 - "public_state.dart"
Cohesion: 0.06
Nodes (34): LocationService, SmoothFix, NavSession, ProjectMap, RealtimeFeed, Session, CommandState, alerts (+26 more)

### Community 70 - "live_map_page.dart"
Cohesion: 0.05
Nodes (37): build, camera, createIncidentDialog, createState, desc, _focus, incident, _keyOpen (+29 more)

### Community 71 - "PreemptStatus"
Cohesion: 0.18
Nodes (11): PreemptPhase, Active, Clearing, None, PreemptStatus, arrDirX, arrDirY, fromWayId (+3 more)

### Community 72 - "aiosqlite"
Cohesion: 0.09
Nodes (19): _choose(), _consider(), due_at(), _duplicate_of(), _now(), _parse(), run_forever(), run_once() (+11 more)

### Community 73 - "realtime.dart"
Cohesion: 0.07
Nodes (21): app, _backoff, baseUrl, _ch, _closed, _connect, dispose, _failedTries (+13 more)

### Community 74 - "command_shell.dart"
Cohesion: 0.10
Nodes (16): build, CommandShell, _CommandShellState, createState, dispose, _EngineChip, _FeedDot, icon (+8 more)

### Community 75 - "session.dart"
Cohesion: 0.07
Nodes (24): api, app, baseUrl, connect, connected, connectError, enrollFromQr, forgetServer (+16 more)

### Community 76 - "dependencies"
Cohesion: 0.08
Nodes (24): dependencies, flutter, flutter_map, flutter_tts, geolocator, http, latlong2, mobile_scanner (+16 more)

### Community 77 - "api.dart"
Cohesion: 0.07
Nodes (20): baseUrl, delete, _detail, _headers, message, patch, post, postBytes (+12 more)

### Community 78 - "fear_gov/pubspec.yaml"
Cohesion: 0.10
Nodes (20): dependencies, cupertino_icons, fear_core, flutter, qr_flutter, url_launcher, description, dev_dependencies (+12 more)

### Community 79 - "fear_public/pubspec.yaml"
Cohesion: 0.09
Nodes (22): dependencies, audioplayers, cupertino_icons, fear_core, flutter, record, shared_preferences, url_launcher (+14 more)

### Community 80 - "State"
Cohesion: 0.05
Nodes (51): QrScanScreen, _QrScanScreenState, AuditPage, _AuditPageState, build, createState, _filter, initState (+43 more)

### Community 81 - "theme.dart"
Cohesion: 0.12
Nodes (14): brand, categories, category, demo, FearColors, FearIcons, fearTheme, incident (+6 more)

### Community 83 - "format.dart"
Cohesion: 0.14
Nodes (13): d, fmtAgo, fmtClock, fmtDistance, fmtDuration, m, parseTime, s (+5 more)

### Community 84 - "map_import.py"
Cohesion: 0.22
Nodes (6): _num_suffix(), _approach_bearings(), _cycle(), _f(), main(), normalize_signals()

### Community 86 - "home.dart"
Cohesion: 0.14
Nodes (10): _askTrafficConsent, build, createState, dispose, initState, PublicHome, _PublicHomeState, session (+2 more)

### Community 88 - "triage.py"
Cohesion: 0.09
Nodes (23): ApiException, _plan(), _triage_of(), voice(), available(), chat_json(), _http(), _post() (+15 more)

### Community 89 - "manifest.json"
Cohesion: 0.18
Nodes (10): background_color, description, display, icons, name, orientation, prefer_related_applications, short_name (+2 more)

### Community 90 - "responder.py"
Cohesion: 0.10
Nodes (28): within_bounds(), _covered(), _advance(), answer(), _caller_text(), _conversation_text(), _description(), _direct() (+20 more)

### Community 92 - "ChGraph"
Cohesion: 0.07
Nodes (33): chFindEdge(), ChGraph, down, id, indexOf, n, rank, up (+25 more)

### Community 93 - "ChainEdge"
Cohesion: 0.18
Nodes (11): ChainEdge, carriagewayCenterOffsetM, freeFlowSpeedMps, from, highwayRank, lanes, lanesPerDirection, laneWidthM (+3 more)

### Community 94 - "FEAR apps"
Cohesion: 0.08
Nodes (23): Adding an area to the map (super admin), AI dispatch agent (`fear_backend/ai_dispatch.py`), AI responder (voice SOS and reports), Connecting phones, FEAR apps, Map gestures, Me (both apps), More admins on other desktops (+15 more)

### Community 95 - "FEAR demo credentials"
Cohesion: 0.33
Nodes (5): FEAR Command - Command & Control and administration, FEAR Command - drivers (sign in on the phone), FEAR demo credentials, FEAR public app, Phones by QR code

### Community 96 - "fear_core/README.md"
Cohesion: 0.40
Nodes (4): Additional information, Features, Getting started, Usage

### Community 97 - "fear_gov/analysis_options.yaml"
Cohesion: 0.50
Nodes (3): include, linter, rules

### Community 98 - "fear_public/analysis_options.yaml"
Cohesion: 0.50
Nodes (3): include, linter, rules

### Community 99 - "phone_qr.dart"
Cohesion: 0.06
Nodes (28): AlertsPage, body, build, context, createAlertDialog, guarded, kind, minutes (+20 more)

### Community 112 - "JctCandidate"
Cohesion: 0.18
Nodes (11): JctCandidate, arrDirX, arrDirY, arrivalTime, fromWayId, lengthM, movement, rank (+3 more)

### Community 113 - "simulation.js"
Cohesion: 0.36
Nodes (6): loop(), boot(), buildLampCheckboxGrid(), renderAmenityAreaReadout(), renderExternalControlPanel(), renderInspector()

### Community 118 - "EndpointSpec"
Cohesion: 0.18
Nodes (15): buildSeeds(), EndpointSpec, directions, distToA, distToB, isVirtual, nodeAId, nodeBId (+7 more)

### Community 119 - "map-import.js"
Cohesion: 0.48
Nodes (11): api(), boot(), loadInfo(), loadSession(), poll(), render(), saveSession(), setPaused() (+3 more)

### Community 121 - "ch_preprocess.cpp"
Cohesion: 0.08
Nodes (34): BaseEdge, from, to, weight, bidirectionalDijkstra(), buildGraph(), Clock, CsrGraph (+26 more)

### Community 122 - "driver_profile.dart"
Cohesion: 0.12
Nodes (15): ApiClient, api, build, createState, _driver, _editContact, _error, initState (+7 more)

### Community 123 - "EmergencyReport"
Cohesion: 0.08
Nodes (22): EmergencyReport, arrDirX, arrDirY, clearUntilSimClock, fromWayId, gpsX, gpsY, holdUntilSimClock (+14 more)

### Community 126 - "String?"
Cohesion: 0.17
Nodes (9): build, _busy, _controller, createState, dispose, _error, _onDetect, open (+1 more)

### Community 130 - "Type"
Cohesion: 0.29
Nodes (7): Type, Array, Bool, Null, Number, Object, String

### Community 131 - "vehicles.hpp"
Cohesion: 0.08
Nodes (45): parseRedlightGroups(), simLaneCount(), main(), desiredLaneForStep(), findLaneNeighbors(), isEmergencyCapable(), isWideVehicle(), laneChangeSafe() (+37 more)

### Community 135 - "providers.py"
Cohesion: 0.47
Nodes (3): DevOutboxOtpSender, otp_sender(), OtpSender

## Knowledge Gaps
- **1151 isolated node(s):** `discoverOnLan`, `arrDirX`, `arrDirY`, `arrivalTime`, `fromWayId` (+1146 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1688 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **35 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `WsClient` connect `sim_engine.cpp` to `netinfo.py`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **What connects `discoverOnLan`, `arrDirX`, `arrDirY` to the rest of the system?**
  _1151 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Map Editor Core` be split into smaller, more focused modules?**
  _Cohesion score 0.05873340143003064 - nodes in this community are weakly interconnected._
- **Why does `handleCommand()` connect `sim_engine.cpp` to `vehicles.hpp`, `RoadGraph`, `Vehicle State Fields`, `json.hpp`, `redlights.hpp`, `ChGraph`?**
  _High betweenness centrality (0.047) - this node is a cross-community bridge._
- **Should `Area Data Layer` be split into smaller, more focused modules?**
  _Cohesion score 0.058126619770455384 - nodes in this community are weakly interconnected._
- **Why does `Vehicle` connect `Vehicle State Fields` to `sim_engine.cpp`, `redlights.hpp`, `vehicles.hpp`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Should `package:flutter/material.dart` be split into smaller, more focused modules?**
  _Cohesion score 0.08262108262108261 - nodes in this community are weakly interconnected._