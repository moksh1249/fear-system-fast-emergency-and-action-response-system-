// Headless traffic simulation engine for the "traffic light revamped" project
// (Phase 2 of the simulation plan - no networking yet, see the project's own
// plan doc; Phase 3 adds a WebSocket server + live rendering on top of this).
//
// Usage:
//   sim_engine.exe <map_data.json> <map_data.ch.bin> <vehicles.json>
//                  [--sim-seconds N] [--concurrency N] [--ramp-seconds N]
//                  [--stats-interval N] [--track-vehicle ID]
//
// What this does:
//   - Loads the road network straight from map_data.json (nodes/ways/tags) -
//     NOT from map_data.ch.bin, which only stores a compact routing graph
//     with no per-edge metadata (wayId, lanes, highway class, signal
//     objects...) that the simulation physics/signals need. See RoadGraph
//     below.
//   - Loads map_data.ch.bin and runs the existing bidirectional-Dijkstra CH
//     query in-process (backend/ch/ch_graph.hpp) to give each vehicle its
//     ONE-TIME shortest route at the moment it spawns - never recomputed
//     mid-trip, per the project's own routing requirement.
//   - Loads backend/generate_vehicles.py's trip manifest (vehicles.json) and
//     spawns vehicles from it, ramping up to a target concurrent count.
//   - Runs a fixed-timestep (20 Hz) car-following simulation: IDM
//     (Intelligent Driver Model) acceleration/braking so no vehicle ever
//     teleports to speed or stops instantly, a direct C++ port of
//     front-end/redlight.js's fixed-time phase math for signalized
//     junctions (the "default" mode), and a road-class-priority +
//     first-come-first-served + minimum-discharge-gap arbitration for the
//     much more common unsignalized junctions (2841 of this map's 2844
//     junctions currently have no configured signal at all).
//   - Prints periodic stats to stdout/stderr and a final summary - no
//     websocket, no frontend, by design (see the plan's phase breakdown).
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
// resolveRoute()'s "CH path hop not resolvable" error, which would only ever
// fire if this graph drifted out of sync with ch_preprocess.cpp's rules.
// (Unlike ch_preprocess.cpp, this file does NOT need the divided-road
// #fwd/#bwd twin-node splitting - that only existed to keep the CH's OWN
// search from switching carriageway mid-way; once a path is fully resolved,
// walking it by real node id is equivalent and simpler here.)

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <functional>
#include <iomanip>
#include <iostream>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <winsock2.h>
#include <ws2tcpip.h>
#include <timeapi.h>

#include "../ch/json.hpp"
#include "../ch/ch_graph.hpp"

using Clock = std::chrono::steady_clock;
static double elapsedMs(Clock::time_point t0) {
    return std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
}

static double dist2d(double ax, double ay, double bx, double by) {
    double dx = ax - bx, dy = ay - by;
    return std::sqrt(dx * dx + dy * dy);
}

// Windows' default scheduler timer granularity is commonly ~15ms, which
// std::this_thread::sleep_for rounds up to - even the main loop's ordinary
// per-tick sleep (see step 7) is a nominal ~50ms, so that overshoot alone
// was measured costing the real-time pacing loop a consistent ~15-20% of
// its target rate at EVERY speedMultiplier, not just the very short sleeps
// the tick-batching fix (see step 7's own comment) already addresses.
// timeBeginPeriod(1) requests 1ms system-wide scheduler resolution for as
// long as this process holds it (paired with timeEndPeriod in the
// destructor - RAII so it's released on every exit path, including an
// exception unwinding out of main's try block).
struct TimerResolutionGuard {
    TimerResolutionGuard() { timeBeginPeriod(1); }
    ~TimerResolutionGuard() { timeEndPeriod(1); }
};

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
// priority ranking used by unsignalized-junction arbitration below. Higher
// wins.
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
static constexpr double MIN_DISCHARGE_GAP_SEC = 1.2;          // minimum headway between successive discharges at an unsignalized junction - shortened along with the rest of the "selfish driver" tuning, see profileFor
// A vehicle's effective priority at an unsignalized junction climbs the
// longer it's waited (see the arbitration step), so a low-class approach
// isn't starved forever behind a busier cross-street - a real, impatient
// driver eventually just goes. This is also what makes the simulation
// useful for spotting where a real traffic light is needed: a junction that
// still backs up even with drivers this willing to push in is a genuine
// candidate, not an artifact of overly-polite simulated drivers.
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
// before a new trip is allowed to spawn onto it - see the spawn step's own
// comment. Sized to comfortably clear even a long truck/bus, not just a car.
static constexpr double SPAWN_CLEARANCE_M = 10.0;

// ---------------------------------------------------------------------------
// Signal model - a direct port of front-end/redlight.js's fixed-time phase
// math (buildRedlightSegments/getRedlightState, the "paired 4-way"
// choreography, and intersection-group turn-taking). Only the "default"
// static-light mode; Phase 4 adds the other two signal-control modes as
// alternate implementations of computeLampColor's job.
// ---------------------------------------------------------------------------

struct PlainPhase { std::vector<std::string> wayIds; double greenSec = 0, yellowSec = 0; };
struct PairCfg { std::string wayA, wayB; double stepSec = 15; };

struct SignalConfig {
    bool present = false;
    bool isPaired = false;
    double allRedSec = 0;
    std::vector<PlainPhase> phases;      // plain scheme
    std::array<PairCfg, 2> pairs;        // paired4way scheme
    double pairedYellowSec = 3;
    std::string groupId;                 // redlightGroups membership, if any
};

struct RedlightGroupConfig { std::vector<std::string> memberIds; double turnSec = 30; };

static SignalConfig parseSignal(const JsonValue* signalVal) {
    SignalConfig cfg;
    if (!signalVal || signalVal->type != JsonValue::Type::Object) return cfg;
    cfg.present = true;
    cfg.allRedSec = signalVal->num("allRedSec").value_or(0.0);
    auto scheme = signalVal->str("scheme");
    if (scheme && *scheme == "paired4way") {
        cfg.isPaired = true;
        const JsonValue* paired = signalVal->find("paired");
        if (paired) {
            cfg.pairedYellowSec = paired->num("yellowSec").value_or(3.0);
            const JsonValue* pairsArr = paired->find("pairs");
            if (pairsArr && pairsArr->type == JsonValue::Type::Array) {
                for (size_t i = 0; i < pairsArr->arrVal.size() && i < 2; ++i) {
                    const JsonValue& p = pairsArr->arrVal[i];
                    const JsonValue* wids = p.find("wayIds");
                    if (wids && wids->type == JsonValue::Type::Array && wids->arrVal.size() >= 2) {
                        cfg.pairs[i].wayA = wids->arrVal[0].strVal;
                        cfg.pairs[i].wayB = wids->arrVal[1].strVal;
                    }
                    cfg.pairs[i].stepSec = p.num("stepSec").value_or(15.0);
                }
            }
        }
    } else {
        const JsonValue* phasesArr = signalVal->find("phases");
        if (phasesArr && phasesArr->type == JsonValue::Type::Array) {
            for (auto& ph : phasesArr->arrVal) {
                PlainPhase pp;
                pp.greenSec = ph.num("greenSec").value_or(0.0);
                pp.yellowSec = ph.num("yellowSec").value_or(0.0);
                const JsonValue* wids = ph.find("wayIds");
                if (wids && wids->type == JsonValue::Type::Array)
                    for (auto& w : wids->arrVal) if (w.type == JsonValue::Type::String) pp.wayIds.push_back(w.strVal);
                cfg.phases.push_back(std::move(pp));
            }
        }
    }
    auto gid = signalVal->str("groupId");
    if (gid) cfg.groupId = *gid;
    return cfg;
}

// Port of redlight.js's getApproachCountdown/buildRedlightSegments (the
// plain phase-list scheme): rebuilds the flat [start,end) segment list each
// call, same as the original - call frequency is bounded (at most once per
// signalized junction's front vehicle per tick) so this is not a hot path.
static std::string getPlainColor(const SignalConfig& cfg, double clockSec, const std::string& wayId) {
    double allRed = std::max(0.0, cfg.allRedSec);
    struct Seg { double start, end; int color; const std::vector<std::string>* wayIds; }; // color: 0 green,1 yellow,2 red
    std::vector<Seg> segs;
    double cursor = 0;
    for (auto& ph : cfg.phases) {
        double green = std::max(0.0, ph.greenSec), yellow = std::max(0.0, ph.yellowSec);
        if (green > 0) { segs.push_back({cursor, cursor + green, 0, &ph.wayIds}); cursor += green; }
        if (yellow > 0) { segs.push_back({cursor, cursor + yellow, 1, &ph.wayIds}); cursor += yellow; }
        if (allRed > 0) { segs.push_back({cursor, cursor + allRed, 2, nullptr}); cursor += allRed; }
    }
    double cycle = cursor;
    if (segs.empty() || cycle <= 0) return "red";
    double t = std::fmod(std::fmod(clockSec, cycle) + cycle, cycle);
    int found = -1;
    for (size_t i = 0; i < segs.size(); ++i) if (t >= segs[i].start && t < segs[i].end) { found = (int)i; break; }
    const Seg& cur = segs[found >= 0 ? found : (int)segs.size() - 1];
    if (cur.color == 2) return "red";
    bool has = cur.wayIds && std::find(cur.wayIds->begin(), cur.wayIds->end(), wayId) != cur.wayIds->end();
    if (!has) return "red";
    return cur.color == 0 ? "green" : "yellow";
}

// Port of redlight.js's pairedMovementState.
static std::string pairedMovementState(double redStart, double redDur, double yellowSec, double cycleLen, double t) {
    if (cycleLen <= 0) return "red";
    t = std::fmod(std::fmod(t, cycleLen) + cycleLen, cycleLen);
    double intoRed = std::fmod(std::fmod(t - redStart, cycleLen) + cycleLen, cycleLen);
    if (intoRed < redDur) return "red";
    double greenDur = cycleLen - redDur;
    double remGreen = greenDur - (intoRed - redDur);
    if (remGreen <= yellowSec) return "yellow";
    return "green";
}

static double pairedPairCycleLen(const PairCfg& p) { return 4.0 * std::max(1.0, p.stepSec); }

// Port of redlight.js's getPairedIntersectionState + getPairedMovementCountdown.
static std::string getPairedColor(const SignalConfig& cfg, double clockSec, const std::string& wayId, const std::string& movement) {
    int pairIdx = -1;
    if (cfg.pairs[0].wayA == wayId || cfg.pairs[0].wayB == wayId) pairIdx = 0;
    else if (cfg.pairs[1].wayA == wayId || cfg.pairs[1].wayB == wayId) pairIdx = 1;
    if (pairIdx < 0) return "red";

    double allRed = std::max(0.0, cfg.allRedSec);
    double cyc0 = pairedPairCycleLen(cfg.pairs[0]), cyc1 = pairedPairCycleLen(cfg.pairs[1]);
    double master = cyc0 + allRed + cyc1 + allRed;
    if (master <= 0) return "red";
    double tMaster = std::fmod(std::fmod(clockSec, master) + master, master);
    int activePairIndex = -1;
    double localT = 0;
    if (tMaster < cyc0) { activePairIndex = 0; localT = tMaster; }
    else if (tMaster < cyc0 + allRed) { activePairIndex = -1; }
    else if (tMaster < cyc0 + allRed + cyc1) { activePairIndex = 1; localT = tMaster - (cyc0 + allRed); }
    if (activePairIndex != pairIdx) return "red";

    const PairCfg& pair = cfg.pairs[pairIdx];
    double stepSec = std::max(1.0, pair.stepSec);
    double cycleLen = 4 * stepSec;
    double yellowSec = std::max(0.0, cfg.pairedYellowSec);
    bool isA = (wayId == pair.wayA);
    double redStart, redDur;
    if (movement == "right" || movement == "uturn") { redStart = isA ? stepSec : 3 * stepSec; redDur = 3 * stepSec; }
    else { redStart = isA ? 2 * stepSec : 0; redDur = stepSec; }
    return pairedMovementState(redStart, redDur, yellowSec, cycleLen, localT);
}

struct GroupTurnInfo { bool valid = false; std::string activeNodeId; double localClock = 0; };

