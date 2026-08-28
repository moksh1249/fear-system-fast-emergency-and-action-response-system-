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

using Clock = std::chrono::steady_clock;

// ---------------------------------------------------------------------------
// CH graph model + binary loader (mirrors the CSR layout ch_preprocess.cpp
// writes at the end of its main(): header, then per-node records, then the
// up-adjacency offsets+edges, then the down-adjacency offsets+edges).
// ---------------------------------------------------------------------------

struct WorkEdge {
    int to;
    double w;   // seconds
    int via;    // -1 = base edge, else internal index of the contracted middle node
};

struct ChGraph {
    int n = 0;
    std::vector<std::string> id;
    std::vector<double> x, y;
    std::vector<uint32_t> rank;
    std::vector<std::vector<WorkEdge>> up, down;
    std::unordered_map<std::string, int> indexOf;
};

class BinReader {
public:
    explicit BinReader(std::string buf) : data(std::move(buf)) {}
    uint32_t u32() { check(4); uint32_t v; std::memcpy(&v, data.data() + pos, 4); pos += 4; return v; }
    uint64_t u64() { check(8); uint64_t v; std::memcpy(&v, data.data() + pos, 8); pos += 8; return v; }
    int32_t i32() { check(4); int32_t v; std::memcpy(&v, data.data() + pos, 4); pos += 4; return v; }
    double f64() { check(8); double v; std::memcpy(&v, data.data() + pos, 8); pos += 8; return v; }
    std::string str(size_t len) { check(len); std::string s = data.substr(pos, len); pos += len; return s; }
    void bytes(char* out, size_t len) { check(len); std::memcpy(out, data.data() + pos, len); pos += len; }
private:
    std::string data;
    size_t pos = 0;
    void check(size_t need) { if (pos + need > data.size()) throw std::runtime_error("truncated/corrupt CH binary file"); }
};

static std::string readFile(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open " + path);
    std::ostringstream oss;
    oss << f.rdbuf();
    return oss.str();
}

static ChGraph loadChGraph(const std::string& path) {
    BinReader r(readFile(path));

    char magic[4];
    r.bytes(magic, 4);
    if (std::memcmp(magic, "TLCH", 4) != 0) throw std::runtime_error("not a CH binary file (bad magic)");
    uint32_t version = r.u32();
    if (version != 1) throw std::runtime_error("unsupported CH binary version " + std::to_string(version));
    (void)r.u64();  // sourceHash - not needed for querying
    (void)r.u64();  // sourceSize
    uint32_t n = r.u32();
    uint32_t upEdgeCount = r.u32();
    uint32_t downEdgeCount = r.u32();

    ChGraph g;
    g.n = (int)n;
    g.id.resize(n);
    g.x.resize(n);
    g.y.resize(n);
    g.rank.resize(n);
    g.up.resize(n);
    g.down.resize(n);
    g.indexOf.reserve((size_t)n * 2);

    for (uint32_t a = 0; a < n; ++a) {
        uint32_t len = r.u32();
        g.id[a] = r.str(len);
        g.x[a] = r.f64();
        g.y[a] = r.f64();
        g.rank[a] = r.u32();
        g.indexOf.emplace(g.id[a], (int)a);
    }

    std::vector<uint32_t> upOff(n + 1);
    for (uint32_t a = 0; a <= n; ++a) upOff[a] = r.u32();
    if (upOff[n] != upEdgeCount) throw std::runtime_error("CH binary file inconsistent (up edge count mismatch)");
    for (uint32_t a = 0; a < n; ++a) {
        uint32_t cnt = upOff[a + 1] - upOff[a];
        g.up[a].reserve(cnt);
        for (uint32_t k = 0; k < cnt; ++k) {
            uint32_t to = r.u32();
            double w = r.f64();
            int32_t via = r.i32();
            g.up[a].push_back({(int)to, w, via});
        }
    }

    std::vector<uint32_t> downOff(n + 1);
    for (uint32_t a = 0; a <= n; ++a) downOff[a] = r.u32();
    if (downOff[n] != downEdgeCount) throw std::runtime_error("CH binary file inconsistent (down edge count mismatch)");
    for (uint32_t a = 0; a < n; ++a) {
        uint32_t cnt = downOff[a + 1] - downOff[a];
        g.down[a].reserve(cnt);
        for (uint32_t k = 0; k < cnt; ++k) {
            uint32_t to = r.u32();
            double w = r.f64();
            int32_t via = r.i32();
            g.down[a].push_back({(int)to, w, via});
        }
    }

    return g;
}

