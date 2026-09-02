#pragma once

// Vehicles, routing, and car-following (IDM) physics for the "traffic light
// revamped" simulation engine (backend/sim/sim_engine.cpp). Depends on
// road_graph.hpp for the map model but deliberately knows nothing about
// redlights.hpp/RedlightController/AutoWeightBoard - a Vehicle only ever
// tracks its OWN "am I currently showing the Auto/Density-mode green dot"
// state (autoDotOn/autoDotSince, set by sim_engine.cpp's main loop from the
// gate outcome); it never calls into the signal-control layer itself.
// sim_engine.cpp's main loop is the only code that reads a Vehicle's state
// to feed AutoWeightBoard/build an EmergencyReport - see redlights.hpp's own
// header comment for why that boundary exists.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <optional>
#include <queue>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "../ch/json.hpp"
#include "../ch/ch_graph.hpp"
#include "road_graph.hpp"

// Local, self-contained (no M_PI dependency - not guaranteed available
// without a compiler-specific define) - see visionCone's bearing wraparound.
static constexpr double PI = 3.14159265358979323846;

struct RouteStep { bool isJunction; int edgeIndex; double length; };

// The RoadGraph node index a step ENDS at, regardless of whether it's a
// chain or junction edge - used by emergency dispatch (see sim_engine.cpp's
// handleCommand::triggerEmergency and its main loop's edge-transition step)
// to splice a fresh route on from wherever a vehicle currently is.
static int stepToNode(const RoadGraph& rg, const RouteStep& s) {
    return s.isJunction ? rg.junctionEdges[s.edgeIndex].to : rg.chainEdges[s.edgeIndex].to;
}

static std::string stripDirectionSuffix(const std::string& id) {
    if (id.size() > 4 && id.compare(id.size() - 4, 4, "#fwd") == 0) return id.substr(0, id.size() - 4);
    if (id.size() > 4 && id.compare(id.size() - 4, 4, "#bwd") == 0) return id.substr(0, id.size() - 4);
    return id;
}

// A plain existing node id can seed up to three CH graph entries: the id
// itself, and (for an interior vertex of a DIVIDED road - see
// ch_preprocess.cpp's #fwd/#bwd splitting, road_graph.hpp's own file header)
// its directional twins, which is where such a vertex's real edges actually
// live - the plain id alone can be a degree-0 dead end there. Mirrors
// ch_query.cpp's own buildSeeds() for the non-virtual case exactly (this
// project's vehicles.json start/end are always plain node ids, never a
// mid-road virtual point, so that's the only case this needs).
static std::vector<ChSeed> plainNodeSeeds(const ChGraph& chg, const std::string& nodeId) {
    std::vector<ChSeed> seeds;
    auto tryAdd = [&](const std::string& id) {
        auto it = chg.indexOf.find(id);
        if (it != chg.indexOf.end()) seeds.push_back({it->second, 0.0});
    };
    tryAdd(nodeId);
    tryAdd(nodeId + "#fwd");
    tryAdd(nodeId + "#bwd");
    return seeds;
}