// Port of redlight.js's getGroupTurnInfo.
static GroupTurnInfo getGroupTurnInfo(const RedlightGroupConfig& g, double clockSec) {
    if (g.memberIds.size() < 2) return {};
    double turnSec = std::max(1.0, g.turnSec);
    double cycle = turnSec * (double)g.memberIds.size();
    double t = std::fmod(std::fmod(clockSec, cycle) + cycle, cycle);
    int activeIdx = std::min((int)g.memberIds.size() - 1, (int)(t / turnSec));
    return {true, g.memberIds[activeIdx], t - activeIdx * turnSec};
}

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
// movement also drives the signal-timing lookup (see getPairedColor) and,
// now, lane choice (see desiredLaneForStep). U-turns happen at this map's
// divided roads, where the two carriageways are separate ways that still
// share a join_group at the crossing point.
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
    // departure - used only for buildStateJson's curved-turn rendering
    // (see its own comment), not by any physics/routing here.
    double arrDirX = 0, arrDirY = 0, depDirX = 0, depDirY = 0;
};

struct OutEdgeRef { bool isJunction; int index; };

// One unsignalized-junction crossing currently "in flight" - tracked per
// junction instead of a single busyUntil scalar so genuinely non-conflicting
// movements (see the arbitration step's compatible() lambda) can occupy the
// same junction at once. This is the "width of the intersection should let
// more than one vehicle through" fix: a wide/multi-arm junction naturally
// ends up with several of these active simultaneously, a narrow single-lane
// T-junction still only ever has one (nothing to run it alongside).
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
    // Runtime arbitration state (unsignalized junctions only) - see the main
    // loop's step 3: any number of vehicles may be in flight at once as long
    // as every pair is geometrically compatible (same-approach different
    // lane, or opposite approaches both going straight/left), each gated by
    // its own MIN_DISCHARGE_GAP_SEC headway. Genuinely conflicting movements
    // (crossing approaches, or anything crossing oncoming traffic) still
    // serialize - flow-channel fidelity, not full conflict-point geometry.
    std::vector<JctFlight> inFlight;
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
};

// At most 2 SIMULATED lanes per direction regardless of ce.lanesPerDirection
// (see desiredLaneForStep) - a flat cap so a road tagged with an unusually
// high lane count doesn't add a third lane's worth of complexity; in
// practice almost every two-way road in this map has lanesPerDirection==1
// (see buildRoadGraph - lanes is a TOTAL across both directions), so this
// mostly matters for one-way roads tagged lanes>=2.
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
                rg.outAdj[a].push_back({true, (int)rg.junctionEdges.size() - 1});
                junctionEdgeCount++;
            }
        }
    }

    std::cerr << "[sim] road graph: " << rg.nodeId.size() << " nodes, " << chainEdgeCount << " chain edges, "
              << junctionEdgeCount << " junction edges, " << rg.junctions.size() << " junctions ("
              << std::count_if(rg.junctions.begin(), rg.junctions.end(), [](const JunctionInfo& j) { return j.signal.present; })
              << " signalized), " << skippedWays << " ways skipped (non-routable/invalid)\n";
    return rg;
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

// Phase 4: the other two signal-control modes, runtime-switchable (CLI
// --signal-mode, or live via {"cmd":"setSignalMode","value":...} - see
// handleCommand).
//   - EmergencyOnly: a signalized junction runs the EXACT SAME fixed-time
//     math as Default mode (computeLampColor, complete with its normal
//     phase timer) UNLESS a vehicle with emergency==true (see Vehicle's own
//     comment and handleCommand's triggerEmergency - a manual "responding"
//     toggle, deliberately distinct from merely being vehicleType==
//     "ambulance") is at the front of one of this junction's approach
//     queues, in which case that whole approach is forced green and every
//     other approach forced red for as long as the emergency vehicle
//     occupies that front-of-queue position - real Opticom-style
//     preemption, not a rank bonus fed into ordinary arbitration. See the
//     main loop's step 3 (emergencyPreemptApproach) and buildStateJson's
//     lamps array (which is why a NON-preempted EmergencyOnly junction is
//     deliberately left OUT of that array - see its own comment - letting
//     the client's identical fixed-time math render a real countdown timer
//     instead of a frozen placeholder).
//   - Density: reuses the unsignalized-junction arbitration already built
//     for the "width of the intersection" fix (candidatesForJunction/
//     movementsCompatible/JctFlight below) instead of a fixed phase table -
//     a signalized junction's rank is its approach's live "red dot" weight
//     (count of vehicles currently waiting for this red light, plus the
//     seconds each has been waiting - see Vehicle::waitingLight and the main
//     loop's step 3) rather than a fixed road class, so the busiest-AND-
//     longest-waiting approach simply outranks the others every tick - a
//     live actuated-signal approximation with deliberately no fixed phase
//     table/timer to advance or hold.
// Both modes' signalized junctions are ALSO subject to the same
// emergency-preemption override described above (an emergency vehicle wins
// outright regardless of mode); only Default mode has no ambulance-awareness
// at all. Every genuinely unsignalized junction (~99.9% of this map's
// junctions) is unaffected by mode either way - there is no fixed phase
// there for either mode to replace.
enum class SignalMode { Default, EmergencyOnly, Density };

static SignalMode signalModeFromString(const std::string& s) {
    if (s == "emergency") return SignalMode::EmergencyOnly;
    if (s == "density") return SignalMode::Density;
    return SignalMode::Default;
}
static const char* signalModeToString(SignalMode m) {
    switch (m) {
        case SignalMode::EmergencyOnly: return "emergency";
        case SignalMode::Density: return "density";
        default: return "default";
    }
}

// Top-level per-lamp color dispatch - port of redlight.js's getRedlightCountdown
// (minus the external-override branch, which has no equivalent in this
// headless engine). Only ever consulted for SignalMode::Default - see that
// enum's own comment for the other two modes' completely different path.
static std::string computeLampColor(const RoadGraph& rg, int junctionIdx, const std::string& wayId, const std::string& movement, double clockSec) {
    const JunctionInfo& j = rg.junctions[junctionIdx];
    if (!j.signal.present) return "green"; // unsignalized junctions are gated by arbitration, not this function
    double effectiveClock = clockSec;
    if (!j.signal.groupId.empty()) {
        auto it = rg.redlightGroups.find(j.signal.groupId);
        if (it != rg.redlightGroups.end()) {
            GroupTurnInfo info = getGroupTurnInfo(it->second, clockSec);
            if (info.valid) {
                if (info.activeNodeId != rg.nodeId[j.primaryNodeIdx]) return "red";
                effectiveClock = info.localClock;
            }
        }
    }
    if (j.signal.isPaired) return getPairedColor(j.signal, effectiveClock, wayId, movement);
    return getPlainColor(j.signal, effectiveClock, wayId);
}

// ---------------------------------------------------------------------------
// Vehicles, routing, IDM car-following.
// ---------------------------------------------------------------------------

struct RouteStep { bool isJunction; int edgeIndex; double length; };

// The RoadGraph node index a step ENDS at, regardless of whether it's a
// chain or junction edge - used by emergency dispatch (see handleCommand's
// triggerEmergency and the main loop's edge-transition step) to splice a
// fresh route on from wherever a vehicle currently is.
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
// ch_preprocess.cpp's #fwd/#bwd splitting, file header) its directional
// twins, which is where such a vertex's real edges actually live - the
// plain id alone can be a degree-0 dead end there. Mirrors ch_query.cpp's
// own buildSeeds() for the non-virtual case exactly (this project's
// vehicles.json start/end are always plain node ids, never a mid-road
// virtual point, so that's the only case this needs).
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

// One-time route computation via the existing CH query engine, run
// in-process (never shells out - that wouldn't scale to spawning up to 10k
// vehicles). See file header for why every hop is guaranteed resolvable
// against RoadGraph.
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

// Nearest RoadGraph node with at least one outgoing edge (a real routable
// point, not e.g. a lone building-corner node with no road attached) to a
// clicked map point - used to turn an emergency-dispatch click's world x/y
// (see handleCommand's triggerEmergency) into a real start/end node for
// resolveRoute. Plain linear scan over this map's ~15k nodes: only ever
// called on a manual dispatch click, not a per-tick hot path, so no spatial
// index is worth the complexity.
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
// approach (see the arbitration step's concurrent-movement check) and lets
// the two lanes render/queue side-by-side at independent speeds instead of
// single-file. Single-lane edges always use lane 0 - nothing to choose
// between.
//
// Looks ahead past stepIdx through every remaining CONSECUTIVE chain-edge
// step of the same road segment/approach (a way with intermediate shape
// nodes becomes several short chain edges in a row before the junction edge
// that actually crosses the intersection - see the file header's RoadGraph
// topology note) to find the junction that ends it, rather than only ever
// peeking one step ahead. Peeking only one step used to mean a vehicle only
// discovered it needed the crossing lane once it was already on that final,
// short pulled-back stub right at the junction - a real driver picks the
// correct lane for their turn from the START of the approach, well before
// reaching the intersection, not in the last couple of metres. A route that
// ends mid-way through this segment (its destination) has no junction to
// prepare for, so it's left in lane 0 like a plain through movement.
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
    };
    auto it = table.find(type);
    return it != table.end() ? it->second : table.at("car");
}

struct TripSpec {
    int id;
    std::string vehicleType, startNodeId, endNodeId;
    double length, width, maxSpeedKmh, accelMps2;
    // Present only for the frontend's click-a-vehicle-to-inspect detail
    // panel (see buildVehicleInfoJson) - never consumed by the physics/
    // routing here, so no default beyond "field absent" matters.
    double height = -1.0, weightKg = -1.0, driverAge = -1.0, responseTimeSec = -1.0;
    std::string homeAmenityId, homeHospitalName; // empty = not an ambulance / no depot assigned
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
        t.homeHospitalName = v.str("homeHospitalName").value_or("");
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

    // Emergency dispatch (manual "emergency state" toggle - see handleCommand's
    // triggerEmergency) - independent of vehicleType=="ambulance" alone, per
    // the "currently responding" flag the project's own status notes called
    // for: a plain ambulance trip does NOT get preemption, only one actually
    // dispatched to an incident does. emergencyPhase: 0 = not responding,
    // 1 = en route to the incident, 2 = incident reached, en route to the
    // home hospital - see the main loop's edge-transition step for how a
    // vehicle moves from phase 1 to 2 instead of just ending its trip.
    bool emergency = false;
    int emergencyPhase = 0;
    double dispatchTime = -1.0, incidentArrivalTime = -1.0;
    std::string homeAmenityId; // copied from TripSpec at spawn - hospital lookup for the phase 1->2 handoff