// ---------------------------------------------------------------------------
// Shortcut unpacking: recursively expand a (possibly-shortcut) edge u->v
// into the real base-graph nodes it passes through, using each edge's `via`
// (-1 = base edge, otherwise the contracted middle node) exactly the way
// ch_preprocess.cpp's own header comment describes. Which of up/down holds a
// given sub-edge is decided the same way it was written: by comparing ranks.
// ---------------------------------------------------------------------------

static const WorkEdge* findEdge(const ChGraph& g, int u, int v) {
    if (g.rank[u] < g.rank[v]) {
        for (auto& e : g.up[u]) if (e.to == v) return &e;
    } else {
        for (auto& e : g.down[v]) if (e.to == u) return &e;
    }
    return nullptr;
}

// Appends the real nodes from (just after) u through v to `out`, which must
// already end with u. Leaves `out` ending with v.
static void unpackEdge(const ChGraph& g, int u, int v, int via, std::vector<int>& out) {
    if (via == -1) { out.push_back(v); return; }
    const WorkEdge* e1 = findEdge(g, u, via);
    if (!e1) throw std::runtime_error("CH unpack: missing sub-edge in shortcut (u->via)");
    unpackEdge(g, u, via, e1->via, out);
    const WorkEdge* e2 = findEdge(g, via, v);
    if (!e2) throw std::runtime_error("CH unpack: missing sub-edge in shortcut (via->v)");
    unpackEdge(g, via, v, e2->via, out);
}

// ---------------------------------------------------------------------------
// Bidirectional Dijkstra, rank-restricted to the CH's up/down graphs (the
// standard CH query algorithm): forward search only ever relaxes edges into
// higher rank via `up`, backward search only ever relaxes edges into higher
// rank via `down` (which is edges into it from lower rank, walked backward
// from t) - so both frontiers climb toward the hierarchy's top and are
// guaranteed to meet there. Unlike ch_preprocess.cpp's own copy of this
// (used only to self-verify a distance), this version also tracks parent
// pointers to reconstruct the actual path, and every settled node from each
// direction, for the caller's route + explored-node visualization.
// ---------------------------------------------------------------------------

struct QueryResult {
    bool found = false;
    double distanceSec = 0.0;
    std::vector<int> path;             // full unpacked node indices, origin..destination inclusive
    std::vector<int> exploredForward;  // node indices, in the order the forward search settled them
    std::vector<int> exploredBackward; // node indices, in the order the backward search settled them
    // One real (fully unpacked) road segment per settled node's tree edge -
    // i.e. every road the search actually walked over, not just the nodes it
    // touched. Populated whenever the search runs at all, `found` or not, so
    // a disconnected query still shows how far each frontier got.
    std::vector<std::vector<int>> exploredForwardSegments;
    std::vector<std::vector<int>> exploredBackwardSegments;
};

// A search origin/destination: either a single existing graph node (dist 0,
// the ordinary case) or, for a point clicked mid-road (not on an existing
// node), one or two real graph nodes bracketing it with the partial-edge
// travel time already worked in - see parseEndpointSpec()/buildSeeds() in
// main() for how these get built from the CLI spec. Dijkstra doesn't care
// how many seeds a search starts from, so this needs no change to the
// relaxation loop itself, only to how the frontier is initialized and to how
// the final path is unwound back to a real seed node instead of a single s/t.
struct Seed { int node; double dist; };

