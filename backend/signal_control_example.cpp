// signal_control_example.cpp
//
// Minimal, dependency-free example of a C++ program taking control of a
// traffic light intersection over serve.py's HTTP API (see
// backend/signal_control.py for the same thing in Python, and its module
// docstring for the full endpoint contract - including what the "8 lamps"
// mentioned below are). Talks plain HTTP/1.1 over a raw Winsock TCP socket
// to 127.0.0.1:8765 - no libcurl/boost/nlohmann-json dependency, so it
// builds with the same bare `g++` this project already uses for
// backend/ch/ch_preprocess.cpp and ch_query.cpp.
//
// Build (from a shell where g++ is on PATH, e.g. MSYS2 UCRT64):
//     g++ -O2 -std=c++17 -o signal_control_example.exe signal_control_example.cpp -lws2_32
// Run (with `python serve.py` already running in another window):
//     signal_control_example.exe <nodeId> <lamps...> [--seconds=N]
// nodeId is whatever id the intersection already has in map_data.json -
// click it in the editor or simulation viewer and its id is shown in the
// inspector panel's title; the "Traffic light - external control" panel
// there also lists each of its up to 8 lamps by wayId + movement. Each
// <lamps> argument is one STEP of the hold, spending --seconds on it before
// moving to the next (or releasing, on the last one) WITHOUT ever letting
// go of control in between (see overrideRequest below - the same override
// token is resent every time, which serve.py treats as updating the
// existing hold rather than a new one, so the intersection's phase clock
// stays frozen continuously across every switch). A step is a
// comma-separated list of lamps, each either a bare wayId (both its
// through+right lamps) or wayId:through / wayId:right (just that one lamp):
//     signal_control_example.exe n4821 w1188 w2054 --seconds=10
//     signal_control_example.exe n4821 w1188:right --seconds=5
//     signal_control_example.exe n4821 w1188:through,w2054:through --seconds=15
//
// JSON here is hand-built for these known-shape request bodies only - this
// is NOT a general JSON writer/parser. Response bodies are scanned with a
// plain substring search for "ok":true and a "token":"..." value, which is
// good enough for this server's own fixed response shape, but would not be
// a safe way to parse arbitrary JSON.

#include <winsock2.h>
#include <ws2tcpip.h>
#include <chrono>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "ws2_32.lib")

namespace {

struct Lamp {
    std::string wayId;
    std::string movement;  // "through" or "right"
};

std::string httpPost(const std::string& host, int port, const std::string& path, const std::string& jsonBody) {
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) throw std::runtime_error("WSAStartup failed");

    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) { WSACleanup(); throw std::runtime_error("socket() failed"); }

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<u_short>(port));
    inet_pton(AF_INET, host.c_str(), &addr.sin_addr);

    if (connect(sock, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        closesocket(sock);
        WSACleanup();
        throw std::runtime_error("connect() failed - is `python serve.py` running on " + host + ":" + std::to_string(port) + "?");
    }

    std::ostringstream req;
    req << "POST " << path << " HTTP/1.1\r\n"
        << "Host: " << host << "\r\n"
        << "Content-Type: application/json\r\n"
        << "Content-Length: " << jsonBody.size() << "\r\n"
        << "Connection: close\r\n\r\n"
        << jsonBody;
    const std::string reqStr = req.str();
    send(sock, reqStr.c_str(), static_cast<int>(reqStr.size()), 0);

    std::string response;
    char buf[4096];
    int n;
    while ((n = recv(sock, buf, sizeof(buf), 0)) > 0) response.append(buf, static_cast<size_t>(n));

    closesocket(sock);
    WSACleanup();

    // Strip the HTTP status/header block; only the JSON body matters here.
    const auto bodyStart = response.find("\r\n\r\n");
    return bodyStart == std::string::npos ? response : response.substr(bodyStart + 4);
}

// Hand-rolled: escapes only what these known string values can contain
// (quote/backslash) - not a general JSON encoder.
std::string jsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        if (c == '"' || c == '\\') out += '\\';
        out += c;
    }
    return out;
}

std::string extractField(const std::string& body, const std::string& key) {
    auto pos = body.find("\"" + key + "\"");
    if (pos == std::string::npos) return "";
    pos = body.find(':', pos);
    if (pos == std::string::npos) return "";
    pos = body.find('"', pos);
    if (pos == std::string::npos) return "";
    const auto end = body.find('"', pos + 1);
    if (end == std::string::npos) return "";
    return body.substr(pos + 1, end - pos - 1);
}

bool bodySaysOk(const std::string& body) {
    return body.find("\"ok\":true") != std::string::npos || body.find("\"ok\": true") != std::string::npos;
}