    // Density mode's "waiting for the light" state (see the main loop's step
    // 3) - a vehicle showing a red dot in the frontend, and the basis of that
    // mode's approach-weight ranking. Not meaningful outside Density mode.
    bool waitingLight = false;
    double waitStartTime = -1.0;
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
// per tick, before grouping (see the main loop's step 1.5), on a small
// sorted-by-position list built per chain edge - this is deliberately plain
// O(n) neighbour scans rather than a maintained sorted structure, since even
// a busy 2-lane edge only ever holds a small number of vehicles at once.
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

// ---------------------------------------------------------------------------
// Optional "vision + mini-pathfinding" lane-choice mode (toggleable - see
// --advanced-lane-ai / the {"cmd":"setAdvancedLaneAI"} command, off by
// default). The default heuristic above only reacts to the immediate
// leader; this instead scores each candidate lane by summing up the
// slowdown every vehicle within VISION_RANGE_M ahead would impose, weighted
// by how close it is - a small stand-in for a real perception+planning
// stack, deliberately not a full graph search (this is a 2-lane choice, not
// a routing problem) but a genuine look-ahead rather than a single-neighbour
// reaction. Costs more per vehicle per tick than the default heuristic
// (scans every same-edge vehicle instead of just the nearest one), which is
// exactly why it's opt-in rather than replacing the default outright.
// ---------------------------------------------------------------------------

static constexpr double VISION_RANGE_M = 50.0;

static double laneVisionCost(const std::vector<int>& sortedIdxs, const std::vector<Vehicle>& vehicles,
                              int lane, double pos, double desiredSpeed, int selfVi) {
    double cost = 0.0;
    for (int vi : sortedIdxs) {
        if (vi == selfVi) continue;
        const Vehicle& o = vehicles[vi];
        if (o.lane != lane) continue;
        double d = o.distAlongEdge - pos;
        if (d < -o.length || d > VISION_RANGE_M) continue; // behind me, or beyond my vision range
        double slowdown = std::max(0.0, desiredSpeed - o.speed);
        double proximityWeight = std::max(0.0, (VISION_RANGE_M - std::max(0.0, d)) / VISION_RANGE_M);
        cost += slowdown * proximityWeight;
    }
    return cost;
}

// ---------------------------------------------------------------------------
// Minimal WebSocket server (RFC 6455), hand-rolled with plain Winsock -
// deliberately zero external dependencies, matching the project's existing
// self-contained g++ -static convention (see backend/ch/ch_preprocess.cpp's
// own build-tooling comments in serve.py). Good enough for what this needs:
// a handful of localhost browser clients, one broadcast text frame per tick,
// and occasional small JSON control messages back.
// ---------------------------------------------------------------------------

// Public-domain-style SHA-1 (RFC 3174) - used only for the handshake's
// Sec-WebSocket-Accept per RFC 6455, not for anything security-sensitive.
static std::array<uint8_t, 20> sha1(const std::string& input) {
    uint32_t h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    std::string msg = input;
    uint64_t ml = (uint64_t)input.size() * 8;
    msg += (char)0x80;
    while (msg.size() % 64 != 56) msg += (char)0x00;
    for (int i = 7; i >= 0; --i) msg += (char)((ml >> (i * 8)) & 0xFF);

    for (size_t chunk = 0; chunk < msg.size(); chunk += 64) {
        uint32_t w[80];
        for (int i = 0; i < 16; ++i) {
            w[i] = ((uint8_t)msg[chunk + i * 4] << 24) | ((uint8_t)msg[chunk + i * 4 + 1] << 16) |
                   ((uint8_t)msg[chunk + i * 4 + 2] << 8) | (uint8_t)msg[chunk + i * 4 + 3];
        }
        for (int i = 16; i < 80; ++i) {
            uint32_t v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
            w[i] = (v << 1) | (v >> 31);
        }
        uint32_t a = h0, b = h1, c = h2, d = h3, e = h4;
        for (int i = 0; i < 80; ++i) {
            uint32_t f, k;
            if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
            else { f = b ^ c ^ d; k = 0xCA62C1D6; }
            uint32_t temp = ((a << 5) | (a >> 27)) + f + e + k + w[i];
            e = d; d = c; c = (b << 30) | (b >> 2); b = a; a = temp;
        }
        h0 += a; h1 += b; h2 += c; h3 += d; h4 += e;
    }
    std::array<uint8_t, 20> out;
    uint32_t hs[5] = {h0, h1, h2, h3, h4};
    for (int i = 0; i < 5; ++i) {
        out[i * 4] = (hs[i] >> 24) & 0xFF; out[i * 4 + 1] = (hs[i] >> 16) & 0xFF;
        out[i * 4 + 2] = (hs[i] >> 8) & 0xFF; out[i * 4 + 3] = hs[i] & 0xFF;
    }
    return out;
}

static std::string base64Encode(const uint8_t* data, size_t len) {
    static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    size_t i = 0;
    for (; i + 2 < len; i += 3) {
        uint32_t n = ((uint32_t)data[i] << 16) | ((uint32_t)data[i + 1] << 8) | data[i + 2];
        out += tbl[(n >> 18) & 0x3F]; out += tbl[(n >> 12) & 0x3F]; out += tbl[(n >> 6) & 0x3F]; out += tbl[n & 0x3F];
    }
    size_t rem = len - i;
    if (rem == 1) {
        uint32_t n = (uint32_t)data[i] << 16;
        out += tbl[(n >> 18) & 0x3F]; out += tbl[(n >> 12) & 0x3F]; out += "==";
    } else if (rem == 2) {
        uint32_t n = ((uint32_t)data[i] << 16) | ((uint32_t)data[i + 1] << 8);
        out += tbl[(n >> 18) & 0x3F]; out += tbl[(n >> 12) & 0x3F]; out += tbl[(n >> 6) & 0x3F]; out += "=";
    }
    return out;
}

static std::string wsAcceptKey(const std::string& clientKey) {
    static const std::string GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    auto digest = sha1(clientKey + GUID);
    return base64Encode(digest.data(), digest.size());
}

static std::string encodeWsFrame(uint8_t opcode, const std::string& payload) {
    std::string out;
    out.push_back((char)(0x80 | (opcode & 0x0F))); // FIN=1, no fragmentation - our messages are small/bounded
    size_t len = payload.size();
    if (len < 126) {
        out.push_back((char)len);
    } else if (len <= 0xFFFF) {
        out.push_back((char)126);
        out.push_back((char)((len >> 8) & 0xFF));
        out.push_back((char)(len & 0xFF));
    } else {
        out.push_back((char)127);
        for (int i = 7; i >= 0; --i) out.push_back((char)((len >> (i * 8)) & 0xFF));
    }
    out += payload; // server->client frames are never masked (RFC 6455 5.1)
    return out;
}

struct WsClient {
    SOCKET sock = INVALID_SOCKET;
    std::string recvBuf;
    bool handshakeDone = false;
    bool closed = false;
};

// Unicast reply to a single client's own request (e.g. getRoute, see
// handleCommand) - broadcast() below is for the shared per-tick snapshot,
// this is for a one-off response only that one client asked for.
static void wsSendText(WsClient& c, const std::string& payload) {
    if (c.closed || !c.handshakeDone) return;
    std::string frame = encodeWsFrame(0x1, payload);
    send(c.sock, frame.data(), (int)frame.size(), 0);
}

// Consumes header bytes from c.recvBuf up through "\r\n\r\n" once the full
// HTTP upgrade request has arrived (tolerates it arriving across multiple
// recv() calls - see WsServer::pump), extracts Sec-WebSocket-Key, and writes
// the 101 response directly to the socket. Malformed requests just close the
// connection rather than crash the server.
static void tryCompleteHandshake(WsClient& c) {
    size_t pos = c.recvBuf.find("\r\n\r\n");
    if (pos == std::string::npos) return; // wait for the rest
    std::string headerBlock = c.recvBuf.substr(0, pos);
    c.recvBuf.erase(0, pos + 4);

    std::string key;
    size_t lineStart = 0;
    while (lineStart < headerBlock.size()) {
        size_t lineEnd = headerBlock.find('\n', lineStart);
        if (lineEnd == std::string::npos) lineEnd = headerBlock.size();
        std::string line = headerBlock.substr(lineStart, lineEnd - lineStart);
        if (!line.empty() && line.back() == '\r') line.pop_back();
        std::string lower = line;
        for (auto& ch : lower) ch = (char)tolower((unsigned char)ch);
        if (lower.rfind("sec-websocket-key:", 0) == 0) {
            size_t cpos = line.find(':');
            key = line.substr(cpos + 1);
            size_t s = key.find_first_not_of(" \t");
            size_t e = key.find_last_not_of(" \t");
            key = (s == std::string::npos) ? "" : key.substr(s, e - s + 1);
        }
        lineStart = lineEnd + 1;
    }
    if (key.empty()) { c.closed = true; return; }

    std::string accept = wsAcceptKey(key);
    std::ostringstream resp;
    resp << "HTTP/1.1 101 Switching Protocols\r\n"
         << "Upgrade: websocket\r\n"
         << "Connection: Upgrade\r\n"
         << "Sec-WebSocket-Accept: " << accept << "\r\n\r\n";
    std::string respStr = resp.str();
    send(c.sock, respStr.data(), (int)respStr.size(), 0);
    c.handshakeDone = true;
}

// Extracts and unmasks one complete client->server frame from c.recvBuf if
// one has fully arrived. Returns false if there isn't a complete frame yet
// (leaves recvBuf untouched so the caller can retry after the next recv()).
// A text frame's payload comes back via outText; ping is answered with pong
// internally; close sets shouldClose.
static bool tryReadWsFrame(WsClient& c, std::string& outText, bool& shouldClose) {
    shouldClose = false;
    if (c.recvBuf.size() < 2) return false;
    uint8_t b0 = (uint8_t)c.recvBuf[0], b1 = (uint8_t)c.recvBuf[1];
    bool fin = (b0 & 0x80) != 0;
    int opcode = b0 & 0x0F;
    bool masked = (b1 & 0x80) != 0;
    uint64_t len = b1 & 0x7F;
    size_t pos = 2;
    if (len == 126) {
        if (c.recvBuf.size() < 4) return false;
        len = ((uint8_t)c.recvBuf[2] << 8) | (uint8_t)c.recvBuf[3];
        pos = 4;
    } else if (len == 127) {
        if (c.recvBuf.size() < 10) return false;
        len = 0;
        for (int i = 0; i < 8; ++i) len = (len << 8) | (uint8_t)c.recvBuf[2 + i];
        pos = 10;
    }
    uint8_t maskKey[4] = {0, 0, 0, 0};
    if (masked) {
        if (c.recvBuf.size() < pos + 4) return false;
        for (int i = 0; i < 4; ++i) maskKey[i] = (uint8_t)c.recvBuf[pos + i];
        pos += 4;
    }
    if (c.recvBuf.size() < pos + (size_t)len) return false;
    std::string payload = c.recvBuf.substr(pos, (size_t)len);
    if (masked) for (size_t i = 0; i < payload.size(); ++i) payload[i] = (char)((uint8_t)payload[i] ^ maskKey[i % 4]);
    c.recvBuf.erase(0, pos + (size_t)len);

    if (opcode == 0x8) { shouldClose = true; return true; }
    if (opcode == 0x9) { // ping -> pong, same payload
        std::string frame = encodeWsFrame(0xA, payload);
        send(c.sock, frame.data(), (int)frame.size(), 0);
        return true;
    }
    if (opcode == 0x1 && fin) outText = std::move(payload); // text frame, unfragmented (our clients never fragment)
    return true;
}

class WsServer {
public:
    bool start(int port) {
        WSADATA wsa;
        if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;
        listenSock_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (listenSock_ == INVALID_SOCKET) return false;
        // Deliberately NOT setting SO_REUSEADDR: each run is a fresh process
        // (no quick-restart-same-process case to work around), and on
        // Windows SO_REUSEADDR's looser semantics can let a second process
        // silently bind the same port instead of a real conflict failing
        // loudly here - serve.py's start_sim_engine() is the actual guard
        // against a duplicate launch, but a plain exclusive bind is a good
        // second line of defense against anything started outside it.
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons((u_short)port);
        addr.sin_addr.s_addr = inet_addr("127.0.0.1");
        if (bind(listenSock_, (sockaddr*)&addr, sizeof(addr)) != 0) return false;
        if (listen(listenSock_, 16) != 0) return false;
        u_long mode = 1;
        ioctlsocket(listenSock_, FIONBIO, &mode);
        return true;
    }

    // Accepts any pending connections, drains available bytes from every
    // client, advances handshakes, and dispatches complete text messages to
    // onCommand. Non-blocking throughout - safe to call once per simulation
    // tick without ever stalling the physics loop on network I/O.
    void pump(const std::function<void(const std::string&, WsClient&)>& onCommand) {
        while (true) {
            SOCKET s = accept(listenSock_, nullptr, nullptr);
            if (s == INVALID_SOCKET) break;
            u_long mode = 1;
            ioctlsocket(s, FIONBIO, &mode);
            auto c = std::make_unique<WsClient>();
            c->sock = s;
            clients_.push_back(std::move(c));
        }

        for (auto& cp : clients_) {
            WsClient& c = *cp;
            if (c.closed) continue;
            char buf[16384];
            while (true) {
                int n = recv(c.sock, buf, sizeof(buf), 0);
                if (n > 0) { c.recvBuf.append(buf, n); if (n < (int)sizeof(buf)) break; continue; }
                if (n == 0) { c.closed = true; }
                else if (WSAGetLastError() != WSAEWOULDBLOCK) { c.closed = true; }
                break;
            }
            if (c.closed) continue;
            if (!c.handshakeDone) { tryCompleteHandshake(c); continue; }
            std::string text; bool shouldClose;
            while (tryReadWsFrame(c, text, shouldClose)) {
                if (shouldClose) { c.closed = true; break; }
                if (!text.empty()) { onCommand(text, c); text.clear(); }
            }
        }

        clients_.erase(std::remove_if(clients_.begin(), clients_.end(), [](std::unique_ptr<WsClient>& cp) {
            if (cp->closed) { closesocket(cp->sock); return true; }
            return false;
        }), clients_.end());
    }

