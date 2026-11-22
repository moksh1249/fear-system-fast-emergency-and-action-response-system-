"""Who may see and do what - the FEAR permission model, enforced server-side.

Roles (gov_users.role):
  super_admin  platform administration: organizations, command accounts,
               registry verification, audit. Sees operational data for
               oversight but never caller contacts or driver identities.
  org_admin    administers one organization and the organizations beneath it
               (a health department and its hospitals, police HQ and its
               stations): vehicles, drivers, assignments, its own live fleet.
  operator     a Command & Control seat with one authority (below).
  driver       a verified driver; can only act through the vehicle they are
               currently assigned to.

Citizens are a separate subject type (sessions.subject_type = 'citizen') and
never reach any /gov endpoint.

Authorities decide which vehicle categories an operator can see live, which
incident kinds reach them, and which categories they may dispatch. A
department dispatches only its own units ("each department retains control
over its own personnel").
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import aiosqlite

ROLES = ("super_admin", "org_admin", "operator", "driver")

AUTHORITIES = {
    "iccc": "Integrated Command & Control Centre",
    "city_traffic": "City Traffic Command",
    "police_command": "Police Command",
    "health_command": "Health Emergency Command",
    "fire_command": "Fire Command",
    "municipal": "Municipal Administration",
    "rto": "Transport / RTO Verification",
    "analytics": "Government Analytics",
}

ORG_KINDS = {
    "platform": "FEAR platform",
    "health_dept": "Health department",
    "hospital": "Hospital",
    "ambulance_operator": "Private ambulance operator",
    "fire_dept": "Fire department",
    "fire_station": "Fire station",
    "police_hq": "Police headquarters",
    "police_station": "Police station / traffic unit",
    "transport_dept": "Transport department (RTO)",
    "transport_corp": "State transport corporation",
    "municipal": "Municipal authority",
    "enterprise": "Commercial fleet operator",
}

# Which vehicle categories an organization of a given kind may register.
ORG_VEHICLE_CATEGORIES = {
    "health_dept": ("ambulance",), "hospital": ("ambulance",), "ambulance_operator": ("ambulance",),
    "fire_dept": ("firetruck",), "fire_station": ("firetruck",),
    "police_hq": ("police",), "police_station": ("police",),
    "transport_corp": ("bus",), "municipal": ("municipal",),
    "transport_dept": ("government",), "enterprise": ("commercial",), "platform": ("government",),
}

VEHICLE_CATEGORIES = {
    # category: (label, FEAR id prefix, sim engine vehicleType)
    "ambulance": ("Ambulance", "AMB", "ambulance"),
    "firetruck": ("Fire engine", "FIR", "firetruck"),
    "police": ("Police vehicle", "POL", "police"),
    "bus": ("Public transport bus", "BUS", "bus"),
    "municipal": ("Municipal vehicle", "MUN", "truck"),
    "government": ("Government vehicle", "GOV", "car"),
    "commercial": ("Commercial fleet vehicle", "COM", "truck"),
}
EMERGENCY_CATEGORIES = frozenset({"ambulance", "firetruck", "police"})

INCIDENT_KINDS = {
    "medical": "Medical emergency", "fire": "Fire", "crime": "Police / crime", "accident": "Road accident",
    "hazard": "Road hazard", "road_blocked": "Blocked road", "congestion": "Congestion", "other": "Other",
}

# Live vehicle visibility per authority. Commercial fleets are absent on
# purpose: Command only ever sees them aggregated.
AUTHORITY_CATEGORIES = {
    "iccc": {"ambulance", "firetruck", "police", "bus", "municipal", "government"},
    "city_traffic": {"ambulance", "firetruck", "police", "bus", "municipal", "government"},
    "police_command": {"police", "ambulance", "firetruck"},
    "health_command": {"ambulance"},
    "fire_command": {"firetruck"},
    "municipal": {"municipal"},
    "rto": set(),
    "analytics": set(),
}

AUTHORITY_INCIDENT_KINDS = {
    "iccc": set(INCIDENT_KINDS),
    "city_traffic": set(INCIDENT_KINDS),
    "police_command": {"crime", "accident", "hazard", "road_blocked", "congestion", "other"},
    "health_command": {"medical", "accident"},
    "fire_command": {"fire", "accident", "hazard"},
    "municipal": {"hazard", "road_blocked", "congestion"},
    "rto": set(),
    "analytics": set(),
}

AUTHORITY_DISPATCH = {
    # The city's integrated control room coordinates all three services from one seat.
    "iccc": {"ambulance", "firetruck", "police"},
    "police_command": {"police"},
    "health_command": {"ambulance"},
    "fire_command": {"firetruck"},
}

# Authorities that handle an incident of a given kind - only they can open
# the caller's contact details (and every opening is audited).
INCIDENT_HANDLERS = {
    "medical": {"iccc", "health_command"},
    "fire": {"iccc", "fire_command"},
    "crime": {"iccc", "police_command"},
    "accident": {"iccc", "health_command", "police_command", "fire_command"},
    "hazard": {"iccc", "city_traffic", "municipal", "police_command", "fire_command"},
    "road_blocked": {"iccc", "city_traffic", "municipal", "police_command"},
    "congestion": {"iccc", "city_traffic", "police_command"},
    "other": {"iccc", "city_traffic", "police_command"},
}

# What a public SOS of each kind asks for by default.
SOS_NEEDS = {
    "medical": {"ambulance": 1},
    "fire": {"firetruck": 1, "ambulance": 1},
    "crime": {"police": 1},
    "accident": {"ambulance": 1, "police": 1},
}

ALERT_AUTHORITIES = {"iccc", "city_traffic", "municipal", "police_command"}
SIGNAL_AUTHORITIES = {"iccc", "city_traffic"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def visible_categories(user) -> set:
    if user["role"] == "super_admin":
        return set(VEHICLE_CATEGORIES) - {"commercial"}
    if user["role"] == "operator":
        return set(AUTHORITY_CATEGORIES.get(user["authority"], set()))
    return set()


def visible_incident_kinds(user) -> set:
    if user["role"] == "super_admin":
        return set(INCIDENT_KINDS)
    if user["role"] == "operator":
        return set(AUTHORITY_INCIDENT_KINDS.get(user["authority"], set()))
    return set()


# Who sees the traffic picture: every vehicle the engine is moving, as
# anonymous dots (simulated vehicles, or in realistic mode every phone sending
# GPS - drivers and the public's anonymous traffic sharing).
TRAFFIC_AUTHORITIES = {"iccc", "city_traffic", "police_command", "analytics"}


def can_view_traffic(user) -> bool:
    return user["role"] == "super_admin" or (user["role"] == "operator" and user["authority"] in TRAFFIC_AUTHORITIES)


def can_dispatch(user, category: str) -> bool:
    if user["role"] == "super_admin":
        return False
    return user["role"] == "operator" and category in AUTHORITY_DISPATCH.get(user["authority"], set())


def dispatch_categories(user) -> set:
    if user["role"] == "operator":
        return set(AUTHORITY_DISPATCH.get(user["authority"], set()))
    return set()


def can_handle_incident(user, kind: str) -> bool:
    return user["role"] == "operator" and user["authority"] in INCIDENT_HANDLERS.get(kind, set())


def can_manage_alerts(user) -> bool:
    return user["role"] == "super_admin" or (user["role"] == "operator" and user["authority"] in ALERT_AUTHORITIES)


def can_control_signals(user) -> bool:
    return user["role"] == "super_admin" or (user["role"] == "operator" and user["authority"] in SIGNAL_AUTHORITIES)


def can_verify_citizen_vehicles(user) -> bool:
    return user["role"] == "super_admin" or (user["role"] == "operator" and user["authority"] == "rto")


async def org_subtree(conn: aiosqlite.Connection, root_id: Optional[str]) -> set:
    """root_id plus every organization beneath it."""
    if not root_id:
        return set()
    cur = await conn.execute(
        """WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT o.id FROM organizations o JOIN sub ON o.parent_id = sub.id)
           SELECT id FROM sub""",
        (root_id,),
    )
    return {r[0] for r in await cur.fetchall()}


async def audit(conn: aiosqlite.Connection, actor_type: str, actor_id: str, action: str,
                target_type: Optional[str] = None, target_id: Optional[str] = None,
                org_id: Optional[str] = None, reason: Optional[str] = None, commit: bool = True) -> None:
    await conn.execute(
        "INSERT INTO audit_log(at, actor_type, actor_id, action, target_type, target_id, org_id, reason) VALUES (?,?,?,?,?,?,?,?)",
        (now_iso(), actor_type, actor_id, action, target_type, target_id, org_id, reason),
    )
    if commit:
        await conn.commit()


def can_enroll_phones(user) -> bool:
    """Who may issue phone logins (QR codes): FEAR's admin, the integrated
    control room, and organization admins for their own organizations."""
    return user["role"] in ("super_admin", "org_admin") or (user["role"] == "operator" and user["authority"] == "iccc")


def can_manage_network(user) -> bool:
    return user["role"] == "super_admin" or (user["role"] == "operator" and user["authority"] in ("iccc", "city_traffic"))