// Route computation via the existing CH query engine, run in-process (never
// shells out - that wouldn't scale to spawning up to 10k vehicles). Used for
// a vehicle's initial spawn-time route and for emergency-dispatch splicing
// (see sim_engine.cpp's handleCommand::triggerEmergency) - both genuinely
// want the STATIC shortest path (an ambulance mid-response isn't rerouting
// around traffic, and a spawn has no live data yet anyway). See
// liveWeightedRoute below for the live-traffic-aware version an ordinary
// vehicle's periodic reroute uses instead. See road_graph.hpp's file header
// for why every hop is guaranteed resolvable against RoadGraph.
static std::vector<RouteStep> resolveRoute(const RoadGraph& rg, const ChGraph& chg, const std::string& startId, const std::string& endId, std::string& err) {
    std::vector<ChSeed> ss = plainNodeSeeds(chg, startId);
    std::vector<ChSeed> es = plainNodeSeeds(chg, endId);
    if (ss.empty() || es.empty()) { err = "start/end node not in CH graph"; return {}; }
    ChQueryResult res = runChQuery(chg, ss, es);
    if (!res.found) { err = "no route found between " + startId + " and " + endId; return {}; }

    std::vector<int> rgPath;
    rgPath.reserve(res.path.size());
    for (int idx : res.path) {
        std::string id = stripDirectionSuffix(chg.id[idx]);
        auto it = rg.indexOf.find(id);
        if (it == rg.indexOf.end()) { err = "path node not in road graph: " + id; return {}; }
        if (!rgPath.empty() && rgPath.back() == it->second) continue; // collapsed #fwd/#bwd no-op hop
        rgPath.push_back(it->second);
    }

    std::vector<RouteStep> steps;
    steps.reserve(rgPath.size());
    for (size_t k = 0; k + 1 < rgPath.size(); ++k) {
        int u = rgPath[k], v = rgPath[k + 1];
        bool found = false;
        for (auto& oe : rg.outAdj[u]) {
            if (oe.isJunction) {
                const JunctionEdge& je = rg.junctionEdges[oe.index];
                if (je.to == v) { steps.push_back({true, oe.index, je.lengthM}); found = true; break; }
            } else {
                const ChainEdge& ce = rg.chainEdges[oe.index];
                if (ce.to == v) { steps.push_back({false, oe.index, ce.lengthM}); found = true; break; }
            }
        }
        if (!found) { err = "CH path hop not resolvable in road graph (" + rg.nodeId[u] + " -> " + rg.nodeId[v] + ")"; return {}; }
    }
    return steps;
}

// Live-traffic-aware routing ("the CH path is a suggestion, not gospel" -
// see sim_engine.cpp's reroute step, Vehicle::destNodeId/nextRerouteAt). A
// plain Dijkstra directly over RoadGraph's own adjacency (rg.outAdj) -
// deliberately NOT through backend/ch's contraction-hierarchy shortcuts,
// which are only valid for the STATIC weights ch_preprocess.cpp baked in at
// preprocess time (free-flow speed limits); reweighting them live would
// silently produce wrong shortest paths, since a shortcut edge represents a
// whole precomputed subpath under the OLD weights. This is a full graph
// search rather than a bounded/local one - correctness over cleverness -
// but it's only ever called a few times per minute per vehicle, staggered
// (see nextRerouteAt), on a graph of a few tens of thousands of nodes, so a
// plain priority-queue Dijkstra with early-exit on reaching the destination
// is comfortably fast enough without needing an A* heuristic. Returns the
// same RouteStep shape resolveRoute does, so callers splice it on exactly
// the same way handleCommand::triggerEmergency already does.
// Same live-traffic edge cost liveWeightedRoute's Dijkstra uses internally,
// hoisted out so a caller can also price an EXISTING route's remaining
// steps on the same scale (see liveWeightedRemainingCost) - what makes it
// possible to ask "is switching actually worth it", not just "does the
// alternative look nonzero-better".
static double liveEdgeCost(const RoadGraph& rg, bool isJunction, int edgeIndex) {
    if (isJunction) {
        const JunctionEdge& je = rg.junctionEdges[edgeIndex];
        return je.lengthM / std::max(0.1, je.speedMps);
    }
    const ChainEdge& ce = rg.chainEdges[edgeIndex];
    double liveSpeed = (size_t)edgeIndex < rg.chainEdgeLiveSpeed.size() ? (double)rg.chainEdgeLiveSpeed[edgeIndex] : ce.freeFlowSpeedMps;
    return ce.lengthM / std::max(2.0, liveSpeed); // floored, not infinite - a jam is strongly penalized, never impossible
}

// Live-weighted cost of an already-resolved route's steps from fromIdx
// onward - used by sim_engine.cpp's reroute step to compare "stick with the
// current plan" against a freshly-queried liveWeightedRoute on the exact
// same scale, since both are priced with liveEdgeCost.
static double liveWeightedRemainingCost(const RoadGraph& rg, const std::vector<RouteStep>& route, size_t fromIdx) {
    double cost = 0.0;
    for (size_t k = fromIdx; k < route.size(); ++k) cost += liveEdgeCost(rg, route[k].isJunction, route[k].edgeIndex);
    return cost;
}

