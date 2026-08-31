#pragma once

// Road network model for the "traffic light revamped" simulation engine
// (backend/sim/sim_engine.cpp) - the map/graph data BOTH vehicles.hpp
// (routing/physics) and sim_engine.cpp's own main loop (junction
// arbitration) read, built once at startup and never mutated except for
// each JunctionInfo's own tiny inFlight arbitration log. Deliberately
// depends on redlights.hpp only for the static SignalConfig/
// RedlightGroupConfig types (a junction's own configuration is map data);
// it does NOT depend on vehicles.hpp - nothing here knows a Vehicle or
// RouteStep exists, keeping the dependency graph one-directional:
// redlights.hpp <- road_graph.hpp <- vehicles.hpp <- sim_engine.cpp.
//
// Domain note this file MUST stay in lockstep with: real junctions in this
// map format are NOT shared node ids - osm_to_json.py pulls every road's end
// back a couple of metres from the junction it meets and tags all those
// pulled-back endpoints with a shared tags.join_group (a small clique per
// junction). backend/ch/ch_preprocess.cpp's own header comment documents
// this and builds its routing graph the same way; RoadGraph below
// deliberately mirrors that exact topology (chain edges along each way +
// junction clique edges from shared join_group) so that every hop in a CH
// query's unpacked path is guaranteed to resolve to a real edge here - see
// vehicles.hpp's resolveRoute()'s "CH path hop not resolvable" error, which
// would only ever fire if this graph drifted out of sync with
// ch_preprocess.cpp's rules. (Unlike ch_preprocess.cpp, this file does NOT
// need the divided-road #fwd/#bwd twin-node splitting - that only existed to
// keep the CH's OWN search from switching carriageway mid-way; once a path
// is fully resolved, walking it by real node id is equivalent and simpler
// here.)

#include <algorithm>
#include <cmath>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "../ch/json.hpp"
#include "redlights.hpp"

static double dist2d(double ax, double ay, double bx, double by) {
    double dx = ax - bx, dy = ay - by;
    return std::sqrt(dx * dx + dy * dy);
}

// ---------------------------------------------------------------------------
// Domain rules shared with backend/ch/ch_preprocess.cpp's buildGraph() - kept
// as an intentional, documented duplication (see file header) rather than a
// shared header, since ch_preprocess.cpp's own Graph type has no room for the
// richer per-edge metadata (wayId, lanes, highway class) this file needs and
// is explicitly "permanent, standalone routing infrastructure" not meant to
// be reshaped for a second consumer. If either copy's rules change, the
// other must change with it.
// ---------------------------------------------------------------------------

static bool isRoutableHighway(const std::string& hw) {
    static const std::unordered_set<std::string> excluded = {
        "footway", "path", "steps", "track", "cycleway", "pedestrian",
        "bridleway", "construction", "proposed", "platform", "elevator",
        "corridor", "razed", "raceway",
    };
    if (hw.empty()) return false;
    return excluded.find(hw) == excluded.end();
}

static double fallbackSpeedKmh(const std::string& hw) {
    static const std::unordered_map<std::string, double> table = {
        {"motorway", 90}, {"trunk", 60}, {"primary", 60}, {"secondary", 60},
        {"tertiary", 60}, {"unclassified", 60},
        {"motorway_link", 45}, {"trunk_link", 30}, {"primary_link", 30},
        {"secondary_link", 30}, {"tertiary_link", 30},
        {"residential", 35}, {"living_street", 27}, {"service", 35},
    };
    auto it = table.find(hw);
    return it != table.end() ? it->second : 30.0;
}

static double parseSpeedTag(const std::optional<std::string>& s) {
    if (!s) return -1.0;
    try {
        size_t pos = 0;
        double v = std::stod(*s, &pos);
        return v > 0 ? v : -1.0;
    } catch (...) {
        return -1.0;
    }
}

