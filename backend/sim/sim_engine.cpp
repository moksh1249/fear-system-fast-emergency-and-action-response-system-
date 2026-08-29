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
static constexpr double MIN_DISCHARGE_GAP_SEC = 2.0;          // minimum headway between successive discharges at an unsignalized junction

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
    if (movement == "right") { redStart = isA ? stepSec : 3 * stepSec; redDur = 3 * stepSec; }
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
static std::string classifyMovement(double arrDirX, double arrDirY, double depDirX, double depDirY) {
    double cross = arrDirX * depDirY - arrDirY * depDirX;
    double dot = arrDirX * depDirX + arrDirY * depDirY;
    double angle = std::atan2(cross, dot);
    return (angle < -0.1) ? "right" : "through";
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
    int lanes;
    int highwayRank;
};

struct JunctionEdge {
    int from, to;
    std::string fromWayId;   // arrival approach - signal/priority lookup key
    std::string toWayId;     // departure approach
    std::string movement;    // "through" | "right"
    double lengthM;
    double speedMps;
    int junctionIdx;
    int priorityRank;        // = highway rank of fromWayId
};

struct OutEdgeRef { bool isJunction; int index; };

struct JunctionInfo {
    std::string joinGroupId;
    int primaryNodeIdx;
    std::vector<int> memberIndices;
    SignalConfig signal;
    // Runtime arbitration state (unsignalized junctions only) - see the main
    // loop's step 3: only one vehicle may enter per MIN_DISCHARGE_GAP_SEC
    // window, a coarse "one at a time" approximation appropriate at
    // flow-channel fidelity (real conflict-point geometry is out of scope).
    double busyUntil = 0.0;
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
        int rank = highwayPriorityRank(highway);
        wayHighwayRank[wayId] = rank;

        std::string oneway = tags ? tags->str("oneway").value_or("") : "";
        std::string junction = tags ? tags->str("junction").value_or("") : "";
        bool forward = true, backward = true;
        if (oneway == "yes") backward = false;
        else if (oneway == "-1") forward = false;
        else if (oneway != "no" && junction == "roundabout") backward = false;

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
                rg.chainEdges.push_back({chain[k], chain[k + 1], wayId, d, speedMps, lanes, rank});
                rg.outAdj[chain[k]].push_back({false, (int)rg.chainEdges.size() - 1});
                chainEdgeCount++;
            }
            if (backward) {
                rg.chainEdges.push_back({chain[k + 1], chain[k], wayId, d, speedMps, lanes, rank});
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

        int junctionIdx = (int)rg.junctions.size();
        rg.junctionIndexByGroupId[gid] = junctionIdx;
        rg.junctions.push_back(std::move(info));

        if (members.size() < 2) continue; // a lone member has nothing to cross to

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
                je.movement = classifyMovement(arrDirX, arrDirY, depDirX, depDirY);
                je.lengthM = d; je.speedMps = TURN_SPEED_MPS;
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

// Top-level per-lamp color dispatch - port of redlight.js's getRedlightCountdown
// (minus the external-override branch, which has no equivalent in this
// headless engine; Phase 4/5 add their own internal preemption on top of this).
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

struct TypeProfile { double aMax, bComfort, headwayT, minGap; };

static const TypeProfile& profileFor(const std::string& type) {
    static const std::unordered_map<std::string, TypeProfile> table = {
        {"car", {2.5, 3.0, 1.4, 2.0}},
        {"motorcycle", {3.5, 3.5, 1.0, 1.5}},
        {"bus", {1.2, 2.0, 1.8, 3.0}},
        {"truck", {1.0, 2.0, 1.8, 3.0}},
        {"ambulance", {3.0, 3.5, 1.2, 2.0}},
    };
    auto it = table.find(type);
    return it != table.end() ? it->second : table.at("car");
}

struct TripSpec {
    int id;
    std::string vehicleType, startNodeId, endNodeId;
    double length, maxSpeedKmh;
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
        t.maxSpeedKmh = v.num("maxSpeedKmh").value_or(140.0);
        out.push_back(std::move(t));
    }
    return out;
}