static std::vector<RouteStep> liveWeightedRoute(const RoadGraph& rg, const std::string& startId, const std::string& destId, std::string& err, double* outCost = nullptr) {
    auto sIt = rg.indexOf.find(startId), dIt = rg.indexOf.find(destId);
    if (sIt == rg.indexOf.end() || dIt == rg.indexOf.end()) { err = "start/end node not in road graph"; return {}; }
    int start = sIt->second, dest = dIt->second;
    if (start == dest) return {};

    const double INF = 1e30;
    std::vector<double> dist(rg.nodeId.size(), INF);
    std::vector<int> cameFrom(rg.nodeId.size(), -1);
    std::vector<OutEdgeRef> cameEdge(rg.nodeId.size(), {false, -1});
    using PQItem = std::pair<double, int>;
    std::priority_queue<PQItem, std::vector<PQItem>, std::greater<PQItem>> pq;
    dist[start] = 0.0;
    pq.push({0.0, start});
    while (!pq.empty()) {
        auto [d, u] = pq.top();
        pq.pop();
        if (d > dist[u]) continue; // stale entry, already improved
        if (u == dest) break;
        for (const OutEdgeRef& oe : rg.outAdj[u]) {
            int v = oe.isJunction ? rg.junctionEdges[oe.index].to : rg.chainEdges[oe.index].to;
            double w = liveEdgeCost(rg, oe.isJunction, oe.index);
            double nd = d + w;
            if (nd < dist[v]) {
                dist[v] = nd;
                cameFrom[v] = u;
                cameEdge[v] = oe;
                pq.push({nd, v});
            }
        }
    }
    if (dist[dest] >= INF) { err = "no live-weighted route found between " + startId + " and " + destId; return {}; }
    if (outCost) *outCost = dist[dest];

    std::vector<RouteStep> steps;
    for (int cur = dest; cur != start; cur = cameFrom[cur]) {
        const OutEdgeRef& oe = cameEdge[cur];
        double len = oe.isJunction ? rg.junctionEdges[oe.index].lengthM : rg.chainEdges[oe.index].lengthM;
        steps.push_back({oe.isJunction, oe.index, len});
    }
    std::reverse(steps.begin(), steps.end());
    return steps;
}

// Nearest RoadGraph node with at least one outgoing edge (a real routable
// point, not e.g. a lone building-corner node with no road attached) to a
// clicked map point - used to turn an emergency-dispatch click's world x/y
// (see sim_engine.cpp's handleCommand::triggerEmergency) into a real
// start/end node for resolveRoute. Plain linear scan over this map's ~15k
// nodes: only ever called on a manual dispatch click, not a per-tick hot
// path, so no spatial index is worth the complexity.
static std::string nearestRoutableNodeId(const RoadGraph& rg, double x, double y) {
    int best = -1;
    double bestD2 = 1e30;
    for (size_t i = 0; i < rg.nodeId.size(); ++i) {
        if (rg.outAdj[i].empty()) continue;
        double dx = rg.nodeX[i] - x, dy = rg.nodeY[i] - y;
        double d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = (int)i; }
    }
    return best >= 0 ? rg.nodeId[best] : std::string();
}

// Which of an edge's (at most 2, see simLaneCount) simulated lanes a vehicle
// should use while travelling it, chosen by peeking at the movement of the
// junction it leads to: lane 0 (the outer/curb lane in this left-hand-
// traffic map) carries "through" - straight and the non-crossing left turn,
// which classifyMovement bundles into "through" - while lane 1 (inner,
// nearer the road's centreline) carries "right" and "uturn", the two
// movements that cross oncoming traffic. This is what lets a u-turning
// vehicle queue without blocking a following through vehicle on a 2-lane
// approach (see the lane-changing section below) and lets the two lanes
// render/queue side-by-side at independent speeds instead of single-file.
// Single-lane edges always use lane 0 - nothing to choose between.
//
// Looks ahead past stepIdx through every remaining CONSECUTIVE chain-edge
// step of the same road segment/approach (a way with intermediate shape
// nodes becomes several short chain edges in a row before the junction edge
// that actually crosses the intersection - see road_graph.hpp's file
// header's RoadGraph topology note) to find the junction that ends it,
// rather than only ever peeking one step ahead. Peeking only one step used
// to mean a vehicle only discovered it needed the crossing lane once it was
// already on that final, short pulled-back stub right at the junction - a
// real driver picks the correct lane for their turn from the START of the
// approach, well before reaching the intersection, not in the last couple
// of metres. A route that ends mid-way through this segment (its
// destination) has no junction to prepare for, so it's left in lane 0 like
// a plain through movement.
static int desiredLaneForStep(const RoadGraph& rg, const std::vector<RouteStep>& route, size_t stepIdx) {
    if (stepIdx >= route.size() || route[stepIdx].isJunction) return 0;
    const ChainEdge& ce = rg.chainEdges[route[stepIdx].edgeIndex];
    if (simLaneCount(ce) < 2) return 0;
    size_t k = stepIdx + 1;
    while (k < route.size() && !route[k].isJunction) ++k;
    if (k >= route.size()) return 0;
    const std::string& movement = rg.junctionEdges[route[k].edgeIndex].movement;
    return movement == "through" ? 0 : 1;
}