// New in this file (ch_preprocess.cpp has no concept of this - CH routing
// only cares about travel time, not who yields to whom): a coarse road-class
// priority ranking used by unsignalized-junction arbitration in
// sim_engine.cpp's main loop. Higher wins.
static int highwayPriorityRank(const std::string& hw) {
    static const std::unordered_map<std::string, int> table = {
        {"motorway", 6}, {"motorway_link", 6},
        {"trunk", 5}, {"trunk_link", 5},
        {"primary", 4}, {"primary_link", 4},
        {"secondary", 3}, {"secondary_link", 3},
        {"tertiary", 2}, {"tertiary_link", 2},
        {"unclassified", 1}, {"residential", 1}, {"living_street", 1}, {"service", 1},
    };
    auto it = table.find(hw);
    return it != table.end() ? it->second : 0;
}

static constexpr double TURN_SPEED_MPS = 15.0 / 3.6;         // matches ch_preprocess.cpp's TURN_SPEED_KMH
static constexpr double DEFAULT_LANE_WIDTH_M = 3.2;           // matches front-end/settings.js's Config.defaultLaneWidth - a way's own tags.lane_width (see buildRoadGraph) overrides this exactly as map-core.js's wayPhysicalWidth does
static constexpr double MIN_DISCHARGE_GAP_SEC = 1.2;          // minimum headway between successive discharges at an unsignalized junction - shortened along with the rest of the "selfish driver" tuning, see vehicles.hpp's profileFor
// A vehicle's effective priority at an unsignalized junction climbs the
// longer it's waited (see sim_engine.cpp's main loop step 3), so a low-class
// approach isn't starved forever behind a busier cross-street - a real,
// impatient driver eventually just goes. This is also what makes the
// simulation useful for spotting where a real traffic light is needed: a
// junction that still backs up even with drivers this willing to push in is
// a genuine candidate, not an artifact of overly-polite simulated drivers.
static constexpr double IMPATIENCE_SEC = 6.0;
// How far before a chain edge's end (the pulled-back junction node - see
// this file's header) a blocked vehicle actually stops, so it doesn't sit
// rendered/logically inside the visual intersection footprint (map-core.js
// draws its own junction clearance ring starting at JUNCTION_SETBACK_M=1.5m
// back from that same node, growing further for wide/crowded junctions -
// this is a fixed approximation of that rather than a full port of its
// crowding-growth algorithm, which is a purely cosmetic computation not
// worth duplicating in the physics engine).
static constexpr double STOP_LINE_SETBACK_M = 2.0;
// Minimum clearance a route's first edge/lane must have near position 0
// before a new trip is allowed to spawn onto it - see vehicles.hpp/
// sim_engine.cpp's spawn step. Sized to comfortably clear even a long
// truck/bus, not just a car.
static constexpr double SPAWN_CLEARANCE_M = 10.0;

// New in this file: classifies a turn at a junction as "through" (straight
// or the traffic-keeps-left-side turn, which in this left-hand-traffic map -
// see osm_to_json.py's project(), x east-positive/y north-positive, and this
// map's real-world location - never crosses oncoming traffic) or "right"
// (crosses oncoming traffic, needs the dedicated protected lamp) - matching
// the two lamps front-end/redlight.js's paired4way scheme actually has. The
// source project never needed this itself (a human places lamps by hand in
// the editor); this is a geometric convention this file introduces so a
// simulated vehicle's actual turn can be matched to the right lamp. A CCW
// turn from the arrival direction to the departure direction is a left turn
// (through-compatible); anything meaningfully CW is a right turn. A small
// epsilon avoids misclassifying a nearly-straight move as "right" from
// floating-point noise.
// The u-turn check comes first and uses the dot product directly: near
// dot=-1 (arrival and departure nearly opposite) the cross-product's SIGN is
// dominated by floating-point noise, which used to misclassify u-turns as
// "right" or "through" at random - a real bug, not just cosmetic, since
// movement also drives the signal-timing lookup (see redlights.hpp's
// getPairedColor) and, now, lane choice (see vehicles.hpp's
// desiredLaneForStep). U-turns happen at this map's divided roads, where the
// two carriageways are separate ways that still share a join_group at the
// crossing point.
static std::string classifyMovement(double arrDirX, double arrDirY, double depDirX, double depDirY) {
    double dot = arrDirX * depDirX + arrDirY * depDirY;
    if (dot < -0.7) return "uturn";
    double cross = arrDirX * depDirY - arrDirY * depDirX;
    double angle = std::atan2(cross, dot);
    return (angle < -0.1) ? "right" : "through";
}

