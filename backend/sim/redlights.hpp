#pragma once

// Traffic-light control logic for the "traffic light revamped" simulation
// engine (backend/sim/sim_engine.cpp) - deliberately split out of that file
// so this module has NO access to Vehicle, RouteStep, or RoadGraph internals
// (see road_graph.hpp/vehicles.hpp for those). Everything it knows about
// live traffic comes in through one narrow channel: VehicleStopReport /
// EmergencyReport, submitted by the caller once a vehicle has already been
// observed stopped at a red light or is an ambulance approaching one - the
// same kind of arms-length signal a real induction-loop sensor or connected-
// vehicle GPS ping would give a physical signal controller. This module
// never sees a vehicle's route or destination, so it has no way to "know"
// what's about to arrive before it's actually there - only to react to
// what's currently reported.
//
// Two independent things live here:
//   - The static signal MODEL (SignalConfig/RedlightGroupConfig/parseSignal)
//     and its fixed-time math (getPlainColor/getPairedColor/computeLampColor,
//     a direct port of front-end/redlight.js) - this is map DATA (how a
//     junction's lamps are configured), not live vehicle state, so it's not
//     part of the reporting scheme at all.
//   - RedlightController: the live, per-tick arbitration state for
//     SignalMode::Density and emergency preemption (see sim_engine.cpp's own
//     SignalMode comment for the three modes' full behaviour), built purely
//     from reports submitted this tick.

#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "../ch/json.hpp"

// ---------------------------------------------------------------------------
// Signal model - a direct port of front-end/redlight.js's fixed-time phase
// math (buildRedlightSegments/getRedlightState, the "paired 4-way"
// choreography, and intersection-group turn-taking). Only the "default"
// static-light mode; SignalMode below adds the other two signal-control
// modes as alternate implementations of a lamp's colour decision.
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

// Phase 4: the other two signal-control modes, runtime-switchable (CLI
// --signal-mode, or live via {"cmd":"setSignalMode","value":...} - see
// sim_engine.cpp's handleCommand).
//   - EmergencyOnly: a signalized junction runs the EXACT SAME fixed-time
//     math as Default mode (computeLampColor, complete with its normal
//     phase timer) UNLESS an EmergencyReport has been submitted for this
//     tick naming one of its approaches (see sim_engine.cpp's main loop step
//     3 and handleCommand's triggerEmergency - a manual "responding" toggle,
//     deliberately distinct from merely being vehicleType=="ambulance"), in
//     which case that whole approach is forced green and every other
//     approach forced red for as long as the report keeps naming it - real
//     Opticom-style preemption, not a rank bonus fed into ordinary
//     arbitration. See sim_engine.cpp's buildStateJson (which is why a
//     NON-preempted EmergencyOnly junction is deliberately left out of its
//     lamps array - letting the client's identical fixed-time math render a
//     real countdown timer instead of a frozen placeholder).
//   - Density: reuses the unsignalized-junction arbitration already built in
//     sim_engine.cpp's main loop for the "width of the intersection" fix
//     (movementsCompatible, in road_graph.hpp) instead of a fixed phase
//     table - a signalized junction's rank is its approach's live "red dot"
//     weight (see RedlightController::reportStopped below: the count of
//     vehicles currently reported waiting for this red light, plus the
//     seconds each has been waiting, each scaled by vehiclePriorityWeight)
//     rather than a fixed road class, so the busiest-AND-longest-waiting-
//     AND-highest-priority approach simply outranks the others every tick -
//     a live actuated-signal approximation with deliberately no fixed phase
//     table/timer to advance or hold, and no knowledge of any vehicle's
//     route beyond "it is here, right now, waiting."
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
// headless engine). Only ever consulted for SignalMode::Default/EmergencyOnly
// (with no active preemption) - see SignalMode's own comment for Density's
// completely different, report-driven path. Deliberately takes only the
// static signal config + group table rather than a RoadGraph/JunctionInfo,
// so this stays free of any dependency on the road-graph or vehicle layers.
static std::string computeLampColor(const SignalConfig& signal, const std::string& primaryNodeId,
                                     const std::unordered_map<std::string, RedlightGroupConfig>& redlightGroups,
                                     const std::string& wayId, const std::string& movement, double clockSec) {
    if (!signal.present) return "green"; // unsignalized junctions are gated by arbitration, not this function
    double effectiveClock = clockSec;
    if (!signal.groupId.empty()) {
        auto it = redlightGroups.find(signal.groupId);
        if (it != redlightGroups.end()) {
            GroupTurnInfo info = getGroupTurnInfo(it->second, clockSec);
            if (info.valid) {
                if (info.activeNodeId != primaryNodeId) return "red";
                effectiveClock = info.localClock;
            }
        }
    }
    if (signal.isPaired) return getPairedColor(signal, effectiveClock, wayId, movement);
    return getPlainColor(signal, effectiveClock, wayId);
}

