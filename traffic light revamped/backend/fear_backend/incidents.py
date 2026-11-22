"""Incident lifecycle, shared by FEAR Command and the public app.

Incident status:
  reported    a public report waiting for Command to verify it
  open        accepted (or an SOS / Command-created incident), nobody dispatched yet
  dispatched  at least one unit assigned or on its way
  on_scene    at least one unit on scene or transporting
  closed      resolved by Command, or automatically once every unit has finished
  rejected    a report Command found to be invalid
  cancelled   the caller cancelled their SOS before any unit arrived

Unit (incident_units.status):
  assigned -> en_route (driver accepted) -> on_scene -> transporting (ambulance,
  to a hospital) -> completed;  on_scene -> completed (cleared);
  assigned -> declined;  any active -> recalled (by Command).

Closing an incident ends the caller's contact sharing and releases its units.
"""

from __future__ import annotations

import json
from typing import Optional

import aiosqlite
from fastapi import HTTPException

from . import access, geo, places, schema_v2
from .live import hub

ACTIVE_UNIT = ("assigned", "en_route", "on_scene", "transporting")
TERMINAL_UNIT = ("declined", "recalled", "completed")
OPEN_INCIDENT = ("reported", "open", "dispatched", "on_scene")

UNIT_LABELS = {
    "assigned": "Assigned", "en_route": "En route", "on_scene": "On scene", "transporting": "Transporting",
    "completed": "Completed", "declined": "Declined", "recalled": "Recalled",
}


async def event(conn, incident_id: str, actor: str, text: str, public: bool = False) -> None:
    await conn.execute(
        "INSERT INTO incident_events(incident_id, at, actor, public, text) VALUES (?,?,?,?,?)",
        (incident_id, access.now_iso(), actor, int(public), text),
    )


async def create(conn, *, kind: str, source: str, lat: float, lon: float, description: Optional[str],
                 severity: str = "normal", reporter_citizen_id: Optional[str] = None,
                 created_by: Optional[str] = None, demo: bool = False, contact: Optional[dict] = None,
                 status: Optional[str] = None) -> str:
    if kind not in access.INCIDENT_KINDS:
        raise HTTPException(400, "unknown incident kind")
    inc_id = schema_v2.new_id("INC", 3)
    status = status or ("reported" if source == "report" else "open")
    place = places.describe(lat, lon)
    await conn.execute(
        """INSERT INTO incidents(id, kind, source, severity, status, lat, lon, place, description,
           reporter_citizen_id, created_by, demo, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (inc_id, kind, source, severity, status, lat, lon, place, description, reporter_citizen_id,
         created_by, int(demo), access.now_iso()),
    )
    if contact is not None:
        await conn.execute(
            "INSERT INTO incident_contacts(incident_id, citizen_id, name, phone, sharing_active) VALUES (?,?,?,?,1)",
            (inc_id, contact.get("citizen_id"), contact.get("name"), contact.get("phone")),
        )
    label = access.INCIDENT_KINDS[kind]
    origin = {"sos": "SOS from the public app", "report": "Report from the public app",
              "command": "Created by Command"}.get(source, source)
    await event(conn, inc_id, "system", f"{label} - {origin}, {place}", public=True)
    await conn.commit()
    hub.bump()
    return inc_id


async def mark_responded(conn, incident_id: str, user) -> bool:
    """Records Command's first response to an incident (acknowledge, verify,
    note, dispatch, recall, close) - the AI dispatch agent never acts once a
    human has. True if this was the first."""
    cur = await conn.execute("UPDATE incidents SET responded_at=?, responded_by=? WHERE id=? AND responded_at IS NULL",
                             (access.now_iso(), user["id"], incident_id))
    return cur.rowcount > 0


async def get(conn, incident_id: str):
    cur = await conn.execute("SELECT * FROM incidents WHERE id=?", (incident_id,))
    inc = await cur.fetchone()
    if inc is None:
        raise HTTPException(404, "incident not found")
    return inc


async def units_of(conn, incident_id: str) -> list:
    cur = await conn.execute(
        """SELECT iu.*, v.category, v.plate, v.org_id, o.name AS org_name FROM incident_units iu
           JOIN fleet_vehicles v ON v.id = iu.vehicle_id JOIN organizations o ON o.id = v.org_id
           WHERE iu.incident_id=? ORDER BY iu.assigned_at""",
        (incident_id,),
    )
    return [dict(r) for r in await cur.fetchall()]


async def recompute_status(conn, incident_id: str) -> str:
    inc = await get(conn, incident_id)
    if inc["status"] in ("closed", "rejected", "cancelled", "reported"):
        return inc["status"]
    units = await units_of(conn, incident_id)
    statuses = {u["status"] for u in units}
    if statuses & {"on_scene", "transporting"}:
        new = "on_scene"
    elif statuses & {"assigned", "en_route"}:
        new = "dispatched"
    elif units and "completed" in statuses and not (statuses & set(ACTIVE_UNIT)):
        await close(conn, incident_id, "system", "All units finished - incident resolved", auto=True)
        return "closed"
    else:
        new = "open"
    if new != inc["status"]:
        await conn.execute("UPDATE incidents SET status=? WHERE id=?", (new, incident_id))
    return new


async def dispatch(conn, incident_id: str, vehicle_id: str, actor_id: str) -> dict:
    inc = await get(conn, incident_id)
    if inc["status"] not in ("open", "dispatched", "on_scene"):
        raise HTTPException(409, f"incident is {inc['status']}")
    unit = hub.units.get(vehicle_id)
    if unit is None:
        raise HTTPException(404, "vehicle not found")
    if not unit.on_duty or not unit.authorized:
        raise HTTPException(409, "vehicle is not on duty with an authorized driver")
    if unit.task is not None:
        raise HTTPException(409, "vehicle is already on another task")
    unit_id = schema_v2.new_id("UNT", 3)
    await conn.execute(
        """INSERT INTO incident_units(id, incident_id, vehicle_id, status, dest_kind, dest_lat, dest_lon, dest_name,
           assigned_by, assigned_at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (unit_id, incident_id, vehicle_id, "assigned", "incident", inc["lat"], inc["lon"],
         access.INCIDENT_KINDS[inc["kind"]], actor_id, access.now_iso()),
    )
    label = access.VEHICLE_CATEGORIES[unit.category][0]
    await event(conn, incident_id, actor_id, f"{label} {vehicle_id} dispatched", public=True)
    await recompute_status(conn, incident_id)
    await conn.commit()
    await hub.refresh_unit(conn, vehicle_id)
    hub.bump()
    return {"unitId": unit_id}