// The physical speed a vehicle can carry through a junction crossing depends
// on how sharp the turn is, not just the junction's approach roads' own
// speed (see JunctionInfo::approachSpeedMps, the average of those) - through
// traffic barely needs to slow, a right turn crosses oncoming traffic and
// must slow more, a u-turn is the sharpest turn there is.
static double movementSpeedFactor(const std::string& movement) {
    if (movement == "through") return 1.0;
    if (movement == "uturn") return 0.35;
    return 0.55; // "right"
}

// ---------------------------------------------------------------------------
// RoadGraph: nodes + directed edges built straight from map_data.json,
// mirroring ch_preprocess.cpp's buildGraph topology (see file header) but
// carrying the extra per-edge metadata simulation physics/signals need.
// ---------------------------------------------------------------------------

struct ChainEdge {
    int from, to;
    std::string wayId;
    double lengthM;
    double freeFlowSpeedMps;
    int lanes;              // raw tags.lanes - total across BOTH directions on a two-way road (matches map-core.js's wayPhysicalWidth convention), or this direction's own count on a one-way road
    int lanesPerDirection;  // lanes actually usable going THIS way - see simLaneCount/buildRoadGraph
    double laneWidthM;
    // Offset from the way's own node-chain (its geometric centreline) to the
    // centre of THIS direction's carriageway, toward the LEFT of travel
    // (this map's left-hand-traffic convention) - 0 for a one-way road
    // (the whole road is "my" carriageway, no divider to sit on top of).
    // See buildRoadGraph's own comment for why this exists.
    double carriagewayCenterOffsetM;
    int highwayRank;
};

struct JunctionEdge {
    int from, to;
    std::string fromWayId;   // arrival approach - signal/priority lookup key
    std::string toWayId;     // departure approach
    std::string movement;    // "through" | "right" | "uturn"
    double lengthM;
    double speedMps;
    int junctionIdx;
    int priorityRank;        // = highway rank of fromWayId
    // Unit tangent direction the vehicle is already travelling in on
    // arrival (same as the departing-way direction used by
    // classifyMovement) and the one it needs to be travelling in on
    // departure - used only for sim_engine.cpp's buildStateJson curved-turn
    // rendering (see its own comment), not by any physics/routing here.
    double arrDirX = 0, arrDirY = 0, depDirX = 0, depDirY = 0;
};

struct OutEdgeRef { bool isJunction; int index; };

// One unsignalized-junction crossing currently "in flight" - tracked per
// junction instead of a single busyUntil scalar so genuinely non-conflicting
// movements (see movementsCompatible below) can occupy the same junction at
// once. This is the "width of the intersection should let more than one
// vehicle through" fix: a wide/multi-arm junction naturally ends up with
// several of these active simultaneously, a narrow single-lane T-junction
// still only ever has one (nothing to run it alongside).
struct JctFlight {
    double freeAt;
    std::string fromWayId, movement, toWayId;
    double arrDirX, arrDirY;
};

struct JunctionInfo {
    std::string joinGroupId;
    int primaryNodeIdx;
    std::vector<int> memberIndices;
    SignalConfig signal;
    // Average free-flow speed of the roads that actually meet here (see
    // buildRoadGraph) - the basis for each JunctionEdge's own speed cap
    // (movementSpeedFactor scales it down per turn sharpness). Defaults to
    // the old flat constant if no approach way was found.
    double approachSpeedMps = TURN_SPEED_MPS;
    // Runtime arbitration state (unsignalized junctions only) - see
    // sim_engine.cpp's main loop step 3: any number of vehicles may be in
    // flight at once as long as every pair is geometrically compatible
    // (same-approach different lane, or opposite approaches both going
    // straight/left), each gated by its own MIN_DISCHARGE_GAP_SEC headway.
    // Genuinely conflicting movements (crossing approaches, or anything
    // crossing oncoming traffic) still serialize - flow-channel fidelity,
    // not full conflict-point geometry.
    std::vector<JctFlight> inFlight;
    // This junction's own JunctionEdges, by index into rg.junctionEdges -
    // populated in buildRoadGraph alongside the existing junction-edge push
    // loop. Lets sim_engine.cpp's vision-based admission fallback (see its
    // own header comment) find this junction's REAL live occupants in O(1)
    // via the main loop's `groups` map instead of scanning every
    // JunctionEdge in the whole map - real ground-truth positions, not a
    // predicted freeAt timer.
    std::vector<int> edgeIndices;
};

