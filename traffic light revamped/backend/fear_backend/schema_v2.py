"""Tables behind the FEAR Command (government) and FEAR (public) apps.

Laid out as the three data domains of the FEAR design, joined only through
internal ids:

  - identity     gov_users, drivers, citizens - who a person is. `drivers` is
                 the restricted domain: name, phone, licence, address. Only the
                 employing organization (and an audited break-glass request)
                 can read it; nothing on the operational side selects from it.
  - registry     organizations, fleet_vehicles, assignments, citizen_vehicles -
                 what a vehicle is, who operates it, who may drive it.
  - operational  duty, fleet_location, incidents, incident_units, public_alerts
                 - where authorized vehicles are and what they're doing.

The older employer/employee/vehicles tables in db.py are left untouched; they
belong to the earlier back-office flow and the web phone page still uses them.
"""

import secrets

import aiosqlite

from . import config

SCHEMA_V2 = """
CREATE TABLE IF NOT EXISTS organizations(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    parent_id TEXT REFERENCES organizations(id),
    verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gov_users(
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    pw_hash TEXT NOT NULL,
    pw_salt TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    org_id TEXT REFERENCES organizations(id),
    authority TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drivers(
    id TEXT PRIMARY KEY,
    gov_user_id TEXT UNIQUE NOT NULL REFERENCES gov_users(id),
    org_id TEXT NOT NULL REFERENCES organizations(id),
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    licence_no TEXT NOT NULL,
    address TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fleet_vehicles(
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id),
    category TEXT NOT NULL,
    plate TEXT NOT NULL,
    make_model TEXT,
    verified INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments(
    id TEXT PRIMARY KEY,
    vehicle_id TEXT NOT NULL REFERENCES fleet_vehicles(id),
    driver_id TEXT NOT NULL REFERENCES drivers(id),
    assigned_by TEXT NOT NULL,
    assigned_at TEXT NOT NULL,
    revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS duty(
    vehicle_id TEXT PRIMARY KEY REFERENCES fleet_vehicles(id),
    driver_id TEXT REFERENCES drivers(id),
    on_duty INTEGER NOT NULL DEFAULT 0,
    priority_requested INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fleet_location(
    vehicle_id TEXT PRIMARY KEY REFERENCES fleet_vehicles(id),
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    heading REAL,
    speed_kmh REAL,
    demo INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS citizens(
    id TEXT PRIMARY KEY,
    phone TEXT UNIQUE,
    name TEXT,
    share_traffic INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS otp_requests(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    code_salt TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    consumed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dev_outbox(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    recipient TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS citizen_vehicles(
    id TEXT PRIMARY KEY,
    citizen_id TEXT NOT NULL REFERENCES citizens(id),
    plate TEXT NOT NULL,
    vehicle_type TEXT NOT NULL,
    make_model TEXT,
    rto_status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_note TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents(
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    place TEXT,
    description TEXT,
    reporter_citizen_id TEXT REFERENCES citizens(id),
    created_by TEXT,
    demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    closed_at TEXT,
    closed_by TEXT
);

CREATE TABLE IF NOT EXISTS incident_contacts(
    incident_id TEXT PRIMARY KEY REFERENCES incidents(id),
    citizen_id TEXT REFERENCES citizens(id),
    name TEXT,
    phone TEXT,
    sharing_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS incident_units(
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id),
    vehicle_id TEXT NOT NULL REFERENCES fleet_vehicles(id),
    status TEXT NOT NULL,
    dest_kind TEXT NOT NULL DEFAULT 'incident',
    dest_lat REAL NOT NULL,
    dest_lon REAL NOT NULL,
    dest_name TEXT,
    assigned_by TEXT NOT NULL,
    assigned_at TEXT NOT NULL,
    accepted_at TEXT,
    on_scene_at TEXT,
    transport_at TEXT,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS incident_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL REFERENCES incidents(id),
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    public INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public_alerts(
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    radius_m REAL NOT NULL,
    incident_id TEXT REFERENCES incidents(id),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    org_id TEXT,
    reason TEXT
);

CREATE TABLE IF NOT EXISTS enrollments(
    id TEXT PRIMARY KEY,
    code_hash TEXT UNIQUE,
    app TEXT NOT NULL,
    subject_type TEXT,
    subject_id TEXT,
    label TEXT NOT NULL,
    org_id TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
);

CREATE TABLE IF NOT EXISTS account_requests(
    id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    vehicle_id TEXT,
    target_phone TEXT,
    note TEXT,
    org_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_note TEXT
);

CREATE TABLE IF NOT EXISTS ai_settings(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT,
    updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_units_incident ON incident_units(incident_id);
CREATE INDEX IF NOT EXISTS idx_units_vehicle ON incident_units(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_assign_vehicle ON assignments(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_requests(phone);
"""


async def init_schema_v2() -> None:
    async with aiosqlite.connect(config.DB_PATH) as conn:
        # WAL: drivers post GPS fixes every second while dashboards read -
        # without it, readers and the writer serialize on the whole file.
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.executescript(SCHEMA_V2)
        # Columns added after the first release - added in place, data kept.
        for table, col, decl in (("citizens", "address", "TEXT"), ("citizens", "pw_hash", "TEXT"),
                                 ("citizens", "pw_salt", "TEXT"),
                                 # triage (triage.py): 1-5 score and its key terms / needs as JSON
                                 ("incidents", "severity_score", "INTEGER"), ("incidents", "triage", "TEXT"),
                                 # first human response from Command - stops the AI dispatch agent
                                 ("incidents", "responded_at", "TEXT"), ("incidents", "responded_by", "TEXT"),
                                 ("incidents", "ai_state", "TEXT"),
                                 # a voice report: {"language", "original"} (no audio is kept)
                                 ("incidents", "voice", "TEXT"),
                                 # removed by an admin (staff.py): deactivated, personal data erased
                                 ("gov_users", "deleted_at", "TEXT"), ("fleet_vehicles", "deleted_at", "TEXT"),
                                 # the AI responder's spoken interview with the reporter (responder.py)
                                 ("incidents", "interview", "TEXT")):
            cur = await conn.execute(f"PRAGMA table_info({table})")
            if col not in {r[1] for r in await cur.fetchall()}:
                await conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        # Sign-ins made under the old 12-hour limit now last like new ones.
        from datetime import datetime, timedelta, timezone

        now = datetime.now(timezone.utc)
        await conn.execute("UPDATE sessions SET expires_at=? WHERE expires_at > ?",
                           ((now + timedelta(seconds=config.SESSION_TTL_SECONDS)).isoformat(), now.isoformat()))
        await conn.commit()


async def connect() -> aiosqlite.Connection:
    conn = await aiosqlite.connect(config.DB_PATH)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys=ON")
    await conn.execute("PRAGMA busy_timeout=5000")
    return conn


async def get_db():
    """FastAPI dependency - one connection per request."""
    conn = await connect()
    try:
        yield conn
    finally:
        await conn.close()


def new_id(prefix: str, nbytes: int = 4) -> str:
    return f"{prefix}-{secrets.token_hex(nbytes).upper()}"