static QueryResult runQuery(const ChGraph& g, const std::vector<Seed>& startSeeds, const std::vector<Seed>& endSeeds) {
    QueryResult res;
    int n = g.n;

    const double INF = std::numeric_limits<double>::infinity();
    std::vector<double> distF(n, INF), distB(n, INF);
    std::vector<char> doneF(n, 0), doneB(n, 0);
    std::vector<int> parentF(n, -1), parentB(n, -1);
    std::vector<int> viaF(n, -2), viaB(n, -2);

    using QE = std::pair<double, int>;
    std::priority_queue<QE, std::vector<QE>, std::greater<>> pqF, pqB;
    std::unordered_set<int> startSeedNodes, endSeedNodes;
    for (auto& sd : startSeeds) {
        if (sd.dist < distF[sd.node]) { distF[sd.node] = sd.dist; pqF.push({sd.dist, sd.node}); }
        startSeedNodes.insert(sd.node);
    }
    for (auto& sd : endSeeds) {
        if (sd.dist < distB[sd.node]) { distB[sd.node] = sd.dist; pqB.push({sd.dist, sd.node}); }
        endSeedNodes.insert(sd.node);
    }

    double best = INF;
    int meet = -1;

    while (!pqF.empty() || !pqB.empty()) {
        bool progressed = false;
        if (!pqF.empty()) {
            auto [d, u] = pqF.top();
            if (d <= best) {
                pqF.pop();
                progressed = true;
                if (!doneF[u]) {
                    doneF[u] = 1;
                    res.exploredForward.push_back(u);
                    if (doneB[u] && distF[u] + distB[u] < best) { best = distF[u] + distB[u]; meet = u; }
                    for (auto& e : g.up[u]) {
                        double nd = d + e.w;
                        if (nd < distF[e.to]) {
                            distF[e.to] = nd;
                            parentF[e.to] = u;
                            viaF[e.to] = e.via;
                            pqF.push({nd, e.to});
                        }
                    }
                }
            } else {
                pqF = decltype(pqF)();  // forward frontier can no longer improve `best`
            }
        }
        if (!pqB.empty()) {
            auto [d, u] = pqB.top();
            if (d <= best) {
                pqB.pop();
                progressed = true;
                if (!doneB[u]) {
                    doneB[u] = 1;
                    res.exploredBackward.push_back(u);
                    if (doneF[u] && distF[u] + distB[u] < best) { best = distF[u] + distB[u]; meet = u; }
                    for (auto& e : g.down[u]) {
                        double nd = d + e.w;
                        if (nd < distB[e.to]) {
                            distB[e.to] = nd;
                            parentB[e.to] = u;
                            viaB[e.to] = e.via;
                            pqB.push({nd, e.to});
                        }
                    }
                }
            } else {
                pqB = decltype(pqB)();
            }
        }
        if (!progressed) break;
    }

    // Unpack every settled node's own tree edge into the real road it
    // represents, in each direction. Same unpackEdge() the final path uses
    // below - this is just running it over the whole search tree instead of
    // only the origin->meet->destination chain. Seed nodes themselves have no
    // incoming tree edge (that's what makes them seeds), so they're skipped
    // here exactly like the single-node origin/destination used to be.
    for (int u : res.exploredForward) {
        if (startSeedNodes.count(u)) continue;
        int p = parentF[u];
        std::vector<int> seg{p};
        unpackEdge(g, p, u, viaF[u], seg);
        res.exploredForwardSegments.push_back(std::move(seg));
    }
    for (int u : res.exploredBackward) {
        if (endSeedNodes.count(u)) continue;
        int p = parentB[u];
        std::vector<int> seg{u};
        unpackEdge(g, u, p, viaB[u], seg);
        res.exploredBackwardSegments.push_back(std::move(seg));
    }

    if (meet < 0 || !std::isfinite(best)) {
        res.found = false;
        return res;
    }

    res.found = true;
    res.distanceSec = best;

    // Forward tree edges from the real origin seed to meet, in that order.
    // Walking parent pointers back from `meet` stops at whichever seed node
    // this particular tree happened to grow from - with a single plain-node
    // start (the common case) that's always the same one node, exactly as
    // before.
    std::vector<std::array<int, 3>> fwdEdges;  // {u, v, via}
    int fwdOrigin = meet;
    while (!startSeedNodes.count(fwdOrigin)) {
        int p = parentF[fwdOrigin];
        fwdEdges.push_back({p, fwdOrigin, viaF[fwdOrigin]});
        fwdOrigin = p;
    }
    std::reverse(fwdEdges.begin(), fwdEdges.end());

    // Backward tree edges from meet to the real destination seed: parentB[cur]
    // is always the node closer to the destination, so walking it from `meet`
    // already visits them in meet->destination order - each step is the real
    // directed edge cur->parentB[cur].
    std::vector<std::array<int, 3>> bwdEdges;
    int bwdDest = meet;
    while (!endSeedNodes.count(bwdDest)) {
        int p = parentB[bwdDest];
        bwdEdges.push_back({bwdDest, p, viaB[bwdDest]});
        bwdDest = p;
    }

    // path[0]/path.back() are always these two real seed nodes - the caller
    // (main(), for a virtual mid-road endpoint) prepends/appends the actual
    // clicked point's own coordinate around them.
    res.path.push_back(fwdOrigin);
    for (auto& e : fwdEdges) unpackEdge(g, e[0], e[1], e[2], res.path);
    for (auto& e : bwdEdges) unpackEdge(g, e[0], e[1], e[2], res.path);

    return res;
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
