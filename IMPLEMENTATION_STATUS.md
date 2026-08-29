# Traffic Simulation Engine — Implementation Status

Tracks progress against the original 6-phase plan for the vehicle simulation
layer built on top of the existing map editor/viewer + Contraction Hierarchy
router + fixed-time signal model. Working agreement throughout: phased
delivery with a checkpoint after each phase, flow-channel fidelity (not
per-lane microscopic), real vehicle hitboxes, auto-detected hospitals as
ambulance depots.

Last updated: 2026-08-29 (session 2 - see "Session 2" notes throughout for
what changed against the "done this session" state above each note).

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

## Not yet done

### Phase 5 — Ambulance emergency system
**Partially done in Session 2** - a manual, per-vehicle version rather than
the originally-planned incident-preset system:
- Added: a real `emergency` flag on `Vehicle`, deliberately separate from
  `vehicleType=="ambulance"` (resolves the "known simplification" the
  previous session's notes flagged) - toggled via a new
  `{"cmd":"triggerEmergency","id":N,"x":..,"y":..}` command and a "🚨
  Dispatch to incident" button in a selected ambulance's inspector panel
  (click, then click a point on the map). This is the "live re-routing
  capability that doesn't exist yet" the previous notes called out: it
  splices a freshly CH-resolved route from the vehicle's current position
  on to the clicked point (nearest routable node), onto whatever it was
  already mid-edge on - no teleport.
- Added: automatic hand-off on arrival. Reaching the incident node hands the
  same vehicle off to a second freshly-resolved leg toward its own home
  hospital (looked up from `vehicles.json`'s `meta.depots`, which
  `generate_vehicles.py`'s hospital-snapping already populated - Phase 1's
  work reused, not redone) instead of ending the trip; reaching the hospital
  ends it normally, with dispatch/incident-arrival/hospital-arrival
  timestamps rolled into the response/transport stats below.
- Still not done, per the original plan: `daily` / `building` / `custom` /
  `random` emergency PRESETS (a scheduling/generation system that fires
  incidents on its own and picks the nearest available depot ambulance) -
  today a human manually picks an already-active ambulance and a point,
  every time. Worth deciding whether that's sufficient or Phase 5 should
  still get the fuller preset system on top of this.

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
- **Resolved in Session 2:** EmergencyOnly mode's priority no longer applies
  to any `vehicleType=="ambulance"` - it now requires the new `emergency`
  flag (Phase 5), so a plain, non-dispatched ambulance trip gets zero
  preemption priority, exactly the distinction the previous session's notes
  said Phase 5 should decide on.
- Emergency dispatch (Session 2) is manual/per-vehicle only - there is still
  no incident-preset/auto-dispatch system (see Phase 5's "not done" note).
  Also, `triggerEmergency`'s "nearest routable node" search for the clicked
  incident point is a plain linear scan (fine for an occasional manual click
  against this map's ~15k nodes, not something ever called per tick).
- Emergency preemption detection (Session 2) only ever looks at the FRONT
  vehicle of each approach-lane group - consistent with how this file's
  arbitration always worked (only front vehicles are gated directly), but it
  does mean an emergency vehicle stuck behind ordinary traffic in the same
  lane at a busy signalized junction won't preempt until it fights its way
  to the front, same as any other vehicle would.
- Only 3 junctions in the current map are actually signalized (of 2,844
  total), so Phase 4's density/emergency modes have a small real footprint
  today; their value will scale once more signals are added or a different
  map is used.