    // Best-effort: a client that can't accept the full frame right now
    // (WSAEWOULDBLOCK/partial send) just misses this tick's update rather
    // than being queued - the next tick's snapshot supersedes it anyway, so
    // buffering old position data isn't worth the complexity for a live feed.
    void broadcast(const std::string& json) {
        if (clients_.empty()) return;
        std::string frame = encodeWsFrame(0x1, json);
        for (auto& cp : clients_) {
            if (!cp->handshakeDone || cp->closed) continue;
            send(cp->sock, frame.data(), (int)frame.size(), 0);
        }
    }

    size_t clientCount() const { return clients_.size(); }

private:
    SOCKET listenSock_ = INVALID_SOCKET;
    std::vector<std::unique_ptr<WsClient>> clients_;
};

static void appendJsonString(std::string& out, const std::string& s) {
    out += '"';
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if ((unsigned char)c < 0x20) { char buf[8]; snprintf(buf, sizeof(buf), "\\u%04x", c); out += buf; }
                else out += c;
        }
    }
    out += '"';
}

// Whether two unsignalized-junction (or, under EmergencyOnly/Density mode, a
// signalized junction's own arbitration - see SignalMode) candidate
// movements can occupy the junction at the same time - see the main loop's
// step 3 for the full reasoning. Hoisted to a free function so buildStateJson
// can reuse the exact same rule to report live lamp colors under those two
// modes, rather than keeping a second copy in sync by hand.
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
//   - Opposite approaches (arrival directions within ~135-180° of each
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

struct TypeStats { long long count = 0; double sumTripSec = 0; };
struct EmergencyStats { long long count = 0; double sumResponseSec = 0, sumTransportSec = 0; };

