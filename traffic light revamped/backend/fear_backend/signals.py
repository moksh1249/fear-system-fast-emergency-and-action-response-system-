"""Traffic-light lamps for the phone apps' native map.

Lamp layout is static (from map_data.json): one lamp per (signalized node,
approach way, movement) for every approach a signal phase lights, placed at
that approach's stop line on the left (approach) side of the road - this
map drives on the left. Colours are computed every tick exactly the way the
engine does (port of redlights.hpp's computeLampColor: plain phase lists,
the paired 4-way scheme, and redlight groups taking turns), on the engine's
own sim clock, then overlaid with whatever the engine reports for that
junction (emergency preemption, density mode) and with manual External
Control overrides. The traffic lights stay simulated in both vehicle-source
modes; only the vehicles change.

Colours go to the phones as one string, one character per lamp in table
order: g / y / r. Alongside it a number per lamp and what it means
(`last_timer_kinds`, one character per lamp):
  c  seconds until the colour changes (fixed-time plans - exact)
  m  green under density control: at most this many seconds left (the
     engine ends a green after DENSITY_MAX_GREEN_SEC, sooner if its queue
     clears)
  e  red / amber under density control: seconds it has been waiting
  h  held for an emergency vehicle (or by Command) - seconds held
"""

from __future__ import annotations

import math
from typing import Optional

from . import mapraw

PAIRED_DEFAULT_STEP_SEC = 15.0