// "w1188" -> both its lamps; "w1188:right" -> just that one. One STEP
// argument can list several lamps separated by commas (a whole custom
// phase), e.g. "w1188:through,w2054:through".
std::vector<Lamp> parseStep(const std::string& step) {
    std::vector<Lamp> lamps;
    std::stringstream ss(step);
    std::string item;
    while (std::getline(ss, item, ',')) {
        const auto colon = item.find(':');
        if (colon == std::string::npos) {
            lamps.push_back({item, "through"});
            lamps.push_back({item, "right"});
        } else {
            const std::string wayId = item.substr(0, colon);
            const std::string movement = item.substr(colon + 1);
            if (movement != "through" && movement != "right") {
                throw std::runtime_error("invalid movement '" + movement + "' in '" + item + "' - use 'through' or 'right'");
            }
            lamps.push_back({wayId, movement});
        }
    }
    return lamps;
}

// Takes control of `nodeId` (or, given an already-held `token`, switches
// which lamps that same hold forces green) - forces every lamp in `lamps`
// green and every other lamp at this node red (an empty list forces
// everything red). An empty `token` asks the server for a brand new hold; a
// non-empty one re-asserts this program's existing hold, which serve.py
// accepts as an update (not a conflict) rather than a fresh override - see
// the "since" comment in serve.py's /api/signal/override handler.
std::string overrideRequest(const std::string& host, int port, const std::string& nodeId,
                             const std::vector<Lamp>& lamps, const std::string& token) {
    std::ostringstream lampsJson;
    lampsJson << "[";
    for (size_t i = 0; i < lamps.size(); ++i) {
        if (i) lampsJson << ",";
        lampsJson << "{\"wayId\":\"" << jsonEscape(lamps[i].wayId) << "\","
                  << "\"movement\":\"" << jsonEscape(lamps[i].movement) << "\"}";
    }
    lampsJson << "]";

    std::ostringstream body;
    body << "{\"nodeId\":\"" << jsonEscape(nodeId) << "\","
         << "\"greenLamps\":" << lampsJson.str() << ","
         << "\"controller\":\"cpp-example\","
         << "\"token\":" << (token.empty() ? "null" : "\"" + jsonEscape(token) + "\"") << "}";
    const std::string resp = httpPost(host, port, "/api/signal/override", body.str());
    if (!bodySaysOk(resp)) throw std::runtime_error("override request failed: " + resp);
    return extractField(resp, "token");
}

std::string describeStep(const std::vector<Lamp>& lamps) {
    if (lamps.empty()) return "none - all red";
    std::string out;
    for (size_t i = 0; i < lamps.size(); ++i) {
        if (i) out += ", ";
        out += lamps[i].wayId + ":" + lamps[i].movement;
    }
    return out;
}

}  // namespace

int main(int argc, char** argv) {
    std::vector<std::string> args(argv + 1, argv + argc);
    int holdSeconds = 10;
    std::vector<std::string> positional;
    for (const auto& a : args) {
        if (a.rfind("--seconds=", 0) == 0) holdSeconds = std::stoi(a.substr(10));
        else positional.push_back(a);
    }
    if (positional.empty()) {
        std::cerr << "usage: " << argv[0] << " <nodeId> [<step1> <step2> ...] [--seconds=N]\n"
                  << "  Each step is a comma-separated list of lamps (bare wayId = both its\n"
                  << "  lamps, wayId:through / wayId:right = just one) - holds the first step,\n"
                  << "  then switches to each further one in turn (without ever releasing\n"
                  << "  control), spending --seconds on each. No steps at all forces all-red.\n";
        return 1;
    }
    const std::string nodeId = positional[0];
    std::vector<std::vector<Lamp>> steps;
    for (size_t i = 1; i < positional.size(); ++i) steps.push_back(parseStep(positional[i]));
    if (steps.empty()) steps.push_back({});  // no steps given -> one all-red hold
    const std::string host = "127.0.0.1";
    const int port = 8765;

    try {
        std::cout << "Taking control of " << nodeId << " (green: " << describeStep(steps[0]) << ") ...\n";
        std::string token = overrideRequest(host, port, nodeId, steps[0], "");
        std::cout << "In control (token " << token << "). Holding for " << holdSeconds
                  << "s - open the simulation viewer to watch it live.\n";
        std::this_thread::sleep_for(std::chrono::seconds(holdSeconds));

        for (size_t i = 1; i < steps.size(); ++i) {
            std::cout << "Switching to " << describeStep(steps[i]) << " (control never released) ...\n";
            overrideRequest(host, port, nodeId, steps[i], token);
            std::this_thread::sleep_for(std::chrono::seconds(holdSeconds));
        }

        std::ostringstream releaseBody;
        releaseBody << "{\"nodeId\":\"" << jsonEscape(nodeId) << "\","
                    << "\"token\":\"" << jsonEscape(token) << "\"}";
        httpPost(host, port, "/api/signal/release", releaseBody.str());
        std::cout << "Released.\n";
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << "\n";
        return 1;
    }
    return 0;
}
