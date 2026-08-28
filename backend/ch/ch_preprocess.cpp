// Contraction Hierarchy preprocessor for the "traffic light revamped" road map.
//
// Reads map_data.json (the format written by serve.py / osm_to_json.py /
// editor.js) and builds a time-weighted directed routing graph, contracts it
// into a Contraction Hierarchy, self-verifies the result against a plain
// Dijkstra, and writes a compact CSR binary (map_data.ch.bin) plus a small
// JSON summary (map_data.ch.meta.json) next to the input file.
//
// Usage: ch_preprocess.exe <path-to-map_data.json>
//
// Domain notes specific to this map format (not a generic OSM router):
//   - Real junctions are NOT shared node ids. osm_to_json.py pulls every
//     road's end back a couple of metres from each junction it meets and
//     tags all those pulled-back endpoints with a shared tags.join_group.
//     So the routable graph must connect every pair of nodes that share a
//     join_group (a small clique per junction) - that IS the intersection.
//   - Edge weight is travel TIME in seconds: segment length (nodes are
//     already in projected metres) divided by a speed derived from the way's
//     avg_max_speed/maxspeed tags (falls back to a per-highway-class table).
//   - A join_group whose member set includes a node with a "signal" object
//     (traffic-light phase plan) gets a flat expected-wait penalty added to
//     every crossing edge in that junction's clique: half the signal's cycle
//     length, i.e. the standard "average delay ~= cycle/2" approximation for
//     an uncoordinated fixed-time signal. This is a static approximation
//     (CH requires static weights) - not a time-dependent simulation.

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <optional>
#include <queue>
#include <random>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;

static double elapsedMs(Clock::time_point t0) {
    return std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
}

// ---------------------------------------------------------------------------
// Minimal JSON DOM + parser (only what this file format needs: objects,
// arrays, strings with \u escapes, numbers, bool/null).
// ---------------------------------------------------------------------------

struct JsonValue {
    enum class Type { Null, Bool, Number, String, Array, Object };
    Type type = Type::Null;
    bool boolVal = false;
    double numVal = 0.0;
    std::string strVal;
    std::vector<JsonValue> arrVal;
    std::vector<std::pair<std::string, JsonValue>> objVal;

    const JsonValue* find(std::string_view key) const {
        for (auto& kv : objVal)
            if (kv.first == key) return &kv.second;
        return nullptr;
    }
    std::optional<std::string> str(std::string_view key) const {
        auto* v = find(key);
        if (v && v->type == Type::String) return v->strVal;
        return std::nullopt;
    }
    std::optional<double> num(std::string_view key) const {
        auto* v = find(key);
        if (v && v->type == Type::Number) return v->numVal;
        return std::nullopt;
    }
};

class JsonParser {
public:
    explicit JsonParser(const std::string& text) : s(text), n(text.size()) {}

    JsonValue parse() {
        skipWs();
        JsonValue v = parseValue();
        return v;
    }

private:
    const std::string& s;
    size_t n;
    size_t i = 0;

    [[noreturn]] void fail(const std::string& msg) {
        size_t line = 1, col = 1;
        for (size_t k = 0; k < i && k < n; ++k) {
            if (s[k] == '\n') { line++; col = 1; } else { col++; }
        }
        std::ostringstream oss;
        oss << "JSON parse error at line " << line << " col " << col << ": " << msg;
        throw std::runtime_error(oss.str());
    }

