// Point-to-point shortest-path query engine for the "traffic light revamped"
// road map, using a bidirectional Dijkstra search restricted to the
// Contraction Hierarchy built by ch_preprocess.cpp.
//
// This is the "future consumer" ch_preprocess.cpp's header comment refers to:
// it loads the compact CSR binary (map_data.ch.bin) - never map_data.json
// directly - and answers a single start/end query by running the same
// rank-restricted bidirectional Dijkstra ch_preprocess.cpp already uses for
// its own self-verification, except here the result is a full path (shortcut
// edges recursively unpacked back to real graph edges via their stored `via`
// node) plus the settled-node sets from each direction, instead of just a
// distance.
//
// Usage: ch_query.exe <path-to-map_data.ch.bin> <startNodeId> <endNodeId>
// Prints exactly one JSON object to stdout and exits 0, whether or not a
// route was found (the JSON's "found" field says which); a non-zero exit
// means the query itself could not run at all (bad file, bad args).
//
// This file is permanent, standalone routing infrastructure - unlike the
// temporary visualization harness that currently drives it from the browser
// (see routetest.js and the matching TEMP-marked block in serve.py), it is
// meant to stay regardless of whether that harness is later removed.

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <queue>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "ch_graph.hpp"

using Clock = std::chrono::steady_clock;
using QueryResult = ChQueryResult;
using Seed = ChSeed;
static const WorkEdge* findEdge(const ChGraph& g, int u, int v) { return chFindEdge(g, u, v); }
static void unpackEdge(const ChGraph& g, int u, int v, int via, std::vector<int>& out) { chUnpackEdge(g, u, v, via, out); }
static QueryResult runQuery(const ChGraph& g, const std::vector<Seed>& startSeeds, const std::vector<Seed>& endSeeds) {
    return runChQuery(g, startSeeds, endSeeds);
}

// ---------------------------------------------------------------------------
// JSON output (hand-rolled, same approach as ch_preprocess.cpp's meta.json
// writer - no library, node ids here are plain alphanumeric so only a
// handful of escapes are worth handling).
// ---------------------------------------------------------------------------

static std::string jsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default: out += c;
        }
    }
    return out;
}

static void printNodeArray(std::ostream& os, const ChGraph& g, const std::vector<int>& idxs) {
    os << "[";
    for (size_t i = 0; i < idxs.size(); ++i) {
        if (i) os << ",";
        int a = idxs[i];
        os << "{\"id\":\"" << jsonEscape(g.id[a]) << "\",\"x\":" << g.x[a] << ",\"y\":" << g.y[a] << "}";
    }
    os << "]";
}

static void printSegments(std::ostream& os, const ChGraph& g, const std::vector<std::vector<int>>& segs) {
    os << "[";
    for (size_t i = 0; i < segs.size(); ++i) {
        if (i) os << ",";
        printNodeArray(os, g, segs[i]);
    }
    os << "]";
}

// ---------------------------------------------------------------------------
// Endpoint spec parsing: a query endpoint (start or end) is either a bare
// existing node id (the original, still-supported case), or - for a point
// clicked mid-road, not on an existing node - a virtual-point spec built by
// the browser from map_data.json (which knows the way/geometry ch_query.cpp
// never sees, since map_data.ch.bin stores only nodes + edges):
//   "V:<nodeA>:<nodeB>:<distToA>:<distToB>:<directions>"
// nodeA/nodeB are the two real graph nodes bracketing the clicked point on
// its way; distToA/distToB are the partial-edge travel times (seconds, same
// unit as every edge weight) from the point to each; <directions> is one of
// "AtoB"/"BtoA"/"both" - which of the base way's travel direction(s) are
// legal to use right at that point (both, unless it's a divided road, in
// which case only whichever carriageway the click landed on - see
// routetest.js for how the browser derives this).
// ---------------------------------------------------------------------------

