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
//     objects...) that the simulation physics/signals need. See
//     road_graph.hpp's RoadGraph.
//   - Loads map_data.ch.bin and runs the existing bidirectional-Dijkstra CH
//     query in-process (backend/ch/ch_graph.hpp) to give each vehicle its
//     initial shortest route at the moment it spawns. That CH route is a
//     SUGGESTION, not gospel - see vehicles.hpp's liveWeightedRoute and this
//     file's own reroute step: a vehicle periodically (~every 30s, staggered)
//     and immediately when it gets stuck re-derives a fresh path toward the
//     SAME destination from live per-edge congestion, the way a phone GPS
//     re-routes around traffic. The destination itself never changes.
//   - Loads backend/generate_vehicles.py's trip manifest (vehicles.json) and
//     spawns vehicles from it, ramping up to a target concurrent count.
//   - Runs a fixed-timestep (20 Hz) car-following simulation: IDM
//     (Intelligent Driver Model) acceleration/braking so no vehicle ever
//     teleports to speed or stops instantly, a direct C++ port of
//     front-end/redlight.js's fixed-time phase math for signalized
//     junctions (the "default" mode), and a road-class-priority +
//     first-come-first-served + minimum-discharge-gap arbitration for the
//     much more common unsignalized junctions (2841 of this map's 2844
//     junctions currently have no configured signal at all) - backstopped by
//     a real position-and-timing vision-cone gap check (visionGapIsSafe)
//     whenever that class-based arbitration alone would otherwise serialize
//     two movements that, right now, don't actually come close to each
//     other. See visionGapIsSafe's own comment for why this can only ever
//     admit MORE concurrent crossings than the class-based rule alone, never
//     fewer.
//   - Prints periodic stats to stdout/stderr and a final summary - no
//     websocket, no frontend, by design (see the plan's phase breakdown).
//
// Module layout (this file is the orchestrator/networking layer only):
//   - redlights.hpp  - the signal model (fixed-time phase math) and
//     RedlightController, the live Density-mode/emergency-preemption
//     arbiter. Knows nothing about Vehicle or RoadGraph - it only ever sees
//     VehicleStopReport/EmergencyReport, small "here's my position and type,
//     right now" messages submitted below (see step 3), the same arms-
//     length signal a real induction-loop sensor or connected-vehicle GPS
//     ping would give a physical signal controller. This is deliberate: it's
//     what makes Density mode a genuine reactive/actuated approximation
//     rather than a shortcut that peeks at any vehicle's planned route.
//   - road_graph.hpp - the static map/graph model (RoadGraph, buildRoadGraph)
//     both other modules read.
//   - vehicles.hpp   - Vehicle/TripSpec, routing (resolveRoute), lane
//     choice/changing, and the IDM car-following math.
//   - sim_engine.cpp (this file) - the hand-rolled WebSocket server, JSON
//     wire format, control-message handling, and the main loop that ties
//     the three together tick by tick.
//
// Domain note this file MUST stay in lockstep with: real junctions in this
// map format are NOT shared node ids - osm_to_json.py pulls every road's end
// back a couple of metres from the junction it meets and tags all those
// pulled-back endpoints with a shared tags.join_group (a small clique per
// junction). backend/ch/ch_preprocess.cpp's own header comment documents
// this and builds its routing graph the same way; road_graph.hpp's RoadGraph
// deliberately mirrors that exact topology (chain edges along each way +
// junction clique edges from shared join_group) so that every hop in a CH
// query's unpacked path is guaranteed to resolve to a real edge here - see
// vehicles.hpp's resolveRoute()'s "CH path hop not resolvable" error, which
// would only ever fire if this graph drifted out of sync with
// ch_preprocess.cpp's rules.

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
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <winsock2.h>
#include <ws2tcpip.h>
#include <timeapi.h>

#include "../ch/json.hpp"
#include "../ch/ch_graph.hpp"
#include "redlights.hpp"
#include "road_graph.hpp"
#include "vehicles.hpp"