    void skipWs() {
        while (i < n && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
    }

    char peek() { return i < n ? s[i] : '\0'; }

    JsonValue parseValue() {
        skipWs();
        if (i >= n) fail("unexpected end of input");
        char c = s[i];
        if (c == '{') return parseObject();
        if (c == '[') return parseArray();
        if (c == '"') return parseString();
        if (c == 't' || c == 'f') return parseBool();
        if (c == 'n') return parseNull();
        if (c == '-' || (c >= '0' && c <= '9')) return parseNumber();
        fail(std::string("unexpected character '") + c + "'");
    }

    JsonValue parseObject() {
        JsonValue v;
        v.type = JsonValue::Type::Object;
        ++i;  // '{'
        skipWs();
        if (peek() == '}') { ++i; return v; }
        while (true) {
            skipWs();
            if (peek() != '"') fail("expected string key");
            JsonValue key = parseString();
            skipWs();
            if (peek() != ':') fail("expected ':'");
            ++i;
            JsonValue val = parseValue();
            v.objVal.emplace_back(std::move(key.strVal), std::move(val));
            skipWs();
            if (peek() == ',') { ++i; continue; }
            if (peek() == '}') { ++i; break; }
            fail("expected ',' or '}'");
        }
        return v;
    }

    JsonValue parseArray() {
        JsonValue v;
        v.type = JsonValue::Type::Array;
        ++i;  // '['
        skipWs();
        if (peek() == ']') { ++i; return v; }
        while (true) {
            JsonValue val = parseValue();
            v.arrVal.push_back(std::move(val));
            skipWs();
            if (peek() == ',') { ++i; continue; }
            if (peek() == ']') { ++i; break; }
            fail("expected ',' or ']'");
        }
        return v;
    }

    static void appendUtf8(std::string& out, uint32_t cp) {
        if (cp <= 0x7F) {
            out += static_cast<char>(cp);
        } else if (cp <= 0x7FF) {
            out += static_cast<char>(0xC0 | (cp >> 6));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else if (cp <= 0xFFFF) {
            out += static_cast<char>(0xE0 | (cp >> 12));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else {
            out += static_cast<char>(0xF0 | (cp >> 18));
            out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        }
    }

    uint32_t parseHex4() {
        if (i + 4 > n) fail("truncated \\u escape");
        uint32_t v = 0;
        for (int k = 0; k < 4; ++k) {
            char c = s[i + k];
            v <<= 4;
            if (c >= '0' && c <= '9') v |= (c - '0');
            else if (c >= 'a' && c <= 'f') v |= (c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') v |= (c - 'A' + 10);
            else fail("invalid \\u escape");
        }
        i += 4;
        return v;
    }

    JsonValue parseString() {
        JsonValue v;
        v.type = JsonValue::Type::String;
        ++i;  // opening quote
        std::string out;
        while (true) {
            if (i >= n) fail("unterminated string");
            char c = s[i++];
            if (c == '"') break;
            if (c == '\\') {
                if (i >= n) fail("unterminated escape");
                char e = s[i++];
                switch (e) {
                    case '"': out += '"'; break;
                    case '\\': out += '\\'; break;
                    case '/': out += '/'; break;
                    case 'b': out += '\b'; break;
                    case 'f': out += '\f'; break;
                    case 'n': out += '\n'; break;
                    case 'r': out += '\r'; break;
                    case 't': out += '\t'; break;
                    case 'u': {
                        uint32_t cp = parseHex4();
                        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < n && s[i] == '\\' && s[i + 1] == 'u') {
                            size_t save = i;
                            i += 2;
                            uint32_t lo = parseHex4();
                            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            } else {
                                i = save;  // not a valid low surrogate, treat cp alone
                            }
                        }
                        appendUtf8(out, cp);
                        break;
                    }
                    default: fail("invalid escape character");
                }
            } else {
                out += c;
            }
        }
        v.strVal = std::move(out);
        return v;
    }

    JsonValue parseBool() {
        JsonValue v;
        v.type = JsonValue::Type::Bool;
        if (s.compare(i, 4, "true") == 0) { v.boolVal = true; i += 4; }
        else if (s.compare(i, 5, "false") == 0) { v.boolVal = false; i += 5; }
        else fail("invalid literal");
        return v;
    }

    JsonValue parseNull() {
        if (s.compare(i, 4, "null") != 0) fail("invalid literal");
        i += 4;
        JsonValue v;
        v.type = JsonValue::Type::Null;
        return v;
    }

    JsonValue parseNumber() {
        size_t start = i;
        if (peek() == '-') ++i;
        while (i < n && s[i] >= '0' && s[i] <= '9') ++i;
        if (i < n && s[i] == '.') {
            ++i;
            while (i < n && s[i] >= '0' && s[i] <= '9') ++i;
        }
        if (i < n && (s[i] == 'e' || s[i] == 'E')) {
            ++i;
            if (i < n && (s[i] == '+' || s[i] == '-')) ++i;
            while (i < n && s[i] >= '0' && s[i] <= '9') ++i;
        }
        JsonValue v;
        v.type = JsonValue::Type::Number;
        auto res = std::from_chars(s.data() + start, s.data() + i, v.numVal);
        if (res.ec != std::errc()) fail("invalid number");
        return v;
    }
};

// ---------------------------------------------------------------------------
// FNV-1a 64-bit, used only as a cheap "did the source change" fingerprint.
// ---------------------------------------------------------------------------

static uint64_t fnv1a64(const std::string& data) {
    uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : data) {
        h ^= c;
        h *= 1099511628211ULL;
    }
    return h;
}

// ---------------------------------------------------------------------------
// Domain rules: which highway classes are drivable, and how fast.
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

// Fallback free-flow speed (km/h) by highway class, used only when a way has
// neither avg_max_speed nor maxspeed. Chosen to match the values the rest of
// this project's own pipeline (osm_to_json.py / editor.js) already assigns
// for these classes, so the fallback only ever matters for hand-edited ways.
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

// Low-speed maneuvering speed used for the small synthetic edges that cross
// a junction clique (see join_group handling below).
static constexpr double TURN_SPEED_KMH = 15.0;

// ---------------------------------------------------------------------------
// Graph model
// ---------------------------------------------------------------------------

struct BaseEdge {
    int from, to;
    double weight;  // seconds
};

struct Graph {
    std::vector<std::string> id;      // internal index -> original node id string
    std::vector<double> x, y;
    std::vector<BaseEdge> edges;      // original (pre-contraction) directed edges
    std::unordered_map<std::string, int> indexOf;