// ---------------------------------------------------------------------------
// Live reporting interface - the ONLY way this module learns about traffic.
// A vehicle (see vehicles.hpp) never talks to this module directly; the
// simulation's main loop (sim_engine.cpp) observes a vehicle has been marked
// stopped at a red light or is an emergency vehicle approaching one, and
// submits a report on its behalf. Neither report carries a vehicle id,
// route, or destination - just enough to answer "who's waiting where, in
// what, and since when."
// ---------------------------------------------------------------------------

// One vehicle's self-report, submitted once it has already been observed
// stopped at a red light this tick. gpsX/gpsY is its current position in
// this map's own projected coordinate space (a metric projection of real
// lon/lat - see osm_to_json.py's project()) - carried here so this module's
// reports are traceable back to a real place on the map even though it never
// looks at a route to get there, the same way a real connected-vehicle GPS
// ping or induction-loop sensor only ever reports "something is here now."
struct VehicleStopReport {
    std::string fromWayId, movement, toWayId; // which approach/turn this vehicle is queued for
    double gpsX = 0, gpsY = 0;
    std::string vehicleType;
    double waitStartTime = -1;
};

// An ambulance's self-report while "responding" (see handleCommand's
// triggerEmergency) and at the front of an approach queue leading into a
// signalized junction.
struct EmergencyReport {
    std::string fromWayId;
    double gpsX = 0, gpsY = 0;
};

// Density mode's per-vehicle-type priority weight: a bus carries many
// passengers so clearing it quickly benefits far more people than clearing
// one car, while a truck can tolerate sitting at a red light longer than the
// average driver - so a queued bus counts as 10 "vehicles waiting" toward
// its approach's weight, a queued truck counts as half of one, and
// everything else (car, motorcycle, ambulance not currently preempting)
// counts as exactly one, unchanged from before this weighting existed.
static double vehiclePriorityWeight(const std::string& vehicleType) {
    if (vehicleType == "bus") return 10.0;
    if (vehicleType == "truck") return 0.5;
    return 1.0;
}

// Live, per-tick arbitration state for Density mode and emergency
// preemption. Constructed once and kept for the whole run; beginTick()
// clears the previous tick's reports so a lull correctly decays back to
// zero instead of latching a stale weight or a stale preemption forever.
// Deliberately plain data + reports in, queries out - no Vehicle/RoadGraph
// type ever appears in this class's interface.
class RedlightController {
public:
    void beginTick() { densityWeight_.clear(); emergencyPreempt_.clear(); }

    // Density mode's per-approach "red dot" weight (see SignalMode's own
    // comment) - accumulated from the END of last tick's reports, one tick
    // of lag behind the caller's own gate outcome for this tick, same as the
    // ordinary impatience-rank feedback loop the rest of this project's
    // arbitration already accepts.
    void reportStopped(int junctionIdx, const VehicleStopReport& r, double simClock) {
        double waited = std::max(0.0, simClock - r.waitStartTime);
        densityWeight_[key(junctionIdx, r.fromWayId)] += (1.0 + waited) * vehiclePriorityWeight(r.vehicleType);
    }

    double densityWeightFor(int junctionIdx, const std::string& fromWayId) const {
        auto it = densityWeight_.find(key(junctionIdx, fromWayId));
        return it != densityWeight_.end() ? it->second : 0.0;
    }

    // Real preemption, not a rank bonus: every report for a junction this
    // tick names the SAME fromWayId (only one approach can hold an ambulance
    // at its front at a time), so last-writer-wins is fine here.
    void reportEmergency(int junctionIdx, const EmergencyReport& r) {
        emergencyPreempt_[junctionIdx] = r.fromWayId;
    }

    // True + the forced-green fromWayId if `junctionIdx` is under active
    // preemption this tick.
    bool preempting(int junctionIdx, std::string& forWayIdOut) const {
        auto it = emergencyPreempt_.find(junctionIdx);
        if (it == emergencyPreempt_.end()) return false;
        forWayIdOut = it->second;
        return true;
    }
    const std::unordered_map<int, std::string>& preemptions() const { return emergencyPreempt_; }

private:
    static std::string key(int junctionIdx, const std::string& fromWayId) { return std::to_string(junctionIdx) + "|" + fromWayId; }

    std::unordered_map<std::string, double> densityWeight_;
    std::unordered_map<int, std::string> emergencyPreempt_;
};