async def set_unit_status(conn, unit_id: str, new_status: str, actor_id: str,
                          hospital: Optional[dict] = None) -> dict:
    cur = await conn.execute("SELECT * FROM incident_units WHERE id=?", (unit_id,))
    iu = await cur.fetchone()
    if iu is None:
        raise HTTPException(404, "task not found")
    cur_status = iu["status"]
    allowed = {
        "assigned": {"en_route", "declined", "recalled"},
        "en_route": {"on_scene", "recalled"},
        "on_scene": {"transporting", "completed", "recalled"},
        "transporting": {"completed", "recalled"},
    }.get(cur_status, set())
    if new_status not in allowed:
        raise HTTPException(409, f"cannot go from {cur_status} to {new_status}")
    cur = await conn.execute("SELECT category FROM fleet_vehicles WHERE id=?", (iu["vehicle_id"],))
    category = (await cur.fetchone())["category"]
    now = access.now_iso()
    sets, args = ["status=?"], [new_status]
    if new_status == "en_route":
        sets.append("accepted_at=?"); args.append(now)
    elif new_status == "on_scene":
        sets.append("on_scene_at=?"); args.append(now)
    elif new_status == "transporting":
        if category != "ambulance":
            raise HTTPException(409, "only ambulances transport patients")
        if hospital is None:
            inc = await get(conn, iu["incident_id"])
            near = places.receiving_hospitals(inc["lat"], inc["lon"], 1)
            if not near:
                raise HTTPException(409, "no hospital on the map")
            hospital = near[0]
        sets += ["transport_at=?", "dest_kind='hospital'", "dest_lat=?", "dest_lon=?", "dest_name=?"]
        args += [now, hospital["lat"], hospital["lon"], hospital["name"]]
    elif new_status in TERMINAL_UNIT:
        sets.append("completed_at=?"); args.append(now)
    await conn.execute(f"UPDATE incident_units SET {', '.join(sets)} WHERE id=?", (*args, unit_id))

    label = access.VEHICLE_CATEGORIES[category][0]
    text = {
        "en_route": f"{label} {iu['vehicle_id']} is on the way",
        "declined": f"{label} {iu['vehicle_id']} declined the assignment",
        "on_scene": f"{label} {iu['vehicle_id']} reached the scene",
        "transporting": f"{label} {iu['vehicle_id']} is taking the patient to {hospital['name'] if hospital else 'hospital'}",
        "completed": f"{label} {iu['vehicle_id']} finished" + (" at the hospital" if cur_status == "transporting" else ""),
        "recalled": f"{label} {iu['vehicle_id']} was recalled by Command",
    }[new_status]
    await event(conn, iu["incident_id"], actor_id, text, public=new_status != "declined")
    await recompute_status(conn, iu["incident_id"])
    await conn.commit()
    await hub.refresh_unit(conn, iu["vehicle_id"])
    hub.bump()
    return {"ok": True, "status": new_status}