def _f(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- colours (port of redlights.hpp)

def _plain_color(signal: dict, clock: float, way_id: str) -> str:
    all_red = max(0.0, _f(signal.get("allRedSec")))
    segs, cursor = [], 0.0
    for ph in signal.get("phases") or []:
        green, yellow = max(0.0, _f(ph.get("greenSec"))), max(0.0, _f(ph.get("yellowSec")))
        ways = ph.get("wayIds") or []
        if green > 0:
            segs.append((cursor, cursor + green, "g", ways)); cursor += green
        if yellow > 0:
            segs.append((cursor, cursor + yellow, "y", ways)); cursor += yellow
        if all_red > 0:
            segs.append((cursor, cursor + all_red, "r", None)); cursor += all_red
    if not segs or cursor <= 0:
        return "r"
    t = math.fmod(math.fmod(clock, cursor) + cursor, cursor)
    cur = next((s for s in segs if s[0] <= t < s[1]), segs[-1])
    if cur[2] == "r" or not cur[3] or way_id not in cur[3]:
        return "r"
    return cur[2]


def _paired_movement(red_start, red_dur, yellow, cycle, t) -> str:
    if cycle <= 0:
        return "r"
    t = math.fmod(math.fmod(t, cycle) + cycle, cycle)
    into_red = math.fmod(math.fmod(t - red_start, cycle) + cycle, cycle)
    if into_red < red_dur:
        return "r"
    rem_green = (cycle - red_dur) - (into_red - red_dur)
    return "y" if rem_green <= yellow else "g"


def _paired_color(signal: dict, clock: float, way_id: str, movement: str) -> str:
    paired = signal.get("paired") or {}
    pairs = paired.get("pairs") or []
    if len(pairs) < 2:
        return "r"
    cfg = []
    for p in pairs[:2]:
        w = p.get("wayIds") or ["", ""]
        cfg.append((w[0] if w else "", w[1] if len(w) > 1 else "", max(1.0, _f(p.get("stepSec"), PAIRED_DEFAULT_STEP_SEC))))
    idx = 0 if way_id in cfg[0][:2] else 1 if way_id in cfg[1][:2] else -1
    if idx < 0:
        return "r"
    all_red = max(0.0, _f(signal.get("allRedSec")))
    c0, c1 = 4 * cfg[0][2], 4 * cfg[1][2]
    master = c0 + all_red + c1 + all_red
    if master <= 0:
        return "r"
    tm = math.fmod(math.fmod(clock, master) + master, master)
    if tm < c0:
        active, local = 0, tm
    elif tm < c0 + all_red:
        active, local = -1, 0.0
    elif tm < c0 + all_red + c1:
        active, local = 1, tm - (c0 + all_red)
    else:
        active, local = -1, 0.0
    if active != idx:
        return "r"
    step = cfg[idx][2]
    yellow = max(0.0, _f(paired.get("yellowSec"), 3.0))
    is_a = way_id == cfg[idx][0]
    if movement in ("right", "uturn"):
        red_start, red_dur = (step if is_a else 3 * step), 3 * step
    else:
        red_start, red_dur = (2 * step if is_a else 0.0), step
    return _paired_movement(red_start, red_dur, yellow, 4 * step, local)


def lamp_color(signal: dict, node_id: str, groups: dict, way_id: str, movement: str, clock: float) -> str:
    effective = clock
    gid = signal.get("groupId")
    g = groups.get(gid) if gid else None
    if g and len(g.get("memberIds") or []) >= 2:
        members = g["memberIds"]
        turn = max(1.0, _f(g.get("turnSec"), 30.0))
        cycle = turn * len(members)
        t = math.fmod(math.fmod(clock, cycle) + cycle, cycle)
        active = min(len(members) - 1, int(t // turn))
        if members[active] != node_id:
            return "r"
        effective = t - active * turn
    if signal.get("scheme") == "paired4way" and signal.get("paired"):
        return _paired_color(signal, effective, way_id, movement)
    return _plain_color(signal, effective, way_id)


# --------------------------------------------------------------------------- lamp layout

_layout_cache: Optional[tuple] = None


def _lit_ways(signal: dict) -> list:
    out = []
    if signal.get("scheme") == "paired4way" and signal.get("paired"):
        for p in signal["paired"].get("pairs") or []:
            out += p.get("wayIds") or []
    else:
        for ph in signal.get("phases") or []:
            out += ph.get("wayIds") or []
    seen, uniq = set(), []
    for w in out:
        if w not in seen:
            seen.add(w)
            uniq.append(w)
    return uniq


def _way_half_width(way: dict) -> float:
    tags = way.get("tags") or {}
    try:
        lanes = int(tags.get("lanes") or 0)
    except ValueError:
        lanes = 0
    lw = _f(tags.get("lane_width"), 3.2) or 3.2
    return max(2.5, (lanes or 2) * lw / 2)


def layout() -> list:
    """[{"node", "way", "mv", "x", "y"}] - stable order for the colour string."""
    global _layout_cache
    m = mapraw.load()
    if _layout_cache and _layout_cache[0] == m["mtime"]:
        return _layout_cache[1]
    nodes, ways, clusters = m["nodes"], m["ways"], m["clusters"]
    lamps = []
    for nid in sorted(nodes):
        n = nodes[nid]
        sig = n.get("signal")
        if not sig:
            continue
        group = (n.get("tags") or {}).get("join_group")
        members = clusters.get(group, [nid]) if group else [nid]
        cx = sum(_f(nodes[i].get("x")) for i in members) / len(members)
        cy = sum(_f(nodes[i].get("y")) for i in members) / len(members)
        for wid in _lit_ways(sig):
            w = ways.get(wid)
            if not w or len(w.get("nodes") or []) < 2:
                continue
            ids = [i for i in w["nodes"] if i in nodes]
            if len(ids) < 2:
                continue
            first, last = nodes[ids[0]], nodes[ids[-1]]
            d_first = math.hypot(_f(first.get("x")) - cx, _f(first.get("y")) - cy)
            d_last = math.hypot(_f(last.get("x")) - cx, _f(last.get("y")) - cy)
            end, prev = (ids[0], ids[1]) if d_first <= d_last else (ids[-1], ids[-2])
            ex, ey = _f(nodes[end].get("x")), _f(nodes[end].get("y"))
            px, py = _f(nodes[prev].get("x")), _f(nodes[prev].get("y"))
            dx, dy = ex - px, ey - py  # direction of travel into the junction
            ln = math.hypot(dx, dy) or 1.0
            ux, uy = dx / ln, dy / ln
            lx, ly = -uy, ux           # left of travel - the approach side in left-hand traffic
            back = min(4.0, ln * 0.4)
            half = _way_half_width(w)
            bx, by = ex - ux * back, ey - uy * back
            for mv, frac in (("through", 0.70), ("right", 0.25)):
                lamps.append({"node": nid, "way": wid, "mv": mv,
                              "x": round(bx + lx * half * frac, 2), "y": round(by + ly * half * frac, 2)})
    _layout_cache = (m["mtime"], lamps)
    return lamps


# lamp index -> (time it was worked out at, time its colour changes, colour)
_change_at: dict = {}
_since: dict = {}  # lamp index -> (colour, time it turned that colour) for engine-driven lamps
_TIMER_STEP = 0.5
_TIMER_HORIZON = 400.0
DENSITY_MAX_GREEN_SEC = 30.0  # sim_engine.cpp's density arbitration
last_timers: list = []
last_timer_kinds = ""


def _held_for(i: int, colour: str, t: float) -> float:
    prev = _since.get(i)
    if prev is None or prev[0] != colour or t < prev[1]:
        prev = (colour, t)
        _since[i] = prev
    return t - prev[1]


def _seconds_left(sig: dict, nid: str, groups: dict, way: str, mv: str, t: float, colour: str) -> Optional[float]:
    """When this lamp next changes colour, stepping forward through its plan."""
    k = 1
    while k * _TIMER_STEP <= _TIMER_HORIZON:
        if lamp_color(sig, nid, groups, way, mv, t + k * _TIMER_STEP) != colour:
            return t + k * _TIMER_STEP
        k += 1
    return None


def colors(clock: Optional[float], engine_lamps: Optional[list], overrides: Optional[dict]) -> str:
    """The colour string for layout(), at engine time `clock` (falls back to
    wall-clock seconds when no engine is running, so the lights still cycle).
    Also refreshes `last_timers` (see module docstring)."""
    import time

    global last_timers, last_timer_kinds

    m = mapraw.load()
    nodes = m["nodes"]
    groups = m["raw"].get("redlightGroups") or {}
    if isinstance(groups, list):
        groups = {g.get("id"): g for g in groups if isinstance(g, dict)}
    t = clock if clock is not None else time.time() % 86400
    reported = {}
    for lamp in engine_lamps or []:
        reported[(lamp.get("nodeId"), lamp.get("wayId"), lamp.get("movement"))] = ((lamp.get("color") or "red")[0], lamp.get("reason"))
    out, timers, kinds = [], [], []
    for i, lp in enumerate(layout()):
        key = (lp["node"], lp["way"], lp["mv"])
        ov = (overrides or {}).get(lp["node"])
        if ov is not None:
            greens = {(g.get("wayId"), g.get("movement")) for g in ov.get("greenLamps") or []}
            c = "g" if (lp["way"], lp["mv"]) in greens else "r"
            out.append(c)
            timers.append(int(_held_for(i, c, t)))
            kinds.append("h")
        elif key in reported:
            c, reason = reported[key]
            out.append(c)
            held = _held_for(i, c, t)
            if reason == "emergency":
                timers.append(int(held))
                kinds.append("h")
            elif c == "g":
                timers.append(max(0, math.ceil(DENSITY_MAX_GREEN_SEC - held)))
                kinds.append("m")
            else:
                timers.append(int(held))
                kinds.append("e")
        else:
            _since.pop(i, None)
            sig = nodes[lp["node"]]["signal"]
            c = lamp_color(sig, lp["node"], groups, lp["way"], lp["mv"], t)
            out.append(c)
            cached = _change_at.get(i)
            # re-worked out only when the colour changed or the clock jumped
            if cached is None or cached[2] != c or t < cached[0] or (cached[1] is not None and t >= cached[1]):
                cached = (t, _seconds_left(sig, lp["node"], groups, lp["way"], lp["mv"], t, c), c)
                _change_at[i] = cached
            timers.append(-1 if cached[1] is None else max(0, math.ceil(cached[1] - t)))
            kinds.append("-" if cached[1] is None else "c")
    last_timers = timers
    last_timer_kinds = "".join(kinds)
    return "".join(out)