struct EndpointSpec {
    bool isVirtual = false;
    std::string nodeId;                 // plain case
    std::string nodeAId, nodeBId;       // virtual case
    double distToA = 0, distToB = 0;
    std::string directions;             // "AtoB" | "BtoA" | "both"
};

static EndpointSpec parseEndpointSpec(const std::string& s) {
    EndpointSpec spec;
    if (s.rfind("V:", 0) != 0) { spec.nodeId = s; return spec; }
    spec.isVirtual = true;
    std::vector<std::string> parts;
    size_t start = 2;
    for (size_t i = 2; i <= s.size(); ++i) {
        if (i == s.size() || s[i] == ':') { parts.push_back(s.substr(start, i - start)); start = i + 1; }
    }
    if (parts.size() != 5) throw std::runtime_error("malformed virtual endpoint spec: " + s);
    spec.nodeAId = parts[0];
    spec.nodeBId = parts[1];
    spec.distToA = std::stod(parts[2]);
    spec.distToB = std::stod(parts[3]);
    spec.directions = parts[4];
    return spec;
}

// A divided way's purely-interior chain vertices exist in the graph twice -
// once per travel direction, as "<id>#fwd"/"<id>#bwd" (see the matching
// comment in ch_preprocess.cpp's buildGraph) - so that a route can't switch
// carriageway anywhere except a real crossing point. nodeA/nodeB in an
// EndpointSpec are always the plain real id (the browser has no idea these
// twins exist), so resolving one has to prefer whichever twin matches the
// direction actually being connected through, falling back to the plain id
// for a true way endpoint (or any node of an undivided way), where no twin
// was ever created.
static int resolveDirectionalNode(const ChGraph& g, const std::string& nodeId, bool wantForwardChain) {
    auto itS = g.indexOf.find(nodeId + (wantForwardChain ? "#fwd" : "#bwd"));
    if (itS != g.indexOf.end()) return itS->second;
    auto itP = g.indexOf.find(nodeId);
    return itP != g.indexOf.end() ? itP->second : -1;
}

// Resolves an EndpointSpec into the Seed list runQuery() needs. `isStart`
// picks which of AtoB/BtoA means "seed toward A" vs "seed toward B": a start
// point DEPARTS toward the legal direction's downstream node, an end point
// is ARRIVED AT from the legal direction's upstream node - same restriction,
// opposite end of the trip. Connecting to B means "on the forward (A->B)
// chain" exactly when this is a start (departing forward); connecting to A
// means forward exactly when this is an end (arrived at via forward travel) -
// hence `wantForwardChain = isStart` for B and `!isStart` for A below.
static std::vector<Seed> buildSeeds(const ChGraph& g, const EndpointSpec& spec, bool isStart, std::string& errorOut) {
    std::vector<Seed> seeds;
    if (!spec.isVirtual) {
        // Normally just the plain id (a real endpoint's edges live there
        // directly). Defensively also seed its #fwd/#bwd twins if present -
        // routetest.js never sends a plain id for a divided way's interior
        // vertex (it always resolves those through the virtual-point path
        // instead, see routeIsWayEndpointNode), but a bare plain id for one
        // would otherwise be a fully edge-less, unreachable node and this
        // endpoint would rather answer "start from either carriageway" than
        // silently report no route at all.
        auto itPlain = g.indexOf.find(spec.nodeId);
        if (itPlain != g.indexOf.end()) seeds.push_back({itPlain->second, 0.0});
        auto itFwd = g.indexOf.find(spec.nodeId + "#fwd");
        if (itFwd != g.indexOf.end()) seeds.push_back({itFwd->second, 0.0});
        auto itBwd = g.indexOf.find(spec.nodeId + "#bwd");
        if (itBwd != g.indexOf.end()) seeds.push_back({itBwd->second, 0.0});
        if (seeds.empty()) errorOut = "node " + spec.nodeId + " is not in the routing graph";
        return seeds;
    }
    if (!g.indexOf.count(spec.nodeAId) || !g.indexOf.count(spec.nodeBId)) {
        errorOut = "virtual endpoint's bracketing nodes are not in the routing graph";
        return seeds;
    }
    bool wantA = spec.directions == "both" || (isStart ? spec.directions == "BtoA" : spec.directions == "AtoB");
    bool wantB = spec.directions == "both" || (isStart ? spec.directions == "AtoB" : spec.directions == "BtoA");
    if (wantA) {
        int idx = resolveDirectionalNode(g, spec.nodeAId, /*wantForwardChain=*/!isStart);
        if (idx >= 0) seeds.push_back({idx, spec.distToA});
    }
    if (wantB) {
        int idx = resolveDirectionalNode(g, spec.nodeBId, /*wantForwardChain=*/isStart);
        if (idx >= 0) seeds.push_back({idx, spec.distToB});
    }
    if (seeds.empty()) errorOut = "virtual endpoint spec has no legal direction (bad 'directions' value: " + spec.directions + ")";
    return seeds;
}