struct TypeProfile { double aMax, bComfort, headwayT, minGap; };

// Deliberately tighter than a textbook-cautious IDM parameter set (real
// driving-model papers commonly use headwayT ~1.5-2.0s, minGap ~2-3m) - the
// project asked for "a bit selfish" drivers that don't yield more than they
// have to, specifically so congestion that shows up ANYWAY (despite this
// tighter following) is a stronger signal that a location genuinely needs a
// traffic light rather than just needing more cautious simulated drivers.
static const TypeProfile& profileFor(const std::string& type) {
    static const std::unordered_map<std::string, TypeProfile> table = {
        {"car", {2.8, 3.0, 1.0, 1.5}},
        {"motorcycle", {4.0, 3.5, 0.7, 1.0}},
        {"bus", {1.4, 2.0, 1.5, 2.5}},
        {"truck", {1.2, 2.0, 1.5, 2.5}},
        {"ambulance", {3.2, 3.5, 0.9, 1.5}},
        // Firetruck: heavy and not especially nimble (lower aMax/bComfort
        // than a car), but still an urgent responder - slightly tighter
        // headway than an ordinary truck, wider minGap than a car/ambulance
        // since its own length makes a tight gap riskier to matter as much.
        {"firetruck", {1.8, 2.2, 1.2, 2.2}},
        // Police: the most aggressive profile of the 3 (pursuit-tuned) -
        // tighter headway and higher accel than even the ambulance.
        {"police", {3.6, 3.8, 0.85, 1.3}},
    };
    auto it = table.find(type);
    return it != table.end() ? it->second : table.at("car");
}

// Vehicle types capable of being dispatched to an emergency incident (see
// sim_engine.cpp's triggerEmergency/dispatchIncident) - deliberately an
// ALLOWLIST, not "anything that isn't car/bus/etc", so adding a new
// ordinary vehicle type later never accidentally makes it dispatchable.
static bool isEmergencyCapable(const std::string& vehicleType) {
    return vehicleType == "ambulance" || vehicleType == "firetruck" || vehicleType == "police";
}

struct TripSpec {
    int id;
    std::string vehicleType, startNodeId, endNodeId;
    double length, width, maxSpeedKmh, accelMps2;
    // Present only for the frontend's click-a-vehicle-to-inspect detail
    // panel (see sim_engine.cpp's buildVehicleInfoJson) - never consumed by
    // the physics/routing here, so no default beyond "field absent" matters.
    double height = -1.0, weightKg = -1.0, driverAge = -1.0, responseTimeSec = -1.0;
    std::string homeAmenityId, homeDepotName; // empty = not an emergency-capable type / no depot assigned
};