struct Vehicle {
    int id = -1;
    std::string vehicleType;
    double length = 4.5, maxSpeedMps = 38.9;
    double aMax = 2.5, bComfort = 3.0, headwayT = 1.4, minGap = 2.0;
    std::vector<RouteStep> route;
    size_t routeIdx = 0;
    double distAlongEdge = 0.0;
    double speed = 0.0;
    double accel = 0.0;
    bool active = false;
    double spawnSimTime = 0.0;
    double waitTimeSec = 0.0;
    double arrivalAtStopLineTime = -1.0;
    int gate = 0; // 0 = n/a this tick, 1 = open, 2 = closed - only meaningful for an edge-group's front vehicle
};

static uint64_t edgeKey(const RouteStep& s) { return ((uint64_t)(s.isJunction ? 1 : 0) << 32) | (uint32_t)s.edgeIndex; }

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
    void pump(const std::function<void(const std::string&)>& onCommand) {
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
                if (!text.empty()) { onCommand(text); text.clear(); }
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

// Compact JSON build (hand-rolled, matching ch_preprocess.cpp/ch_query.cpp's
// own approach - no library) for the per-tick broadcast. vehicleType is
// always one of this project's own small fixed set (never externally
// supplied), so no escaping is needed for it.
static std::string buildStateJson(double simClock, const std::vector<Vehicle>& vehicles, const RoadGraph& rg,
                                   long long totalSpawned, long long totalCompleted, size_t totalTrips) {
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
        if (!first) out += ",";
        first = false;
        out += "{\"id\":"; out += std::to_string(v.id);
        out += ",\"x\":"; appendNum(x, 2);
        out += ",\"y\":"; appendNum(y, 2);
        out += ",\"h\":"; appendNum(heading, 3);
        out += ",\"s\":"; appendNum(v.speed * 3.6, 1);
        out += ",\"ty\":\""; out += v.vehicleType; out += "\"}";
    }
    out += "]}";
    return out;
}

