"""  """"""
Serves front-end/ over http:// so the map editor (index.html) can fetch
map_data.json (browsers block fetch() of local files opened via file://),
and accepts POST /api/save from the editor's Save button to write the
current map straight back into map_data.json on disk.

Also exposes /api/signal/override, /api/signal/release and
/api/signal/overrides - a tiny JSON API any external Python or C++ script
can use to take control of a traffic light intersection while this server
is running (see the SIGNAL_OVERRIDES comment below for the full contract,
and backend/signal_control.py / backend/signal_control_example.cpp for
ready-to-run clients).

Run:
    python serve.py
Then open the printed URL in a browser.
"""

import base64
import binascii
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import threading
import time
import uuid
import webbrowser

PORT = 8765
HERE = os.path.dirname(os.path.abspath(__file__))

# Project layout (post-reorg): serve.py stays at the project root; everything
# else lives under one of these three directories.
FRONTEND_DIR = os.path.join(HERE, "front-end")   # servable app: html/js/css + the LIVE map_data.json
BACKEND_DIR = os.path.join(HERE, "backend")       # processing/build tooling (osm_to_json.py, add_buildings.py, ch/)
MAPS_DIR = os.path.join(HERE, "maps")             # map data assets: source .osm, CH bin/meta output, timestamped backups

MAP_DATA_PATH = os.path.join(FRONTEND_DIR, "map_data.json")

# Amenity icon images uploaded from the editor's Icon section land here, under
# a server-generated filename (never the client-supplied one - see
# /api/upload-icon below). icons/ sits at the project root (a sibling of
# front-end/, not inside it), so it's served via Handler.translate_path's
# special case below rather than the default cwd-relative static serving.
ICONS_DIR = os.path.join(HERE, "icons")
ICON_EXT_WHITELIST = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
ICON_MAX_BYTES = 3 * 1024 * 1024

# Contraction Hierarchy preprocessor (backend/ch/ch_preprocess.cpp). It reads
# map_data.json and writes map_data.ch.bin + map_data.ch.meta.json next to
# it (hardcoded in ch_preprocess.cpp's own argv handling) - i.e. next to
# MAP_DATA_PATH, in front-end/. This app wants that generated pair to live
# in maps/ instead (alongside the other map-data assets, not the served
# app files), so run_ch_preprocess() moves them there right after each run;
# CH_BIN_PATH/CH_META_PATH below are that final, maps/-rooted location, which
# is what the rest of this file (and ch_query.exe) actually reads from. The
# algorithm itself lives only in C++ (never reimplemented in Python/JS); this
# file just (re)compiles it and runs it. Recalculation is manual (the
# "Recalculate CH" sidebar button / POST /api/recalc-ch below) rather than
# automatic on every save, since a save can happen much more often than the
# routing graph actually needs to be refreshed.
CH_DIR = os.path.join(BACKEND_DIR, "ch")
CH_SRC = os.path.join(CH_DIR, "ch_preprocess.cpp")
CH_EXE = os.path.join(CH_DIR, "ch_preprocess.exe" if os.name == "nt" else "ch_preprocess")
CH_RAW_OUTPUT_BIN = os.path.join(FRONTEND_DIR, "map_data.ch.bin")
CH_RAW_OUTPUT_META = os.path.join(FRONTEND_DIR, "map_data.ch.meta.json")
CH_BIN_PATH = os.path.join(MAPS_DIR, "map_data.ch.bin")
CH_META_PATH = os.path.join(MAPS_DIR, "map_data.ch.meta.json")

# ch/ch_query.cpp - the permanent bidirectional-Dijkstra/CH point-to-point
# query engine. Reads map_data.ch.bin (never map_data.json) and answers a
# single start/end query. Compiled on demand the same way as ch_preprocess.
CH_QUERY_SRC = os.path.join(CH_DIR, "ch_query.cpp")
CH_QUERY_EXE = os.path.join(CH_DIR, "ch_query.exe" if os.name == "nt" else "ch_query")