static std::vector<TripSpec> loadTrips(const JsonValue& root) {
    const JsonValue* arr = root.find("vehicles");
    if (!arr || arr->type != JsonValue::Type::Array) throw std::runtime_error("vehicles.json missing 'vehicles' array");
    std::vector<TripSpec> out;
    out.reserve(arr->arrVal.size());
    for (auto& v : arr->arrVal) {
        TripSpec t;
        t.id = (int)v.num("id").value_or(0);
        t.vehicleType = v.str("vehicleType").value_or("car");
        t.startNodeId = v.str("startNodeId").value_or("");
        t.endNodeId = v.str("endNodeId").value_or("");
        t.length = v.num("length").value_or(4.5);
        t.width = v.num("width").value_or(1.8);
        t.maxSpeedKmh = v.num("maxSpeedKmh").value_or(140.0);
        t.accelMps2 = v.num("accelMps2").value_or(-1.0); // -1 = not present, fall back to profileFor's type default
        t.height = v.num("height").value_or(-1.0);
        t.weightKg = v.num("weightKg").value_or(-1.0);
        t.driverAge = v.num("driverAge").value_or(-1.0);
        t.responseTimeSec = v.num("responseTimeSec").value_or(-1.0);
        t.homeAmenityId = v.str("homeAmenityId").value_or("");
        t.homeDepotName = v.str("homeDepotName").value_or("");
        out.push_back(std::move(t));
    }
    return out;
}

// A vehicle wider than this can't meaningfully share a 2-lane road side by
// side with another vehicle - it (and anyone considering a lane change
// beside it) should treat it as occupying the full road, not just one lane.
// Driven by the vehicle's own generated width (see generate_vehicles.py),
// not a hardcoded vehicleType list, so it falls directly out of each
// vehicle's actual hitbox rather than a separate parallel rule.
static constexpr double WIDE_VEHICLE_THRESHOLD_M = 2.15;
static bool isWideVehicle(double width) { return width > WIDE_VEHICLE_THRESHOLD_M; }

struct Vehicle {
    int id = -1;
    std::string vehicleType;
    double length = 4.5, width = 1.8, maxSpeedMps = 38.9;
    double aMax = 2.5, bComfort = 3.0, headwayT = 1.4, minGap = 2.0;
    std::vector<RouteStep> route;
    size_t routeIdx = 0;
    int lane = 0; // which of the current chain edge's (at most 2) lanes - see desiredLaneForStep
    double nextLaneEvalAt = 0.0; // throttles discretionary lane-change checks - see the main loop's step 1.5
    double distAlongEdge = 0.0;
    double speed = 0.0;
    double accel = 0.0;
    bool active = false;
    double spawnSimTime = 0.0;
    double waitTimeSec = 0.0;
    double arrivalAtStopLineTime = -1.0;
    int gate = 0; // 0 = n/a this tick, 1 = open, 2 = closed - only meaningful for an edge-group's front vehicle

    // Emergency dispatch ("emergency state" toggle, set by either a manual
    // triggerEmergency or an auto dispatchIncident - see sim_engine.cpp's
    // handleCommand) - independent of isEmergencyCapable(vehicleType) alone,
    // per the "currently responding" flag the project's own status notes
    // called for: a plain, non-dispatched ambulance/firetruck/police trip
    // does NOT get preemption, only one actually dispatched to an incident
    // does. emergencyPhase: 0 = not responding, 1 = en route to the
    // incident, 2 = incident reached, en route to the home depot - see
    // sim_engine.cpp's main loop edge-transition step for how a vehicle
    // moves from phase 1 to 2 instead of just ending its trip.
    bool emergency = false;
    int emergencyPhase = 0;
    double dispatchTime = -1.0, incidentArrivalTime = -1.0;
    std::string homeAmenityId; // copied from TripSpec at spawn - depot lookup for the phase 1->2 handoff

    // Auto/Density mode's green-dot queue-chain state (rewritten from
    // scratch 2026-09-02 - see redlights.hpp's AutoWeightBoard and
    // sim_engine.cpp's main loop for where this gets set): the first vehicle
    // stopped at a red light, and every vehicle that stops behind it, each
    // get their OWN autoDotOn/autoDotSince - autoDotSince is when THIS
    // vehicle personally started queuing, not the front vehicle's time, so
    // each dot's age (and the weight it contributes to its approach) is its
    // own. Not meaningful outside Auto/Density mode.
    bool autoDotOn = false;
    double autoDotSince = -1.0;