struct RoadGraph {
    std::vector<std::string> nodeId;
    std::vector<double> nodeX, nodeY;
    std::unordered_map<std::string, int> indexOf;
    std::vector<ChainEdge> chainEdges;
    std::vector<JunctionEdge> junctionEdges;
    std::vector<std::vector<OutEdgeRef>> outAdj;
    std::vector<JunctionInfo> junctions;
    std::unordered_map<std::string, int> junctionIndexByGroupId;
    std::unordered_map<std::string, RedlightGroupConfig> redlightGroups;
    // Live per-chain-edge speed, parallel to chainEdges - starts at each
    // edge's freeFlowSpeedMps and is nudged every tick by sim_engine.cpp's
    // main loop toward the average speed of whatever's actually on it right now
    // (see that update site's own comment). Feeds vehicles.hpp's
    // liveWeightedRoute so a vehicle's periodic reroute ("the CH path is a
    // suggestion" - see Vehicle::destNodeId/nextRerouteAt) actually reacts
    // to live congestion instead of the same static weights the one-time CH
    // query already used.
    std::vector<float> chainEdgeLiveSpeed;
};

// At most 2 SIMULATED lanes per direction regardless of ce.lanesPerDirection
// (see vehicles.hpp's desiredLaneForStep) - a flat cap so a road tagged with
// an unusually high lane count doesn't add a third lane's worth of
// complexity; in practice almost every two-way road in this map has
// lanesPerDirection==1 (see buildRoadGraph - lanes is a TOTAL across both
// directions), so this mostly matters for one-way roads tagged lanes>=2.
static int simLaneCount(const ChainEdge& ce) { return std::min(2, std::max(1, ce.lanesPerDirection)); }

