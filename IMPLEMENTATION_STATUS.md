# Traffic Simulation Engine — Implementation Status

Tracks progress against the original 6-phase plan for the vehicle simulation
layer built on top of the existing map editor/viewer + Contraction Hierarchy
router + fixed-time signal model. Working agreement throughout: phased
delivery with a checkpoint after each phase, flow-channel fidelity (not
per-lane microscopic), real vehicle hitboxes, auto-detected hospitals/fire
stations/police stations as ambulance/firetruck/police depots (Session 4).

Last updated: 2026-09-01 (session 5 - see "Session 4"/"Session 5" notes
throughout for what changed against the "done this session" state above
each note).

## Done

### Phase 1 — Vehicle trip generator (`backend/generate_vehicles.py`)
- Samples routable start/end node pairs from the largest connected component
  of the road graph, minimum 200 m apart.
- Per-vehicle type mix (default `car .82 / motorcycle .10 / bus .03 / truck
  .03 / ambulance .02`), each with randomized realistic dimensions
  (length/width/height), weight, per-type max speed and acceleration ranges,
  driver age, and a derived driver response time.
- Ambulances snap to the nearest `amenity=hospital`/`building=hospital` as a
  home depot (round-robin assignment across depots for balanced coverage).
- Deterministic given `--seed`; outputs `maps/vehicles.json` + `.csv`.
- Current tuned profiles: car 90–120 km/h, motorcycle 80–110, bus 60–85
  (length 7.0–10.0 m, shortened after visual review), truck 60–80, ambulance
  100–130.

### Phase 2 — Core C++ engine (`backend/sim/sim_engine.cpp`), headless
- One CH-router query per vehicle at spawn (never recomputed mid-trip).
- IDM (Intelligent Driver Model) car-following, tuned "selfish" (tighter
  headway/gap, higher accel) so vehicles don't wait unless they have to.
- Default fixed-time signal mode, ported directly from `front-end/redlight.js`
  (plain phases, paired-4-way, intersection turn-taking groups).
- Real per-vehicle hitboxes (length/width) and per-vehicle acceleration fed
  from `generate_vehicles.py`, not fixed type constants.
- Discrete 2-lane-per-direction model (`lanesPerDirection` derived correctly
  from OSM `lanes` being a *total across both directions*, not per-direction
  — a real bug caught and fixed mid-project).
- Left-hand-traffic geometry throughout (carriageway offset, lane offset,
  turn classification into through/right/u-turn).
- Discretionary lane-changing/overtaking with gap acceptance, plus a
  toggleable "vision + mini-pathfinding" advanced mode (50 m lookahead,
  cost-based lane scoring) vs. a cheap default nearest-neighbor heuristic.
  **Session 2:** the underlying lane-commitment logic (`desiredLaneForStep`)
  used to only peek one route step ahead, so a turning vehicle only
  discovered it needed the crossing lane once already on the final, short
  pulled-back stub right at the junction, forcing a last-second squeeze. It
  now looks ahead through every consecutive chain-edge step of the same
  approach to find the junction that ends it, so it commits to the correct
  lane from the start of the approach; a non-turning vehicle is still free
  to use either lane. This was the main cause of traffic looking
  artificially single-file near junctions instead of using both lanes.
- Curved (quadratic Bezier) turning through junctions instead of instant
  heading snaps, with a proper turn radius.