# ============================================================
# EXTERNAL SIGNAL CONTROL - lets any process (a Python or C++ script, see
# backend/signal_control.py and backend/signal_control_example.cpp, or the
# "Test override" button in the simulation viewer's own inspector) take
# control of a traffic light intersection over plain HTTP.
#
# This is a dumb in-memory registry, nothing more: it doesn't know about the
# map's actual topology (nodes/ways), doesn't validate that a wayId is a real
# approach at that node, and doesn't persist across a server restart. All the
# real meaning - forcing one approach green and every other red, freezing
# that intersection's phase clock while held, resuming it on release - lives
# entirely in the front-end (see front-end/redlight.js's "External control"
# section), which polls GET /api/signal/overrides and reacts to whatever's
# here. An unrecognized nodeId/wayId is simply ignored client-side (or, for a
# wayId that doesn't match any real approach, every lamp at that
# intersection shows red) - a safe, fail-red default rather than a crash.
#
# SIGNAL_OVERRIDES: nodeId -> {"wayId": str|None, "controller": str,
#                               "token": str, "since": float (unix time)}
# wayId=None means "force every approach at this intersection red" (a full
# stop / emergency-preemption style hold) rather than picking one green.
# ============================================================
SIGNAL_OVERRIDES = {}
_signal_lock = threading.Lock()


def _ch_log(msg):
    print(f"[ch] {msg}", flush=True)


def ensure_ch_binary():
    """(Re)compiles ch_preprocess.cpp with g++ if the binary is missing or
    older than its source. Returns True if a usable binary is ready.

    -static matters: without it, the compiled .exe dynamically links against
    the compiler's own runtime DLLs (libstdc++-6.dll etc.), findable only via
    PATH - which works fine when you run the .exe directly from the same
    shell g++ was found in, but not when THIS process later runs it via
    subprocess.run() from a plain double-clicked/task-launched Python (a
    different process environment) - it then fails immediately with no
    stdout/stderr, just a nonzero exit code. Static linking removes the
    dependency on the runtime DLLs being reachable at all."""
    if not os.path.exists(CH_SRC):
        return False
    if os.path.exists(CH_EXE) and os.path.getmtime(CH_EXE) >= os.path.getmtime(CH_SRC):
        return True

    gxx = shutil.which("g++")
    if not gxx:
        _ch_log("g++ not found on PATH - skipping contraction hierarchy build "
                 "(install a C++ toolchain, e.g. MSYS2 UCRT64, to enable it)")
        return False

    _ch_log("compiling ch_preprocess.cpp ...")
    result = subprocess.run(
        [gxx, "-O2", "-std=c++17", "-static", "-o", CH_EXE, CH_SRC],
        cwd=CH_DIR, capture_output=True, text=True,
    )
    if result.returncode != 0:
        _ch_log("g++ build FAILED:")
        sys.stderr.write(result.stderr)
        return False
    _ch_log(f"built {CH_EXE}")
    return True


def run_ch_preprocess():
    """Runs the compiled CH tool against the current map_data.json (blocking).
    Never raises - a failed/skipped build just means routing data goes stale,
    it must not take the save/server down."""
    try:
        if not os.path.exists(MAP_DATA_PATH):
            return
        if not ensure_ch_binary():
            return
        result = subprocess.run(
            [CH_EXE, MAP_DATA_PATH], cwd=CH_DIR, capture_output=True, text=True,
        )
        for line in result.stdout.splitlines():
            print(line, flush=True)
        if result.returncode != 0:
            _ch_log(f"FAILED (exit {result.returncode})")
            if result.stderr:
                sys.stderr.write(result.stderr)
            return
        # ch_preprocess.exe always writes next to its input (front-end/) -
        # relocate the pair into maps/, this app's actual read location for
        # them (see the CH_BIN_PATH/CH_META_PATH comment above).
        os.makedirs(MAPS_DIR, exist_ok=True)
        if os.path.exists(CH_RAW_OUTPUT_BIN):
            os.replace(CH_RAW_OUTPUT_BIN, CH_BIN_PATH)
        if os.path.exists(CH_RAW_OUTPUT_META):
            os.replace(CH_RAW_OUTPUT_META, CH_META_PATH)
    except Exception as e:
        _ch_log(f"ERROR: {e}")


def ensure_ch_query_binary():
    """Same on-demand compile pattern as ensure_ch_binary() (including the
    -static reasoning documented there), for ch_query.cpp."""
    if not os.path.exists(CH_QUERY_SRC):
        return False
    if os.path.exists(CH_QUERY_EXE) and os.path.getmtime(CH_QUERY_EXE) >= os.path.getmtime(CH_QUERY_SRC):
        return True

    gxx = shutil.which("g++")
    if not gxx:
        _ch_log("g++ not found on PATH - skipping ch_query build")
        return False

    _ch_log("compiling ch_query.cpp ...")
    result = subprocess.run(
        [gxx, "-O2", "-std=c++17", "-static", "-o", CH_QUERY_EXE, CH_QUERY_SRC],
        cwd=CH_DIR, capture_output=True, text=True,
    )
    if result.returncode != 0:
        _ch_log("g++ build FAILED:")
        sys.stderr.write(result.stderr)
        return False
    _ch_log(f"built {CH_QUERY_EXE}")
    return True