    // Live-traffic rerouting ("the CH path is a suggestion, not gospel" -
    // see sim_engine.cpp's reroute step and liveWeightedRoute below).
    // destNodeId is copied from TripSpec at spawn so a mid-trip reroute
    // always still terminates at the originally-planned destination - it
    // never invents a new trip, only a fresh PATH to the same one.
    // nextRerouteAt/nextStuckRerouteAt are staggered per-vehicle at spawn so
    // the whole fleet doesn't hit liveWeightedRoute's Dijkstra in the same
    // tick; nextStuckRerouteAt additionally throttles the stuck-triggered
    // immediate reroute (see sim_engine.cpp's stuck-detection step) so a
    // vehicle stuck with genuinely no better alternative doesn't retry every
    // single tick.
    std::string destNodeId;
    double nextRerouteAt = 0.0;
    double nextStuckRerouteAt = 0.0;

    // Stuck-vehicle tracking (>5s spent below near-zero speed) - see
    // sim_engine.cpp's integrate step for stoppedDurationSec's accumulation
    // and buildStateJson's "stk"/stuckNow/stuckTotal reporting. stuckCounted
    // latches so the once-ever "stuckTotal" tally counts distinct vehicles
    // that were EVER stuck, not repeated stop/go episodes at the same light.
    double stoppedDurationSec = 0.0;
    bool stuckCounted = false;
};

// Junction-edge groups ignore lane (vehicles aren't lane-differentiated once
// inside the junction box - see desiredLaneForStep's own doc comment), so
// `lane` is masked out whenever s.isJunction; the default lane=0 keeps every
// pre-existing junction-edge lookup site compiling unchanged.
static uint64_t edgeKey(const RouteStep& s, int lane = 0) {
    uint64_t l = s.isJunction ? 0 : (uint32_t)std::max(0, lane);
    return ((uint64_t)(s.isJunction ? 1 : 0) << 40) | (l << 32) | (uint32_t)s.edgeIndex;
}

// ---------------------------------------------------------------------------
// Discretionary lane changing (overtaking) - a chain edge with 2 simulated
// lanes is no longer a one-way commitment made once at edge entry
// (desiredLaneForStep still decides the lane REQUIRED to make the upcoming
// turn, but a vehicle may now drift into the other lane mid-edge to get
// around a slower leader, then merge back in time for its turn). Run once
// per tick, before grouping (see sim_engine.cpp's main loop step 1.5), on a
// small sorted-by-position list built per chain edge - this is deliberately
// plain O(n) neighbour scans rather than a maintained sorted structure,
// since even a busy 2-lane edge only ever holds a small number of vehicles
// at once.
// ---------------------------------------------------------------------------

struct LaneNeighbors { int aheadVi = -1, behindVi = -1; };

// Nearest vehicle ahead/behind `pos` in `lane`, among `sortedIdxs` (a chain
// edge's vehicles, any lane, sorted by distAlongEdge - see byChainEdge in
// the main loop). `selfVi` is excluded (a vehicle is never its own neighbour).
static LaneNeighbors findLaneNeighbors(const std::vector<int>& sortedIdxs, const std::vector<Vehicle>& vehicles,
                                        int lane, double pos, int selfVi) {
    LaneNeighbors out;
    double bestAheadPos = 1e18, bestBehindPos = -1e18;
    for (int vi : sortedIdxs) {
        if (vi == selfVi) continue;
        const Vehicle& o = vehicles[vi];
        if (o.lane != lane) continue;
        if (o.distAlongEdge >= pos) { if (o.distAlongEdge < bestAheadPos) { bestAheadPos = o.distAlongEdge; out.aheadVi = vi; } }
        else { if (o.distAlongEdge > bestBehindPos) { bestBehindPos = o.distAlongEdge; out.behindVi = vi; } }
    }
    return out;
}

// Selfish/assertive gap thresholds - deliberately tighter than a textbook
// lane-change model (which commonly wants 15-20m+ of clearance), per the
// same "a bit selfish" brief as profileFor. Merging back for a REQUIRED turn
// uses a smaller threshold still - a real driver noses in more insistently
// when they're about to miss their turn than when casually overtaking.
static constexpr double LANE_CHANGE_GAP_AHEAD_M = 5.0;
static constexpr double LANE_CHANGE_GAP_BEHIND_M = 6.0;
static constexpr double MERGE_BACK_GAP_AHEAD_M = 3.0;
static constexpr double MERGE_BACK_GAP_BEHIND_M = 4.0;
// A wide vehicle (see isWideVehicle) occupying the target lane needs
// proportionally more clearance to pull alongside - it can't be squeezed
// against as tightly as a car-sized gap would allow.
static constexpr double WIDE_NEIGHBOR_GAP_SCALE = 1.5;