async def close(conn, incident_id: str, actor_id: str, note: Optional[str], auto: bool = False,
                status: str = "closed") -> None:
    units = await units_of(conn, incident_id)
    now = access.now_iso()
    for u in units:
        if u["status"] in ACTIVE_UNIT:
            await conn.execute("UPDATE incident_units SET status='recalled', completed_at=? WHERE id=?", (now, u["id"]))
    await conn.execute("UPDATE incidents SET status=?, closed_at=?, closed_by=? WHERE id=?",
                       (status, now, actor_id, incident_id))
    # Purpose-limited sharing ends with the incident.
    await conn.execute("UPDATE incident_contacts SET sharing_active=0 WHERE incident_id=?", (incident_id,))
    await conn.execute("UPDATE public_alerts SET active=0 WHERE incident_id=?", (incident_id,))
    text = {"closed": "Incident closed", "rejected": "Report rejected", "cancelled": "SOS cancelled by the caller"}[status]
    await event(conn, incident_id, actor_id, text + (f": {note}" if note else ""), public=True)
    if not auto:
        await conn.commit()
    for u in units:
        await hub.refresh_unit(conn, u["vehicle_id"])
    hub.bump()


def unit_live(vehicle_id: str) -> dict:
    u = hub.units.get(vehicle_id)
    if u is None:
        return {}
    return {"lat": u.lat, "lon": u.lon, "heading": u.heading, "speedKmh": u.speed_kmh, "stale": u.stale,
            "etaSec": hub.eta_sec(u), "emergency": u.emergency_active}


async def citizen_view(conn, incident_id: str) -> dict:
    """What the caller sees: their incident's progress and the responding
    units' positions - no driver, plate, organization or operator details."""
    inc = await get(conn, incident_id)
    cur = await conn.execute(
        "SELECT at, text FROM incident_events WHERE incident_id=? AND public=1 ORDER BY id", (incident_id,))
    events = [dict(r) for r in await cur.fetchall()]
    units = []
    for u in await units_of(conn, incident_id):
        if u["status"] in ("declined",):
            continue
        live = unit_live(u["vehicle_id"]) if u["status"] in ("en_route", "on_scene", "transporting") else {}
        units.append({
            "category": u["category"], "categoryLabel": access.VEHICLE_CATEGORIES[u["category"]][0],
            "vehicleId": u["vehicle_id"], "status": u["status"], "statusLabel": UNIT_LABELS[u["status"]],
            "destName": u["dest_name"] if u["dest_kind"] == "hospital" else None,
            **{k: live.get(k) for k in ("lat", "lon", "heading", "etaSec")},
        })
    return {"id": inc["id"], "kind": inc["kind"], "kindLabel": access.INCIDENT_KINDS[inc["kind"]],
            "source": inc["source"], "status": inc["status"], "lat": inc["lat"], "lon": inc["lon"],
            "place": inc["place"], "description": inc["description"], "createdAt": inc["created_at"],
            "closedAt": inc["closed_at"], "events": events, "units": units}


def summary(inc) -> dict:
    from . import ai_dispatch, triage

    try:
        voice = json.loads(inc["voice"]) if inc["voice"] else None
    except (ValueError, TypeError):
        voice = None
    return {"id": inc["id"], "kind": inc["kind"], "kindLabel": access.INCIDENT_KINDS[inc["kind"]],
            "source": inc["source"], "severity": inc["severity"], "status": inc["status"],
            "lat": inc["lat"], "lon": inc["lon"], "place": inc["place"], "description": inc["description"],
            "createdAt": inc["created_at"], "closedAt": inc["closed_at"], "demo": bool(inc["demo"]),
            "voice": voice, **triage.view(inc), **ai_dispatch.view(inc)}


async def suggestions(conn, inc, category: str, limit: int = 5) -> list:
    """Nearest available, authorized, on-duty units of a category, by road
    time for the closest few (straight-line ranking first, so only a handful
    of routes are computed)."""
    from . import routing

    cands = [u for u in hub.units.values()
             if u.category == category and u.on_duty and u.authorized and u.task is None and u.has_fix and not u.stale]
    cands.sort(key=lambda u: geo.distance_m(u.lat, u.lon, inc["lat"], inc["lon"]))
    out = []
    for u in cands[:limit]:
        r = await routing.route(u.lat, u.lon, inc["lat"], inc["lon"])
        out.append({"vehicleId": u.vehicle_id, "category": u.category, "plate": u.plate, "orgId": u.org_id,
                    "straightM": round(geo.distance_m(u.lat, u.lon, inc["lat"], inc["lon"])),
                    "roadM": round(r["distanceM"]) if r and r.get("found") else None,
                    "etaSec": r["durationSec"] if r and r.get("found") else None,
                    "demo": u.demo})
    out.sort(key=lambda s: (s["etaSec"] is None, s["etaSec"] or 0))
    return out
