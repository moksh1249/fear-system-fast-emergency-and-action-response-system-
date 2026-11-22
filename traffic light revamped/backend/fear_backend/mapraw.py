"""The full map_data.json, parsed once and cached on the file's mtime, for the
modules that need more than map_data.py's road-only view: the phones' map
export (mapexport.py), traffic-light lamps (signals.py) and turn-by-turn
directions (navigation.py)."""

from __future__ import annotations

import json
import os
import threading
from typing import Optional

from . import config

_lock = threading.Lock()
_cache: Optional[dict] = None


def load() -> dict:
    """{"mtime", "raw", "nodes": id->node, "ways": id->way, "clusters": join_group->[node ids]}"""
    global _cache
    mtime = os.path.getmtime(config.MAP_DATA_PATH)
    with _lock:
        if _cache is not None and _cache["mtime"] == mtime:
            return _cache
        with open(config.MAP_DATA_PATH, encoding="utf-8") as f:
            raw = json.load(f)
        nodes = raw.get("nodes", {})
        ways = {w.get("id"): w for w in raw.get("ways", []) if w.get("id")}
        clusters: dict[str, list] = {}
        for nid, n in nodes.items():
            g = (n.get("tags") or {}).get("join_group")
            if g:
                clusters.setdefault(g, []).append(nid)
        _cache = {"mtime": mtime, "raw": raw, "nodes": nodes, "ways": ways, "clusters": clusters}
        return _cache


def version() -> str:
    return str(int(load()["mtime"]))