    int getOrCreate(const std::string& nodeId, const JsonValue& nodeObj) {
        auto it = indexOf.find(nodeId);
        if (it != indexOf.end()) return it->second;
        int idx = (int)id.size();
        indexOf.emplace(nodeId, idx);
        id.push_back(nodeId);
        x.push_back(nodeObj.num("x").value_or(0.0));
        y.push_back(nodeObj.num("y").value_or(0.0));
        return idx;
    }

    // Same as getOrCreate, but for a synthetic id with no JSON node object of
    // its own (see the divided-way #fwd/#bwd splitting in buildGraph) - same
    // coordinates as whatever real node it was derived from, copied by the
    // caller rather than looked up here.
    int getOrCreateAt(const std::string& nodeId, double xv, double yv) {
        auto it = indexOf.find(nodeId);
        if (it != indexOf.end()) return it->second;
        int idx = (int)id.size();
        indexOf.emplace(nodeId, idx);
        id.push_back(nodeId);
        x.push_back(xv);
        y.push_back(yv);
        return idx;
    }
};

static double dist2d(double ax, double ay, double bx, double by) {
    double dx = ax - bx, dy = ay - by;
    return std::sqrt(dx * dx + dy * dy);
}

// Builds the routable directed graph (chain edges along each way + junction
// clique edges from shared join_group tags) from the parsed map_data.json.
static Graph buildGraph(const JsonValue& root, std::ostream& log) {
    Graph g;
    const JsonValue* nodesJson = root.find("nodes");
    const JsonValue* waysJson = root.find("ways");
    if (!nodesJson || nodesJson->type != JsonValue::Type::Object)
        throw std::runtime_error("map_data.json missing 'nodes' object");
    if (!waysJson || waysJson->type != JsonValue::Type::Array)
        throw std::runtime_error("map_data.json missing 'ways' array");

    // Fast id -> node JSON lookup (nodesJson->find() would be O(n) per call).
    std::unordered_map<std::string, const JsonValue*> nodeByld;
    nodeByld.reserve(nodesJson->objVal.size() * 2);
    for (auto& kv : nodesJson->objVal) nodeByld.emplace(kv.first, &kv.second);

    long long chainEdgeCount = 0;
    long long skippedWays = 0;

    for (auto& wayVal : waysJson->arrVal) {
        const JsonValue* tags = wayVal.find("tags");
        const JsonValue* nodesArr = wayVal.find("nodes");
        if (!nodesArr || nodesArr->type != JsonValue::Type::Array || nodesArr->arrVal.size() < 2) continue;

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

        std::string oneway = tags ? tags->str("oneway").value_or("") : "";
        std::string junction = tags ? tags->str("junction").value_or("") : "";
        bool forward = true, backward = true;
        if (oneway == "yes") backward = false;
        else if (oneway == "-1") forward = false;
        else if (oneway != "no" && junction == "roundabout") backward = false;

        // A divided (median-separated) two-way road is physically two
        // carriageways, not one - see the #fwd/#bwd interior-node splitting
        // where this is used, a few lines down.
        bool divided = forward && backward && tags && tags->str("divider").value_or("") == "yes";

        // Resolve every node in this way's chain up front (also registers
        // them in the graph even if a later lookup fails for a neighbour).
        std::vector<int> chain;
        chain.reserve(nodesArr->arrVal.size());
        bool ok = true;
        for (auto& nv : nodesArr->arrVal) {
            if (nv.type != JsonValue::Type::String) { ok = false; break; }
            auto it = nodeByld.find(nv.strVal);
            if (it == nodeByld.end()) { ok = false; break; }
            chain.push_back(g.getOrCreate(nv.strVal, *it->second));
        }
        if (!ok || chain.size() < 2) { skippedWays++; continue; }

        // On an undivided way, every chain vertex is a single shared node
        // used by both directions - free to switch direction anywhere along
        // it, matching how a real 2-lane road can be crossed/turned-around
        // on at will. On a DIVIDED way, only the way's own first/last node
        // (always a real intersection or an explicit U-turn split point -
        // see splitWayAt/addUturn, which only ever split at those) may be
        // shared between directions; every purely-interior vertex gets a
        // direction-specific twin (id+"#fwd" / id+"#bwd", same coordinates),
        // so the forward and backward chains only reconnect at a real
        // crossing point, never at an ordinary shape vertex partway along
        // the median. Without this, a route could "reverse" anywhere along
        // a divided road's interior, which - while harmless for an ordinary
        // intersection-to-intersection query (Dijkstra never benefits from
        // gratuitous mid-edge backtracking when both endpoints are outside
        // the segment) - defeats the point of resolving which carriageway a
        // mid-road click landed on (see ch_query.cpp's EndpointSpec).
        auto sideNode = [&](size_t k, bool wantForward) -> int {
            int real = chain[k];
            if (!divided || k == 0 || k + 1 == chain.size()) return real;
            return g.getOrCreateAt(g.id[real] + (wantForward ? "#fwd" : "#bwd"), g.x[real], g.y[real]);
        };
        for (size_t k = 0; k + 1 < chain.size(); ++k) {
            double d = dist2d(g.x[chain[k]], g.y[chain[k]], g.x[chain[k + 1]], g.y[chain[k + 1]]);
            double t = d / speedMps;
            if (forward) {
                g.edges.push_back({sideNode(k, true), sideNode(k + 1, true), t});
                chainEdgeCount++;
            }
            if (backward) {
                g.edges.push_back({sideNode(k + 1, false), sideNode(k, false), t});
                chainEdgeCount++;
            }
        }
    }

    // Junction cliques: every node sharing a tags.join_group value that we
    // already touched via a routable way gets connected to every other
    // member of that group (see file header for why this replaces the
    // usual "shared node id" junction model).
    std::unordered_map<std::string, std::vector<int>> groups;
    std::unordered_map<std::string, double> groupExtraWaitSec;
    for (auto& [nid, idx] : g.indexOf) {
        auto it = nodeByld.find(nid);
        if (it == nodeByld.end()) continue;
        const JsonValue* tags = it->second->find("tags");
        if (!tags) continue;
        auto jg = tags->str("join_group");
        if (!jg) continue;
        groups[*jg].push_back(idx);

        if (!groupExtraWaitSec.count(*jg)) {
            const JsonValue* signal = it->second->find("signal");
            if (signal && signal->type == JsonValue::Type::Object) {
                double allRed = signal->num("allRedSec").value_or(0.0);
                double cycle = allRed;
                const JsonValue* phases = signal->find("phases");
                if (phases && phases->type == JsonValue::Type::Array) {
                    for (auto& ph : phases->arrVal) {
                        cycle += ph.num("greenSec").value_or(0.0);
                        cycle += ph.num("yellowSec").value_or(0.0);
                    }
                }
                if (cycle > 0) groupExtraWaitSec[*jg] = cycle / 2.0;  // average delay ~= cycle/2
            }
        }
    }

    long long junctionEdgeCount = 0;
    double turnSpeedMps = TURN_SPEED_KMH / 3.6;
    for (auto& [gid, members] : groups) {
        if (members.size() < 2) continue;
        double extraWait = 0.0;
        auto itw = groupExtraWaitSec.find(gid);
        if (itw != groupExtraWaitSec.end()) extraWait = itw->second;
        for (size_t a = 0; a < members.size(); ++a) {
            for (size_t b = 0; b < members.size(); ++b) {
                if (a == b) continue;
                int ia = members[a], ib = members[b];
                double d = dist2d(g.x[ia], g.y[ia], g.x[ib], g.y[ib]);
                double t = d / turnSpeedMps + extraWait;
                g.edges.push_back({ia, ib, t});
                junctionEdgeCount++;
            }
        }
    }

    log << "  chain edges: " << chainEdgeCount << ", junction crossing edges: " << junctionEdgeCount
        << ", ways skipped (non-routable/invalid): " << skippedWays << "\n";
    log << "  graph: " << g.id.size() << " nodes, " << g.edges.size() << " directed edges, "
        << groups.size() << " junction groups\n";
    return g;
}

// ---------------------------------------------------------------------------
// Contraction Hierarchy construction
// ---------------------------------------------------------------------------

struct WorkEdge {
    int to;
    double w;
    int via;  // -1 = base edge, else internal index of the contracted middle node
};

class ContractionHierarchy {
public:
    explicit ContractionHierarchy(const Graph& g) : n((int)g.id.size()) {
        outAdj.resize(n);
        inAdj.resize(n);
        active.assign(n, true);
        contractedNeighbors.assign(n, 0);
        rank.assign(n, -1);
        for (auto& e : g.edges) addEdgeBoth(e.from, e.to, e.weight, -1);
    }