// Compact JSON build (hand-rolled, matching ch_preprocess.cpp/ch_query.cpp's
// own approach - no library) for the per-tick broadcast. vehicleType is
// always one of this project's own small fixed set (never externally
// supplied), so no escaping is needed for it.
static std::string buildStateJson(double simClock, const std::vector<Vehicle>& vehicles, const RoadGraph& rg,
                                   long long totalSpawned, long long totalCompleted, size_t totalTrips, SignalMode signalMode,
                                   const std::unordered_map<int, std::string>& emergencyPreemptApproach,
                                   const std::unordered_map<std::string, double>& densityApproachWeight,
                                   const std::unordered_map<std::string, TypeStats>& completedByType,
                                   const EmergencyStats& emergencyStats) {
    std::string out;
    out.reserve(vehicles.size() * 72 + 128);
    char buf[64];
    auto appendNum = [&](double v, int decimals) {
        snprintf(buf, sizeof(buf), "%.*f", decimals, v);
        out += buf;
    };
    out += "{\"type\":\"state\",\"t\":"; appendNum(simClock, 2);
    out += ",\"spawned\":"; out += std::to_string(totalSpawned);
    out += ",\"completed\":"; out += std::to_string(totalCompleted);
    out += ",\"total\":"; out += std::to_string(totalTrips);
    out += ",\"mode\":\""; out += signalModeToString(signalMode); out += "\"";
    // Under EmergencyOnly/Density mode a signalized junction's lamp colors
    // are decided live, server-side (see the main loop's step 3 and
    // SignalMode's own comment), not the fixed-time math front-end/
    // redlight.js runs locally from the clock alone - so those colors have
    // to be streamed explicitly here for the client to render correctly (see
    // sim-client.js's handling of this field). Only ever non-empty for this
    // map's 3 signalized junctions.
    //   - EmergencyOnly mode with no ambulance currently preempting a given
    //     junction is deliberately SKIPPED here entirely (not just "colored
    //     the same as default") - that junction is left out of this array so
    //     the client falls back to its own ordinary fixed-time computation
    //     (same math, kept in lockstep via Sim.clockSec - see sim-client.js),
    //     which is what lets it show a genuine countdown timer rather than a
    //     frozen "0". Only emitted once an ambulance is actually preempting.
    //   - Density mode always emits every signalized junction (it has no
    //     fixed-time fallback to defer to).
    //   - Either mode, once emergencyPreemptApproach names a junction (see
    //     the main loop's step 3 - a vehicle with emergency==true at the
    //     front of its approach queue), that approach's own color is forced
    //     green and every other approach forced red, overriding the mode's
    //     ordinary logic - real preemption, not just a priority nudge.
    if (signalMode != SignalMode::Default) {
        out += ",\"lamps\":[";
        bool firstLamp = true;
        for (size_t ji = 0; ji < rg.junctions.size(); ++ji) {
            const JunctionInfo& jn = rg.junctions[ji];
            if (!jn.signal.present) continue;
            auto preemptIt = emergencyPreemptApproach.find((int)ji);
            bool preempting = preemptIt != emergencyPreemptApproach.end();
            if (signalMode == SignalMode::EmergencyOnly && !preempting) continue;
            std::unordered_set<std::string> seen;
            for (const JunctionEdge& je : rg.junctionEdges) {
                if (je.junctionIdx != (int)ji) continue;
                std::string key = je.fromWayId + "|" + je.movement;
                if (!seen.insert(key).second) continue;
                bool green;
                const char* reason;
                if (preempting) {
                    green = je.fromWayId == preemptIt->second;
                    reason = "emergency";
                } else {
                    green = true;
                    for (auto& f : jn.inFlight) {
                        if (!movementsCompatible(je.fromWayId, je.movement, je.arrDirX, je.arrDirY, je.toWayId,
                                                  f.fromWayId, f.movement, f.arrDirX, f.arrDirY, f.toWayId)) { green = false; break; }
                    }
                    reason = "density";
                }
                if (!firstLamp) out += ",";
                firstLamp = false;
                out += "{\"nodeId\":"; appendJsonString(out, rg.nodeId[jn.primaryNodeIdx]);
                out += ",\"wayId\":"; appendJsonString(out, je.fromWayId);
                out += ",\"movement\":"; appendJsonString(out, je.movement);
                out += ",\"color\":\""; out += (green ? "green" : "red"); out += "\"";
                out += ",\"r\":\""; out += reason; out += "\"}";
            }
        }
        out += "]";
    }
    // Density mode's live per-approach "red dot" weight (see the main loop's
    // step 3 and Vehicle::waitingLight) - streamed unkeyed by movement (one
    // entry per fromWayId, not per lamp) purely for display: the frontend's
    // node inspector shows this when a signalized junction is selected, so a
    // user can see WHY a given approach is winning (or not) under Density
    // mode. Only ever non-empty in Density mode; harmless/empty otherwise.
    if (signalMode == SignalMode::Density) {
        out += ",\"approachWeights\":[";
        bool firstW = true;
        for (size_t ji = 0; ji < rg.junctions.size(); ++ji) {
            const JunctionInfo& jn = rg.junctions[ji];
            if (!jn.signal.present) continue;
            std::unordered_set<std::string> seenWay;
            for (const JunctionEdge& je : rg.junctionEdges) {
                if (je.junctionIdx != (int)ji) continue;
                if (!seenWay.insert(je.fromWayId).second) continue;
                auto it = densityApproachWeight.find(std::to_string(ji) + "|" + je.fromWayId);
                double w = it != densityApproachWeight.end() ? it->second : 0.0;
                if (!firstW) out += ",";
                firstW = false;
                out += "{\"nodeId\":"; appendJsonString(out, rg.nodeId[jn.primaryNodeIdx]);
                out += ",\"wayId\":"; appendJsonString(out, je.fromWayId);
                out += ",\"weight\":"; appendNum(w, 1);
                out += "}";
            }
        }
        out += "]";
    }
    out += ",\"stats\":{";
    {
        long long allCount = 0; double allSum = 0;
        for (auto& [ty, ts] : completedByType) { allCount += ts.count; allSum += ts.sumTripSec; }
        out += "\"completedTotal\":"; out += std::to_string(allCount);
        out += ",\"avgTripSec\":"; appendNum(allCount ? allSum / allCount : 0.0, 1);
        out += ",\"byType\":{";
        bool firstTy = true;
        for (auto& [ty, ts] : completedByType) {
            if (!firstTy) out += ",";
            firstTy = false;
            out += "\""; out += ty; out += "\":{\"count\":"; out += std::to_string(ts.count);
            out += ",\"avgTripSec\":"; appendNum(ts.count ? ts.sumTripSec / ts.count : 0.0, 1);
            out += "}";
        }
        out += "}";
        out += ",\"emergency\":{\"count\":"; out += std::to_string(emergencyStats.count);
        out += ",\"avgResponseSec\":"; appendNum(emergencyStats.count ? emergencyStats.sumResponseSec / emergencyStats.count : 0.0, 1);
        out += ",\"avgTransportSec\":"; appendNum(emergencyStats.count ? emergencyStats.sumTransportSec / emergencyStats.count : 0.0, 1);
        out += "}";
    }
    out += "}";
    out += ",\"vehicles\":[";
    bool first = true;
    for (auto& v : vehicles) {
        if (!v.active) continue;
        const RouteStep& cur = v.route[v.routeIdx];
        int fromNode = cur.isJunction ? rg.junctionEdges[cur.edgeIndex].from : rg.chainEdges[cur.edgeIndex].from;
        int toNode = cur.isJunction ? rg.junctionEdges[cur.edgeIndex].to : rg.chainEdges[cur.edgeIndex].to;
        double fx = rg.nodeX[fromNode], fy = rg.nodeY[fromNode], tx = rg.nodeX[toNode], ty = rg.nodeY[toNode];
        double t = cur.length > 1e-6 ? std::max(0.0, std::min(1.0, v.distAlongEdge / cur.length)) : 0.0;
        double x = fx + (tx - fx) * t, y = fy + (ty - fy) * t;
        double heading = std::atan2(ty - fy, tx - fx);

        // Curved turning path: a junction edge connects two DIFFERENT
        // approach nodes with a straight line, which is geometrically
        // correct for routing/distance but renders as an instant snap from
        // the arrival heading to the departure heading, right at the
        // junction - real vehicles sweep through a turn radius instead.
        // This bends the RENDERED path (never the physics - distAlongEdge/t
        // above is untouched) into a quadratic Bezier whose tangents match
        // the real arrival/departure directions (JunctionEdge::arrDir/
        // depDir, from the SAME classifyMovement geometry, not guessed):
        // the control point is where those two tangent lines actually
        // cross. A "through" movement's arrival/departure directions are
        // nearly identical, so that crossing point is degenerate/far away -
        // caught by the determinant/sanity checks below, which simply skip
        // curving and keep the straight line (correct - there's no visible
        // turn to smooth there anyway).
        if (cur.isJunction) {
            const JunctionEdge& je = rg.junctionEdges[cur.edgeIndex];
            double dx = tx - fx, dy = ty - fy;
            double det = je.arrDirX * je.depDirY - je.arrDirY * je.depDirX;
            if (std::fabs(det) > 1e-6) {
                double s = (dx * je.depDirY - dy * je.depDirX) / det;
                double maxS = std::max(1.0, cur.length * 3.0);
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
        }

        // Lateral offset from the raw edge (its node-chain, which on a
        // two-way road runs down the geometric centreline - see
        // ChainEdge::carriagewayCenterOffsetM) to where this vehicle should
        // actually sit: its own carriageway's side, then centred in
        // whichever of that carriageway's (at most 2) simulated lanes it's
        // using. Junction edges are left at 0 (raw centreline between the
        // two specific approach nodes) - see that field's own comment for
        // why. Sent as a real metre offset, LEFT-of-heading positive
        // (matching this map's left-hand-traffic convention elsewhere -
        // see routetest.js's routeWorldLeftNormal), rather than baked
        // straight into x/y, so the frontend can ease a sudden lane-change
        // (the engine flips v.lane in one tick) into a smooth visual
        // transition instead of a sideways teleport, without that easing
        // also smearing out genuine forward motion.
        double lateralOffsetM = 0.0;
        if (!cur.isJunction) {
            const ChainEdge& ce = rg.chainEdges[cur.edgeIndex];
            int n = simLaneCount(ce);
            int laneIdx = std::min(v.lane, n - 1);
            lateralOffsetM = ce.carriagewayCenterOffsetM + ((n - 1) / 2.0 - laneIdx) * ce.laneWidthM;
        }

        if (!first) out += ",";
        first = false;
        out += "{\"id\":"; out += std::to_string(v.id);
        out += ",\"x\":"; appendNum(x, 2);
        out += ",\"y\":"; appendNum(y, 2);
        out += ",\"h\":"; appendNum(heading, 3);
        out += ",\"s\":"; appendNum(v.speed * 3.6, 1);
        out += ",\"o\":"; appendNum(lateralOffsetM, 2);
        out += ",\"l\":"; appendNum(v.length, 1);
        out += ",\"w\":"; appendNum(v.width, 1);
        out += ",\"ty\":\""; out += v.vehicleType; out += "\"";
        // "Waiting for the light" red dot (Density mode only - see the main
        // loop's step 3) - omitted rather than sent as 0 for every other
        // vehicle, matching this function's existing sparse-field convention.
        if (v.waitingLight) out += ",\"wt\":1";
        if (v.emergency) out += ",\"em\":1";
        out += "}";
    }
    out += "]}";
    return out;
}

// Response to a {"cmd":"getRoute","id":N} request (see handleCommand) - the
// vehicle's full planned route as a polyline of real map coordinates, for
// the frontend's click-a-vehicle-to-see-its-path feature. Routes are
// computed once at spawn and never change (this project's own routing
// requirement), so this is just a read of already-resolved state, not a
// fresh query. `v` null (vehicle not found, or finished/not active) yields
// an empty points array rather than an error - the client treats that as
// "nothing to draw", not a failure.
static std::string buildRouteJson(int id, const Vehicle* v, const RoadGraph& rg) {
    std::string out;
    char buf[64];
    auto appendNum = [&](double val) { snprintf(buf, sizeof(buf), "%.2f", val); out += buf; };
    out += "{\"type\":\"route\",\"id\":"; out += std::to_string(id); out += ",\"points\":[";
    if (v) {
        bool first = true;
        auto emit = [&](int nodeIdx) {
            if (!first) out += ",";
            first = false;
            out += "["; appendNum(rg.nodeX[nodeIdx]); out += ","; appendNum(rg.nodeY[nodeIdx]); out += "]";
        };
        for (const RouteStep& s : v->route) {
            emit(s.isJunction ? rg.junctionEdges[s.edgeIndex].from : rg.chainEdges[s.edgeIndex].from);
        }
        if (!v->route.empty()) {
            const RouteStep& last = v->route.back();
            emit(last.isJunction ? rg.junctionEdges[last.edgeIndex].to : rg.chainEdges[last.edgeIndex].to);
        }
    }
    out += "]}";
    return out;
}

// Response to a {"cmd":"getVehicleInfo","id":N} request - the vehicle's full
// generated tag set (see generate_vehicles.py's per-vehicle record) for the
// frontend's click-to-inspect detail panel. These are all static, decided
// once at generation time, so a plain read of the already-loaded TripSpec is
// enough - no need to touch the live Vehicle state (the per-tick broadcast
// already carries that: x/y/h/s/o/l/w). `t` null (id not found) yields a
// bare object with just the id, matching buildRouteJson's "missing means
// empty, not an error" convention.
static std::string buildVehicleInfoJson(int id, const TripSpec* t) {
    std::string out;
    char buf[64];
    auto appendNum = [&](double val, int decimals) { snprintf(buf, sizeof(buf), "%.*f", decimals, val); out += buf; };
    out += "{\"type\":\"vehicleInfo\",\"id\":"; out += std::to_string(id);
    if (t) {
        out += ",\"vehicleType\":"; appendJsonString(out, t->vehicleType);
        out += ",\"startNodeId\":"; appendJsonString(out, t->startNodeId);
        out += ",\"endNodeId\":"; appendJsonString(out, t->endNodeId);
        out += ",\"length\":"; appendNum(t->length, 2);
        out += ",\"width\":"; appendNum(t->width, 2);
        if (t->height > 0) { out += ",\"height\":"; appendNum(t->height, 2); }
        if (t->weightKg > 0) { out += ",\"weightKg\":"; appendNum(t->weightKg, 0); }
        out += ",\"maxSpeedKmh\":"; appendNum(t->maxSpeedKmh, 1);
        if (t->accelMps2 > 0) { out += ",\"accelMps2\":"; appendNum(t->accelMps2, 2); }
        if (t->driverAge > 0) { out += ",\"driverAge\":"; appendNum(t->driverAge, 0); }
        if (t->responseTimeSec > 0) { out += ",\"responseTimeSec\":"; appendNum(t->responseTimeSec, 2); }
        if (!t->homeAmenityId.empty()) { out += ",\"homeAmenityId\":"; appendJsonString(out, t->homeAmenityId); }
        if (!t->homeHospitalName.empty()) { out += ",\"homeHospitalName\":"; appendJsonString(out, t->homeHospitalName); }
    }
    out += "}";
    return out;
}

// Control messages from the frontend - setSpeed/stop/getRoute/getVehicleInfo/
// setAdvancedLaneAI/setSignalMode/triggerEmergency all do something now.
// triggerEmergency dispatches an already-active ambulance to a clicked map
// point: it splices a freshly-resolved route from the vehicle's current
// position on to the incident node (see stepToNode/resolveRoute), flags it
// emergency (which EmergencyOnly/Density mode's junction preemption keys off
// - see the main loop's step 3), and records dispatchTime so the eventual
// incident/hospital arrivals can report response/transport times (see the
// edge-transition step and buildStateJson's "stats" field).
static void handleCommand(const std::string& text, WsClient& fromClient, double& speedMultiplier, bool& stopRequested,
                           bool& advancedLaneAI, SignalMode& signalMode, std::vector<Vehicle>& vehicles,
                           const RoadGraph& rg, const ChGraph& chg, const std::vector<TripSpec>& trips,
                           double simClock) {
    try {
        JsonValue msg = JsonParser(text).parse();
        auto cmd = msg.str("cmd");
        if (!cmd) return;
        if (*cmd == "setSpeed") {
            speedMultiplier = std::max(0.1, std::min(24.0, msg.num("value").value_or(1.0)));
            std::cerr << "[sim] speed set to " << speedMultiplier << "x\n";
        } else if (*cmd == "stop") {
            stopRequested = true;
        } else if (*cmd == "setAdvancedLaneAI") {
            const JsonValue* val = msg.find("value");
            if (val && val->type == JsonValue::Type::Bool) advancedLaneAI = val->boolVal;
            std::cerr << "[sim] advanced lane AI (vision + mini-pathfinding) " << (advancedLaneAI ? "ON" : "OFF") << "\n";
        } else if (*cmd == "setSignalMode") {
            auto val = msg.str("value");
            if (val) signalMode = signalModeFromString(*val);
            std::cerr << "[sim] signal-control mode set to " << signalModeToString(signalMode) << "\n";
        } else if (*cmd == "getRoute") {
            int id = (int)msg.num("id").value_or(-1);
            const Vehicle* found = nullptr;
            for (auto& v : vehicles) if (v.id == id && v.active) { found = &v; break; }
            wsSendText(fromClient, buildRouteJson(id, found, rg));
        } else if (*cmd == "getVehicleInfo") {
            int id = (int)msg.num("id").value_or(-1);
            const TripSpec* found = nullptr;
            for (auto& t : trips) if (t.id == id) { found = &t; break; }
            wsSendText(fromClient, buildVehicleInfoJson(id, found));
        } else if (*cmd == "triggerEmergency") {
            int id = (int)msg.num("id").value_or(-1);
            double x = msg.num("x").value_or(0.0), y = msg.num("y").value_or(0.0);
            Vehicle* found = nullptr;
            for (auto& v : vehicles) if (v.id == id && v.active) { found = &v; break; }
            if (!found) { std::cerr << "[sim] triggerEmergency ignored: vehicle " << id << " not active\n"; return; }
            if (found->vehicleType != "ambulance") { std::cerr << "[sim] triggerEmergency ignored: vehicle " << id << " is not an ambulance\n"; return; }
            std::string fromNodeId = rg.nodeId[stepToNode(rg, found->route[found->routeIdx])];
            std::string incidentNodeId = nearestRoutableNodeId(rg, x, y);
            std::string err;
            std::vector<RouteStep> newRoute = resolveRoute(rg, chg, fromNodeId, incidentNodeId, err);
            if (newRoute.empty()) { std::cerr << "[sim] WARN emergency dispatch route failed for vehicle " << id << ": " << err << "\n"; return; }
            found->route.resize(found->routeIdx + 1);
            found->route.insert(found->route.end(), newRoute.begin(), newRoute.end());
            found->emergency = true;
            found->emergencyPhase = 1;
            found->dispatchTime = simClock;
            found->incidentArrivalTime = -1.0;
            std::cerr << "[sim] emergency dispatch: vehicle " << id << " -> incident near node " << incidentNodeId << "\n";
        } else {
            std::cerr << "[sim] control message noted (no effect until a later phase): " << text << "\n";
        }
    } catch (const std::exception& ex) {
        std::cerr << "[sim] WARN malformed control message ignored: " << ex.what() << "\n";
    }
}

int main(int argc, char** argv) {
    if (argc < 4) {
        std::cerr << "usage: sim_engine <map_data.json> <map_data.ch.bin> <vehicles.json> "
                     "[--sim-seconds N] [--concurrency N] [--ramp-seconds N] [--stats-interval N] "
                     "[--track-vehicle ID] [--port N] [--speed N] [--headless] [--advanced-lane-ai] "
                     "[--signal-mode default|emergency|density]\n";
        return 2;
    }
    std::string mapPath = argv[1], chPath = argv[2], vehiclesPath = argv[3];
    double simSeconds = 300, rampSeconds = 60, statsInterval = 10, speedMultiplier = 1.0;
    long long concurrency = -1;
    int trackId = -1, port = 8766;
    bool headless = false; // --headless skips the websocket server + real-time pacing (Phase 2's original mode - runs flat out, for scripted testing)
    // Off by default - see laneVisionCost's own comment for why this costs
    // more per vehicle per tick than the default heuristic. Toggleable live
    // via {"cmd":"setAdvancedLaneAI","value":true|false} too (see handleCommand).
    bool advancedLaneAI = false;
    // Phase 4 - see SignalMode's own comment. Toggleable live via
    // {"cmd":"setSignalMode","value":"default"|"emergency"|"density"}.
    SignalMode signalMode = SignalMode::Default;
    for (int i = 4; i < argc; ++i) {
        std::string a = argv[i];
        auto nextVal = [&](const char* name) -> std::string {
            if (i + 1 >= argc) throw std::runtime_error(std::string("missing value for ") + name);
            return argv[++i];
        };
        if (a == "--sim-seconds") simSeconds = std::stod(nextVal(a.c_str()));
        else if (a == "--concurrency") concurrency = std::stoll(nextVal(a.c_str()));
        else if (a == "--ramp-seconds") rampSeconds = std::stod(nextVal(a.c_str()));
        else if (a == "--stats-interval") statsInterval = std::stod(nextVal(a.c_str()));
        else if (a == "--track-vehicle") trackId = std::stoi(nextVal(a.c_str()));
        else if (a == "--port") port = std::stoi(nextVal(a.c_str()));
        else if (a == "--speed") speedMultiplier = std::max(0.1, std::min(24.0, std::stod(nextVal(a.c_str()))));
        else if (a == "--headless") headless = true;
        else if (a == "--advanced-lane-ai") advancedLaneAI = true;
        else if (a == "--signal-mode") signalMode = signalModeFromString(nextVal(a.c_str()));
        else { std::cerr << "unknown argument: " << a << "\n"; return 2; }
    }

    try {
        TimerResolutionGuard timerGuard;
        auto t0 = Clock::now();
        JsonValue mapRoot = JsonParser(chReadFile(mapPath)).parse();
        RoadGraph rg = buildRoadGraph(mapRoot);
        parseRedlightGroups(mapRoot, rg);

        ChGraph chg = loadChGraph(chPath);
        std::cerr << "[sim] CH graph: " << chg.n << " nodes\n";

        JsonValue vehiclesRoot = JsonParser(chReadFile(vehiclesPath)).parse();
        std::vector<TripSpec> trips = loadTrips(vehiclesRoot);
        std::cerr << "[sim] loaded " << trips.size() << " trip specs (setup " << elapsedMs(t0) << " ms)\n";

        // Ambulance depot -> routable node lookup (generate_vehicles.py's own
        // hospital-snapping, already done once at generation time - see
        // find_hospital_depots there - persisted into vehicles.json's
        // meta.depots) so an emergency dispatch's phase 1->2 handoff (see the
        // main loop's edge-transition step) can route an ambulance on to its
        // OWN home hospital by amenity id, not just anywhere.
        std::unordered_map<std::string, std::string> hospitalNodeByAmenityId;
        if (const JsonValue* metaVal = vehiclesRoot.find("meta")) {
            if (const JsonValue* depotsArr = metaVal->find("depots")) {
                if (depotsArr->type == JsonValue::Type::Array) {
                    for (auto& d : depotsArr->arrVal) {
                        auto did = d.str("id"), dNode = d.str("nodeId");
                        if (did && dNode) hospitalNodeByAmenityId[*did] = *dNode;
                    }
                }
            }
        }

        if (concurrency < 0) concurrency = (long long)trips.size();
        concurrency = std::min<long long>(concurrency, (long long)trips.size());

        std::vector<Vehicle> vehicles(trips.size());
        const double dt = 1.0 / 20.0;
        long long spawnBudgetPerTick = std::max<long long>(1, (long long)std::ceil((double)concurrency / std::max(1.0, rampSeconds / dt)));

        double simClock = 0.0;
        size_t spawnCursor = 0;
        std::deque<size_t> spawnRetryQueue; // trip indices blocked by SPAWN_CLEARANCE_M - see the spawn step's own comment
        long long activeCount = 0, totalSpawned = 0, totalCompleted = 0, totalFailedRoute = 0;
        double nextStatsAt = 0.0, nextTrackAt = 0.0;
        bool stopRequested = false;
        double batchAccum = 0.0; // fractional carry for how many sim ticks to run per broadcast, see step 7's own comment

        WsServer server;
        if (!headless) {
            if (!server.start(port)) throw std::runtime_error("failed to start websocket server on 127.0.0.1:" + std::to_string(port) + " (port already in use?)");
            std::cerr << "[sim] websocket server listening on ws://127.0.0.1:" << port << "\n";
        }

        std::unordered_map<std::string, TypeStats> completedByType;
        EmergencyStats emergencyStats;
        // Junctions currently under real emergency preemption this tick
        // (junctionIdx -> the fromWayId being forced green) - recomputed
        // fresh each physics tick in step 3, but declared here (outside the
        // per-tick rep loop) so the last tick's result is still in scope for
        // step 7's broadcast, which only runs once per OUTER iteration.
        std::unordered_map<int, std::string> emergencyPreemptApproach;
        // Density mode's live per-approach "red dot" weight (key
        // "junctionIdx|fromWayId" - see step 3's own comment for how it's
        // computed) - same "declared outside the rep loop so the broadcast
        // can still see it" reasoning as emergencyPreemptApproach above; also
        // exposed to the frontend (buildStateJson's "approachWeights" field)
        // for the selected-junction sidebar display.
        std::unordered_map<std::string, double> densityApproachWeight;

        bool allDone = false;
        while (simClock < simSeconds && !stopRequested && !allDone) {
            auto tickWallStart = Clock::now();
            if (!headless) server.pump([&](const std::string& text, WsClient& fc) { handleCommand(text, fc, speedMultiplier, stopRequested, advancedLaneAI, signalMode, vehicles, rg, chg, trips, simClock); });

            // How many dt=1/20s physics ticks to run before the next
            // broadcast/sleep (step 7) - see that step's own comment for why
            // this batches ticks instead of trying to sleep for an
            // ever-smaller fraction of one tick as speedMultiplier grows.
            // headless mode (scripted testing, no networking) is untouched:
            // always exactly 1 tick per outer iteration, same as before.
            // Live mode accumulates the fractional multiplier (a plain
            // Bresenham-style carry) so the AVERAGE rate over time matches
            // speedMultiplier exactly even when it isn't a whole number.
            int ticksThisIteration = 1;
            if (!headless) {
                batchAccum += speedMultiplier;
                ticksThisIteration = std::max(1, (int)std::floor(batchAccum));
                batchAccum -= ticksThisIteration;
            }

            for (int rep = 0; rep < ticksThisIteration && simClock < simSeconds; ++rep) {

            // 1. Spawn, paced so a large target concurrency ramps up over
            // rampSeconds instead of bursting thousands of CH queries into
            // tick 0. trySpawnIndex refuses to spawn on top of a vehicle
            // already sitting near the start of the route's first edge/lane
            // (see SPAWN_CLEARANCE_M) - without that, two trips starting on
            // the same road could spawn overlapping/collided, since spawning
            // otherwise never checked for existing traffic. A blocked trip
            // goes on spawnRetryQueue rather than being dropped or stalling
            // every OTHER trip this tick - each tick gives every currently-
            // queued retry exactly one more attempt (the size() snapshot
            // below bounds that to one pass, so a still-blocked one goes to
            // the BACK of the queue instead of being retried again
            // immediately, which would spin forever on a single persistently
            // busy road instead of moving on to try other trips).
            long long spawnedThisTick = 0;
            auto trySpawnIndex = [&](size_t idx) -> bool {
                const TripSpec& t = trips[idx];
                std::string err;
                std::vector<RouteStep> route = resolveRoute(rg, chg, t.startNodeId, t.endNodeId, err);
                if (route.empty()) {
                    totalSpawned++;
                    totalFailedRoute++;
                    std::cerr << "[sim] WARN vehicle " << t.id << " route failed: " << err << "\n";
                    return true;
                }
                int spawnLane = desiredLaneForStep(rg, route, 0);
                if (!route[0].isJunction) {
                    for (auto& ov : vehicles) {
                        if (!ov.active || ov.route.empty()) continue;
                        const RouteStep& os = ov.route[ov.routeIdx];
                        if (os.isJunction || os.edgeIndex != route[0].edgeIndex || ov.lane != spawnLane) continue;
                        if (ov.distAlongEdge < SPAWN_CLEARANCE_M) return false; // blocked - caller re-queues
                    }
                }
                totalSpawned++;
                Vehicle& v = vehicles[idx];
                v.id = t.id; v.vehicleType = t.vehicleType; v.length = t.length; v.width = t.width;
                v.maxSpeedMps = t.maxSpeedKmh / 3.6;
                const TypeProfile& prof = profileFor(t.vehicleType);
                v.aMax = t.accelMps2 > 0 ? t.accelMps2 : prof.aMax; // per-vehicle if generate_vehicles.py provided one, else the type default
                v.bComfort = prof.bComfort; v.headwayT = prof.headwayT; v.minGap = prof.minGap;
                v.route = std::move(route);
                v.routeIdx = 0; v.distAlongEdge = 0; v.speed = 0; v.active = true;
                v.lane = spawnLane;
                v.spawnSimTime = simClock; v.waitTimeSec = 0; v.arrivalAtStopLineTime = -1;
                v.homeAmenityId = t.homeAmenityId;
                v.emergency = false; v.emergencyPhase = 0; v.dispatchTime = -1; v.incidentArrivalTime = -1;
                v.waitingLight = false; v.waitStartTime = -1;
                activeCount++;
                return true;
            };

            size_t retryRounds = spawnRetryQueue.size();
            for (size_t i = 0; i < retryRounds && activeCount < concurrency && spawnedThisTick < spawnBudgetPerTick; ++i) {
                size_t idx = spawnRetryQueue.front();
                spawnRetryQueue.pop_front();
                if (trySpawnIndex(idx)) spawnedThisTick++;
                else spawnRetryQueue.push_back(idx);
            }
            while (activeCount < concurrency && spawnCursor < trips.size() && spawnedThisTick < spawnBudgetPerTick) {
                size_t idx = spawnCursor++;
                if (trySpawnIndex(idx)) spawnedThisTick++;
                else spawnRetryQueue.push_back(idx);
            }

            // 1.5. Discretionary lane changing (overtaking) - decide/update
            // each vehicle's lane BEFORE grouping, so every step downstream
            // (grouping, arbitration, IDM) just sees each vehicle's already-
            // current lane with no further changes needed - see the lane-
            // changing section's own header comment for the model. Wide
            // vehicles (isWideVehicle) and junction-edge vehicles are
            // excluded entirely: junction-edge vehicles because lanes aren't
            // meaningful once inside the box (see desiredLaneForStep), wide
            // ones because they can't share a lane split with anyone anyway.
            {
                std::unordered_map<int, std::vector<int>> byChainEdge;
                for (size_t vi = 0; vi < vehicles.size(); ++vi) {
                    Vehicle& v = vehicles[vi];
                    if (!v.active || v.route[v.routeIdx].isJunction) continue;
                    byChainEdge[v.route[v.routeIdx].edgeIndex].push_back((int)vi);
                }
                for (auto& [edgeIdx, idxs] : byChainEdge) {
                    const ChainEdge& ce = rg.chainEdges[edgeIdx];
                    if (simLaneCount(ce) < 2) continue;
                    std::sort(idxs.begin(), idxs.end(), [&](int a, int b) { return vehicles[a].distAlongEdge < vehicles[b].distAlongEdge; });
                    for (int vi : idxs) {
                        Vehicle& v = vehicles[vi];
                        if (isWideVehicle(v.width)) continue;
                        if (simClock < v.nextLaneEvalAt) continue;
                        v.nextLaneEvalAt = simClock + 0.8 + 0.4 * (vi % 5); // staggered so the whole edge doesn't re-evaluate in lockstep

                        int homeLane = desiredLaneForStep(rg, v.route, v.routeIdx);
                        double distToEnd = ce.lengthM - v.distAlongEdge;
                        double mergeBackDist = std::max(35.0, v.speed * 3.0);

                        // Only a movement that actually REQUIRES the crossing
                        // lane (right turn / u-turn - homeLane 1, see
                        // desiredLaneForStep) forces a lane change here. A
                        // through movement's "home" of lane 0 is just the
                        // spawn-time default, not a real requirement - going
                        // straight works fine from either lane - so it's
                        // left alone entirely: a vehicle that drifted into
                        // lane 1 (an earlier overtake) stays there until it
                        // has its own reason to move, rather than being
                        // yanked back to lane 0 on every approach regardless
                        // of whether anything ahead actually needs it.
                        if (homeLane == 1 && v.lane != 1) {
                            bool urgent = distToEnd <= mergeBackDist;
                            double gapA = urgent ? MERGE_BACK_GAP_AHEAD_M : LANE_CHANGE_GAP_AHEAD_M;
                            double gapB = urgent ? MERGE_BACK_GAP_BEHIND_M : LANE_CHANGE_GAP_BEHIND_M;
                            if (laneChangeSafe(idxs, vehicles, v, vi, 1, gapA, gapB)) v.lane = 1;
                            continue;
                        }

                        // Cruising - consider overtaking. Deliberately NOT
                        // skipped near a junction: the single most useful
                        // case is exactly there - getting around a vehicle
                        // that's stopped ahead waiting to turn on red.
                        int otherLane = 1 - v.lane;
                        if (advancedLaneAI) {
                            // "Vision" mode: score both lanes over the next
                            // VISION_RANGE_M rather than just reacting to the
                            // immediate leader - see laneVisionCost's own
                            // comment. The margin avoids flip-flopping when
                            // both lanes are roughly equally clear.
                            double desiredSpeed = std::min(v.maxSpeedMps, ce.freeFlowSpeedMps);
                            double costHome = laneVisionCost(idxs, vehicles, v.lane, v.distAlongEdge, desiredSpeed, vi);
                            double costOther = laneVisionCost(idxs, vehicles, otherLane, v.distAlongEdge, desiredSpeed, vi);
                            if (costOther + 0.5 < costHome &&
                                laneChangeSafe(idxs, vehicles, v, vi, otherLane, LANE_CHANGE_GAP_AHEAD_M, LANE_CHANGE_GAP_BEHIND_M))
                                v.lane = otherLane;
                            continue;
                        }
                        LaneNeighbors here = findLaneNeighbors(idxs, vehicles, v.lane, v.distAlongEdge, vi);
                        if (here.aheadVi < 0) continue;
                        const Vehicle& leader = vehicles[here.aheadVi];
                        double gapToLeader = leader.distAlongEdge - leader.length - v.distAlongEdge;
                        double desiredGap = v.minGap + v.speed * v.headwayT;
                        bool leaderSlow = leader.speed < v.maxSpeedMps * 0.85 && gapToLeader < std::max(desiredGap * 1.4, 10.0);
                        if (!leaderSlow) continue;
                        if (laneChangeSafe(idxs, vehicles, v, vi, otherLane, LANE_CHANGE_GAP_AHEAD_M, LANE_CHANGE_GAP_BEHIND_M))
                            v.lane = otherLane;
                    }
                }
            }

            // 2. Group active vehicles by current edge, ordered by position
            // (back of the vector = front of the physical queue).
            std::unordered_map<uint64_t, std::vector<int>> groups;
            groups.reserve((size_t)activeCount * 2 + 16);
            for (size_t vi = 0; vi < vehicles.size(); ++vi) {
                Vehicle& v = vehicles[vi];
                if (!v.active) continue;
                groups[edgeKey(v.route[v.routeIdx], v.lane)].push_back((int)vi);
            }
            for (auto& [k, idxs] : groups)
                std::sort(idxs.begin(), idxs.end(), [&](int a, int b) { return vehicles[a].distAlongEdge < vehicles[b].distAlongEdge; });

            // 3. Signal/priority gating for each edge-group's front vehicle.
            // Evaluated every tick (not just "at the line") so IDM sees the
            // obstacle from a distance and brakes smoothly, not just at the
            // last moment - see file header discussion. Unsignalized
            // junctions run one small arbitration per junction per tick:
            // highest road-class rank wins, ties broken by whoever became
            // the front of its approach first (first-come-first-served),
            // gated by a minimum discharge headway so one approach can't
            // starve every other one instantly.
            for (auto& v : vehicles) v.gate = 0;

            // Emergency preemption (EmergencyOnly AND Density mode - Default
            // mode has no ambulance-awareness at all, see SignalMode's own
            // comment): a fresh per-tick scan for any vehicle with
            // emergency==true at the front of an approach queue leading into
            // a SIGNALIZED junction, recorded as (junctionIdx -> the
            // fromWayId to force green) BEFORE the gating loop below decides
            // any colors, so it can short-circuit both modes' ordinary logic
            // for a preempted junction. Recomputed fresh every tick (never
            // latched) so preemption ends automatically the instant the
            // emergency vehicle clears the junction (its routeIdx advances
            // past it) or its flag goes back off.
            emergencyPreemptApproach.clear();
            if (signalMode != SignalMode::Default) {
                for (auto& [k, idxs] : groups) {
                    if (idxs.empty()) continue;
                    Vehicle& fv = vehicles[idxs.back()];
                    if (!fv.emergency || fv.vehicleType != "ambulance") continue;
                    if (fv.route[fv.routeIdx].isJunction || fv.routeIdx + 1 >= fv.route.size()) continue;
                    const RouteStep& nxt = fv.route[fv.routeIdx + 1];
                    if (!nxt.isJunction) continue;
                    const JunctionEdge& je = rg.junctionEdges[nxt.edgeIndex];
                    if (!rg.junctions[je.junctionIdx].signal.present) continue;
                    emergencyPreemptApproach[je.junctionIdx] = je.fromWayId;
                }
            }

            // Density mode's per-approach "red dot" weight (count of
            // vehicles currently waiting for this red light, plus the
            // seconds each has been waiting - see Vehicle::waitingLight) -
            // built from the END of LAST tick's waiting state, one tick of
            // lag behind this tick's own gate outcome (decided below), same
            // as the ordinary impatience-rank feedback loop already accepted
            // throughout this file.
            densityApproachWeight.clear();
            if (signalMode == SignalMode::Density) {
                for (auto& v : vehicles) {
                    if (!v.active || !v.waitingLight || v.route[v.routeIdx].isJunction) continue;
                    if (v.routeIdx + 1 >= v.route.size()) continue;
                    const RouteStep& nxt = v.route[v.routeIdx + 1];
                    if (!nxt.isJunction) continue;
                    const JunctionEdge& je = rg.junctionEdges[nxt.edgeIndex];
                    densityApproachWeight[std::to_string(je.junctionIdx) + "|" + je.fromWayId] +=
                        1.0 + std::max(0.0, simClock - v.waitStartTime);
                }
            }

            // Candidates competing for entry into each unsignalized junction
            // this tick (one per approach-lane, i.e. per group's front
            // vehicle) - see the release loop just below for how more than
            // one of these can actually be let through together.
            struct JctCandidate {
                int vi; std::string fromWayId, movement, toWayId;
                double arrDirX, arrDirY, lengthM, speedMps;
                double rank; double arrivalTime;
            };
            std::unordered_map<int, std::vector<JctCandidate>> candidatesForJunction;

            for (auto& [k, idxs] : groups) {
                if (idxs.empty()) continue;
                int frontVi = idxs.back();
                Vehicle& fv = vehicles[frontVi];
                if (fv.routeIdx + 1 >= fv.route.size()) continue;
                const RouteStep& nxt = fv.route[fv.routeIdx + 1];
                if (!nxt.isJunction) { fv.gate = 1; continue; }
                const JunctionEdge& je = rg.junctionEdges[nxt.edgeIndex];
                const JunctionInfo& jn = rg.junctions[je.junctionIdx];

                auto preemptIt = emergencyPreemptApproach.find(je.junctionIdx);
                if (jn.signal.present && preemptIt != emergencyPreemptApproach.end()) {
                    // Real preemption: this approach wins outright, every
                    // other approach at this junction forced red - not a
                    // rank bonus fed into the ordinary arbitration below.
                    fv.gate = (je.fromWayId == preemptIt->second) ? 1 : 2;
                } else if (jn.signal.present && (signalMode == SignalMode::Default || signalMode == SignalMode::EmergencyOnly)) {
                    // EmergencyOnly with no active preemption at this
                    // junction (handled above) runs the EXACT SAME fixed-
                    // time math/timer as Default mode - see SignalMode's own
                    // comment for why that's the whole point of the mode.
                    std::string color = computeLampColor(rg, je.junctionIdx, je.fromWayId, je.movement, simClock);
                    fv.gate = (color == "green") ? 1 : 2;
                } else {
                    if (fv.arrivalAtStopLineTime < 0) fv.arrivalAtStopLineTime = simClock;
                    // Effective rank climbs with wait time (see
                    // IMPATIENCE_SEC's own comment) so a low-class approach
                    // isn't starved forever behind a busier cross-street. A
                    // signalized junction running Density mode instead of
                    // the fixed-time branch above (see SignalMode's own
                    // comment) swaps in that mode's own "red dot" weight in
                    // place of the plain road-class rank; a genuinely
                    // unsignalized junction (any mode) always uses the plain
                    // road-class rank.
                    double waited = std::max(0.0, simClock - fv.arrivalAtStopLineTime);
                    double rank = (jn.signal.present && signalMode == SignalMode::Density)
                        ? densityApproachWeight[std::to_string(je.junctionIdx) + "|" + je.fromWayId]
                        : je.priorityRank + waited / IMPATIENCE_SEC;
                    candidatesForJunction[je.junctionIdx].push_back({frontVi, je.fromWayId, je.movement, je.toWayId,
                        je.arrDirX, je.arrDirY, je.lengthM, je.speedMps, rank, fv.arrivalAtStopLineTime});
                    fv.gate = 2; // tentatively closed, possibly flipped below
                }
            }
            // Two candidate movements at the same unsignalized junction (or a
            // signalized one under Density mode - see SignalMode) can
            // discharge in the same window - i.e. the junction's effective
            // capacity this tick, the "width of the intersection" fix - when
            // they provably don't cross paths (see movementsCompatible's own
            // comment for the exact rule). Anything else still serializes -
            // flow-channel fidelity, not full conflict-point geometry;
            // relaxing only the provably-safe cases widens real bottlenecks
            // without inventing new mid-junction collisions.
            for (auto& [jidx, cands] : candidatesForJunction) {
                JunctionInfo& jn = rg.junctions[jidx];
                jn.inFlight.erase(std::remove_if(jn.inFlight.begin(), jn.inFlight.end(),
                    [&](const JctFlight& f) { return simClock >= f.freeAt; }), jn.inFlight.end());

                std::vector<const JctCandidate*> order;
                order.reserve(cands.size());
                for (auto& c : cands) order.push_back(&c);
                std::sort(order.begin(), order.end(), [](const JctCandidate* a, const JctCandidate* b) {
                    if (a->rank != b->rank) return a->rank > b->rank;
                    return a->arrivalTime < b->arrivalTime;
                });

                std::vector<const JctCandidate*> accepted;
                for (const JctCandidate* c : order) {
                    bool ok = true;
                    for (auto& f : jn.inFlight) {
                        if (!movementsCompatible(c->fromWayId, c->movement, c->arrDirX, c->arrDirY, c->toWayId,
                                                  f.fromWayId, f.movement, f.arrDirX, f.arrDirY, f.toWayId)) { ok = false; break; }
                    }
                    if (ok) for (const JctCandidate* other : accepted) {
                        if (!movementsCompatible(c->fromWayId, c->movement, c->arrDirX, c->arrDirY, c->toWayId,
                                                  other->fromWayId, other->movement, other->arrDirX, other->arrDirY, other->toWayId)) { ok = false; break; }
                    }
                    if (!ok) continue;
                    accepted.push_back(c);
                    vehicles[c->vi].gate = 1;
                    jn.inFlight.push_back({simClock + c->lengthM / std::max(0.1, c->speedMps) + MIN_DISCHARGE_GAP_SEC,
                                            c->fromWayId, c->movement, c->toWayId, c->arrDirX, c->arrDirY});
                }
            }

            // Density mode's "waiting for the light" red-dot state (see
            // Vehicle::waitingLight/waitStartTime): a follower is marked
            // waiting purely from sharing its front vehicle's now-finalized
            // gate (only front vehicles are ever gated directly - see above;
            // followers queue up behind them via ordinary IDM car-following),
            // which is exactly what makes the red dot "chain" backward
            // through a queue as it forms. Feeds NEXT tick's
            // densityApproachWeight above, and is streamed to the frontend
            // as-is (see buildStateJson's per-vehicle "wt" field).
            for (auto& v : vehicles) if (v.active) v.waitingLight = false;
            if (signalMode == SignalMode::Density) {
                for (auto& [k, idxs] : groups) {
                    if (idxs.empty()) continue;
                    Vehicle& gfv = vehicles[idxs.back()];
                    if (gfv.gate != 2 || gfv.route[gfv.routeIdx].isJunction || gfv.routeIdx + 1 >= gfv.route.size()) continue;
                    const RouteStep& gnxt = gfv.route[gfv.routeIdx + 1];
                    if (!gnxt.isJunction) continue;
                    if (!rg.junctions[rg.junctionEdges[gnxt.edgeIndex].junctionIdx].signal.present) continue;
                    for (int vi : idxs) {
                        Vehicle& v = vehicles[vi];
                        if (v.speed < 0.5) v.waitingLight = true;
                    }
                }
            }
            for (auto& v : vehicles) {
                if (v.waitingLight) { if (v.waitStartTime < 0) v.waitStartTime = simClock; }
                else v.waitStartTime = -1;
            }

            // 4. IDM acceleration for every active vehicle.
            const double DELTA = 4.0;
            for (auto& [k, idxs] : groups) {
                for (size_t pos = 0; pos < idxs.size(); ++pos) {
                    Vehicle& v = vehicles[idxs[pos]];
                    const RouteStep& cur = v.route[v.routeIdx];
                    double curLimit = cur.isJunction ? rg.junctionEdges[cur.edgeIndex].speedMps : rg.chainEdges[cur.edgeIndex].freeFlowSpeedMps;
                    double v0 = std::max(0.5, std::min(v.maxSpeedMps, curLimit));
                    double leaderGap = 0, leaderSpeed = 0;
                    bool hasLeader = false;

                    if (pos + 1 < idxs.size()) {
                        Vehicle& lv = vehicles[idxs[pos + 1]];
                        leaderGap = lv.distAlongEdge - lv.length - v.distAlongEdge;
                        leaderSpeed = lv.speed;
                        hasLeader = true;
                    } else if (v.routeIdx + 1 < v.route.size()) {
                        const RouteStep& nxt = v.route[v.routeIdx + 1];
                        double nextLimit = nxt.isJunction ? rg.junctionEdges[nxt.edgeIndex].speedMps : rg.chainEdges[nxt.edgeIndex].freeFlowSpeedMps;
                        if (v.gate == 2) {
                            // Blocked (red / lost arbitration): a real
                            // stationary obstacle - IDM's ordinary leader-
                            // following naturally produces a full, held stop
                            // here, which is exactly right. The obstacle is
                            // placed STOP_LINE_SETBACK_M short of the edge's
                            // true end (the pulled-back junction node) so the
                            // vehicle holds before the intersection's visual
                            // footprint rather than rendering/logically
                            // inside it - see that constant's own comment.
                            double stopBoundary = std::max(0.0, cur.length - STOP_LINE_SETBACK_M);
                            leaderGap = stopBoundary - v.distAlongEdge;
                            leaderSpeed = 0; hasLeader = true;
                        } else {
                            int nxtLane = desiredLaneForStep(rg, v.route, v.routeIdx + 1);
                            auto git = groups.find(edgeKey(nxt, nxtLane));
                            if (git != groups.end() && !git->second.empty()) {
                                Vehicle& rv = vehicles[git->second.front()];
                                leaderGap = (cur.length - v.distAlongEdge) + rv.distAlongEdge - rv.length;
                                leaderSpeed = rv.speed; hasLeader = true;
                            } else if (nextLimit < v0) {
                                // Anticipatory slowing for a slower segment
                                // ahead with nothing actually queued there:
                                // NOT modelled as an IDM leader (that
                                // demands convergence toward a full stop at
                                // the boundary, which is wrong when the
                                // vehicle is meant to cruise through at
                                // nextLimit, not stop there - an earlier
                                // version of this file did exactly that and
                                // deadlocked every vehicle just short of
                                // every boundary). Simply retargeting v0
                                // once within comfortable braking distance
                                // lets the ordinary free-road IDM term glide
                                // the speed down smoothly with no stopping
                                // fixation, and resume normally once
                                // routeIdx actually advances onto the new
                                // edge's own limit.
                                double distToBoundary = std::max(0.0, cur.length - v.distAlongEdge);
                                double brakingDist = (v.speed > nextLimit) ? (v.speed * v.speed - nextLimit * nextLimit) / (2.0 * v.bComfort) : 0.0;
                                double lookahead = std::max(brakingDist, nextLimit * 2.0);
                                if (distToBoundary <= lookahead) v0 = nextLimit;
                            }
                        }
                    }

                    double freeTerm = 1.0 - std::pow(v.speed / std::max(0.01, v0), DELTA);
                    double accel;
                    if (hasLeader) {
                        double gap = std::max(0.1, leaderGap);
                        double dv = v.speed - leaderSpeed;
                        double sStar = v.minGap + std::max(0.0, v.speed * v.headwayT + (v.speed * dv) / (2 * std::sqrt(v.aMax * v.bComfort)));
                        accel = v.aMax * (freeTerm - (sStar / gap) * (sStar / gap));
                    } else {
                        accel = v.aMax * freeTerm;
                    }
                    v.accel = std::max(-8.0, std::min(v.aMax, accel));
                }
            }

            // 5. Integrate + edge transitions.
            for (auto& v : vehicles) {
                if (!v.active) continue;
                v.speed = std::max(0.0, v.speed + v.accel * dt);
                v.distAlongEdge += v.speed * dt;
                if (v.speed < 0.5) v.waitTimeSec += dt;

                size_t startRouteIdx = v.routeIdx;
                while (v.active && v.distAlongEdge >= v.route[v.routeIdx].length) {
                    const RouteStep& cur = v.route[v.routeIdx];
                    if (v.routeIdx + 1 >= v.route.size()) {
                        // Emergency dispatch (see handleCommand's
                        // triggerEmergency): reaching the end of the
                        // incident-bound leg (phase 1) hands off to a fresh
                        // leg toward the ambulance's own home hospital
                        // instead of ending the trip - reaching the end of
                        // THAT leg (phase 2), or a plain non-emergency trip,
                        // ends it exactly as before.
                        if (v.emergency && v.emergencyPhase == 1) {
                            v.incidentArrivalTime = simClock;
                            auto hit = hospitalNodeByAmenityId.find(v.homeAmenityId);
                            std::vector<RouteStep> toHospital;
                            if (hit != hospitalNodeByAmenityId.end()) {
                                std::string err;
                                toHospital = resolveRoute(rg, chg, rg.nodeId[stepToNode(rg, cur)], hit->second, err);
                            }
                            if (!toHospital.empty()) {
                                v.route = std::move(toHospital);
                                v.routeIdx = 0; v.distAlongEdge = 0;
                                v.lane = desiredLaneForStep(rg, v.route, 0);
                                v.emergencyPhase = 2;
                                break;
                            }
                            // No known home hospital, or routing to it
                            // failed - fall through and end the trip like an
                            // ordinary completion, below.
                        }
                        if (v.emergency && v.emergencyPhase == 2) {
                            emergencyStats.count++;
                            emergencyStats.sumResponseSec += std::max(0.0, v.incidentArrivalTime - v.dispatchTime);
                            emergencyStats.sumTransportSec += std::max(0.0, simClock - v.incidentArrivalTime);
                        }
                        v.active = false; activeCount--; totalCompleted++;
                        double tripSec = simClock - v.spawnSimTime;
                        auto& ts = completedByType[v.vehicleType];
                        ts.count++; ts.sumTripSec += tripSec;
                        break;
                    }
                    const RouteStep& nxt = v.route[v.routeIdx + 1];
                    if (nxt.isJunction) {
                        bool gateOk;
                        if (v.routeIdx == startRouteIdx) {
                            gateOk = (v.gate == 1);
                        } else {
                            // A second junction reached within the same tick
                            // (only possible via a very short chain edge) -
                            // re-check a signal fresh (pure function of
                            // simClock); stay conservative/closed for an
                            // unsignalized one rather than bypass arbitration.
                            const JunctionEdge& je2 = rg.junctionEdges[nxt.edgeIndex];
                            const JunctionInfo& jn2 = rg.junctions[je2.junctionIdx];
                            gateOk = jn2.signal.present && signalMode == SignalMode::Default &&
                                     computeLampColor(rg, je2.junctionIdx, je2.fromWayId, je2.movement, simClock) == "green";
                        }
                        if (!gateOk) { v.distAlongEdge = cur.length; break; }
                    }
                    double overshoot = v.distAlongEdge - cur.length;
                    // Reservation bookkeeping for the NEXT unsignalized
                    // junction this vehicle reaches already lives in
                    // JunctionInfo::inFlight, populated the moment
                    // arbitration granted gate==1 (see step 3) rather than
                    // here at physical entry - nothing further to record.
                    if (nxt.isJunction) v.arrivalAtStopLineTime = -1;
                    v.routeIdx++;
                    if (!nxt.isJunction) v.lane = desiredLaneForStep(rg, v.route, v.routeIdx);
                    v.distAlongEdge = overshoot;
                }
            }

            // 6. Periodic stats + optional single-vehicle speed trace (proof
            // of acceleration/deceleration behaviour for verification).
            if (simClock >= nextStatsAt) {
                nextStatsAt += statsInterval;
                double sumSpeed = 0; long long nActive = 0;
                for (auto& v : vehicles) if (v.active) { sumSpeed += v.speed; nActive++; }
                long long allCount = 0; double allSum = 0;
                for (auto& [ty, ts] : completedByType) { allCount += ts.count; allSum += ts.sumTripSec; }
                auto ambIt = completedByType.find("ambulance");
                double avgAmbTrip = (ambIt != completedByType.end() && ambIt->second.count) ? ambIt->second.sumTripSec / ambIt->second.count : 0.0;
                std::cerr << "[sim t=" << std::fixed << std::setprecision(1) << simClock << "s] active=" << nActive
                          << " spawned=" << totalSpawned << "/" << trips.size() << " completed=" << totalCompleted
                          << " avgSpeed=" << (nActive ? (sumSpeed / nActive) * 3.6 : 0.0) << "km/h"
                          << " avgTrip=" << (allCount ? allSum / allCount : 0.0) << "s"
                          << " avgAmbTrip=" << avgAmbTrip << "s"
                          << " emergencies=" << emergencyStats.count
                          << " avgResponse=" << (emergencyStats.count ? emergencyStats.sumResponseSec / emergencyStats.count : 0.0) << "s"
                          << " avgTransport=" << (emergencyStats.count ? emergencyStats.sumTransportSec / emergencyStats.count : 0.0) << "s"
                          << " failedRoutes=" << totalFailedRoute
                          << (headless ? "" : (" wsClients=" + std::to_string(server.clientCount()))) << "\n";
            }
            if (trackId >= 0 && simClock >= nextTrackAt) {
                nextTrackAt += 1.0;
                for (auto& v : vehicles) {
                    if (v.id == trackId && v.active) {
                        std::cerr << "[track " << trackId << "] t=" << simClock << "s speed=" << v.speed * 3.6
                                  << "km/h accel=" << v.accel << "m/s2 routeIdx=" << v.routeIdx << "/" << v.route.size() << "\n";
                        break;
                    }
                }
            }

            simClock += dt;
            if (activeCount == 0 && spawnCursor >= trips.size() && spawnRetryQueue.empty()) { allDone = true; break; }
            } // end of per-tick batch (rep loop)

            // 7. Broadcast the latest snapshot and, unless running headless
            // for scripted testing, pace the loop to real time. This always
            // sleeps for one nominal dt's worth of real time (never a
            // fraction of it) and instead varies HOW MANY physics ticks ran
            // in ticksThisIteration above to reach the target rate - an
            // earlier version instead divided dt itself by speedMultiplier
            // and slept for that shrinking fraction directly, which fell
            // badly short of the requested speed above roughly 5-8x: Windows'
            // std::this_thread::sleep_for has coarse granularity (commonly
            // ~15ms) that dominates once the requested sleep drops to a few
            // milliseconds, so the loop kept oversleeping regardless of how
            // high speedMultiplier was set (measured: 24x only achieved
            // ~5x). Keeping every sleep pinned to a full ~50ms tick's worth
            // of real time stays comfortably above that granularity at any
            // speedMultiplier, and broadcasting once per batch instead of
            // once per physics tick also caps network/JSON-build cost at a
            // steady ~20Hz instead of scaling it up with speed for no
            // visual benefit (a browser can't usefully render faster than
            // that anyway).
            if (!headless) {
                server.broadcast(buildStateJson(simClock, vehicles, rg, totalSpawned, totalCompleted, trips.size(), signalMode,
                                                 emergencyPreemptApproach, densityApproachWeight, completedByType, emergencyStats));
                double elapsed = std::chrono::duration<double>(Clock::now() - tickWallStart).count();
                if (elapsed < dt) std::this_thread::sleep_for(std::chrono::duration<double>(dt - elapsed));
            }
        }
        if (!headless) std::cerr << "[sim] stopping (t=" << simClock << "s, stopRequested=" << stopRequested << ")\n";

        std::cerr << "\n[sim] FINAL SUMMARY at t=" << std::fixed << std::setprecision(1) << simClock << "s\n";
        std::cerr << "  trips in manifest: " << trips.size() << ", spawned: " << totalSpawned
                  << ", completed: " << totalCompleted << ", failed-to-route: " << totalFailedRoute
                  << ", still active: " << activeCount << "\n";
        for (auto& [ty, ts] : completedByType)
            std::cerr << "  " << ty << ": " << ts.count << " completed, avg trip " << (ts.count ? ts.sumTripSec / ts.count : 0.0) << "s\n";
        if (emergencyStats.count)
            std::cerr << "  emergencies: " << emergencyStats.count
                      << ", avg response (dispatch->incident) " << emergencyStats.sumResponseSec / emergencyStats.count << "s"
                      << ", avg transport (incident->hospital) " << emergencyStats.sumTransportSec / emergencyStats.count << "s\n";
        return 0;
    } catch (const std::exception& ex) {
        std::cerr << "[sim] FATAL: " << ex.what() << "\n";
        return 1;
    }
}