static bool laneChangeSafe(const std::vector<int>& sortedIdxs, const std::vector<Vehicle>& vehicles,
                            const Vehicle& v, int selfVi, int targetLane, double gapAhead, double gapBehind) {
    LaneNeighbors n = findLaneNeighbors(sortedIdxs, vehicles, targetLane, v.distAlongEdge, selfVi);
    if (n.aheadVi >= 0) {
        const Vehicle& a = vehicles[n.aheadVi];
        double scale = isWideVehicle(a.width) ? WIDE_NEIGHBOR_GAP_SCALE : 1.0;
        if (a.distAlongEdge - a.length - v.distAlongEdge < gapAhead * scale) return false;
    }
    if (n.behindVi >= 0) {
        const Vehicle& b = vehicles[n.behindVi];
        double scale = isWideVehicle(b.width) ? WIDE_NEIGHBOR_GAP_SCALE : 1.0;
        if (v.distAlongEdge - v.length - b.distAlongEdge < gapBehind * scale) return false;
    }
    return true;
}

// Vehicle's current world position, plain-lerped along its current edge (no
// junction-turn curve bending - see road_graph.hpp's junctionEdgeCurvePoint
// for that refinement, used where a real curved path matters). Used by
// sim_engine.cpp's main loop to fill in EmergencyReport's gpsX/gpsY, and by
// visionCone below - this map's own coordinate space is
// itself a metric projection of real lon/lat (see osm_to_json.py's
// project()), so this IS the vehicle's GPS position, just not degrees.
struct VehiclePosition { double x, y; };
static VehiclePosition vehicleWorldPosition(const RoadGraph& rg, const Vehicle& v) {
    const RouteStep& cur = v.route[v.routeIdx];
    int fromNode = cur.isJunction ? rg.junctionEdges[cur.edgeIndex].from : rg.chainEdges[cur.edgeIndex].from;
    int toNode = cur.isJunction ? rg.junctionEdges[cur.edgeIndex].to : rg.chainEdges[cur.edgeIndex].to;
    double fx = rg.nodeX[fromNode], fy = rg.nodeY[fromNode], tx = rg.nodeX[toNode], ty = rg.nodeY[toNode];
    double t = cur.length > 1e-6 ? std::max(0.0, std::min(1.0, v.distAlongEdge / cur.length)) : 0.0;
    return {fx + (tx - fx) * t, fy + (ty - fy) * t};
}

// A vehicle's own heading right now, from its current edge's real endpoints
// (chain edges are straight; a junction edge's real curved tangent is
// road_graph.hpp's junctionEdgeCurvePoint's job, not needed for the plain
// "which way am I facing" queries visionCone's callers use).
static double vehicleHeading(const RoadGraph& rg, const Vehicle& v) {
    const RouteStep& cur = v.route[v.routeIdx];
    int fromNode = cur.isJunction ? rg.junctionEdges[cur.edgeIndex].from : rg.chainEdges[cur.edgeIndex].from;
    int toNode = cur.isJunction ? rg.junctionEdges[cur.edgeIndex].to : rg.chainEdges[cur.edgeIndex].to;
    return std::atan2(rg.nodeY[toNode] - rg.nodeY[fromNode], rg.nodeX[toNode] - rg.nodeX[fromNode]);
}

// ---------------------------------------------------------------------------
// Generic angle+range perception primitive - a real "look in this direction,
// over this cone, this far" query any driving decision can consult, rather
// than each decision (lane choice, junction entry) inventing its own ad hoc
// straight-line scan. Deliberately takes an already-bounded `candidates`
// list rather than scanning every vehicle on the map itself - callers keep
// this cheap by only ever offering genuinely relevant nearby vehicles (the
// same-edge list for a lane change, a junction's live occupants + rival
// approaches for a crossing decision - see sim_engine.cpp's
// visionGapIsSafe), so this stays O(bounded set) per query, never O(all
// vehicles).
// ---------------------------------------------------------------------------