static RoadGraph buildRoadGraph(const JsonValue& root) {
    RoadGraph rg;
    const JsonValue* nodesJson = root.find("nodes");
    const JsonValue* waysJson = root.find("ways");
    if (!nodesJson || nodesJson->type != JsonValue::Type::Object) throw std::runtime_error("map_data.json missing 'nodes' object");
    if (!waysJson || waysJson->type != JsonValue::Type::Array) throw std::runtime_error("map_data.json missing 'ways' array");

    std::unordered_map<std::string, const JsonValue*> nodeById;
    nodeById.reserve(nodesJson->objVal.size() * 2);
    for (auto& kv : nodesJson->objVal) nodeById.emplace(kv.first, &kv.second);

    auto getOrCreateNode = [&](const std::string& id) -> int {
        auto it = rg.indexOf.find(id);
        if (it != rg.indexOf.end()) return it->second;
        int idx = (int)rg.nodeId.size();
        rg.indexOf.emplace(id, idx);
        rg.nodeId.push_back(id);
        auto nit = nodeById.find(id);
        rg.nodeX.push_back(nit != nodeById.end() ? nit->second->num("x").value_or(0.0) : 0.0);
        rg.nodeY.push_back(nit != nodeById.end() ? nit->second->num("y").value_or(0.0) : 0.0);
        rg.outAdj.emplace_back();
        return idx;
    };

    // Per node, the (wayId, outwardDirX, outwardDirY) of every way for which
    // this node is a terminal (way-endpoint) vertex - "outward" meaning away
    // from this endpoint, further into the way. A join_group member should
    // always be the terminal of exactly one routable way (that's what makes
    // it "the pulled-back point for that approach"); a vector defends against
    // the rare/malformed case of more than one.
    std::unordered_map<int, std::vector<std::tuple<std::string, double, double>>> terminalOutward;
    std::unordered_map<std::string, int> wayHighwayRank;
    std::unordered_map<std::string, double> wayFreeFlowSpeed;

    long long chainEdgeCount = 0, skippedWays = 0;
    for (auto& wayVal : waysJson->arrVal) {
        const JsonValue* tags = wayVal.find("tags");
        const JsonValue* nodesArr = wayVal.find("nodes");
        if (!nodesArr || nodesArr->type != JsonValue::Type::Array || nodesArr->arrVal.size() < 2) continue;
        auto wayIdOpt = wayVal.str("id");
        std::string wayId = wayIdOpt.value_or("");

        std::string highway = tags ? tags->str("highway").value_or("") : "";
        if (!isRoutableHighway(highway)) { skippedWays++; continue; }
        std::string access = tags ? tags->str("access").value_or("") : "";
        if (access == "no") { skippedWays++; continue; }

        double speedKmh = -1.0;
        if (tags) {
            speedKmh = parseSpeedTag(tags->str("avg_max_speed"));
            if (speedKmh < 0) speedKmh = parseSpeedTag(tags->str("maxspeed"));
        }
        if (speedKmh < 0) speedKmh = fallbackSpeedKmh(highway);
        double speedMps = speedKmh / 3.6;
        if (speedMps < 0.1) { skippedWays++; continue; }

        int lanes = 1;
        if (tags) {
            auto lv = tags->str("lanes");
            if (lv) { try { lanes = std::max(1, std::stoi(*lv)); } catch (...) {} }
        }
        double laneWidthM = DEFAULT_LANE_WIDTH_M;
        if (tags) {
            auto lw = tags->str("lane_width");
            if (lw) { try { double v = std::stod(*lw); if (v > 0) laneWidthM = v; } catch (...) {} }
        }
        int rank = highwayPriorityRank(highway);
        wayHighwayRank[wayId] = rank;
        wayFreeFlowSpeed[wayId] = speedMps;

        std::string oneway = tags ? tags->str("oneway").value_or("") : "";
        std::string junction = tags ? tags->str("junction").value_or("") : "";
        bool forward = true, backward = true;
        if (oneway == "yes") backward = false;
        else if (oneway == "-1") forward = false;
        else if (oneway != "no" && junction == "roundabout") backward = false;

        // `lanes` is the road's TOTAL lane count across both directions on a
        // two-way road (matching map-core.js's wayPhysicalWidth, which this
        // mirrors so vehicles line up with what the map actually draws) -
        // NOT how many lanes are usable going any one way. A two-way road's
        // own node chain runs down its geometric centreline (the same
        // points map-core.js draws a divider ON, for a divided=yes road),
        // so without carriagewayCenterOffsetM a vehicle going either
        // direction would render straddling that centreline/divider -
        // exactly the "cars sit on top of the divider" bug this fixes.
        bool twoWay = forward && backward;
        int lanesPerDirection = twoWay ? std::max(1, lanes / 2) : lanes;
        double carriagewayCenterOffsetM = twoWay ? (lanes * laneWidthM) / 4.0 : 0.0;

        std::vector<int> chain;
        chain.reserve(nodesArr->arrVal.size());
        bool ok = true;
        for (auto& nv : nodesArr->arrVal) {
            if (nv.type != JsonValue::Type::String || !nodeById.count(nv.strVal)) { ok = false; break; }
            chain.push_back(getOrCreateNode(nv.strVal));
        }
        if (!ok || chain.size() < 2) { skippedWays++; continue; }

        for (size_t k = 0; k + 1 < chain.size(); ++k) {
            double d = dist2d(rg.nodeX[chain[k]], rg.nodeY[chain[k]], rg.nodeX[chain[k + 1]], rg.nodeY[chain[k + 1]]);
            if (forward) {
                rg.chainEdges.push_back({chain[k], chain[k + 1], wayId, d, speedMps, lanes, lanesPerDirection, laneWidthM, carriagewayCenterOffsetM, rank});
                rg.outAdj[chain[k]].push_back({false, (int)rg.chainEdges.size() - 1});
                chainEdgeCount++;
            }
            if (backward) {
                rg.chainEdges.push_back({chain[k + 1], chain[k], wayId, d, speedMps, lanes, lanesPerDirection, laneWidthM, carriagewayCenterOffsetM, rank});
                rg.outAdj[chain[k + 1]].push_back({false, (int)rg.chainEdges.size() - 1});
                chainEdgeCount++;
            }
        }

        auto recordTerminal = [&](int nodeIdx, int neighborIdx) {
            double dx = rg.nodeX[neighborIdx] - rg.nodeX[nodeIdx], dy = rg.nodeY[neighborIdx] - rg.nodeY[nodeIdx];
            double len = std::max(1e-6, std::hypot(dx, dy));
            terminalOutward[nodeIdx].push_back({wayId, dx / len, dy / len});
        };
        recordTerminal(chain[0], chain[1]);
        recordTerminal(chain.back(), chain[chain.size() - 2]);
    }

    // Junction cliques from shared tags.join_group - see file header. Only
    // nodes already registered (touched by a routable way) participate,
    // matching ch_preprocess.cpp's own rule.
    std::unordered_map<std::string, std::vector<int>> groups;
    for (auto& kv : rg.indexOf) {
        auto nit = nodeById.find(kv.first);
        if (nit == nodeById.end()) continue;
        const JsonValue* tags = nit->second->find("tags");
        if (!tags) continue;
        auto jg = tags->str("join_group");
        if (jg) groups[*jg].push_back(kv.second);
    }

    rg.junctions.reserve(groups.size());
    long long junctionEdgeCount = 0;
    for (auto& [gid, membersRaw] : groups) {
        std::vector<int> members = membersRaw;
        std::sort(members.begin(), members.end(), [&](int a, int b) { return rg.nodeId[a] < rg.nodeId[b]; });

        // Primary: whichever member carries a `signal` object (matches
        // front-end/map-core.js's junctionPrimary); else the lowest id.
        int primary = members[0];
        for (int idx : members) {
            auto nit = nodeById.find(rg.nodeId[idx]);
            if (nit != nodeById.end() && nit->second->find("signal")) { primary = idx; break; }
        }

        JunctionInfo info;
        info.joinGroupId = gid;
        info.primaryNodeIdx = primary;
        info.memberIndices = members;
        auto pnit = nodeById.find(rg.nodeId[primary]);
        info.signal = parseSignal(pnit != nodeById.end() ? pnit->second->find("signal") : nullptr);

        // Max intersection speed = the average free-flow speed of the roads
        // that actually meet here (this map's real junctions are typically
        // 3-4 approaches - see terminalOutward) rather than a flat constant,
        // so a junction of two 60kph roads lets through traffic move faster
        // than one between two 30kph residential streets.
        {
            std::unordered_set<std::string> approachWays;
            for (int m : members) {
                auto it = terminalOutward.find(m);
                if (it != terminalOutward.end())
                    for (auto& entry : it->second) approachWays.insert(std::get<0>(entry));
            }
            double sumSpeed = 0; int nSpeed = 0;
            for (auto& wid : approachWays) {
                auto sit = wayFreeFlowSpeed.find(wid);
                if (sit != wayFreeFlowSpeed.end()) { sumSpeed += sit->second; nSpeed++; }
            }
            if (nSpeed > 0) info.approachSpeedMps = sumSpeed / nSpeed;
        }

        int junctionIdx = (int)rg.junctions.size();
        rg.junctionIndexByGroupId[gid] = junctionIdx;
        rg.junctions.push_back(std::move(info));

        if (members.size() < 2) continue; // a lone member has nothing to cross to

        double approachSpeedMps = rg.junctions[junctionIdx].approachSpeedMps;
        for (int a : members) {
            for (int b : members) {
                if (a == b) continue;
                double d = dist2d(rg.nodeX[a], rg.nodeY[a], rg.nodeX[b], rg.nodeY[b]);

                std::string fromWayId, toWayId;
                double arrDirX = 0, arrDirY = 0, depDirX = 0, depDirY = 0;
                auto itA = terminalOutward.find(a);
                if (itA != terminalOutward.end() && !itA->second.empty()) {
                    auto& [wid, ox, oy] = itA->second[0];
                    fromWayId = wid; arrDirX = -ox; arrDirY = -oy; // arrival = opposite of outward-away-from-junction
                }
                auto itB = terminalOutward.find(b);
                if (itB != terminalOutward.end() && !itB->second.empty()) {
                    auto& [wid, ox, oy] = itB->second[0];
                    toWayId = wid; depDirX = ox; depDirY = oy;
                }

                JunctionEdge je;
                je.from = a; je.to = b;
                je.fromWayId = fromWayId; je.toWayId = toWayId;
                je.arrDirX = arrDirX; je.arrDirY = arrDirY; je.depDirX = depDirX; je.depDirY = depDirY;
                je.movement = classifyMovement(arrDirX, arrDirY, depDirX, depDirY);
                je.lengthM = d;
                je.speedMps = std::max(TURN_SPEED_MPS * 0.5, movementSpeedFactor(je.movement) * approachSpeedMps);
                je.junctionIdx = junctionIdx;
                je.priorityRank = fromWayId.empty() ? 0 : wayHighwayRank[fromWayId];

                rg.junctionEdges.push_back(je);
                rg.junctions[junctionIdx].edgeIndices.push_back((int)rg.junctionEdges.size() - 1);
                rg.outAdj[a].push_back({true, (int)rg.junctionEdges.size() - 1});
                junctionEdgeCount++;
            }
        }
    }

    // Live congestion tracking starts at each edge's own free-flow speed
    // (i.e. "no congestion observed yet") - see RoadGraph::chainEdgeLiveSpeed's
    // own comment for who updates this per tick and who reads it.
    rg.chainEdgeLiveSpeed.resize(rg.chainEdges.size());
    for (size_t i = 0; i < rg.chainEdges.size(); ++i) rg.chainEdgeLiveSpeed[i] = (float)rg.chainEdges[i].freeFlowSpeedMps;

    std::cerr << "[sim] road graph: " << rg.nodeId.size() << " nodes, " << chainEdgeCount << " chain edges, "
              << junctionEdgeCount << " junction edges, " << rg.junctions.size() << " junctions ("
              << std::count_if(rg.junctions.begin(), rg.junctions.end(), [](const JunctionInfo& j) { return j.signal.present; })
              << " signalized), " << skippedWays << " ways skipped (non-routable/invalid)\n";
    return rg;
}