// Control messages from the frontend - only setSpeed/stop do anything in
// this phase; setMode/triggerEmergency are parsed and acknowledged (so a
// forward-compatible client doesn't get an error) but have no effect until
// Phase 4/5 add the modes/emergency system they belong to.
static void handleCommand(const std::string& text, double& speedMultiplier, bool& stopRequested) {
    try {
        JsonValue msg = JsonParser(text).parse();
        auto cmd = msg.str("cmd");
        if (!cmd) return;
        if (*cmd == "setSpeed") {
            speedMultiplier = std::max(0.1, std::min(24.0, msg.num("value").value_or(1.0)));
            std::cerr << "[sim] speed set to " << speedMultiplier << "x\n";
        } else if (*cmd == "stop") {
            stopRequested = true;
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
                     "[--track-vehicle ID] [--port N] [--speed N] [--headless]\n";
        return 2;
    }
    std::string mapPath = argv[1], chPath = argv[2], vehiclesPath = argv[3];
    double simSeconds = 300, rampSeconds = 60, statsInterval = 10, speedMultiplier = 1.0;
    long long concurrency = -1;
    int trackId = -1, port = 8766;
    bool headless = false; // --headless skips the websocket server + real-time pacing (Phase 2's original mode - runs flat out, for scripted testing)
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
        else { std::cerr << "unknown argument: " << a << "\n"; return 2; }
    }

    try {
        auto t0 = Clock::now();
        JsonValue mapRoot = JsonParser(chReadFile(mapPath)).parse();
        RoadGraph rg = buildRoadGraph(mapRoot);
        parseRedlightGroups(mapRoot, rg);

        ChGraph chg = loadChGraph(chPath);
        std::cerr << "[sim] CH graph: " << chg.n << " nodes\n";

        JsonValue vehiclesRoot = JsonParser(chReadFile(vehiclesPath)).parse();
        std::vector<TripSpec> trips = loadTrips(vehiclesRoot);
        std::cerr << "[sim] loaded " << trips.size() << " trip specs (setup " << elapsedMs(t0) << " ms)\n";

        if (concurrency < 0) concurrency = (long long)trips.size();
        concurrency = std::min<long long>(concurrency, (long long)trips.size());

        std::vector<Vehicle> vehicles(trips.size());
        const double dt = 1.0 / 20.0;
        long long spawnBudgetPerTick = std::max<long long>(1, (long long)std::ceil((double)concurrency / std::max(1.0, rampSeconds / dt)));

        double simClock = 0.0;
        size_t spawnCursor = 0;
        long long activeCount = 0, totalSpawned = 0, totalCompleted = 0, totalFailedRoute = 0;
        double nextStatsAt = 0.0, nextTrackAt = 0.0;
        bool stopRequested = false;

        WsServer server;
        if (!headless) {
            if (!server.start(port)) throw std::runtime_error("failed to start websocket server on 127.0.0.1:" + std::to_string(port) + " (port already in use?)");
            std::cerr << "[sim] websocket server listening on ws://127.0.0.1:" << port << "\n";
        }

        struct TypeStats { long long count = 0; double sumTripSec = 0; };
        std::unordered_map<std::string, TypeStats> completedByType;

        while (simClock < simSeconds && !stopRequested) {
            auto tickWallStart = Clock::now();
            if (!headless) server.pump([&](const std::string& text) { handleCommand(text, speedMultiplier, stopRequested); });

            // 1. Spawn, paced so a large target concurrency ramps up over
            // rampSeconds instead of bursting thousands of CH queries into tick 0.
            long long spawnedThisTick = 0;
            while (activeCount < concurrency && spawnCursor < trips.size() && spawnedThisTick < spawnBudgetPerTick) {
                const TripSpec& t = trips[spawnCursor];
                std::string err;
                std::vector<RouteStep> route = resolveRoute(rg, chg, t.startNodeId, t.endNodeId, err);
                totalSpawned++;
                if (route.empty()) {
                    totalFailedRoute++;
                    std::cerr << "[sim] WARN vehicle " << t.id << " route failed: " << err << "\n";
                } else {
                    Vehicle& v = vehicles[spawnCursor];
                    v.id = t.id; v.vehicleType = t.vehicleType; v.length = t.length;
                    v.maxSpeedMps = t.maxSpeedKmh / 3.6;
                    const TypeProfile& prof = profileFor(t.vehicleType);
                    v.aMax = prof.aMax; v.bComfort = prof.bComfort; v.headwayT = prof.headwayT; v.minGap = prof.minGap;
                    v.route = std::move(route);
                    v.routeIdx = 0; v.distAlongEdge = 0; v.speed = 0; v.active = true;
                    v.spawnSimTime = simClock; v.waitTimeSec = 0; v.arrivalAtStopLineTime = -1;
                    activeCount++;
                }
                spawnCursor++;
                spawnedThisTick++;
            }

            // 2. Group active vehicles by current edge, ordered by position
            // (back of the vector = front of the physical queue).
            std::unordered_map<uint64_t, std::vector<int>> groups;
            groups.reserve((size_t)activeCount * 2 + 16);
            for (size_t vi = 0; vi < vehicles.size(); ++vi) {
                Vehicle& v = vehicles[vi];
                if (!v.active) continue;
                groups[edgeKey(v.route[v.routeIdx])].push_back((int)vi);
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
            std::unordered_map<int, int> bestVehicleForJunction;
            std::unordered_map<int, std::pair<int, double>> bestKeyForJunction; // junctionIdx -> (rank, arrivalTime)

            for (auto& [k, idxs] : groups) {
                if (idxs.empty()) continue;
                int frontVi = idxs.back();
                Vehicle& fv = vehicles[frontVi];
                if (fv.routeIdx + 1 >= fv.route.size()) continue;
                const RouteStep& nxt = fv.route[fv.routeIdx + 1];
                if (!nxt.isJunction) { fv.gate = 1; continue; }
                const JunctionEdge& je = rg.junctionEdges[nxt.edgeIndex];
                const JunctionInfo& jn = rg.junctions[je.junctionIdx];
                if (jn.signal.present) {
                    std::string color = computeLampColor(rg, je.junctionIdx, je.fromWayId, je.movement, simClock);
                    fv.gate = (color == "green") ? 1 : 2;
                } else {
                    if (fv.arrivalAtStopLineTime < 0) fv.arrivalAtStopLineTime = simClock;
                    int rank = je.priorityRank;
                    auto bit = bestKeyForJunction.find(je.junctionIdx);
                    bool better = bit == bestKeyForJunction.end() || rank > bit->second.first ||
                                  (rank == bit->second.first && fv.arrivalAtStopLineTime < bit->second.second);
                    if (better) {
                        bestKeyForJunction[je.junctionIdx] = {rank, fv.arrivalAtStopLineTime};
                        bestVehicleForJunction[je.junctionIdx] = frontVi;
                    }
                    fv.gate = 2; // tentatively closed, possibly flipped below
                }
            }
            for (auto& [jidx, vi] : bestVehicleForJunction) {
                if (simClock >= rg.junctions[jidx].busyUntil) vehicles[vi].gate = 1;
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
                            // stationary obstacle at the boundary - IDM's
                            // ordinary leader-following naturally produces a
                            // full, held stop here, which is exactly right.
                            leaderGap = cur.length - v.distAlongEdge;
                            leaderSpeed = 0; hasLeader = true;
                        } else {
                            auto git = groups.find(edgeKey(nxt));
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
                            gateOk = jn2.signal.present && computeLampColor(rg, je2.junctionIdx, je2.fromWayId, je2.movement, simClock) == "green";
                        }
                        if (!gateOk) { v.distAlongEdge = cur.length; break; }
                    }
                    double overshoot = v.distAlongEdge - cur.length;
                    if (nxt.isJunction) {
                        const JunctionEdge& je = rg.junctionEdges[nxt.edgeIndex];
                        JunctionInfo& jn = rg.junctions[je.junctionIdx];
                        if (!jn.signal.present) jn.busyUntil = simClock + je.lengthM / std::max(0.1, je.speedMps) + MIN_DISCHARGE_GAP_SEC;
                        v.arrivalAtStopLineTime = -1;
                    }
                    v.routeIdx++;
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

            // 7. Broadcast this tick's snapshot (every tick = 20Hz, within the
            // 10-20Hz target) and, unless running headless for scripted
            // testing, pace the loop to real time (scaled by speedMultiplier)
            // rather than running flat-out - Phase 2 measured ~20x real-time
            // even at 10k concurrent vehicles on this hardware, so without
            // this the whole manifest would blow past in seconds instead of
            // playing out live.
            if (!headless) {
                server.broadcast(buildStateJson(simClock, vehicles, rg, totalSpawned, totalCompleted, trips.size()));
                double targetDt = dt / speedMultiplier;
                double elapsed = std::chrono::duration<double>(Clock::now() - tickWallStart).count();
                if (elapsed < targetDt) std::this_thread::sleep_for(std::chrono::duration<double>(targetDt - elapsed));
            }

            simClock += dt;
            if (activeCount == 0 && spawnCursor >= trips.size()) break;
        }
        if (!headless) std::cerr << "[sim] stopping (t=" << simClock << "s, stopRequested=" << stopRequested << ")\n";

        std::cerr << "\n[sim] FINAL SUMMARY at t=" << std::fixed << std::setprecision(1) << simClock << "s\n";
        std::cerr << "  trips in manifest: " << trips.size() << ", spawned: " << totalSpawned
                  << ", completed: " << totalCompleted << ", failed-to-route: " << totalFailedRoute
                  << ", still active: " << activeCount << "\n";
        for (auto& [ty, ts] : completedByType)
            std::cerr << "  " << ty << ": " << ts.count << " completed, avg trip " << (ts.count ? ts.sumTripSec / ts.count : 0.0) << "s\n";
        return 0;
    } catch (const std::exception& ex) {
        std::cerr << "[sim] FATAL: " << ex.what() << "\n";
        return 1;
    }
}