struct VisionHit { int vi; double distM; double bearingRad; double closingSpeedMps; };

static std::vector<VisionHit> visionCone(const RoadGraph& rg, const std::vector<Vehicle>& vehicles,
                                          const std::vector<int>& candidates, double originX, double originY,
                                          double headingRad, double halfAngleRad, double rangeM, int selfVi) {
    std::vector<VisionHit> hits;
    for (int vi : candidates) {
        if (vi == selfVi || vi < 0 || (size_t)vi >= vehicles.size()) continue;
        const Vehicle& o = vehicles[vi];
        if (!o.active) continue;
        VehiclePosition op = vehicleWorldPosition(rg, o);
        double dx = op.x - originX, dy = op.y - originY;
        double dist = std::hypot(dx, dy);
        if (dist > rangeM) continue;
        double bearing = std::atan2(dy, dx) - headingRad;
        while (bearing > PI) bearing -= 2 * PI;
        while (bearing < -PI) bearing += 2 * PI;
        if (std::fabs(bearing) > halfAngleRad) continue;
        // Closing speed: the other vehicle's own velocity projected onto the
        // line FROM it back TO the origin - positive means it's approaching,
        // negative means it's pulling away. Used by sim_engine.cpp's
        // visionGapIsSafe to estimate WHEN (not just whether) a hit would
        // reach a shared conflict point - the piece a real driver's eyes
        // give them for free that a pure distance check can't.
        double oHeading = vehicleHeading(rg, o);
        double towardX = -dx / std::max(1e-6, dist), towardY = -dy / std::max(1e-6, dist);
        double closing = o.speed * (std::cos(oHeading) * towardX + std::sin(oHeading) * towardY);
        hits.push_back({vi, dist, bearing, closing});
    }
    return hits;
}

// ---------------------------------------------------------------------------
// Optional "vision + mini-pathfinding" lane-choice mode (toggleable - see
// --advanced-lane-ai / the {"cmd":"setAdvancedLaneAI"} command, off by
// default). The default heuristic above only reacts to the immediate
// leader; this instead scores each candidate lane by summing up the
// slowdown every vehicle within a forward vision cone would impose, weighted
// by how close it is - a small stand-in for a real perception+planning
// stack, deliberately not a full graph search (this is a 2-lane choice, not
// a routing problem) but a genuine look-ahead rather than a single-neighbour
// reaction. Costs more per vehicle per tick than the default heuristic
// (scans every same-edge vehicle instead of just the nearest one), which is
// exactly why it's opt-in rather than replacing the default outright. Uses
// the same generic visionCone() a junction-crossing decision does (see
// sim_engine.cpp's visionGapIsSafe) - a narrow forward cone here, since a
// lane change only cares about traffic roughly ahead in the target lane, not
// to the side or behind.
// ---------------------------------------------------------------------------

static constexpr double VISION_RANGE_M = 50.0;
static constexpr double LANE_VISION_HALF_ANGLE_RAD = 0.45; // ~26 degrees either side of straight ahead

static double laneVisionCost(const RoadGraph& rg, const std::vector<int>& sortedIdxs, const std::vector<Vehicle>& vehicles,
                              int lane, const Vehicle& self, int selfVi, double desiredSpeed) {
    std::vector<int> laneMates;
    laneMates.reserve(sortedIdxs.size());
    for (int vi : sortedIdxs) if (vi != selfVi && vehicles[vi].lane == lane) laneMates.push_back(vi);

    VehiclePosition origin = vehicleWorldPosition(rg, self);
    double headingRad = vehicleHeading(rg, self);
    auto hits = visionCone(rg, vehicles, laneMates, origin.x, origin.y, headingRad, LANE_VISION_HALF_ANGLE_RAD, VISION_RANGE_M, selfVi);

    double cost = 0.0;
    for (auto& h : hits) {
        if (h.distM < 0) continue; // behind (shouldn't happen in a forward cone, defensive)
        double slowdown = std::max(0.0, desiredSpeed - vehicles[h.vi].speed);
        double proximityWeight = std::max(0.0, (VISION_RANGE_M - h.distM) / VISION_RANGE_M);
        cost += slowdown * proximityWeight;
    }
    return cost;
}
