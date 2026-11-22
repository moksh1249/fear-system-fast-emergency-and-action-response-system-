"""Map administration for FEAR's super admin: add a new area to the live map
from an OpenStreetMap .osm export.

POST /gov/map/import?filename=<name>.osm with the raw file as the request
body starts a background job that:
  1. merges the area into map_data.json (backend/map_import.py - the same
     processing as osm_to_json.py, plus signals from OSM traffic_signals),
  2. rebuilds the routing index (serve.py's /api/recalc-ch -> ch_preprocess),
  3. restarts the traffic engine in the mode it was running in, so the new
     roads and signals are live.
The viewer and the apps pick the new map up on their own (the map version
changes). GET /gov/map/import/{job} follows the job's log.
"""

from __future__ import annotations

import asyncio
import os
import re
import threading
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from . import access, auth_v2, mapraw, schema_v2
from .live import hub

router = APIRouter(tags=["map-admin"])
USER = Depends(auth_v2.current_gov_user)

IMPORT_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "maps", "imports"))
MAX_BYTES = 300 * 1024 * 1024

_jobs: dict = {}
_busy = threading.Lock()


def _require_super(user) -> None:
    if user["role"] != "super_admin":
        raise HTTPException(403, "only FEAR's super admin can change the map")


@router.get("/gov/map/info")
async def map_info(user=USER):
    m = mapraw.load()
    meta = m["raw"].get("meta", {})
    sources = meta.get("sources") or ([{"file": meta.get("source"), "bounds": meta.get("bounds")}] if meta.get("source") else [])
    return {"bounds": meta.get("bounds"), "origin": meta.get("origin"), "sources": sources,
            "roads": len(m["raw"].get("ways", [])), "nodes": len(m["nodes"]),
            "signals": sum(1 for n in m["nodes"].values() if n.get("signal")), "version": mapraw.version(),
            "canImport": user["role"] == "super_admin", "busy": _busy.locked()}


@router.post("/gov/map/import")
async def start_import(request: Request, filename: str = "area.osm", user=USER):
    _require_super(user)
    if _busy.locked():
        raise HTTPException(409, "another map import is still running")
    safe = re.sub(r"[^A-Za-z0-9._ -]", "_", os.path.basename(filename))[:80] or "area.osm"
    if not safe.lower().endswith(".osm"):
        raise HTTPException(400, "upload an OpenStreetMap .osm (XML) export")
    os.makedirs(IMPORT_DIR, exist_ok=True)
    path = os.path.join(IMPORT_DIR, f"{time.strftime('%Y%m%d-%H%M%S')}_{safe}")
    size = 0
    head = b""
    with open(path, "wb") as f:
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_BYTES:
                f.close()
                os.remove(path)
                raise HTTPException(413, "file is larger than 300 MB - export a smaller area")
            if len(head) < 512:
                head += chunk[: 512 - len(head)]
            f.write(chunk)
    if b"<osm" not in head:
        os.remove(path)
        raise HTTPException(400, "that doesn't look like an OpenStreetMap XML (.osm) file")
    job_id = schema_v2.new_id("JOB", 3)
    job = {"id": job_id, "file": safe, "status": "running", "log": [], "result": None, "startedAt": access.now_iso()}
    _jobs[job_id] = job
    conn = await schema_v2.connect()
    try:
        await access.audit(conn, "gov", user["id"], "map.import", "file", safe)
    finally:
        await conn.close()
    asyncio.get_running_loop().run_in_executor(None, _run_job, job, path, safe)
    return {"jobId": job_id}


@router.get("/gov/map/import/{job_id}")
async def import_status(job_id: str, user=USER):
    _require_super(user)
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such import")
    return job


def _run_job(job: dict, path: str, label: str) -> None:
    from backend.map_import import import_osm
    from .main import _serve_json

    def log(msg: str) -> None:
        job["log"].append(f"{time.strftime('%H:%M:%S')} {msg}")

    with _busy:
        try:
            engine = hub.engine
            was_running, sim_mode, signal_mode = engine.connected, engine.sim_mode, engine.signal_mode
            job["result"] = import_osm(path, log=log, label=label)
            job["result"].pop("backup", None)
            log("Rebuilding the routing index (contraction hierarchy) ...")
            r = _serve_json("/api/recalc-ch", {}, timeout=600)
            if not r.get("ok"):
                raise RuntimeError(f"routing index rebuild failed: {r.get('error')}")
            log("Routing index rebuilt")
            if was_running:
                log(f"Restarting the traffic engine ({sim_mode or 'realistic'} mode, {signal_mode or 'emergency'} signals) on the new map ...")
                _serve_json("/api/sim/stop", {}, timeout=30)
                time.sleep(1.5)
                r = _serve_json("/api/sim/start", {
                    "mode": sim_mode or "realistic", "signalMode": signal_mode or "emergency",
                    "simSeconds": 7 * 24 * 3600 if (sim_mode or "realistic") == "realistic" else 3600,
                }, timeout=300)
                log("Traffic engine restarted" if r.get("ok") else f"Engine restart failed: {r.get('error')} - start it from the viewer")
            else:
                log("Traffic engine was not running - it will load the new map when started")
            log("Done. Reload the viewer to see the new area; the apps load it on their own.")
            job["status"] = "done"
        except Exception as e:  # noqa: BLE001 - reported to the admin as-is
            log(f"FAILED: {e}")
            job["status"] = "failed"
        job["finishedAt"] = access.now_iso()