    void run(std::ostream& log) {
        using PQ = std::priority_queue<std::pair<double, int>, std::vector<std::pair<double, int>>, std::greater<>>;
        PQ pq;
        for (int v = 0; v < n; ++v) {
            auto res = evaluate(v, false);
            pq.push({priorityOf(res, 0), v});
        }

        int order = 0;
        long long totalShortcuts = 0;
        long long lazyRequeues = 0;
        while (!pq.empty()) {
            auto [p, v] = pq.top();
            pq.pop();
            if (!active[v]) continue;

            auto res = evaluate(v, false);
            double p2 = priorityOf(res, contractedNeighbors[v]);
            if (!pq.empty() && p2 > pq.top().first + 1e-9) {
                pq.push({p2, v});
                lazyRequeues++;
                continue;
            }

            auto applied = evaluate(v, true);
            totalShortcuts += applied.shortcutsAdded;
            active[v] = false;
            rank[v] = order++;
            for (auto& e : inAdj[v]) if (active[e.to]) contractedNeighbors[e.to]++;
            for (auto& e : outAdj[v]) if (active[e.to]) contractedNeighbors[e.to]++;
        }

        log << "  contracted " << order << " nodes, added " << totalShortcuts
            << " shortcuts (" << lazyRequeues << " lazy re-evaluations)\n";
    }