// A JunctionEdge connects two DIFFERENT approach nodes with a straight line
// (geometrically correct for routing/distance), which a real vehicle instead
// sweeps through as a curve - this bends the point at parameter t in [0,1]
// into a quadratic Bezier whose tangents match the real arrival/departure
// directions (je.arrDir/depDir, from classifyMovement's own geometry), with
// the control point at wherever those two tangent lines actually cross.
// Extracted here (rather than living only in sim_engine.cpp's buildStateJson,
// which needs it for rendering) so the vision-based junction-admission check
// can query the SAME real curved path real vehicles are drawn following,
// instead of a second, potentially-drifting copy of this math. A "through"
// movement's arrival/departure directions are nearly identical, so that
// crossing point is degenerate/far away - caught by the determinant/sanity
// checks below, which simply fall back to the straight line (correct -
// there's no visible turn to smooth there anyway).
struct JunctionCurvePoint { double x, y, headingRad; };
static JunctionCurvePoint junctionEdgeCurvePoint(const JunctionEdge& je, double fx, double fy, double tx, double ty,
                                                  double lengthM, double t) {
    double x = fx + (tx - fx) * t, y = fy + (ty - fy) * t;
    double heading = std::atan2(ty - fy, tx - fx);
    double dx = tx - fx, dy = ty - fy;
    double det = je.arrDirX * je.depDirY - je.arrDirY * je.depDirX;
    if (std::fabs(det) > 1e-6) {
        double s = (dx * je.depDirY - dy * je.depDirX) / det;
        double maxS = std::max(1.0, lengthM * 3.0);
        if (s > 0.05 && s < maxS) {
            double p1x = fx + je.arrDirX * s, p1y = fy + je.arrDirY * s;
            double omt = 1.0 - t;
            x = omt * omt * fx + 2 * omt * t * p1x + t * t * tx;
            y = omt * omt * fy + 2 * omt * t * p1y + t * t * ty;
            double tanX = 2 * omt * (p1x - fx) + 2 * t * (tx - p1x);
            double tanY = 2 * omt * (p1y - fy) + 2 * t * (ty - p1y);
            if (std::hypot(tanX, tanY) > 1e-6) heading = std::atan2(tanY, tanX);
        }
    }
    return {x, y, heading};
}

