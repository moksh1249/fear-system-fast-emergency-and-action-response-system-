// signal_control_example.cpp
//
// Minimal, dependency-free example of a C++ program taking control of a
// traffic light intersection over serve.py's HTTP API (see
// backend/signal_control.py for the same thing in Python, and its module
// docstring for the full endpoint contract). Talks plain HTTP/1.1 over a raw
// Winsock TCP socket to 127.0.0.1:8765 - no libcurl/boost/nlohmann-json
// dependency, so it builds with the same bare `g++` this project already
// uses for backend/ch/ch_preprocess.cpp and ch_query.cpp.
//
// Build (from a shell where g++ is on PATH, e.g. MSYS2 UCRT64):
//     g++ -O2 -std=c++17 -o signal_control_example.exe signal_control_example.cpp -lws2_32
// Run (with `python serve.py` already running in another window):
//     signal_control_example.exe <nodeId> <wayId> [holdSeconds=10]
// nodeId/wayId are whatever ids the intersection/road already have in
// map_data.json - click the intersection in the editor or simulation viewer
// and its id is shown in the inspector panel's title.
//
// JSON here is hand-built for these two known-shape request bodies only -
// this is NOT a general JSON writer/parser. Response bodies are scanned
// with a plain substring search for "ok":true and a "token":"..." value,
// which is good enough for this server's own fixed response shape, but
// would not be a safe way to parse arbitrary JSON.

#include <winsock2.h>
#include <ws2tcpip.h>
#include <chrono>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>

#pragma comment(lib, "ws2_32.lib")

namespace {

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

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: " << argv[0] << " <nodeId> <wayId> [holdSeconds=10]\n";
        return 1;
    }
    const std::string nodeId = argv[1];
    const std::string wayId = argv[2];
    const int holdSeconds = argc > 3 ? std::stoi(argv[3]) : 10;
    const std::string host = "127.0.0.1";
    const int port = 8765;

    try {
        std::ostringstream overrideBody;
        overrideBody << "{\"nodeId\":\"" << jsonEscape(nodeId) << "\","
                     << "\"wayId\":\"" << jsonEscape(wayId) << "\","
                     << "\"controller\":\"cpp-example\"}";

        std::cout << "Taking control of " << nodeId << " (green: " << wayId << ") ...\n";
        const std::string overrideResp = httpPost(host, port, "/api/signal/override", overrideBody.str());
        if (!bodySaysOk(overrideResp)) {
            std::cerr << "override failed: " << overrideResp << "\n";
            return 1;
        }
        const std::string token = extractField(overrideResp, "token");
        std::cout << "In control (token " << token << "). Holding for " << holdSeconds
                  << "s - open the simulation viewer to watch it live.\n";

        std::this_thread::sleep_for(std::chrono::seconds(holdSeconds));

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