    // Final augmented edge set (original + every shortcut ever created),
    // still intact because contraction only flips `active`, never removes.
    void collectAllEdges(std::vector<BaseEdge>& out) const {
        for (int a = 0; a < n; ++a)
            for (auto& e : outAdj[a])
                out.push_back({a, e.to, e.w});
    }

    const std::vector<int>& ranks() const { return rank; }

    // Exposed for the meta.json's via-lookup table used during path unpacking.
    int viaOf(int a, int b) const {
        for (auto& e : outAdj[a]) if (e.to == b) return e.via;
        return -2;  // edge not found
    }

    int nodeCount() const { return n; }

private:
    int n;
    std::vector<std::vector<WorkEdge>> outAdj, inAdj;
    std::vector<char> active;
    std::vector<int> contractedNeighbors;
    std::vector<int> rank;

    static constexpr int WITNESS_SETTLE_CAP = 60;
    static constexpr double ED_WEIGHT = 2.0;
    static constexpr double CN_WEIGHT = 1.0;

    struct EvalResult {
        int shortcutsAdded = 0;
        int edgesRemoved = 0;
    };

    static double priorityOf(const EvalResult& r, int contractedNeighborCount) {
        double edgeDiff = double(r.shortcutsAdded - r.edgesRemoved);
        return ED_WEIGHT * edgeDiff + CN_WEIGHT * contractedNeighborCount;
    }

    void addEdgeBoth(int a, int b, double w, int via) {
        bool found = false;
        for (auto& e : outAdj[a]) {
            if (e.to == b) { if (w < e.w) { e.w = w; e.via = via; } found = true; break; }
        }
        if (!found) outAdj[a].push_back({b, w, via});
        found = false;
        for (auto& e : inAdj[b]) {
            if (e.to == a) { if (w < e.w) { e.w = w; e.via = via; } found = true; break; }
        }
        if (!found) inAdj[b].push_back({a, w, via});
    }

    // Local Dijkstra from `src`, never entering `avoid`, capped to `limit`
    // total weight and WITNESS_SETTLE_CAP settled nodes. Missing a witness
    // within the cap only costs a redundant shortcut later, never a wrong
    // distance - the hierarchy stays correct either way.
    std::unordered_map<int, double> witnessSearch(int src, int avoid, double limit) const {
        std::unordered_map<int, double> dist;
        std::priority_queue<std::pair<double, int>, std::vector<std::pair<double, int>>, std::greater<>> pq;
        dist[src] = 0.0;
        pq.push({0.0, src});
        int settled = 0;
        while (!pq.empty()) {
            auto [d, u] = pq.top();
            pq.pop();
            auto cur = dist.find(u);
            if (cur == dist.end() || d > cur->second + 1e-12) continue;
            if (d > limit) break;
            if (++settled > WITNESS_SETTLE_CAP) break;
            for (auto& e : outAdj[u]) {
                if (e.to == avoid || !active[e.to]) continue;
                double nd = d + e.w;
                if (nd > limit + 1e-12) continue;
                auto it = dist.find(e.to);
                if (it == dist.end() || nd < it->second - 1e-12) {
                    dist[e.to] = nd;
                    pq.push({nd, e.to});
                }
            }
        }
        return dist;
    }