int main(int argc, char** argv) {
    if (argc < 4) {
        std::cout << "{\"ok\":false,\"error\":\"usage: ch_query <path-to-map_data.ch.bin> <startSpec> <endSpec> "
                      "(each spec is either a bare existing node id, or V:nodeA:nodeB:distToA:distToB:directions "
                      "for a point clicked mid-road)\"}\n";
        return 2;
    }
    std::string binPath = argv[1];
    std::string startId = argv[2];
    std::string endId = argv[3];

    try {
        auto t0 = Clock::now();
        ChGraph g = loadChGraph(binPath);
        double loadMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();

        EndpointSpec startSpec = parseEndpointSpec(startId);
        EndpointSpec endSpec = parseEndpointSpec(endId);
        std::string startErr, endErr;
        std::vector<Seed> startSeeds = buildSeeds(g, startSpec, /*isStart=*/true, startErr);
        std::vector<Seed> endSeeds = buildSeeds(g, endSpec, /*isStart=*/false, endErr);
        if (startSeeds.empty() || endSeeds.empty()) {
            std::string reason = !startErr.empty() ? startErr : !endErr.empty() ? endErr
                : "start or end node is not in the routing graph "
                  "(it may be non-routable, e.g. a footway-only point, or the CH is stale - try Recalculate CH)";
            std::cout << "{\"ok\":false,\"error\":\"" << jsonEscape(reason) << "\"}\n";
            return 0;
        }

        t0 = Clock::now();
        QueryResult res = runQuery(g, startSeeds, endSeeds);
        double queryMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();

        std::ostringstream out;
        out << std::setprecision(10);
        out << "{\"ok\":true,\"found\":" << (res.found ? "true" : "false") << ","
            << "\"start\":\"" << jsonEscape(startId) << "\","
            << "\"end\":\"" << jsonEscape(endId) << "\"";
        if (res.found) {
            out << ",\"distanceSec\":" << res.distanceSec << ",\"path\":";
            printNodeArray(out, g, res.path);
        }
        out << ",\"exploredForward\":";
        printNodeArray(out, g, res.exploredForward);
        out << ",\"exploredBackward\":";
        printNodeArray(out, g, res.exploredBackward);
        out << ",\"exploredForwardSegments\":";
        printSegments(out, g, res.exploredForwardSegments);
        out << ",\"exploredBackwardSegments\":";
        printSegments(out, g, res.exploredBackwardSegments);
        out << ",\"stats\":{"
            << "\"forwardSettled\":" << res.exploredForward.size() << ","
            << "\"backwardSettled\":" << res.exploredBackward.size() << ","
            << "\"pathNodes\":" << res.path.size() << ","
            << "\"loadMs\":" << loadMs << ","
            << "\"queryMs\":" << queryMs
            << "}}";
        std::cout << out.str() << "\n";
        return 0;
    } catch (const std::exception& ex) {
        std::cout << "{\"ok\":false,\"error\":\"" << jsonEscape(ex.what()) << "\"}\n";
        return 1;
    }
}