using Clock = std::chrono::steady_clock;
static double elapsedMs(Clock::time_point t0) {
    return std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
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

struct TypeStats { long long count = 0; double sumTripSec = 0; };
struct EmergencyStats { long long count = 0; double sumResponseSec = 0, sumTransportSec = 0; };

// One vehicle competing for entry into an unsignalized junction this tick
// (one per approach-lane, i.e. per edge-group's front vehicle) - see the
// main loop's step 3 for how these are built/ranked/released, and
// visionGapIsSafe just below for how a candidate the class-based
// arbitration alone would reject can still be admitted. Hoisted to file
// scope (rather than declared inline inside main(), as it originally was)
// so visionGapIsSafe can take it by reference.
struct JctCandidate {
    int vi; std::string fromWayId, movement, toWayId;
    double arrDirX, arrDirY, lengthM, speedMps;
    double rank; double arrivalTime;
};

// Compact JSON build (hand-rolled, matching ch_preprocess.cpp/ch_query.cpp's
// own approach - no library) for the per-tick broadcast. vehicleType is
// always one of this project's own small fixed set (never externally
// supplied), so no escaping is needed for it.
static std::string buildStateJson(double simClock, const std::vector<Vehicle>& vehicles, const RoadGraph& rg,
                                   long long totalSpawned, long long totalCompleted, size_t totalTrips, SignalMode signalMode,
                                   const RedlightController& redlights,
                                   const std::unordered_map<std::string, TypeStats>& completedByType,
                                   const EmergencyStats& emergencyStats, long long totalStuckVehicles, bool isFinal = false) {
    std::string out;
    out.reserve(vehicles.size() * 72 + 128);
    char buf[64];
    auto appendNum = [&](double v, int decimals) {
        snprintf(buf, sizeof(buf), "%.*f", decimals, v);
        out += buf;
    };
    out += "{\"type\":\"state\",\"t\":"; appendNum(simClock, 2);
    // Sent once, right before the engine's main loop actually exits (natural
    // end-of-run OR a manual stop) - see main()'s closing broadcast, sent
    // unconditionally so sim-client.js's end-of-run popup (see
    // showSimStatsModal) reliably fires even when nobody clicked Stop.
    if (isFinal) out += ",\"final\":true";
    out += ",\"spawned\":"; out += std::to_string(totalSpawned);
    out += ",\"completed\":"; out += std::to_string(totalCompleted);
    out += ",\"total\":"; out += std::to_string(totalTrips);
    out += ",\"mode\":\""; out += signalModeToString(signalMode); out += "\"";
    // Under EmergencyOnly/Density mode a signalized junction's lamp colors
    // are decided live, server-side from RedlightController (see the main
    // loop's step 3 and redlights.hpp's SignalMode comment), not the
    // fixed-time math front-end/redlight.js runs locally from the clock
    // alone - so those colors have to be streamed explicitly here for the
    // client to render correctly (see sim-client.js's handling of this
    // field). Only ever non-empty for this map's 3 signalized junctions.
    //   - EmergencyOnly mode with no ambulance currently preempting a given
    //     junction is deliberately SKIPPED here entirely (not just "colored
    //     the same as default") - that junction is left out of this array so
    //     the client falls back to its own ordinary fixed-time computation
    //     (same math, kept in lockstep via Sim.clockSec - see sim-client.js),
    //     which is what lets it show a genuine countdown timer rather than a
    //     frozen "0". Only emitted once an ambulance is actually preempting.
    //   - Density mode always emits every signalized junction (it has no
    //     fixed-time fallback to defer to).
    //   - Either mode, once RedlightController::preempting names a junction
    //     (see the main loop's step 3 - an ambulance's EmergencyReport at
    //     the front of its approach queue), that approach's own color is
    //     forced green and every other approach forced red, overriding the
    //     mode's ordinary logic - real preemption, not just a priority
    //     nudge.
    if (signalMode != SignalMode::Default) {
        out += ",\"lamps\":[";
        bool firstLamp = true;
        for (size_t ji = 0; ji < rg.junctions.size(); ++ji) {
            const JunctionInfo& jn = rg.junctions[ji];
            if (!jn.signal.present) continue;
            std::string preemptWayId;
            bool preempting = redlights.preempting((int)ji, preemptWayId);
            if (signalMode == SignalMode::EmergencyOnly && !preempting) continue;
            std::unordered_set<std::string> seen;
            std::vector<const JunctionEdge*> approaches;
            for (const JunctionEdge& je : rg.junctionEdges) {
                if (je.junctionIdx != (int)ji) continue;
                if (!seen.insert(je.fromWayId + "|" + je.movement).second) continue;
                approaches.push_back(&je);
            }
            const char* reason = preempting ? "emergency" : "density";
            std::vector<const JunctionEdge*> greenList;
            if (preempting) {
                for (auto* je : approaches) if (je->fromWayId == preemptWayId) greenList.push_back(je);
            } else {
                // Density mode: replicate the SAME greedy compatibility
                // acceptance the real per-tick admission uses (see step 3's
                // candidatesForJunction loop above), applied to EVERY
                // approach at this junction - not just ones with a vehicle
                // currently waiting. Checking each approach only against
                // jn.inFlight in isolation (an earlier version of this did
                // exactly that) is wrong: during a lull with nothing actually
                // mid-crossing, every approach reads as "compatible with
                // nothing" and would display green simultaneously even when
                // they are NOT mutually compatible with each other - painting
                // the junction as safe for everyone at once when real
                // vehicles would never actually be granted that together.
                // Ranking by the same RedlightController weight shown in the
                // sidebar keeps the displayed set consistent with what real
                // vehicles would actually be granted if they all showed up.
                std::vector<const JunctionEdge*> order = approaches;
                std::sort(order.begin(), order.end(), [&](const JunctionEdge* a, const JunctionEdge* b) {
                    auto wOf = [&](const JunctionEdge* e) { return redlights.densityWeightFor((int)ji, e->fromWayId); };
                    double wa = wOf(a), wb = wOf(b);
                    if (wa != wb) return wa > wb;
                    return (a->fromWayId + a->movement) < (b->fromWayId + b->movement);
                });
                for (const JunctionEdge* c : order) {
                    bool ok = true;
                    for (auto& f : jn.inFlight) {
                        if (!movementsCompatible(c->fromWayId, c->movement, c->arrDirX, c->arrDirY, c->toWayId,
                                                  f.fromWayId, f.movement, f.arrDirX, f.arrDirY, f.toWayId)) { ok = false; break; }
                    }
                    if (ok) for (const JunctionEdge* other : greenList) {
                        if (!movementsCompatible(c->fromWayId, c->movement, c->arrDirX, c->arrDirY, c->toWayId,
                                                  other->fromWayId, other->movement, other->arrDirX, other->arrDirY, other->toWayId)) { ok = false; break; }
                    }
                    if (ok) greenList.push_back(c);
                }
            }
            for (auto* je : approaches) {
                bool green = std::find(greenList.begin(), greenList.end(), je) != greenList.end();
                if (!firstLamp) out += ",";
                firstLamp = false;
                out += "{\"nodeId\":"; appendJsonString(out, rg.nodeId[jn.primaryNodeIdx]);
                out += ",\"wayId\":"; appendJsonString(out, je->fromWayId);
                out += ",\"movement\":"; appendJsonString(out, je->movement);
                out += ",\"color\":\""; out += (green ? "green" : "red"); out += "\"";
                out += ",\"r\":\""; out += reason; out += "\"}";
            }
        }
        out += "]";
    }
    // Density mode's live per-approach "red dot" weight (see the main loop's
    // step 3 and RedlightController::reportStopped) - streamed unkeyed by
    // movement (one entry per fromWayId, not per lamp) purely for display:
    // the frontend's node inspector shows this when a signalized junction is
    // selected, so a user can see WHY a given approach is winning (or not)
    // under Density mode. Only ever non-empty in Density mode; harmless/
    // empty otherwise.
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
                double w = redlights.densityWeightFor((int)ji, je.fromWayId);
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
    // Live "currently stuck right now" snapshot (see Vehicle::stoppedDurationSec)
    // - computed as its own quick pass since the per-vehicle loop that also
    // emits each one's "stk" flag runs AFTER this stats block below.
    long long stuckNow = 0;
    for (auto& v : vehicles) if (v.active && v.stoppedDurationSec > 5.0) stuckNow++;

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
        // Two distinct numbers, both wanted in the end-of-run report (see
        // sim-client.js's showSimStatsModal): stuckTotal is a monotonically
        // increasing count of DISTINCT vehicles that were ever stuck >5s at
        // any point in the run (Vehicle::stuckCounted latches this); stuckNow
        // is a live snapshot of how many are stuck AT THIS EXACT MOMENT -
        // the number that matters when the run stops.
        out += ",\"stuckTotal\":"; out += std::to_string(totalStuckVehicles);
        out += ",\"stuckNow\":"; out += std::to_string(stuckNow);
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

        // Curved turning path: a junction edge connects two DIFFERENT
        // approach nodes with a straight line, which is geometrically
        // correct for routing/distance but renders as an instant snap from
        // the arrival heading to the departure heading, right at the
        // junction - real vehicles sweep through a turn radius instead. This
        // bends the RENDERED path (never the physics - distAlongEdge/t above
        // is untouched) into a quadratic Bezier - see road_graph.hpp's
        // junctionEdgeCurvePoint for the actual math (shared with
        // visionGapIsSafe's admission check, so both see the SAME real
        // curved path a vehicle is actually drawn following).
        double x, y, heading;
        if (cur.isJunction) {
            JunctionCurvePoint cp = junctionEdgeCurvePoint(rg.junctionEdges[cur.edgeIndex], fx, fy, tx, ty, cur.length, t);
            x = cp.x; y = cp.y; heading = cp.headingRad;
        } else {
            x = fx + (tx - fx) * t; y = fy + (ty - fy) * t;
            heading = std::atan2(ty - fy, tx - fx);
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
        // Live "stuck >5s" flag - drives sim-client.js's magenta dot; the
        // SAME condition stuckNow above already counted, computed here per
        // vehicle rather than threaded through as a precomputed set.
        if (v.stoppedDurationSec > 5.0) out += ",\"stk\":1";
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

// Second-opinion junction admission check, only ever consulted (see the main
// loop's step 3) once the fast class-based movementsCompatible() gate has
// ALREADY said no for a candidate - a real position-and-timing gap check
// using the generic visionCone() primitive (vehicles.hpp), scoped to exactly
// this junction's real occupants plus this tick's other just-admitted
// candidates. This can only ever ADMIT a crossing the fast gate would have
// refused, never refuse one the fast gate already allowed, so it's strictly
// additive to that hand-verified safety baseline (see road_graph.hpp's
// movementsCompatible comment for why a from-scratch replacement was
// deliberately NOT attempted again here).
//
// The one case worth being paranoid about, because road_graph.hpp's own
// history says an earlier rewrite got it wrong: a protected right/crossing
// turn against opposing through traffic. That earlier attempt only checked
// whether the two paths crossed geometrically, never whether the two
// vehicles would actually BE at that crossing point at the same time - this
// check is built entirely around real closing-speed/time-to-conflict
// estimates specifically so it doesn't repeat that mistake: two vehicles
// whose paths cross but who'd actually pass through minutes apart are
// correctly judged safe, but two who'd arrive within SAFETY_MARGIN_SEC of
// each other are not, regardless of movement class.
static bool visionGapIsSafe(const RoadGraph& rg, const std::vector<Vehicle>& vehicles,
                             const std::unordered_map<uint64_t, std::vector<int>>& groups,
                             const JunctionInfo& jn, const JctCandidate& cand,
                             const std::vector<const JctCandidate*>& accepted) {
    const Vehicle& cv = vehicles[cand.vi];
    VehiclePosition origin = vehicleWorldPosition(rg, cv);
    double headingRad = std::atan2(cand.arrDirY, cand.arrDirX);
    double candCrossSpeed = std::max(0.5, cand.speedMps);
    double candTimeToMid = (cand.lengthM * 0.5) / candCrossSpeed;

    // Real occupants of this junction's own edges right now (ground truth
    // from `groups`, not a predicted freeAt timer) plus this tick's other
    // already-accepted rivals (about to start moving even though their
    // routeIdx hasn't advanced onto the junction edge yet) - each recorded
    // with its OWN approach/speed so the hit loop below doesn't need to
    // dig back into route state to tell the two kinds apart.
    struct OccupantInfo { std::string fromWayId; double speedMps; };
    std::unordered_map<int, OccupantInfo> occupants;
    for (int edgeIdx : jn.edgeIndices) {
        auto it = groups.find(edgeKey(RouteStep{true, edgeIdx, 0.0}, 0));
        if (it == groups.end()) continue;
        const JunctionEdge& oje = rg.junctionEdges[edgeIdx];
        for (int vi : it->second) occupants[vi] = {oje.fromWayId, oje.speedMps};
    }
    for (const JctCandidate* other : accepted) occupants[other->vi] = {other->fromWayId, other->speedMps};

    std::vector<int> candidateVis;
    candidateVis.reserve(occupants.size());
    for (auto& [vi, info] : occupants) candidateVis.push_back(vi);

    // A junction needs looking both ways, not a narrow forward cone - wide
    // half-angle (~115 degrees either side) and a range comfortably covering
    // a real junction box plus a short approach. Named distinctly from
    // vehicles.hpp's own VISION_RANGE_M (the lane-change cone's range) since
    // a junction needs a shorter, wider look than a lane change does.
    const double JUNCTION_VISION_HALF_ANGLE_RAD = 2.0;
    const double JUNCTION_VISION_RANGE_M = 35.0;
    const double SAFETY_MARGIN_SEC = 3.0;

    auto hits = visionCone(rg, vehicles, candidateVis, origin.x, origin.y, headingRad, JUNCTION_VISION_HALF_ANGLE_RAD, JUNCTION_VISION_RANGE_M, cand.vi);
    for (auto& h : hits) {
        auto infoIt = occupants.find(h.vi);
        if (infoIt == occupants.end()) continue; // defensive - every candidateVis entry has one
        if (infoIt->second.fromWayId == cand.fromWayId) continue; // same approach - always safe (rule 1)
        double oSpeed = std::max(0.5, infoIt->second.speedMps);
        double oTimeToConflict = h.distM / oSpeed;
        if (std::fabs(oTimeToConflict - candTimeToMid) < SAFETY_MARGIN_SEC) return false;
    }
    return true;
}

// Control messages from the frontend - setSpeed/stop/getRoute/getVehicleInfo/
// setAdvancedLaneAI/setSignalMode/triggerEmergency all do something now.
// triggerEmergency dispatches an already-active ambulance to a clicked map
// point: it splices a freshly-resolved route from the vehicle's current
// position on to the incident node (see stepToNode/resolveRoute), flags it
// emergency (which EmergencyOnly/Density mode's junction preemption keys off
// via an EmergencyReport - see the main loop's step 3), and records
// dispatchTime so the eventual incident/hospital arrivals can report
// response/transport times (see the edge-transition step and
// buildStateJson's "stats" field).
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
    // Off by default - see vehicles.hpp's laneVisionCost own comment for why
    // this costs more per vehicle per tick than the default heuristic.
    // Toggleable live via {"cmd":"setAdvancedLaneAI","value":true|false} too
    // (see handleCommand).
    bool advancedLaneAI = false;
    // Phase 4 - see redlights.hpp's SignalMode comment. Toggleable live via
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
        long long totalStuckVehicles = 0; // distinct vehicles ever stuck >5s - see the integrate step's stuck-detection block
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
        // Live signal-control arbiter (see redlights.hpp) - the only thing
        // in this whole file that decides Density-mode ranking/emergency
        // preemption, and it does so purely from VehicleStopReport/
        // EmergencyReport values submitted fresh each physics tick in step 3
        // below. Declared here (outside the per-tick rep loop) so the last
        // tick's reports are still in scope for step 7's broadcast, which
        // only runs once per OUTER iteration.
        RedlightController redlights;

        // Persistent per-tick scratch buffers for the live per-chain-edge
        // congestion tracking (see RoadGraph::chainEdgeLiveSpeed's own
        // comment) - allocated ONCE here rather than freshly inside the
        // per-tick rep loop below, since that loop can run several reps per
        // outer iteration at a high speed multiplier and rg.chainEdges.size()
        // can be in the tens of thousands; std::fill-ing these each tick is
        // far cheaper than reallocating them.
        std::vector<double> chainEdgeSpeedSum(rg.chainEdges.size(), 0.0);
        std::vector<int> chainEdgeSpeedCount(rg.chainEdges.size(), 0);

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
                // Checked for EITHER edge type - a route that starts already
                // crossing a junction (its origin node IS an intersection)
                // used to skip this check entirely, which let unbounded
                // numbers of trips spawn on top of each other at any popular
                // junction-node origin (a real, observed cause of large
                // vehicle pileups, not just a rare edge case - see the map's
                // own busiest junction-adjacent depots). Junction edges have
                // no real lane concept (see desiredLaneForStep/edgeKey), so
                // the lane match is skipped there - any existing occupant of
                // that same junction edge blocks a fresh spawn onto it.
                for (auto& ov : vehicles) {
                    if (!ov.active || ov.route.empty()) continue;
                    const RouteStep& os = ov.route[ov.routeIdx];
                    if (os.isJunction != route[0].isJunction || os.edgeIndex != route[0].edgeIndex) continue;
                    if (!route[0].isJunction && ov.lane != spawnLane) continue;
                    if (ov.distAlongEdge < SPAWN_CLEARANCE_M) return false; // blocked - caller re-queues
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
                // Live-traffic rerouting - destNodeId anchors every future
                // reroute to the SAME destination. nextRerouteAt is
                // staggered per-vehicle across the FULL ~30s cadence
                // (t.id % 29, not a narrow slice of it) - too narrow a
                // stagger here (an earlier version used only an 11s spread)
                // let hundreds of concurrently-spawned vehicles all requery
                // liveWeightedRoute within the same few seconds, so they'd
                // all see the SAME congestion snapshot and could all pile
                // onto the SAME "currently least-congested" alternative at
                // once - a real, measured regression at moderate load (more
                // real distance travelled for no actual time saved, since
                // the "better" alternative promptly got swamped by everyone
                // who just reroute onto it together). A full-cadence spread
                // means only ~1/30th of active vehicles ever reroute in the
                // same tick, and that spread is preserved on every
                // subsequent cycle too (each reroute is scheduled exactly
                // 30s after the last, never resetting the phase).
                v.destNodeId = t.endNodeId;
                v.nextRerouteAt = simClock + 15.0 + (double)(t.id % 29);
                v.nextStuckRerouteAt = 0.0; // eligible for an immediate stuck-triggered reroute the very first time
                v.stoppedDurationSec = 0.0; v.stuckCounted = false;
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
            // current lane with no further changes needed - see
            // vehicles.hpp's lane-changing section for the model. Wide
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
                            double costHome = laneVisionCost(rg, idxs, vehicles, v.lane, v, vi, desiredSpeed);
                            double costOther = laneVisionCost(rg, idxs, vehicles, otherLane, v, vi, desiredSpeed);
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

            // 2.5. Live per-chain-edge congestion tracking ("the CH path is
            // a suggestion" - see vehicles.hpp's liveWeightedRoute and
            // RoadGraph::chainEdgeLiveSpeed's own comment). A simple per-tick
            // EMA toward this tick's observed average speed on each edge,
            // decaying back toward free-flow when the edge is empty so a
            // cleared jam doesn't linger in the data forever. Uses the
            // persistent chainEdgeSpeedSum/Count buffers declared before the
            // main loop rather than fresh vectors, since this runs every
            // physics tick.
            {
                std::fill(chainEdgeSpeedSum.begin(), chainEdgeSpeedSum.end(), 0.0);
                std::fill(chainEdgeSpeedCount.begin(), chainEdgeSpeedCount.end(), 0);
                for (auto& v : vehicles) {
                    if (!v.active || v.route[v.routeIdx].isJunction) continue;
                    int ei = v.route[v.routeIdx].edgeIndex;
                    chainEdgeSpeedSum[ei] += v.speed;
                    chainEdgeSpeedCount[ei]++;
                }
                const double LIVE_SPEED_EMA_ALPHA = 0.1;
                for (size_t ei = 0; ei < rg.chainEdges.size(); ++ei) {
                    double observed = chainEdgeSpeedCount[ei] > 0 ? chainEdgeSpeedSum[ei] / chainEdgeSpeedCount[ei] : rg.chainEdges[ei].freeFlowSpeedMps;
                    rg.chainEdgeLiveSpeed[ei] = (float)(rg.chainEdgeLiveSpeed[ei] * (1.0 - LIVE_SPEED_EMA_ALPHA) + observed * LIVE_SPEED_EMA_ALPHA);
                }
            }

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

            // Clears last tick's reports (see RedlightController::beginTick)
            // before this tick submits fresh ones below - both the emergency
            // scan and the density-report loop feed the SAME controller, so
            // one beginTick() covers both.
            redlights.beginTick();

            // Emergency preemption (EmergencyOnly AND Density mode - Default
            // mode has no ambulance-awareness at all, see redlights.hpp's
            // SignalMode comment): a fresh per-tick scan for any vehicle
            // with emergency==true at the front of an approach queue leading
            // into a SIGNALIZED junction, reported to `redlights` as an
            // EmergencyReport (its approach + current position - see
            // vehicles.hpp's vehicleWorldPosition) BEFORE the gating loop
            // below decides any colors, so it can short-circuit both modes'
            // ordinary logic for a preempted junction. Recomputed fresh
            // every tick (never latched, since beginTick() just cleared the
            // controller's memory of it) so preemption ends automatically
            // the instant the emergency vehicle clears the junction (its
            // routeIdx advances past it) or its flag goes back off.
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
                    VehiclePosition pos = vehicleWorldPosition(rg, fv);
                    redlights.reportEmergency(je.junctionIdx, {je.fromWayId, pos.x, pos.y});
                }
            }

            // Density mode's per-approach "red dot" weight: every vehicle
            // already marked waitingLight (see below) submits a
            // VehicleStopReport - its approach, current position, vehicle
            // type (bus/truck get RedlightController::vehiclePriorityWeight's
            // 10x/0.5x multiplier), and how long it's been waiting - to
            // `redlights`, which is the only thing that turns those reports
            // into a weight. Built from the END of LAST tick's waiting
            // state, one tick of lag behind this tick's own gate outcome
            // (decided below), same as the ordinary impatience-rank feedback
            // loop already accepted throughout this file.
            if (signalMode == SignalMode::Density) {
                for (auto& v : vehicles) {
                    if (!v.active || !v.waitingLight || v.route[v.routeIdx].isJunction) continue;
                    if (v.routeIdx + 1 >= v.route.size()) continue;
                    const RouteStep& nxt = v.route[v.routeIdx + 1];
                    if (!nxt.isJunction) continue;
                    const JunctionEdge& je = rg.junctionEdges[nxt.edgeIndex];
                    VehiclePosition pos = vehicleWorldPosition(rg, v);
                    redlights.reportStopped(je.junctionIdx, {je.fromWayId, je.movement, je.toWayId, pos.x, pos.y, v.vehicleType, v.waitStartTime}, simClock);
                }
            }

            // Candidates competing for entry into each unsignalized junction
            // this tick (one per approach-lane, i.e. per group's front
            // vehicle) - see the release loop just below for how more than
            // one of these can actually be let through together. (JctCandidate
            // itself is declared at file scope, above buildStateJson, so
            // visionGapIsSafe can take it by reference.)
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

                std::string preemptWayId;
                bool preempting = jn.signal.present && redlights.preempting(je.junctionIdx, preemptWayId);
                if (preempting) {
                    // Real preemption: this approach wins outright, every
                    // other approach at this junction forced red - not a
                    // rank bonus fed into the ordinary arbitration below.
                    fv.gate = (je.fromWayId == preemptWayId) ? 1 : 2;
                } else if (jn.signal.present && (signalMode == SignalMode::Default || signalMode == SignalMode::EmergencyOnly)) {
                    // EmergencyOnly with no active preemption at this
                    // junction (handled above) runs the EXACT SAME fixed-
                    // time math/timer as Default mode - see redlights.hpp's
                    // SignalMode comment for why that's the whole point of
                    // the mode.
                    std::string color = computeLampColor(jn.signal, rg.nodeId[jn.primaryNodeIdx], rg.redlightGroups, je.fromWayId, je.movement, simClock);
                    fv.gate = (color == "green") ? 1 : 2;
                } else {
                    if (fv.arrivalAtStopLineTime < 0) fv.arrivalAtStopLineTime = simClock;
                    // Effective rank climbs with wait time (see
                    // IMPATIENCE_SEC's own comment) so a low-class approach
                    // isn't starved forever behind a busier cross-street. A
                    // signalized junction running Density mode instead of
                    // the fixed-time branch above (see redlights.hpp's
                    // SignalMode comment) swaps in that mode's own reported
                    // "red dot" weight in place of the plain road-class
                    // rank; a genuinely unsignalized junction (any mode)
                    // always uses the plain road-class rank.
                    double waited = std::max(0.0, simClock - fv.arrivalAtStopLineTime);
                    double rank = (jn.signal.present && signalMode == SignalMode::Density)
                        ? redlights.densityWeightFor(je.junctionIdx, je.fromWayId)
                        : je.priorityRank + waited / IMPATIENCE_SEC;
                    candidatesForJunction[je.junctionIdx].push_back({frontVi, je.fromWayId, je.movement, je.toWayId,
                        je.arrDirX, je.arrDirY, je.lengthM, je.speedMps, rank, fv.arrivalAtStopLineTime});
                    fv.gate = 2; // tentatively closed, possibly flipped below
                }
            }
            // Two candidate movements at the same unsignalized junction (or a
            // signalized one under Density mode - see redlights.hpp's
            // SignalMode) can discharge in the same window - i.e. the
            // junction's effective capacity this tick, the "width of the
            // intersection" fix - when they provably don't cross paths (see
            // road_graph.hpp's movementsCompatible for the exact rule).
            // Anything else still serializes - flow-channel fidelity, not
            // full conflict-point geometry; relaxing only the provably-safe
            // cases widens real bottlenecks without inventing new
            // mid-junction collisions.
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
                    // The class-based table above said no - ask whether a
                    // real look at everyone's actual position and closing
                    // speed says it's genuinely safe anyway (see
                    // visionGapIsSafe's own comment). Can only ADMIT a
                    // crossing the table alone would have refused, never the
                    // reverse - strictly additive to the existing baseline.
                    if (!ok) ok = visionGapIsSafe(rg, vehicles, groups, jn, *c, accepted);
                    if (!ok) continue;
                    accepted.push_back(c);
                    vehicles[c->vi].gate = 1;
                    jn.inFlight.push_back({simClock + c->lengthM / std::max(0.1, c->speedMps) + MIN_DISCHARGE_GAP_SEC,
                                            c->fromWayId, c->movement, c->toWayId, c->arrDirX, c->arrDirY});
                }
            }

            // Density mode's "waiting for the light" red-dot state (see
            // vehicles.hpp's Vehicle::waitingLight/waitStartTime): a
            // follower is marked waiting purely from sharing its front
            // vehicle's now-finalized gate (only front vehicles are ever
            // gated directly - see above; followers queue up behind them via
            // ordinary IDM car-following), which is exactly what makes the
            // red dot "chain" backward through a queue as it forms. Feeds
            // NEXT tick's VehicleStopReport submissions above, and is
            // streamed to the frontend as-is (see buildStateJson's per-
            // vehicle "wt" field).
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

            // Merge-point awareness: if more than one current-edge group's
            // front vehicle targets the SAME next-edge lane this tick (two
            // lanes of one approach reconverging after a junction, or two
            // junction movements sharing one destination lane), collect them
            // here so step 4 below can gap them against EACH OTHER, not only
            // against whatever already happens to occupy that lane. Without
            // this, simultaneous convergers have no mutual awareness at all -
            // each only checks the lane's pre-existing occupant (or nothing,
            // if it's currently empty) - and can advance onto the same spot
            // at the same time, which is exactly the vehicle-overlap seen at
            // narrow merge points right after a junction. Excludes vehicles
            // currently held at a red/lost-arbitration stop line (gate==2 -
            // they aren't going anywhere near the merge point this tick).
            std::unordered_map<uint64_t, std::vector<int>> mergeApproachers;
            for (auto& [k, idxs] : groups) {
                if (idxs.empty()) continue;
                Vehicle& fv = vehicles[idxs.back()];
                if (fv.gate == 2 || fv.routeIdx + 1 >= fv.route.size()) continue;
                const RouteStep& nxt = fv.route[fv.routeIdx + 1];
                int nxtLane = desiredLaneForStep(rg, fv.route, fv.routeIdx + 1);
                mergeApproachers[edgeKey(nxt, nxtLane)].push_back(idxs.back());
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
                            uint64_t nextKey = edgeKey(nxt, nxtLane);
                            // Unify "the real vehicle already on the next
                            // edge/lane" and "every OTHER group's own front
                            // vehicle also about to enter that SAME lane this
                            // tick" (see mergeApproachers above) onto one
                            // number line: 0 = the shared entry point,
                            // negative = still short of it (still on the
                            // current edge), positive = already past it. The
                            // nearest entity strictly ahead on that line is
                            // this vehicle's real leader for gap purposes.
                            double myPos = -(cur.length - v.distAlongEdge);
                            bool foundLeader = false;
                            double bestPos = 0, bestLen = 0, bestSpeed = 0;
                            auto git = groups.find(nextKey);
                            if (git != groups.end() && !git->second.empty()) {
                                Vehicle& rv = vehicles[git->second.front()];
                                bestPos = rv.distAlongEdge; bestLen = rv.length; bestSpeed = rv.speed;
                                foundLeader = true;
                            }
                            auto mit = mergeApproachers.find(nextKey);
                            if (mit != mergeApproachers.end()) {
                                for (int otherVi : mit->second) {
                                    if (otherVi == idxs[pos]) continue;
                                    Vehicle& ov = vehicles[otherVi];
                                    const RouteStep& ocur = ov.route[ov.routeIdx];
                                    double otherPos = -(ocur.length - ov.distAlongEdge);
                                    if (otherPos <= myPos) continue; // not ahead of us toward the merge point
                                    if (!foundLeader || otherPos < bestPos) {
                                        bestPos = otherPos; bestLen = ov.length; bestSpeed = ov.speed;
                                        foundLeader = true;
                                    }
                                }
                            }
                            if (foundLeader) {
                                leaderGap = (bestPos - bestLen) - myPos;
                                leaderSpeed = bestSpeed; hasLeader = true;
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

                // Stuck-vehicle tracking (>5s below near-zero speed) - see
                // Vehicle::stoppedDurationSec/stuckCounted's own comment and
                // buildStateJson's "stk"/stuckNow/stuckTotal reporting.
                // stuckCounted latches so totalStuckVehicles counts distinct
                // vehicles, not repeated stop/go episodes at the same light.
                // The first time a vehicle crosses the threshold, it's also
                // made eligible for an immediate reroute attempt below (step
                // 5.6) rather than waiting for its regular ~30s cadence -
                // "re-evaluate the path when getting stuck", throttled by its
                // own nextStuckRerouteAt so a vehicle stuck with genuinely no
                // better alternative doesn't retry every single tick.
                if (v.speed < 0.5) {
                    v.stoppedDurationSec += dt;
                    if (!v.stuckCounted && v.stoppedDurationSec > 5.0) {
                        v.stuckCounted = true;
                        totalStuckVehicles++;
                        if (simClock >= v.nextStuckRerouteAt) {
                            v.nextRerouteAt = std::min(v.nextRerouteAt, simClock);
                            v.nextStuckRerouteAt = simClock + 15.0;
                        }
                    }
                } else {
                    v.stoppedDurationSec = 0.0;
                }

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
                                     computeLampColor(jn2.signal, rg.nodeId[jn2.primaryNodeIdx], rg.redlightGroups, je2.fromWayId, je2.movement, simClock) == "green";
                        }
                        if (gateOk) {
                            // A granted movement only means arbitration
                            // considers this approach clear to enter - it
                            // says nothing about whether the junction edge
                            // ITSELF still has room. Vehicles from the SAME
                            // approach are always "compatible" with each
                            // other (movementsCompatible's rule 1), so
                            // nothing else here limits how many can be
                            // in-flight together on what's sometimes a very
                            // short crossing - without this, a short junction
                            // edge could keep accepting same-approach
                            // vehicles faster than the far end can drain
                            // them, stacking several on top of each other
                            // with no physical room to space out. Same
                            // treatment as the chain-to-chain check below.
                            auto git = groups.find(edgeKey(nxt, 0));
                            if (git != groups.end() && !git->second.empty()) {
                                Vehicle& rv = vehicles[git->second.front()];
                                if (rv.distAlongEdge - rv.length < v.length + v.minGap) gateOk = false;
                            }
                        }
                        if (!gateOk) { v.distAlongEdge = cur.length; break; }
                    } else {
                        // Hard capacity check for an ordinary chain-to-chain
                        // transition. Step 4's IDM lookahead already tries to
                        // decelerate a vehicle toward a stop when the next
                        // lane is already occupied, but that's advisory only
                        // - nothing previously stopped a vehicle with enough
                        // residual speed (or simply a slightly-too-small
                        // computed gap) from crossing into an already-packed
                        // lane anyway, once distAlongEdge reached cur.length.
                        // Repeated many times under sustained heavy load,
                        // that let vehicles silently stack far closer than
                        // any real gap - the severe same-point overlap seen
                        // on this map's busiest chain edges. A junction's red
                        // light already hard-blocks entry the same way (see
                        // gateOk above); a plain lane deserves the same floor
                        // instead of relying on braking alone to always be
                        // enough.
                        int nxtLane = desiredLaneForStep(rg, v.route, v.routeIdx + 1);
                        auto git = groups.find(edgeKey(nxt, nxtLane));
                        if (git != groups.end() && !git->second.empty()) {
                            Vehicle& rv = vehicles[git->second.front()];
                            if (rv.distAlongEdge - rv.length < v.length + v.minGap) {
                                v.distAlongEdge = cur.length;
                                break;
                            }
                        }
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

            // 5.6. Live-traffic rerouting ("the CH path is a suggestion, not
            // gospel" - see vehicles.hpp's liveWeightedRoute and
            // Vehicle::destNodeId/nextRerouteAt's own comment). Only
            // reconsiders a vehicle's PATH from wherever it currently is
            // toward the SAME destination it was already spawned for - never
            // invents a new trip, never touches an emergency-dispatch
            // vehicle's own route (that mechanism already owns its route for
            // the duration of a response - see handleCommand's
            // triggerEmergency). Only reroutes from a chain edge (mirrors
            // triggerEmergency's own constraint) - mid-junction is not a
            // sensible place to splice a new path. Staggered per-vehicle via
            // nextRerouteAt (and, on a fresh stuck episode, brought forward
            // to right now - see step 5's stuck-detection block) so the
            // whole fleet doesn't hit liveWeightedRoute's Dijkstra in the
            // same tick.
            // A real, not just nonzero-better, improvement is required before
            // actually swapping (see REROUTE_IMPROVEMENT_FACTOR) - a live-
            // weighted "alternative" that's only marginally cheaper is often
            // just measurement noise (a single momentarily-stopped vehicle
            // on a short edge swings its live speed hard), and unconditionally
            // chasing every marginal gain is exactly what caused hundreds of
            // vehicles to simultaneously pile onto the SAME "currently best"
            // alternative at once - a real, measured regression at moderate
            // load (net LOSS: more real distance for no actual time saved,
            // since the alternative promptly got swamped by everyone who
            // just rerouted onto it together). Requiring a clear margin means
            // only vehicles with a genuinely worthwhile detour take it.
            const double REROUTE_IMPROVEMENT_FACTOR = 0.85; // must be >=15% cheaper to bother
            for (auto& v : vehicles) {
                if (!v.active || v.emergency) continue;
                if (v.route[v.routeIdx].isJunction) continue;
                if (v.routeIdx + 1 >= v.route.size()) continue;
                if (simClock < v.nextRerouteAt) continue;
                v.nextRerouteAt = simClock + 30.0;
                std::string fromNodeId = rg.nodeId[stepToNode(rg, v.route[v.routeIdx])];
                if (fromNodeId == v.destNodeId) continue;
                double currentCost = liveWeightedRemainingCost(rg, v.route, v.routeIdx + 1);
                std::string err;
                double newCost = 0.0;
                std::vector<RouteStep> newRoute = liveWeightedRoute(rg, fromNodeId, v.destNodeId, err, &newCost);
                if (newRoute.empty()) continue; // keep the existing route rather than strand the vehicle
                if (newCost >= currentCost * REROUTE_IMPROVEMENT_FACTOR) continue; // not worth the churn
                v.route.resize(v.routeIdx + 1);
                v.route.insert(v.route.end(), newRoute.begin(), newRoute.end());
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
                                                 redlights, completedByType, emergencyStats, totalStuckVehicles));
                double elapsed = std::chrono::duration<double>(Clock::now() - tickWallStart).count();
                if (elapsed < dt) std::this_thread::sleep_for(std::chrono::duration<double>(dt - elapsed));
            }
        }
        // One extra broadcast, explicitly marked final:true, right before the
        // engine actually stops - covers BOTH a natural end (simClock reached
        // simSeconds, or allDone) and a manual Stop, so sim-client.js's
        // end-of-run popup (see showSimStatsModal) reliably fires either way
        // instead of only when someone happened to click Stop.
        if (!headless) {
            server.broadcast(buildStateJson(simClock, vehicles, rg, totalSpawned, totalCompleted, trips.size(), signalMode,
                                             redlights, completedByType, emergencyStats, totalStuckVehicles, /*isFinal=*/true));
        }
        if (!headless) std::cerr << "[sim] stopping (t=" << simClock << "s, stopRequested=" << stopRequested << ")\n";

        std::cerr << "\n[sim] FINAL SUMMARY at t=" << std::fixed << std::setprecision(1) << simClock << "s\n";
        std::cerr << "  trips in manifest: " << trips.size() << ", spawned: " << totalSpawned
                  << ", completed: " << totalCompleted << ", failed-to-route: " << totalFailedRoute
                  << ", still active: " << activeCount << "\n";
        {
            long long stuckNowFinal = 0;
            for (auto& v : vehicles) if (v.active && v.stoppedDurationSec > 5.0) stuckNowFinal++;
            std::cerr << "  stuck vehicles: " << totalStuckVehicles << " ever stuck >5s during the run, "
                      << stuckNowFinal << " stuck right now\n";
        }
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