    EvalResult evaluate(int v, bool apply) {
        std::vector<std::pair<int, double>> preds, succs;
        for (auto& e : inAdj[v]) if (active[e.to] && e.to != v) preds.push_back({e.to, e.w});
        for (auto& e : outAdj[v]) if (active[e.to] && e.to != v) succs.push_back({e.to, e.w});

        EvalResult r;
        r.edgesRemoved = (int)preds.size() + (int)succs.size();

        for (auto& [u, w_uv] : preds) {
            double limit = -1.0;
            for (auto& [x, w_vx] : succs) if (x != u) limit = std::max(limit, w_uv + w_vx);
            if (limit < 0) continue;

            auto dist = witnessSearch(u, v, limit);
            for (auto& [x, w_vx] : succs) {
                if (x == u) continue;
                double viaW = w_uv + w_vx;
                auto it = dist.find(x);
                double witnessD = (it != dist.end()) ? it->second : std::numeric_limits<double>::infinity();
                if (witnessD > viaW + 1e-9) {
                    r.shortcutsAdded++;
                    if (apply) addEdgeBoth(u, x, viaW, v);
                }
            }
        }
        return r;
    }
};

// ---------------------------------------------------------------------------
// CH query (bidirectional Dijkstra, rank-restricted) + plain Dijkstra used
// only to self-verify the hierarchy right after building it.
// ---------------------------------------------------------------------------

struct CsrGraph {
    // up[a] = edges a->b with rank[a] < rank[b]; down[b] = edges filed under
    // b for backward search, i.e. every a->b with rank[a] > rank[b].
    std::vector<std::vector<WorkEdge>> up, down;
    explicit CsrGraph(int n) : up(n), down(n) {}
};

static double bidirectionalDijkstra(const CsrGraph& csr, const std::vector<int>& rank, int s, int t) {
    if (s == t) return 0.0;
    int n = (int)rank.size();
    std::vector<double> distF(n, std::numeric_limits<double>::infinity());
    std::vector<double> distB(n, std::numeric_limits<double>::infinity());
    std::vector<char> doneF(n, 0), doneB(n, 0);
    using QE = std::pair<double, int>;
    std::priority_queue<QE, std::vector<QE>, std::greater<>> pqF, pqB;
    distF[s] = 0; pqF.push({0, s});
    distB[t] = 0; pqB.push({0, t});
    double best = std::numeric_limits<double>::infinity();

    while (!pqF.empty() || !pqB.empty()) {
        bool progressed = false;
        if (!pqF.empty()) {
            auto [d, u] = pqF.top();
            if (d <= best) {
                pqF.pop();
                progressed = true;
                if (!doneF[u]) {
                    doneF[u] = 1;
                    if (doneB[u] && distF[u] + distB[u] < best) best = distF[u] + distB[u];
                    for (auto& e : csr.up[u]) {
                        double nd = d + e.w;
                        if (nd < distF[e.to]) { distF[e.to] = nd; pqF.push({nd, e.to}); }
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
                    if (doneF[u] && distF[u] + distB[u] < best) best = distF[u] + distB[u];
                    for (auto& e : csr.down[u]) {
                        double nd = d + e.w;
                        if (nd < distB[e.to]) { distB[e.to] = nd; pqB.push({nd, e.to}); }
                    }
                }
            } else {
                pqB = decltype(pqB)();
            }
        }
        if (!progressed) break;
    }
    return best;
}

static double plainDijkstra(const std::vector<std::vector<WorkEdge>>& adj, int s, int t) {
    if (s == t) return 0.0;
    int n = (int)adj.size();
    std::vector<double> dist(n, std::numeric_limits<double>::infinity());
    std::vector<char> done(n, 0);
    using QE = std::pair<double, int>;
    std::priority_queue<QE, std::vector<QE>, std::greater<>> pq;
    dist[s] = 0; pq.push({0, s});
    while (!pq.empty()) {
        auto [d, u] = pq.top(); pq.pop();
        if (done[u]) continue;
        done[u] = 1;
        if (u == t) return d;
        for (auto& e : adj[u]) {
            double nd = d + e.w;
            if (nd < dist[e.to]) { dist[e.to] = nd; pq.push({nd, e.to}); }
        }
    }
    return std::numeric_limits<double>::infinity();
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

static std::string readFile(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open " + p.string());
    std::ostringstream oss;
    oss << f.rdbuf();
    return oss.str();
}

static void writeU32(std::ofstream& f, uint32_t v) { f.write(reinterpret_cast<const char*>(&v), 4); }
static void writeU64(std::ofstream& f, uint64_t v) { f.write(reinterpret_cast<const char*>(&v), 8); }
static void writeI32(std::ofstream& f, int32_t v) { f.write(reinterpret_cast<const char*>(&v), 4); }
static void writeF64(std::ofstream& f, double v) { f.write(reinterpret_cast<const char*>(&v), 8); }

static std::string isoNow() {
    auto t = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    char buf[32];
    std::tm tmv{};
#if defined(_WIN32)
    gmtime_s(&tmv, &t);
#else
    gmtime_r(&t, &tmv);
#endif
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tmv);
    return std::string(buf);
}

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: ch_preprocess <path-to-map_data.json>\n";
        return 2;
    }
    fs::path inputPath = argv[1];
    fs::path dir = inputPath.parent_path();
    fs::path stem = inputPath.stem();  // "map_data"
    fs::path binPath = dir / (stem.string() + ".ch.bin");
    fs::path metaPath = dir / (stem.string() + ".ch.meta.json");
    fs::path binTmp = binPath.string() + ".tmp";
    fs::path metaTmp = metaPath.string() + ".tmp";

