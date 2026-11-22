#pragma once

// Shared Contraction Hierarchy binary reader + bidirectional-Dijkstra query
// engine for the "traffic light revamped" road map.
//
// Extracted from ch_query.cpp so backend/sim/sim_engine.cpp can run the exact
// same in-process route queries (instead of shelling out to ch_query.exe once
// per vehicle, which wouldn't scale to spawning up to 10k of them) without a
// second, drifting copy of the CH graph model or the search itself - a plain
// move, no behaviour change. ch_query.cpp keeps its own CLI/JSON-output/
// endpoint-spec-parsing layer on top of this.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <limits>
#include <queue>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

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

inline std::string chReadFile(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open " + path);
    std::ostringstream oss;
    oss << f.rdbuf();
    return oss.str();
}

inline ChGraph loadChGraph(const std::string& path) {
    BinReader r(chReadFile(path));

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

inline const WorkEdge* chFindEdge(const ChGraph& g, int u, int v) {
    if (g.rank[u] < g.rank[v]) {
        for (auto& e : g.up[u]) if (e.to == v) return &e;
    } else {
        for (auto& e : g.down[v]) if (e.to == u) return &e;
    }
    return nullptr;
}

// Appends the real nodes from (just after) u through v to `out`, which must
// already end with u. Leaves `out` ending with v.
inline void chUnpackEdge(const ChGraph& g, int u, int v, int via, std::vector<int>& out) {
    if (via == -1) { out.push_back(v); return; }
    const WorkEdge* e1 = chFindEdge(g, u, via);
    if (!e1) throw std::runtime_error("CH unpack: missing sub-edge in shortcut (u->via)");
    chUnpackEdge(g, u, via, e1->via, out);
    const WorkEdge* e2 = chFindEdge(g, via, v);
    if (!e2) throw std::runtime_error("CH unpack: missing sub-edge in shortcut (via->v)");
    chUnpackEdge(g, via, v, e2->via, out);
}

// ---------------------------------------------------------------------------
// Bidirectional Dijkstra, rank-restricted to the CH's up/down graphs (the
// standard CH query algorithm): forward search only ever relaxes edges into
// higher rank via `up`, backward search only ever relaxes edges into higher
// rank via `down` (which is edges into it from lower rank, walked backward
// from t) - so both frontiers climb toward the hierarchy's top and are
// guaranteed to meet there. Tracks parent pointers to reconstruct the actual
// path (shortcut edges recursively unpacked back to real graph edges) plus
// every settled node from each direction, for a caller's route +
// explored-node visualization (ch_query.cpp's stdout JSON) or, for
// sim_engine.cpp, just the unpacked path.
// ---------------------------------------------------------------------------

struct ChQueryResult {
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
// travel time already worked in. Dijkstra doesn't care how many seeds a
// search starts from, so this needs no change to the relaxation loop itself,
// only to how the frontier is initialized and to how the final path is
// unwound back to a real seed node instead of a single s/t.
struct ChSeed { int node; double dist; };

inline ChQueryResult runChQuery(const ChGraph& g, const std::vector<ChSeed>& startSeeds, const std::vector<ChSeed>& endSeeds) {
    ChQueryResult res;
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
    // represents, in each direction. Same chUnpackEdge() the final path uses
    // below - this is just running it over the whole search tree instead of
    // only the origin->meet->destination chain. Seed nodes themselves have no
    // incoming tree edge (that's what makes them seeds), so they're skipped
    // here exactly like the single-node origin/destination used to be.
    for (int u : res.exploredForward) {
        if (startSeedNodes.count(u)) continue;
        int p = parentF[u];
        std::vector<int> seg{p};
        chUnpackEdge(g, p, u, viaF[u], seg);
        res.exploredForwardSegments.push_back(std::move(seg));
    }
    for (int u : res.exploredBackward) {
        if (endSeedNodes.count(u)) continue;
        int p = parentB[u];
        std::vector<int> seg{u};
        chUnpackEdge(g, u, p, viaB[u], seg);
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

    // path[0]/path.back() are always these two real seed nodes - a caller
    // handling a virtual mid-road endpoint prepends/appends the actual
    // clicked point's own coordinate around them.
    res.path.push_back(fwdOrigin);
    for (auto& e : fwdEdges) chUnpackEdge(g, e[0], e[1], e[2], res.path);
    for (auto& e : bwdEdges) chUnpackEdge(g, e[0], e[1], e[2], res.path);

    return res;
}