- Unsignalized-junction priority arbitration with impatience-based rank
  escalation (prevents starvation), and — most recently — genuine
  multi-vehicle concurrent discharge when movements are geometrically
  non-conflicting (same-approach different lane; opposite approaches both
  going straight/left, **or, since Session 2, opposite approaches both
  turning "right" - this map's crossing turn - since a real dual-protected-
  turn phase doesn't have the two arcs cross each other either**), instead
  of a global one-at-a-time mutex.
- Stop-line setback so vehicles hold *before* the visual intersection
  footprint, not inside it.
- Spawn-time collision avoidance via a two-pass retry queue (no overlap, no
  throughput stall).
- Windows real-time pacing fixed (tick-batching + `timeBeginPeriod(1)`) so
  the 1×–24× fast-forward slider is accurate at all speeds.
- Verified via headless CLI runs (`--headless --sim-seconds N --concurrency
  N`) at up to 8,000–10,000 concurrent vehicles, 0 failed routes.

### Phase 3 — WebSocket streaming + live rendering
- Hand-rolled WebSocket server in the engine (`backend/sim/sim_engine.cpp`),
  no external deps, matching the project's `g++ -static` convention.
- `serve.py` compiles-on-demand and manages the engine as a background
  subprocess (`/api/sim/start|stop|status`).
- `front-end/sim-client.js` renders true-to-scale vehicle rectangles
  (no artificial min/max pixel clamp) on the existing map canvas, reusing
  `map-core.js`'s pan/zoom/rotation.
- Click-to-select a vehicle: shows its planned route as a dashed path on the
  map, **and now a full detail panel** (shares the existing node/way/
  building/amenity inspector) with live state (position/speed/heading) and
  its complete generated tag set (dimensions, weight, max speed,
  acceleration, driver age, response time, home hospital for ambulances) —
  added in this session.
- Fast-forward speed control wired to actually drive the live engine, not
  just the local clock.

### Phase 4 — The other two signal-control modes
Runtime-switchable via a sidebar dropdown or `{"cmd":"setSignalMode"}`:
- **Default** — unchanged fixed-time math (Phase 2/3 behavior). No
  ambulance-awareness at all - that's the whole point of the distinction
  from EmergencyOnly below.
- **Density-based** — **redesigned in Session 2.** A signalized junction's
  rank (fed into the same live arbitration used for unsignalized junctions)
  is now the approach's live "red dot" weight rather than raw queue length:
  a vehicle stopped behind this red light shows a red dot (`Vehicle::
  waitingLight`, streamed as the per-vehicle `wt` field), chaining backward
  through a queue exactly as more vehicles join it (a follower is marked
  waiting purely by sharing its front vehicle's finalized gate - see the
  main loop's step 3 - not by any separate arbitration of its own); an
  approach's weight is the count of its current red dots plus the seconds
  each has been waiting, and the highest-weighted approach wins each round.
  Deliberately has no fixed phase timer to advance or hold, per the
  original ask. Old behavior (raw queue length only) is gone.
- **Emergency-only — redesigned in Session 2.** Previously a signalized
  junction under this mode ALWAYS ran the unsignalized-style arbitration
  (fair road-class + impatience, no fixed timer, and any vehicle with
  `vehicleType=="ambulance"` got a rank bonus) - this made an EmergencyOnly
  junction look like a free-for-all with no coherent phase pattern even with
  no ambulance around, and the frontend's countdown label was hard-frozen at
  "0" for it (a real, confirmed, now-fixed bug — see below). It now runs the
  EXACT SAME fixed-time math/timer as Default mode by default, and only
  overrides to real preemption (that approach forced green, every other
  approach forced red - not a rank bonus) while a vehicle with the new
  `emergency` flag (see Phase 5 below) is at the front of an approach queue.
- **Emergency preemption is now shared by both Density and EmergencyOnly**
  (Default is the only mode excluded) - an emergency-flagged vehicle wins
  outright in either mode, computed once per tick
  (`emergencyPreemptApproach`) ahead of each mode's own ordinary logic.
- Client-side rendering bug fixed: the frontend used to show a frozen "0"
  countdown (not a real timer, not even the "CTRL" label a manual override
  gets) for EVERY signalized junction in either non-Default mode, since the
  engine streamed an explicit lamp color for all of them unconditionally.
  Now: EmergencyOnly only streams a lamp entry for a junction it is
  ACTUALLY preempting right now — an unpreempted junction is left out of
  that field entirely, so the client's own ordinary fixed-time math (kept in
  sync via the already-existing clock sync) renders a genuine live countdown
  for it, exactly like Default mode. Density still streams every signalized
  junction always (it has no fixed-time fallback), but each lamp now also
  carries a `reason` ("emergency" vs "density") so the label reads "EMRG"/
  "AUTO" instead of a manual-override-flavored "CTRL", with a matching
  colored ring.
- Verified via headless runs (all 3 modes, up to 2,000 concurrent, 0 failed
  routes, no behavioral cliff vs. Default at the same load) and a live
  browser session: confirmed the EmergencyOnly countdown genuinely ticks
  down tick-over-tick (52→51→50...) when unpreempted, confirmed Density
  mode's red-dot weighting flags real waiting vehicles live (5-7 at a time
  observed at the map's one busy signalized junction), and confirmed the
  full emergency dispatch cycle below end-to-end with real, non-zero
  response/transport times.
- **Redesigned in Session 5:** preemption was purely reactive (Session 2) -
  it only ever engaged once a responding vehicle was ALREADY the front of
  its approach-lane queue on the very edge leading into a signalized
  junction, which was often too late for cross traffic to actually clear in
  time, and also meant a responding vehicle stuck behind ordinary traffic in
  the same lane never triggered it at all (it was never literally "front").
  Replaced with a lead-time/grace-period model, per user request: every
  physics tick, each active `emergency`-flagged vehicle (regardless of queue
  position) has its route scanned AHEAD for the next SIGNALIZED junction,
  and its time-to-arrival there is estimated (remaining route distance ÷
  current speed, floored at 3 m/s so a momentarily slow/stopped vehicle
  doesn't read as "never arriving"). Preemption engages once that estimate
  drops under `PREEMPT_LEAD_SEC` (10s) - "green 10 seconds before it reaches
  the intersection" - and releases `PREEMPT_GRACE_SEC` (5s) after the
  vehicle finishes crossing the junction edge, both constants defined at
  `sim_engine.cpp`'s emergency-preemption block (main loop step 3).
  Implementation detail: `RedlightController::reportEmergency`
  (`redlights.hpp`) now takes a `holdUntilSimClock` deadline instead of
  being a plain per-tick flag, and `beginTick()` no longer clears it - every
  tick the scan still needs a junction (still approaching within the lead
  window, or currently transiting it) it pushes the deadline out to
  `simClock + PREEMPT_GRACE_SEC`; since physics ticks are far more frequent
  than that grace period, the deadline never actually elapses while still
  needed, and only starts counting down for real from the last tick
  anything refreshed it - which is the tick the vehicle finishes crossing.
  One rule produces both halves of the requested behavior with no separate
  "has this vehicle crossed yet" bookkeeping anywhere. Verified live against
  the real engine (EmergencyOnly mode, a dispatched vehicle tracked over a
  90s window): preemption engaged at an estimated 9.9-10.0s before arrival
  at 2 different signalized junctions crossed en route, stayed held through
  each crossing, and released a few seconds after - including a 3rd,
  closely-spaced junction cluster where the vehicle slowed under
  congestion and preemption correctly re-armed for the second leg before
  releasing once clear.
- **Extended in Session 5 (same session, follow-up request):** preemption
  used to cut straight from ordinary green/red to the forced green/red
  override the instant it engaged - a vehicle already flowing through a
  conflicting approach on a genuinely green light would suddenly find it
  forced red with no warning. Added a `PREEMPT_YELLOW_SEC` (5s) "Clearing"
  window at the START of every preemption episode, before the existing
  forced-override behavior ("Active") begins: `redlights.hpp` gained a
  `PreemptPhase` enum (`None`/`Clearing`/`Active`) and `RedlightController::
  reportEmergency` now anchors a `clearUntil` deadline once per fresh
  episode (never re-pushed by later reports the way `holdUntil` is - a stale,
  already-elapsed entry from a PAST episode at the same junction is detected
  via `simClock >= holdUntil` and treated as fresh, so a junction preempted
  a second time later in the run still gets its own Clearing window).
  During Clearing, gating is completely UNCHANGED from no preemption at all
  - the main loop's step 3 gating branch and `buildStateJson`'s lamp-color
  computation both fall through to the exact same ordinary fixed-time
  (EmergencyOnly) or greedy-arbitration (Density) logic they'd use with no
  preemption pending, so no vehicle that wasn't already going to stop is
  forced to. The only effect is cosmetic: any approach that logic currently
  computes as green is relabelled `"yellow"` in the streamed lamp instead
  (the frontend needed zero changes - `redlight.js` already renders a
  generic `"yellow"` lamp color and tags the ring/label from the `r`
  ("reason") field alone, independent of where the color came from). Once
  Clearing elapses, behavior is exactly the pre-existing Active override
  (forced green for the preempted approach, forced red for every other one).
  Verified live: at every preempted junction observed, the Clearing window
  measured exactly 5.0s (e.g. sim-clock 90.60->95.60, 123.40->128.40,
  154.30->159.30) with a currently-green conflicting approach showing
  yellow throughout and the preempted approach itself staying red until the
  window elapsed, at which point it flipped green and every other approach
  flipped red - including the 3rd junction's second Clearing/Active cycle
  for its second leg, confirming the fresh-episode detection works mid-run,
  not just on a junction's first-ever preemption.
- **Bug fixed in Session 5 (same session, reported from a live screenshot):**
  the Clearing window above was implemented as "gating completely unchanged
  from no preemption" for EVERY approach, including the preempted vehicle's
  own - which meant its own approach could show red during Clearing if
  that's what the ordinary fixed-time/density logic happened to say at that
  moment, stopping the emergency vehicle on its own preemption. Most visible
  at a multi-leg junction cluster (`road_graph.hpp`'s junction-merging, e.g.
  the octagon-shaped cluster in the reported screenshot): crossing from one
  leg to the next inside the SAME cluster can trigger a fresh Clearing
  episode with only a second or two of real lead time left (the previous
  leg's Active phase just ended), giving ordinary logic a real chance to
  show red for that approach before the 5s Clearing window ran out. Fixed by
  forcing the preempted approach's own gate open (`fv.gate = 1`) for the
  WHOLE episode - Clearing and Active both - in the main loop's step 3 gating
  loop, and mirroring that in `buildStateJson`'s lamp-color computation
  (explicitly green during Clearing, not left to ordinary/greedy logic to
  possibly pick it). Only OTHER (conflicting) approaches still follow
  ordinary logic during Clearing, as originally intended. Verified live
  against the exact scenario that surfaced the bug (the same multi-leg
  cluster's tight-timing second-leg re-trigger, `t=169.90` in the earlier
  verification run): the winning approach now shows green from the very
  first tick of every preemption episode observed, never red/yellow, while
  conflicting approaches still correctly transition red->yellow->red.
- **Second bug fixed in Session 5 (same session, reported from another live
  screenshot - an ambulance visibly stuck at a large multi-approach
  intersection with several cars queued around it):** the first fix above
  guaranteed the emergency vehicle's OWN light was never the problem, but a
  live diagnostic (dispatching a firetruck across the same busy 8-way
  cluster at 600 concurrent vehicles, logging its speed/neighbours tick by
  tick) showed it could still sit at 0 km/h for 6+ continuous seconds -
  after its own light had already gone green. Root cause: Active preemption
  was forcing EVERY other approach red for as long as the vehicle took to
  cross the cluster (observed: ~17 continuous seconds at this junction,
  since a big cluster's multiple internal legs each need their own episode -
  see the first fix's own note) - long enough to back cross traffic up
  badly enough that it spilled back and physically blocked the emergency
  vehicle's own path, the opposite of what preemption exists for (car-
  following interactions are per real vehicle/edge, not something a forced
  gate alone can undo). Two complementary changes:
  1. `EmergencyReport`/`PreemptStatus` (`redlights.hpp`) now carry the
     priority movement's `movement`/`toWayId`/`arrDirX`/`arrDirY`, not just
     its `fromWayId`, so a caller can ask whether a SPECIFIC other approach
     actually conflicts with it. Active preemption (both the main loop's
     step 3 gating and `buildStateJson`'s lamp colors) now only force-reds
     an approach that `movementsCompatible` (`road_graph.hpp` - the same
     hand-verified rule Density mode's own arbitration already trusts) says
     genuinely conflicts; a provably compatible one (typically the one
     genuinely-opposite through movement at a busy junction) is spared and
     falls through to its own ordinary fixed-time/Density logic instead.
  2. The main loop's step 3 emergency-vehicle scan now skips reporting
     (skips refreshing the hold) for a vehicle that's already counted as
     "stuck" by this project's own existing definition
     (`Vehicle::stoppedDurationSec > 5.0`, the same threshold the `stk` flag
     and `stuckTotal` stat already use) - continuing to hold every other
     approach red does a genuinely stuck vehicle no good (it isn't using the
     green anyway) and only prolongs the backup that's blocking it. The
     preemption simply lapses via the existing grace-period expiry; the
     instant the vehicle moves again (`stoppedDurationSec` resets to 0) the
     very next tick's ETA check re-engages it fresh, with no loss of
     priority (the first fix above guarantees an immediate green even on a
     brand new episode).
  Re-verified against the EXACT reproduction (same dispatched vehicle id,
  same route, same 600-concurrency scenario, fully deterministic so a
  direct before/after comparison is exact): the vehicle's own longest
  continuous near-zero-speed streak dropped from 53 consecutive state ticks
  (~6.5s, recovering to cruising speed only ~11s after first slowing) to 7
  ticks (~1s, back to cruising speed within ~4s) - the same underlying-
  congestion scenario, but the emergency vehicle itself clears it far
  faster once its own preemption stops needlessly starving a non-
  conflicting approach and stops being held open past the point it's doing
  any good.

### Phase 5 — Ambulance/firetruck/police emergency incident system
**Partial (manual, per-vehicle dispatch) in Session 2 - the originally-
planned incident-PRESET system (auto-fires an incident, auto-picks the
nearest available depot vehicle(s)) was built in Session 4, plus 2 new
emergency-capable vehicle types (this session's ask: "1 ambulance, 2
firebrigades etc."). Session 5 added visibility into which hospital/station a
responding vehicle is actually heading to once it has picked up.**

Session 2 (manual dispatch, ambulance-only at the time):
- Added a real `emergency` flag on `Vehicle`, deliberately separate from
  `vehicleType=="ambulance"` - toggled via a
  `{"cmd":"triggerEmergency","id":N,"x":..,"y":..}` command and a "🚨
  Dispatch to incident" button in a selected vehicle's inspector panel
  (click, then click a point on the map). Splices a freshly CH-resolved
  route from the vehicle's current position on to the clicked point
  (nearest routable node), onto whatever it was already mid-edge on - no
  teleport.
- Automatic hand-off on arrival: reaching the incident node hands the same
  vehicle off to a second freshly-resolved leg toward its own home depot
  (looked up from `vehicles.json`'s `meta.depots`) instead of ending the
  trip; reaching the depot ends it normally, with dispatch/incident-
  arrival/depot-arrival timestamps rolled into the response/transport stats.

Session 4 (this session) - the incident-preset system, plus generalizing
everything above past ambulance-only:
- **2 new vehicle types**, `firetruck` and `police` (`backend/
  generate_vehicles.py`'s `VEHICLE_PROFILES`/`DEFAULT_VEHICLE_MIX`, `.015`
  share each), each with their own depot type: `find_depots()` (generalized
  from the old ambulance-only `find_hospital_depots()`) is called once per
  type - hospitals for ambulance, `fire_station` amenities for firetruck,
  `police` amenities for police - with each of the latter two FALLING BACK
  to the other's depot list if this map has none of its own (this map has
  34 hospitals and 4 police amenities but **zero** fire-station amenities,
  so firetrucks depot at the police stations too). `isEmergencyCapable()`
  (`vehicles.hpp`) replaces every old `vehicleType == "ambulance"` check
  (`triggerEmergency`, the EmergencyOnly/Density preemption scan) - a
  dispatched firetruck/police vehicle now preempts signals exactly like an
  ambulance always did. `homeHospitalName` renamed `homeDepotName`
  throughout (generator → `TripSpec` → `buildVehicleInfoJson` →
  sim-client.js's inspector label) since it's no longer hospital-only.
- **New `dispatchIncident` command**:
  `{"cmd":"dispatchIncident","x":..,"y":..,"counts":{"ambulance":1,"firetruck":2,"police":0}}`.
  For each requested type, ranks every active, not-already-`emergency`
  vehicle of that type by straight-line distance to the incident and
  dispatches the closest N (plain O(n) scan+sort - fires a few times a
  sim-minute, not per tick) via a shared `dispatchVehicleToIncident()`
  helper (factored out of `triggerEmergency`'s old inline logic, now used
  by both). Replies once with a `dispatchAck` message (dispatched vehicle
  ids per type + any shortfall) so the frontend can show what actually went
  out.
- **Frontend incident-preset UI** (`sim-client.js`): a 4-kind catalog (fire/
  medical/accident/crime), each naming which vehicle-type quantity inputs to
  show and how to pick a plausible incident location (a random building,
  preferring on-theme building tags where possible, for fire/medical/crime;
  a random point along a random road edge for accident - `State.buildings`/
  `State.ways` are already loaded client-side for the map view, reused
  as-is). A checkbox + "spawn every N sim-minutes" sidebar control
  (`simulation.html`'s `#liveSimSection`) gates a timer keyed off the
  server's own sim clock (`msg.t`, the same one `redlight.js` already stays
  in lockstep with) rather than wall-clock time - deliberate, so cadence
  scales with the fast-forward speed slider instead of flooding the user at
  24x.
  **Redesigned twice more, same session, converging on the current shape:**
  - *First redesign* (a first cut used a blocking centered modal per
    incident, forcing an immediate one-at-a-time decision): a spawned
    incident became purely informational instead - a brief expanding/
    fading "announce" ring at its map location (`INCIDENT_ANNOUNCE_MS`,
    wall-clock, independent of sim speed), settling into a small steady red
    pin + icon - plus a row in a left-sidebar list. `LiveSim.incidents`
    became a `Map` (was a single `pendingIncident`) so several can be
    pending at once, up to `INCIDENT_MAX_PENDING`. Clicking a row (or the
    map pin) opened the per-type quantity inputs in the shared `#inspector`
    panel, same one vehicle/node/way/building selection already used.
  - *Second redesign*, on user feedback that clicking into the shared
    panel for every incident (and back out again) was unnecessary friction
    and that dispatching felt laggy: the sidebar section
    (`#incidentsSection`, now titled "🚨 Emergency Control") is the ONLY
    place incident detail/dispatch controls appear at all - `#inspector` is
    no longer involved for incidents. Every pending incident renders as a
    fully self-contained card (`liveSimRenderIncidentsList`) - icon/kind/
    age, description, its OWN quantity inputs, its OWN Dispatch/Dismiss -
    so every incident's full controls are visible simultaneously, no click
    required. A map-pin click now just highlights + scrolls to the matching
    card (`liveSimSelectIncident`, a targeted class toggle, not a rebuild)
    instead of opening anything. The section itself is collapsible (a
    `.incidents-toggle` header + chevron, pure local UI state, no engine
    round trip), and gained a manual "create incident" control (a kind
    picker defaulting to "🎲 Random" + a "+ Create" button, both wired in
    `initLiveSimUI`) that calls the same `liveSimSpawnIncident` the random
    timer uses, just with an operator-picked kind instead of always random -
    the random timer and manual creation share one code path.
  - *Third redesign*, on user feedback that a manually-created incident
    should be placeable exactly where the operator wants it: "+ Create" no
    longer spawns immediately at a `locate()`-guessed spot - it arms a
    map-click pick instead (`liveSimBeginIncidentCreatePick`/
    `liveSimCompleteIncidentCreatePick`, `LiveSim.pickingIncidentKind`),
    the exact same "next click places it, click the button again to cancel"
    pattern the manual per-vehicle `triggerEmergency` dispatch
    (`liveSimBeginIncidentPick`/`LiveSim.pickingEmergencyForId`) already
    used - `liveSimSpawnIncident` gained a `forcedLoc` param so both a
    picked point and the random timer's `locate()` fallback flow through
    the same function. The 2 pick modes are mutually exclusive (arming
    either cancels the other, both directions) since only one can
    meaningfully own the next map click. The random timer is unaffected -
    it still auto-places via `locate()`; only the manual "+ Create" path
    now asks for a location.
    **The reported "laggy" dispatch button** turned out to have 2
    contributors, both fixed here: (1) the button's own click handler now
    disables it and swaps its label to "Dispatching..." the instant it's
    clicked, rather than giving no feedback until the whole card vanished a
    beat later; (2) the old click path also ran `clearSelection()` (a full
    unrelated `renderInspector()` rebuild, immediately thrown away) and
    `liveSimClearVehicleSelection()` on every incident selection - gone now
    that incidents don't touch `#inspector`/vehicle selection at all.
  - *Fourth redesign*: dispatching used to remove the incident immediately
    (fire-and-forget) - a card now instead has a `status` (`"pending"` or
    `"responding"`) and stays visible, on both the map and the sidebar,
    until every vehicle sent to it actually arrives. This needed one new
    field the engine wasn't streaming: `buildStateJson`'s per-vehicle "em"
    (emergency) flag stayed true for a dispatched vehicle's WHOLE round trip
    including the way home, so the client had no way to tell "still heading
    to the incident" from "already past it" - a new sparse `"ep"` field
    (`Vehicle::emergencyPhase`, 1 or 2, only present alongside `"em"`) fixes
    that. `dispatchIncident`'s request gained a client-supplied, purely
    opaque `incidentId` (the sidebar card's own local id) that the ack
    echoes straight back, letting `liveSimHandleDispatchAck` correlate a
    reply to the right card (several dispatches can be in flight at once)
    and flip it from `pending` (qty inputs + Dispatch/Dismiss) to
    `responding` (each dispatched vehicle listed with a live arrived/en-
    route status derived from "ep", plus a **Trace path** button that's just
    `liveSimSelectVehicle(id)` - the existing click-a-vehicle route display,
    reused as-is rather than building anything new - and one **Recall**
    button for the whole card). A responding card with 0 vehicles actually
    dispatched (dispatchAck reported nothing available) reverts to pending
    rather than getting stuck. Arrival is checked (`liveSimResponderArrived`/
    `liveSimCheckIncidentArrivals`) in the same once-per-sim-second throttle
    the age refresh already used, using targeted per-element text updates
    for the exact same "never rebuild a card with live state on a timer"
    reason below.
    **Recall** needed a genuinely new engine capability - there was no way
    to un-dispatch a vehicle before. A new `cancelEmergency` command
    (`{"cmd":"cancelEmergency","id":N}`) clears `emergency`/`emergencyPhase`
    (immediately stops preemption + the responding beacon) and, if a home
    depot is known, splices a route there right away - the same "send it
    home" leg the normal phase 1→2 hand-off already does, just triggered
    manually instead of automatically on arrival - so a recalled vehicle
    doesn't strand at whatever point it was cancelled, it just heads home a
    leg early. `handleCommand` needed `depotNodeByAmenityId` (previously
    local to `main()`'s hand-off code) threaded in as a parameter to reuse
    that same lookup.
  - **Real bug caught before it shipped, during the first redesign, and
    carried forward correctly into the second:** the vehicle info panel's
    "re-render the whole panel every tick to keep fields fresh" approach was
    briefly applied to the incident panel too, which would have wiped out
    whatever quantity the operator was mid-typing roughly 20x/second (the
    vehicle panel never had this problem - none of ITS fields are editable).
    Fixed by never rebuilding a panel/card with live editable inputs on a
    timer - only each card's own "Ns ago" text node (and, since the fourth
    redesign, a responding card's per-responder status text) gets touched in
    place (`liveSimRefreshIncidentLiveFields`, throttled to once per
    sim-second); the list itself only rebuilds on a genuine structural
    change (spawn/dispatch-confirmed/recall/dismiss).
- **Visual**: any of the 3 emergency-capable types get a small white centre
  dot while idle (unchanged from the old ambulance-only treatment); one
  actually responding (`v.em`) instead gets 2 small dots either side of its
  centreline that swap red/blue on a fast wall-clock toggle (~300ms,
  `Date.now()`-based, independent of sim speed) - the alternating light-bar
  look the project asked for, applied to any of the 3 types, not just
  ambulance. Verified live: dispatched vehicles visibly show the swapping
  red/blue pair while responding (confirmed via a zoomed-in screenshot of a
  dispatched police car).
- Verified: headless runs (2,000 and 10,000-trip manifests, the latter the
  actual regenerated `maps/vehicles.json`) with 0 failed routes including
  the new types' police-station-origin trips; 5 full live browser sessions
  (Playwright, one per design iteration) - engine start/compile, all 7
  vehicle types rendering with distinct colors, a mixed ambulance+firetruck
  dispatch actually rerouting both with `em` flags set and the toast
  reporting the right counts, the manual dispatch button working for a
  police vehicle too (not just ambulance), the red/blue responding-vehicle
  beacon visible close-up, and 0 browser console errors in any session.
  2nd-redesign session specifically: the Emergency Control section's
  collapse/expand toggle both directions, 3 simultaneously-pending cards
  each independently showing full working dispatch controls with no click
  needed to reveal them, a map-pin click correctly highlighting+scrolling to
  its card without touching `#inspector`, and dispatch/dismiss each
  correctly removing their card from both the map and the sidebar.
  3rd-redesign (pinpoint placement) session specifically: arming the create
  pick correctly disables the kind dropdown and relabels the button, an
  incident lands exactly on the clicked point (confirmed against the same
  `screenToWorld` coordinates the click itself resolved to, sub-few-metre
  rounding only), clicking the button again while armed cancels cleanly, and
  arming the OTHER pick mode (a vehicle's manual dispatch) correctly cancels
  an in-progress incident-create pick.
  4th-redesign (dispatch tracking) session specifically: a dispatched
  incident correctly flips to a "responding" card naming the real dispatched
  vehicle id, clicking its Trace path button selects that exact vehicle and
  fetches its route (89 points back from `getRoute` in one run - confirmed
  it's a real server-resolved path, not a placeholder), forcing that
  vehicle's live `ep` to 2 and invoking the arrival check makes the card
  correctly auto-resolve with a toast (isolated from the live 20Hz tick
  stream, which would otherwise overwrite a client-side-only test patch
  before a real-time wait could observe it - not a product bug, a test
  isolation detail worth recording), and Recall removes the card AND is
  confirmed server-side a second later - the vehicle's "em"/"ep" fields
  disappear from its next live snapshot and the engine's own log shows
  `emergency cancelled: vehicle N recalled`.

Session 5 (this session, follow-up request) - "see the hospital ambulances
are taking patients to after picking them up":
- The destination itself was already known (`Vehicle::homeAmenityId`, the
  same depot the phase 1->2 hand-off routes to - unchanged since Session 2)
  but wasn't surfaced anywhere useful: the incident sidebar card is
  deliberately torn down the MOMENT a responder reaches the incident (see
  the 4th-redesign note above - "stays visible until the emergency vehicle
  reaches the position"), which is exactly the moment a patient is picked
  up, so there was no window in which the responding card's own "arrived"
  status could ever show a destination even if it tried to.
- `sim_engine.cpp`'s `dispatchIncident` ack (`handleCommand`) now carries
  each dispatched vehicle's `homeAmenityId`/`homeDepotName` alongside its id
  (`"ids":[{"id":..,"homeAmenityId":..,"homeDepotName":..}]`, was a flat
  `[id,...]` array before) - known from the moment of dispatch, since a
  vehicle's assigned depot never changes mid-trip. `sim-client.js` stores
  this in a new `LiveSim.depotDestinations` map (vehicle id -> depot info),
  populated at dispatch time for BOTH the auto incident-preset flow
  (`liveSimHandleDispatchAck`) and manual per-vehicle dispatch
  (`liveSimCompleteIncidentPick`, from the already-loaded `getVehicleInfo`
  of the vehicle being dispatched) - deliberately independent of the
  incident card's own lifecycle, so the data survives long after that card
  is gone.
- New `liveSimDrawHospitalDestinations()` (called every frame from
  `LiveSim.draw`): for every vehicle currently in `emergencyPhase` 2 (picked
  up, en route home - phase 1 shows nothing yet, matching "after picking
  them up" literally) with a known depot, resolves its `homeAmenityId`
  against the already-loaded `State.amenities` map (same data the map
  editor/viewer already has, needed no new field from the engine) and draws
  a small green marker + name label at the depot's real map location,
  deduplicated per amenity per frame. Covers all 3 emergency-capable types
  (🏥/🚒/🚓), not just ambulance, since the underlying data already does -
  matches the existing project pattern of generalizing past ambulance-only
  wherever the mechanism is type-agnostic anyway.
- The vehicle inspector panel's "Emergency dispatch" section (unchanged
  since Session 2 otherwise) now distinguishes phase 1 ("en route to the
  incident") from phase 2, and for phase 2 names the destination by reusing
  `info.homeDepotName` (already sent by `buildVehicleInfoJson`, needed no
  engine change for this specific spot) - "🏥 Taking patient to X" for an
  ambulance, "Returning to X" for firetruck/police.
- Verified live end-to-end via Playwright against the real engine and UI:
  created a real incident and dispatched it through the actual sidebar
  Dispatch button (not a raw command - confirmed `liveSimHandleDispatchAck`'s
  real incidentId-gated code path, not a bypass), confirmed
  `LiveSim.depotDestinations` was populated immediately at dispatch time,
  confirmed the inspector panel read the generic "en route to the incident"
  text at phase 1 and switched to "🏥 Taking patient to Hospital (amenity
  ...)" the moment `ep` reached 2, and screenshotted the map showing the
  green hospital marker + name label rendered at the real depot location -
  still present after the originating incident's own sidebar card had
  already been auto-resolved and removed (confirming the two are correctly
  decoupled), with 0 browser console errors throughout.

## Not yet done

### Phase 6 — End-of-run statistics
**Mostly done in Session 2:**
- The engine's per-tick broadcast now carries a `stats` field (completed
  trips, average trip time overall and per vehicle type, and emergency
  dispatch count + average response time [dispatch→incident] + average
  transport time [incident→hospital] - see Phase 5) alongside the existing
  stdout summary, which the frontend caches (`LiveSim.lastStats`) and shows
  in a centered popup the moment "Stop engine" is clicked - verified live,
  including the emergency numbers actually populating after a full dispatch
  cycle completed (confirmed real non-zero response/transport seconds in a
  browser session).
- Still not done: a way to view stats WITHOUT stopping the engine (today the
  numbers are only ever shown at stop, even though the server already sends
  them continuously - a live-updating panel could read the same field
  in-run) - a small addition since the underlying data already flows every
  tick, just not surfaced anywhere until the popup.

## Known simplifications worth keeping in mind

- Junction conflict-compatibility (Phase 2's multi-vehicle discharge fix,
  reused by Phase 4) is a deliberately conservative flow-channel
  approximation: same-approach-different-lane, opposite-approaches-both-
  through, and opposite-approaches-both-turning-"right" onto DIFFERENT ways
  are treated as safe to run concurrently; everything else still serializes
  one at a time. This is *not* full conflict-point geometry.
  **Real bug caught and fixed later in Session 2:** the first cut of the
  "both turning right" rule (added earlier the same session) allowed it
  whenever the two approaches were roughly opposite, with no check on where
  each turn actually went - safe at a clean symmetric 4-way, but this map's
  own busiest signalized junction has **8 connected roads**, and a user
  visually caught two such approaches' right turns converging instead of
  diverging (plus, separately, ordinary vehicles visually passing through a
  bus at the same junction - almost certainly the same root cause: real
  conflicting movements marked simultaneously green). A follow-up attempt to
  fix this with a general arrival/departure "chord crossing" geometric test
  was itself hand-verified against the standard textbook conflict case
  (a crossing turn vs. opposite through traffic) and found to give the WRONG
  answer there too - it's now recorded in the code as a "don't redo this"
  note. The rule that shipped requires the two right turns' DESTINATION ways
  to differ, which is what actually prevents the convergence case while
  keeping the plain-4-way case working exactly as before.
- Density mode's "red dot" weight (Session 2) is still a flow-channel
  approximation, not a distance-weighted/time-averaged queue model from
  traffic engineering literature - it's count-of-waiting-vehicles plus
  seconds-waited, recomputed fresh (with a 1-tick lag) every tick, which can
  still react somewhat abruptly at very low traffic volumes, just less so
  than the plain queue-length count it replaced. The engine now also streams
  each signalized junction's live per-approach weight (`approachWeights` on
  the state broadcast), and the frontend shows it - with the current leading
  approach highlighted - in a selected traffic light's inspector panel, kept
  live-refreshed every tick the same way the vehicle detail panel already
  was. The on-map dot itself is now green, not red (so it doesn't read as
  just another red lamp next to the actual signal glyphs), and its screen
  position accounts for the vehicle's actual on-screen heading (using its
  real rotated width/length, not just half its length) - a bug fix, since
  the original always-half-length placement floated the dot well clear of
  an east/west-facing vehicle instead of sitting on top of it.
- **Session 3 findings** (user again flagged a collision risk in the phasing
  display and, separately, vehicles visibly overlapping "when the space is
  less"): two genuinely distinct bugs, both fixed.
  1. **Density-mode lamp display was self-inconsistent.** `buildStateJson`'s
     lamp-color loop decided each approach's displayed color by checking it
     ONLY against `JunctionInfo::inFlight` (vehicles physically mid-crossing
     right now) - during any lull where nothing happened to be mid-crossing,
     every approach at a junction trivially read as "compatible with
     nothing" and displayed green simultaneously, even though those
     approaches were not mutually compatible with EACH OTHER. The real
     per-tick admission (`candidatesForJunction`) was already correct and
     internally consistent (each accepted candidate is checked against both
     `inFlight` AND everything else accepted that same tick) - this was a
     **display-only** bug, but a reasonable one to read as "the phasing
     itself is unsafe" since the lamps are the only visible signal of it.
     Fixed by having the lamp loop run the SAME greedy compatibility
     acceptance as the real admission, applied to every approach at the
     junction (not just ones with a vehicle currently waiting), ranked by
     the same `densityApproachWeight` shown in the sidebar. Verified live:
     the map's busiest (8-arm) junction now shows exactly one approach group
     green at a time instead of 3-4 simultaneously.
  2. **No hard capacity check on ordinary (non-junction-gated) edge
     transitions - the real cause of severe vehicle overlap.** Only a
     transition INTO a junction edge (`nxt.isJunction`) was hard-blocked by
     a red/lost-arbitration light (`gateOk`); a transition onto an ordinary
     downstream chain edge, or - separately - onto an already-granted
     junction edge that was simply out of physical room, had no equivalent
     floor. Step 4's IDM lookahead tries to decelerate a vehicle toward a
     stop when the next lane is already occupied, but that's advisory only:
     nothing stopped a vehicle from crossing `distAlongEdge >= cur.length`
     into an already-packed lane regardless once its own integrated position
     reached the boundary. Under sustained heavy load this compounded badly
     at popular chokepoints - confirmed via direct instrumentation that
     100+ genuinely distinct vehicles (different routes, different
     routeIdx) ended up parked at bit-for-bit identical positions on a
     single edge. Fixed with two hard capacity checks in the step-5
     edge-transition code, both holding a vehicle at its current edge's end
     (`distAlongEdge = cur.length`, same treatment a red light already got)
     whenever the target lane doesn't have room for its own length + minGap:
     one for chain-to-chain transitions, one for a granted-but-still-full
     junction edge (a green/admitted movement previously said nothing about
     whether the junction edge itself had room - same-approach vehicles are
     always "compatible" with each other per rule 1, so nothing else limited
     how many could pile onto a short crossing). Verified live via direct
     pairwise overlap detection (spatial-hashed, using the client's own
     rendered/lane-offset-adjusted positions): under 4500-concurrency stress
     testing, near-total-overlap pairs dropped from ~44,600 to ~240, and the
     remaining ones are ordinary tight-but-physically-plausible bumper-to-
     bumper spacing, not same-point stacking.
  Also fixed in this pass: spawning skipped its own-lane clearance check
  entirely whenever a trip's route started already crossing a junction
  (`route[0].isJunction`) - a real, if smaller, contributor to pileups at
  junction-node-origin depots. The check now applies to both edge types
  (junction edges have no lane concept, so the lane match is skipped only
  there).
- **Resolved in Session 2, extended in Session 4:** EmergencyOnly mode's
  priority no longer applies to any `vehicleType=="ambulance"` - it requires
  the `emergency` flag (Phase 5), so a plain, non-dispatched trip gets zero
  preemption priority. Session 4 widened the type check itself from
  ambulance-only to `isEmergencyCapable()` (ambulance/firetruck/police), so
  the same "flag, not type" distinction now also covers the 2 new types.
- **Resolved in Session 4:** emergency dispatch is no longer manual/per-
  vehicle only - see Phase 5's incident-preset system. `nearestRoutableNodeId`
  (the "nearest routable node" search for an incident point, shared by both
  `triggerEmergency` and `dispatchIncident`) is still a plain linear scan
  (fine against this map's ~15k nodes for something that fires a few times a
  sim-minute at most, never per tick).
- `dispatchIncident`'s (Session 4) nearest-available ranking is straight-line
  distance to the incident, not real route cost - a vehicle on the far side
  of a river/highway with no nearby crossing could rank ahead of a genuinely
  closer-by-road one. A real route-cost ranking would need a CH query per
  candidate vehicle per request, judged not worth it for how rarely this
  fires; worth revisiting if dispatch choices look wrong on a map with more
  disconnected-feeling road topology than this one.
- Phase 6's `stats.emergency` (dispatch count + avg response/transport time)
  is still one aggregate across all 3 emergency-capable types (Session 4
  added firetruck/police to the dispatch system itself but did not split
  this stat by type) - a per-type breakdown would need `EmergencyStats` keyed
  by `vehicleType` instead of a single struct, not done since Phase 6 itself
  is still marked "not yet done" above for other reasons.
- **Resolved in Session 5:** emergency preemption detection (Session 2) used
  to only ever look at the FRONT vehicle of each approach-lane group, so an
  emergency vehicle stuck behind ordinary traffic in the same lane never
  preempted until it fought its way to the front. It's now a per-vehicle
  route lookahead (any active `emergency`-flagged vehicle, any queue
  position) with its own lead-time trigger - see Phase 4's Session 5 note.
- 41 junctions in the current map are actually signalized (of 2,829 total),
  so Phase 4's density/emergency modes have a modest but real footprint
  today; their value will scale further once more signals are added or a different
  map is used.