    auto tTotal = Clock::now();
    try {
        auto t0 = Clock::now();
        std::string raw = readFile(inputPath);
        uint64_t sourceHash = fnv1a64(raw);
        uint64_t sourceSize = raw.size();
        JsonParser parser(raw);
        JsonValue root = parser.parse();
        double parseMs = elapsedMs(t0);
        std::cout << "[ch] parsed " << inputPath.string() << " (" << raw.size() << " bytes) in "
                  << parseMs << " ms\n";

        t0 = Clock::now();
        Graph g = buildGraph(root, std::cout);
        double buildMs = elapsedMs(t0);
        std::cout << "[ch] graph build in " << buildMs << " ms\n";

        if (g.id.empty()) throw std::runtime_error("no routable nodes found in map_data.json");

        t0 = Clock::now();
        ContractionHierarchy ch(g);
        ch.run(std::cout);
        double contractMs = elapsedMs(t0);
        std::cout << "[ch] contraction in " << contractMs << " ms\n";

        // Rebuild original (pre-contraction) adjacency for the verification
        // baseline, and classify the full augmented edge set (original +
        // every shortcut ever created) into up/down CSR by final rank. Each
        // edge keeps its `via` (-1 for a base edge, else the contracted
        // middle node) so a future consumer can unpack a shortcut u->x by
        // recursively looking up u->via and via->x in whichever of up/down
        // holds them (decided the same way, by comparing their ranks).
        std::vector<std::vector<WorkEdge>> originalAdj(g.id.size());
        for (auto& e : g.edges) originalAdj[e.from].push_back({e.to, e.weight, -1});

        const auto& rank = ch.ranks();
        int n = ch.nodeCount();
        CsrGraph csr(n);

        {
            std::vector<BaseEdge> flat;
            ch.collectAllEdges(flat);
            for (auto& e : flat) {
                int via = ch.viaOf(e.from, e.to);
                WorkEdge we{e.to, e.weight, via};
                if (rank[e.from] < rank[e.to]) csr.up[e.from].push_back(we);
                else {
                    we.to = e.from;
                    csr.down[e.to].push_back(we);
                }
            }
        }

        // ---- Self-verification: CH distance vs. plain Dijkstra on the
        // original graph, over a fixed-seed random sample of node pairs. ----
        t0 = Clock::now();
        std::mt19937 rng(12345);
        std::uniform_int_distribution<int> pick(0, n - 1);
        int sampleCount = std::min(300, std::max(1, n / 2));
        int mismatches = 0;
        double maxAbsDiff = 0.0;
        int checked = 0;
        for (int i = 0; i < sampleCount; ++i) {
            int s = pick(rng), tgt = pick(rng);
            double chD = bidirectionalDijkstra(csr, rank, s, tgt);
            double refD = plainDijkstra(originalAdj, s, tgt);
            bool chReach = std::isfinite(chD), refReach = std::isfinite(refD);
            checked++;
            if (chReach != refReach) {
                mismatches++;
                std::cerr << "[ch] VERIFY MISMATCH reachability s=" << g.id[s] << " t=" << g.id[tgt]
                          << " ch=" << chD << " dijkstra=" << refD << "\n";
                continue;
            }
            if (chReach) {
                double diff = std::fabs(chD - refD);
                maxAbsDiff = std::max(maxAbsDiff, diff);
                if (diff > 1e-6 * std::max(1.0, refD)) {
                    mismatches++;
                    std::cerr << "[ch] VERIFY MISMATCH distance s=" << g.id[s] << " t=" << g.id[tgt]
                              << " ch=" << chD << " dijkstra=" << refD << " diff=" << diff << "\n";
                }
            }
        }
        double verifyMs = elapsedMs(t0);
        bool verifyPass = (mismatches == 0);
        std::cout << "[ch] verify: " << (checked - mismatches) << "/" << checked
                  << " sample pairs matched, max|diff|=" << maxAbsDiff << "s -> "
                  << (verifyPass ? "PASS" : "FAIL") << " (" << verifyMs << " ms)\n";

        // ---- Write binary CSR ----
        t0 = Clock::now();
        {
            std::ofstream f(binTmp, std::ios::binary);
            if (!f) throw std::runtime_error("cannot open " + binTmp.string() + " for writing");
            f.write("TLCH", 4);
            writeU32(f, 1);  // version
            writeU64(f, sourceHash);
            writeU64(f, sourceSize);
            writeU32(f, (uint32_t)n);

            uint32_t upEdgeCount = 0, downEdgeCount = 0;
            for (int a = 0; a < n; ++a) { upEdgeCount += (uint32_t)csr.up[a].size(); downEdgeCount += (uint32_t)csr.down[a].size(); }
            writeU32(f, upEdgeCount);
            writeU32(f, downEdgeCount);

            for (int a = 0; a < n; ++a) {
                const std::string& sid = g.id[a];
                writeU32(f, (uint32_t)sid.size());
                f.write(sid.data(), (std::streamsize)sid.size());
                writeF64(f, g.x[a]);
                writeF64(f, g.y[a]);
                writeU32(f, (uint32_t)rank[a]);
            }

            uint32_t offset = 0;
            for (int a = 0; a < n; ++a) { writeU32(f, offset); offset += (uint32_t)csr.up[a].size(); }
            writeU32(f, offset);
            for (int a = 0; a < n; ++a)
                for (auto& e : csr.up[a]) { writeU32(f, (uint32_t)e.to); writeF64(f, e.w); writeI32(f, e.via); }

            offset = 0;
            for (int a = 0; a < n; ++a) { writeU32(f, offset); offset += (uint32_t)csr.down[a].size(); }
            writeU32(f, offset);
            for (int a = 0; a < n; ++a)
                for (auto& e : csr.down[a]) { writeU32(f, (uint32_t)e.to); writeF64(f, e.w); writeI32(f, e.via); }
        }
        fs::rename(binTmp, binPath);
        double writeMs = elapsedMs(t0);

        uint32_t upEdgeCount = 0, downEdgeCount = 0, shortcutCount = 0;
        for (int a = 0; a < n; ++a) {
            upEdgeCount += (uint32_t)csr.up[a].size();
            downEdgeCount += (uint32_t)csr.down[a].size();
            for (auto& e : csr.up[a]) if (e.via != -1) shortcutCount++;
            for (auto& e : csr.down[a]) if (e.via != -1) shortcutCount++;
        }

        double totalMs = elapsedMs(tTotal);
        {
            std::ofstream f(metaTmp, std::ios::binary);
            if (!f) throw std::runtime_error("cannot open " + metaTmp.string() + " for writing");
            f << "{\n"
              << "  \"generatedAt\": \"" << isoNow() << "\",\n"
              << "  \"sourceFile\": \"" << inputPath.filename().string() << "\",\n"
              << "  \"sourceHash\": \"" << std::hex << sourceHash << std::dec << "\",\n"
              << "  \"sourceSize\": " << sourceSize << ",\n"
              << "  \"nodeCount\": " << n << ",\n"
              << "  \"originalDirectedEdgeCount\": " << g.edges.size() << ",\n"
              << "  \"shortcutCount\": " << shortcutCount << ",\n"
              << "  \"upEdgeCount\": " << upEdgeCount << ",\n"
              << "  \"downEdgeCount\": " << downEdgeCount << ",\n"
              << "  \"buildTimeMs\": {\n"
              << "    \"parse\": " << parseMs << ",\n"
              << "    \"graphBuild\": " << buildMs << ",\n"
              << "    \"contraction\": " << contractMs << ",\n"
              << "    \"write\": " << writeMs << ",\n"
              << "    \"verify\": " << verifyMs << ",\n"
              << "    \"total\": " << totalMs << "\n"
              << "  },\n"
              << "  \"verification\": {\n"
              << "    \"samplePairs\": " << checked << ",\n"
              << "    \"mismatches\": " << mismatches << ",\n"
              << "    \"maxAbsDiffSeconds\": " << maxAbsDiff << ",\n"
              << "    \"status\": \"" << (verifyPass ? "PASS" : "FAIL") << "\"\n"
              << "  }\n"
              << "}\n";
        }
        fs::rename(metaTmp, metaPath);

        std::cout << "[ch] wrote " << binPath.string() << " and " << metaPath.string()
                  << " in " << totalMs << " ms total\n";

        return verifyPass ? 0 : 1;
    } catch (const std::exception& ex) {
        std::error_code ec;
        fs::remove(binTmp, ec);
        fs::remove(metaTmp, ec);
        std::cerr << "[ch] ERROR: " << ex.what() << "\n";
        return 2;
    }
}