class Handler(http.server.SimpleHTTPRequestHandler):
    # Browsers cache static files aggressively by default, which makes it
    # easy to keep looking at a stale editor.js/redlight.js after they've
    # been edited (a plain refresh doesn't always re-fetch). This is a local
    # dev server for actively-edited source, not a CDN, so disable caching
    # entirely - every GET always re-fetches the current file from disk.
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def translate_path(self, path):
        # Every static file this app serves (editor.html, map-core.js,
        # map_data.json, ...) lives in front-end/, which main() chdir()s into
        # before serve_forever() - so the default SimpleHTTPRequestHandler
        # behavior (resolve relative to cwd) already covers all of it. The
        # one exception is /icons/... (uploaded amenity icons, referenced by
        # relative "icons/xxx.png" src from editor.html/simulation.html - see
        # /api/upload-icon below): that directory lives at the project root,
        # a sibling of front-end/ rather than inside it, so it needs its own
        # base directory instead of the cwd-relative default.
        url_path = path.split("?", 1)[0].split("#", 1)[0]
        if url_path == "/icons" or url_path.startswith("/icons/"):
            stripped = path[len("/icons"):] or "/"
            saved_directory = self.directory
            self.directory = ICONS_DIR
            try:
                return super().translate_path(stripped)
            finally:
                self.directory = saved_directory
        return super().translate_path(path)

    def do_GET(self):
        if self.path == "/api/signal/overrides":
            with _signal_lock:
                overrides = {
                    node_id: {"wayId": v["wayId"], "controller": v["controller"], "since": v["since"]}
                    for node_id, v in SIGNAL_OVERRIDES.items()
                }
            self._send_json(200, {"ok": True, "overrides": overrides})
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/signal/override":
            # See the SIGNAL_OVERRIDES comment above for the full contract.
            try:
                length = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(length)
                body = json.loads(raw)
                node_id = str(body.get("nodeId", "")).strip()
                if not node_id:
                    raise ValueError("missing nodeId")
                way_id_raw = body.get("wayId")
                way_id = str(way_id_raw).strip() if way_id_raw not in (None, "") else None
                controller = str(body.get("controller") or "unknown").strip()[:200]
                force = bool(body.get("force"))
                token = str(body.get("token") or "").strip() or uuid.uuid4().hex

                with _signal_lock:
                    existing = SIGNAL_OVERRIDES.get(node_id)
                    if existing and existing["token"] != token and not force:
                        self._send_json(409, {
                            "ok": False,
                            "error": f"'{node_id}' is already under external control (by {existing['controller']!r}) - pass force:true to steal it",
                        })
                        return
                    SIGNAL_OVERRIDES[node_id] = {
                        "wayId": way_id, "controller": controller, "token": token, "since": time.time(),
                    }
                self._send_json(200, {"ok": True, "token": token})
            except Exception as e:
                self._send_json(400, {"ok": False, "error": str(e)})
            return

        if self.path == "/api/signal/release":
            try:
                length = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(length)
                body = json.loads(raw)
                node_id = str(body.get("nodeId", "")).strip()
                token = str(body.get("token") or "").strip()
                force = bool(body.get("force"))
                with _signal_lock:
                    existing = SIGNAL_OVERRIDES.get(node_id)
                    if existing and (force or existing["token"] == token):
                        del SIGNAL_OVERRIDES[node_id]
                self._send_json(200, {"ok": True})
            except Exception as e:
                self._send_json(400, {"ok": False, "error": str(e)})
            return

        if self.path == "/api/signal/release-all":
            # Admin/testing convenience (wired to no UI by default beyond the
            # per-row "Release" buttons, which force-release one at a time) -
            # clears every held override in one call, e.g. after a test
            # script crashed without releasing.
            with _signal_lock:
                SIGNAL_OVERRIDES.clear()
            self._send_json(200, {"ok": True})
            return

        if self.path == "/api/shutdown":
            self._send_json(200, {"ok": True})
            # Run in a separate thread: shutdown() blocks until serve_forever's
            # loop exits, which can't happen from this same request-handling thread.
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return

        if self.path == "/api/recalc-ch":
            # Manual trigger for the "Recalculate CH" sidebar button. Runs
            # synchronously (unlike the old auto-trigger) so the response
            # reflects a finished build, and the button can show real stats.
            try:
                run_ch_preprocess()
                meta = {}
                if os.path.exists(CH_META_PATH):
                    with open(CH_META_PATH, encoding="utf-8") as f:
                        meta = json.load(f)
                self._send_json(200, {"ok": True, "meta": meta})
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return

        # ============================================================
        # ROUTING - point-to-point shortest path via ch_query.exe.
        # `start`/`end` in the request body are each either a plain existing
        # node id string (unchanged since this endpoint was written), or, for
        # a point clicked mid-road, an object
        #   {nodeA, nodeB, distToA, distToB, directions}
        # built client-side (see routetest.js) - encoded here as a single
        # "V:nodeA:nodeB:distToA:distToB:directions" argv string, which
        # ch_query.cpp's parseEndpointSpec() decodes. Node ids in this project
        # are always plain alphanumeric, so ":" is a safe delimiter.
        # ============================================================
        if self.path == "/api/route":
            try:
                length = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(length)
                body = json.loads(raw)

                def encode_endpoint(v):
                    if isinstance(v, dict):
                        node_a = str(v.get("nodeA", "")).strip()
                        node_b = str(v.get("nodeB", "")).strip()
                        directions = str(v.get("directions", "")).strip()
                        if not node_a or not node_b or directions not in ("AtoB", "BtoA", "both"):
                            raise ValueError("malformed virtual route endpoint")
                        dist_a = float(v.get("distToA", 0))
                        dist_b = float(v.get("distToB", 0))
                        return f"V:{node_a}:{node_b}:{dist_a}:{dist_b}:{directions}"
                    return str(v).strip()

                start = encode_endpoint(body.get("start", ""))
                end = encode_endpoint(body.get("end", ""))
                if not start or not end:
                    raise ValueError("missing start/end")
                if not os.path.exists(CH_BIN_PATH):
                    raise ValueError("no map_data.ch.bin yet - click Recalculate CH first")
                if not ensure_ch_query_binary():
                    raise ValueError("ch_query.exe not available (g++ missing or build failed - check server console)")

                result = subprocess.run(
                    [CH_QUERY_EXE, CH_BIN_PATH, start, end],
                    cwd=CH_DIR, capture_output=True, text=True,
                )
                if result.stderr:
                    sys.stderr.write(result.stderr)
                out = json.loads(result.stdout)
                self._send_json(200, out)
            except Exception as e:
                self._send_json(400, {"ok": False, "error": str(e)})
            return

        if self.path == "/api/upload-icon":
            try:
                length = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(length)
                body = json.loads(raw)
                filename = str(body.get("filename", ""))
                data_b64 = body.get("dataBase64", "")
                ext = os.path.splitext(filename)[1].lower()
                if ext not in ICON_EXT_WHITELIST:
                    raise ValueError(f"unsupported image type '{ext}' - use one of {sorted(ICON_EXT_WHITELIST)}")
                try:
                    raw_bytes = base64.b64decode(data_b64, validate=True)
                except (binascii.Error, ValueError):
                    raise ValueError("invalid base64 image data")
                if not raw_bytes:
                    raise ValueError("empty image data")
                if len(raw_bytes) > ICON_MAX_BYTES:
                    raise ValueError(f"image too large - max {ICON_MAX_BYTES // (1024 * 1024)}MB")

                os.makedirs(ICONS_DIR, exist_ok=True)
                # Never trust the client-supplied filename for the path on disk -
                # generate our own, only reusing the (already whitelisted) extension.
                out_name = f"{uuid.uuid4().hex}{ext}"
                with open(os.path.join(ICONS_DIR, out_name), "wb") as f:
                    f.write(raw_bytes)

                self._send_json(200, {"ok": True, "path": f"icons/{out_name}"})
            except Exception as e:
                self._send_json(400, {"ok": False, "error": str(e)})
            return

        if self.path != "/api/save":
            self.send_error(404, "Not found")
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            data = json.loads(raw)
            if not isinstance(data, dict) or "nodes" not in data or "ways" not in data:
                raise ValueError("payload is missing nodes/ways")

            # Write to a temp file first and rename over the original so a
            # crash or interrupted request can't leave map_data.json half-written.
            tmp_path = MAP_DATA_PATH + ".tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, separators=(",", ":"))
            os.replace(tmp_path, MAP_DATA_PATH)

            self._send_json(200, {"ok": True})
        except Exception as e:
            self._send_json(400, {"ok": False, "error": str(e)})

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Server(socketserver.TCPServer):
    allow_reuse_address = True


def main():
    os.chdir(FRONTEND_DIR)
    run_ch_preprocess()  # make sure the CH is fresh before we even start serving
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://127.0.0.1:{PORT}/index.html"
        print(f"Serving {FRONTEND_DIR}  (icons/ from {ICONS_DIR})")
        print(f"Open {url}")
        try:
            webbrowser.open(url)
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        print("Server closed.")


if __name__ == "__main__":
    main()