static void parseRedlightGroups(const JsonValue& root, RoadGraph& rg) {
    const JsonValue* arr = root.find("redlightGroups");
    if (!arr || arr->type != JsonValue::Type::Array) return;
    for (auto& g : arr->arrVal) {
        auto id = g.str("id");
        if (!id) continue;
        RedlightGroupConfig cfg;
        cfg.turnSec = g.num("turnSec").value_or(30.0);
        const JsonValue* members = g.find("memberIds");
        if (members && members->type == JsonValue::Type::Array)
            for (auto& m : members->arrVal) if (m.type == JsonValue::Type::String) cfg.memberIds.push_back(m.strVal);
        rg.redlightGroups[*id] = std::move(cfg);
    }
}

// Whether two unsignalized-junction (or, under EmergencyOnly/Density mode, a
// signalized junction's own arbitration - see redlights.hpp's SignalMode)
// candidate movements can occupy the junction at the same time - see
// sim_engine.cpp's main loop step 3 for the full reasoning. Hoisted to a
// free function so sim_engine.cpp's buildStateJson can reuse the exact same
// rule to report live lamp colors under those two modes, rather than
// keeping a second copy in sync by hand.
//
// NOTE (kept as history so this mistake doesn't get re-made): an earlier
// version of this function replaced the rules below with a general
// arrival/departure "chord crossing" geometric test, meant to handle
// irregular junction shapes better than a fixed 4-way assumption. It was
// wrong - hand-verifying it against the single most important conflict case
// (an approach's protected right/crossing turn against the OPPOSITE
// approach's through traffic, the textbook reason protected-turn phases
// exist at all) showed it incorrectly called that pairing safe. A chord
// between two arm positions is not a faithful model of a real curved
// turning path, and this is exactly the kind of function where "elegant but
// unverified" is worse than "conservative and standard" - so this reverts
// to the established traffic-engineering rule set below, which every case
// was hand-checked against instead of just one.
//   - Same approach, different lane: always compatible (the established
//     assumption that a right/u-turning vehicle peels away from its own
//     approach's through lane before their paths would otherwise meet).
//   - Opposite approaches (arrival directions within ~135-180deg of each
//     other) both going "through" (straight, or this map's left-hand-
//     traffic non-crossing turn - see classifyMovement): their paths run
//     parallel down the middle of the junction and never cross, and by
//     definition arrive at DIFFERENT (opposite) exit arms.
//   - Opposite approaches BOTH turning "right" (the crossing turn in this
//     left-hand-traffic map) AND departing onto DIFFERENT ways: at a clean
//     4-way cross this is automatically true and each arcs to the far side
//     away from the other, like a real dual-protected-turn phase; the
//     explicit different-destination check is what keeps this safe at an
//     irregular/5+-arm junction too, where two "opposite-ish" approaches
//     turning the same way could otherwise converge onto the same arm - a
//     real collision risk caught by inspection in this map's own busiest
//     signalized junction, which has more physical arms than a plain cross.
//   - Anything else - u-turns, or ANY mix of "through" and "right" across
//     different approaches (opposite or not) - always serializes. A
//     crossing turn from one approach always conflicts with through traffic
//     from the opposite approach; that's the textbook justification for a
//     protected right/left-turn phase existing in the first place.
static bool movementsCompatible(const std::string& fromA, const std::string& moveA, double axA, double ayA,
                                 const std::string& toWayA, const std::string& fromB, const std::string& moveB,
                                 double axB, double ayB, const std::string& toWayB) {
    if (fromA == fromB) return true;
    if (moveA != moveB) return false;
    double dot = axA * axB + ayA * ayB;
    if (dot >= -0.7) return false;
    if (moveA == "through") return true;
    if (moveA == "right") return toWayA != toWayB;
    return false; // uturn (or anything else) never compatible across approaches
}
