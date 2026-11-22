"""Seeds a demo FEAR deployment for Ghaziabad (the mapped area): departments,
hospitals and police stations taken from the map, Command seats for every
authority, emergency/public vehicles with assigned drivers.

Run from `traffic light revamped` (the fear_backend must not be running, or
restart it afterwards so it reloads the fleet):

    ../.venv/Scripts/python.exe -m backend.fear_backend.seed_demo [--reset]

--reset wipes everything the two apps created (accounts, incidents, alerts,
citizens) first. Generated test logins are written to
apps/DEMO_CREDENTIALS.md in the repo root - not printed.
"""

from __future__ import annotations

import os
import secrets
import sqlite3
import sys
from datetime import datetime, timezone

from . import config, geo, security
from .bootstrap import PLATFORM_ORG_ID, SUPER_ADMIN_USERNAME
from .schema_v2 import SCHEMA_V2

CREDENTIALS_PATH = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "apps", "DEMO_CREDENTIALS.md"))

V2_TABLES = ["audit_log", "public_alerts", "incident_events", "incident_units", "incident_contacts", "incidents",
             "citizen_vehicles", "dev_outbox", "otp_requests", "fleet_location", "duty", "assignments", "drivers",
             "fleet_vehicles", "citizens", "gov_users", "organizations"]

# (key, name, kind, parent key)
ORGS = [
    ("health", "Ghaziabad District Health Department", "health_dept", None),
    ("mmg", "District MMG Hospital", "hospital", "health"),
    ("yashoda", "Yashoda Super Speciality Hospital", "hospital", "health"),
    ("fire", "Ghaziabad Fire & Emergency Services", "fire_dept", None),
    ("police", "Ghaziabad Police Headquarters", "police_hq", None),
    ("kotwali", "Kotwali Ghaziabad Police Station", "police_station", "police"),
    ("rto", "RTO Ghaziabad (UP Transport Department)", "transport_dept", None),
    ("upsrtc", "UPSRTC Ghaziabad Depot", "transport_corp", "rto"),
    ("nagar", "Ghaziabad Nagar Nigam", "municipal", None),
    ("logistics", "Hindon Logistics Pvt Ltd", "enterprise", None),
]

OPERATORS = [
    ("iccc", "Integrated Command & Control Centre (ICCC)", "iccc"),
    ("traffic", "City Traffic Command", "city_traffic"),
    ("health", "Health Emergency Command (108)", "health_command"),
    ("fire", "Fire Command (101)", "fire_command"),
    ("police", "Police Command (112)", "police_command"),
    ("municipal", "Municipal Control Room", "municipal"),
    ("rto", "RTO Verification Desk", "rto"),
    ("analytics", "Government Analytics", "analytics"),
]

ORG_ADMINS = [("health", "Health Dept Administrator"), ("mmg", "MMG Hospital Administrator"),
              ("fire", "Fire Services Administrator"), ("police", "Police HQ Administrator"),
              ("upsrtc", "UPSRTC Depot Administrator"), ("nagar", "Nagar Nigam Administrator"),
              ("logistics", "Hindon Logistics Fleet Admin")]

# (org key, category, plate, make, driver name, start x, start y)  - x/y in map metres
VEHICLES = [
    ("health", "ambulance", "UP14 GA 1081", "Force Traveller BLS", "Ravi Kumar", -2440, -490),
    ("mmg", "ambulance", "UP14 GA 1082", "Tata Winger ALS", "Sunil Yadav", -2400, -520),
    ("yashoda", "ambulance", "UP14 HB 2240", "Force Traveller ALS", "Imran Khan", -1000, -760),
    ("fire", "firetruck", "UP14 FS 0101", "Tata LPT 1613 Water Tender", "Harpreet Singh", -1480, -1220),
    ("fire", "firetruck", "UP14 FS 0102", "Ashok Leyland Rescue Tender", "Deepak Chauhan", -1760, -1000),
    ("kotwali", "police", "UP14 PC 3301", "Mahindra Bolero PCR", "Ankit Sharma", 0, -850),
    ("police", "police", "UP14 PC 3302", "Maruti Ertiga PCR", "Pooja Verma", 300, 200),
    ("upsrtc", "bus", "UP14 BT 7710", "Tata Starbus", "Mahesh Pal", 1400, 100),
    ("nagar", "municipal", "UP14 NN 4402", "Tata Ace Garbage Tipper", "Rakesh Tomar", -600, 400),
    ("logistics", "commercial", "UP14 CT 9921", "Ashok Leyland Dost", "Vikas Jain", 900, -300),
]

PREFIX = {"ambulance": "AMB", "firetruck": "FIR", "police": "POL", "bus": "BUS", "municipal": "MUN",
          "government": "GOV", "commercial": "COM"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(3).upper()}"


def user(conn, username: str, name: str, role: str, org_id, authority=None) -> tuple[str, str]:
    password = security.gen_password()
    h, s = security.hash_password(password)
    uid = new_id("USR")
    conn.execute("""INSERT INTO gov_users(id, username, pw_hash, pw_salt, display_name, role, org_id, authority, active, created_at)
                    VALUES (?,?,?,?,?,?,?,?,1,?)""", (uid, username, h, s, name, role, org_id, authority, now()))
    return uid, password


def main() -> None:
    reset = "--reset" in sys.argv
    conn = sqlite3.connect(config.DB_PATH)
    conn.executescript(SCHEMA_V2)
    if reset:
        for t in V2_TABLES:
            conn.execute(f"DELETE FROM {t}")
        conn.execute("DELETE FROM sessions WHERE subject_type IN ('gov','citizen')")
    elif conn.execute("SELECT COUNT(*) FROM organizations WHERE id != ?", (PLATFORM_ORG_ID,)).fetchone()[0]:
        sys.exit("demo data already present - re-run with --reset to start over")

    conn.execute("INSERT OR IGNORE INTO organizations(id, name, kind, parent_id, verified, created_at) VALUES (?,?,?,NULL,1,?)",
                 (PLATFORM_ORG_ID, "FEAR Platform", "platform", now()))
    creds = []
    conn.execute("DELETE FROM gov_users WHERE role='super_admin'")
    _, pw = user(conn, SUPER_ADMIN_USERNAME, "FEAR Super Admin", "super_admin", PLATFORM_ORG_ID)
    creds.append(("Super admin (platform)", SUPER_ADMIN_USERNAME, pw))

    org_ids = {}
    for key, name, kind, parent in ORGS:
        oid = new_id("ORG")
        org_ids[key] = oid
        conn.execute("INSERT INTO organizations(id, name, kind, parent_id, verified, created_at) VALUES (?,?,?,?,1,?)",
                     (oid, name, kind, org_ids.get(parent), now()))

    op_orgs = {"health": "health", "fire": "fire", "police": "police", "municipal": "nagar", "rto": "rto"}
    for key, name, authority in OPERATORS:
        username = f"cmd-{key}"
        _, pw = user(conn, username, name, "operator", org_ids.get(op_orgs.get(key, "")), authority)
        creds.append((f"Command seat: {name}", username, pw))

    for key, name in ORG_ADMINS:
        username = f"admin-{key}"
        _, pw = user(conn, username, name, "org_admin", org_ids[key])
        creds.append((f"Org admin: {name}", username, pw))

    vehicle_rows = []
    for org_key, category, plate, make, driver, x, y in VEHICLES:
        while True:
            vid = f"FEAR-{PREFIX[category]}-{secrets.randbelow(9000) + 1000}"
            if not conn.execute("SELECT 1 FROM fleet_vehicles WHERE id=?", (vid,)).fetchone():
                break
        oid = org_ids[org_key]
        conn.execute("INSERT INTO fleet_vehicles(id, org_id, category, plate, make_model, verified, active, created_at) VALUES (?,?,?,?,?,1,1,?)",
                     (vid, oid, category, plate, make, now()))
        first = driver.split()[0].lower()
        username = f"drv-{first}"
        uid, pw = user(conn, username, driver, "driver", oid)
        did = new_id("DRV")
        conn.execute("INSERT INTO drivers(id, gov_user_id, org_id, full_name, phone, licence_no, address, created_at) VALUES (?,?,?,?,?,?,?,?)",
                     (did, uid, oid, driver, f"+9198{secrets.randbelow(10**8):08d}", f"UP14 2019{secrets.randbelow(10**7):07d}", "Ghaziabad", now()))
        conn.execute("INSERT INTO assignments(id, vehicle_id, driver_id, assigned_by, assigned_at) VALUES (?,?,?,?,?)",
                     (new_id("ASG"), vid, did, "seed", now()))
        lat, lon = geo.to_latlon(x, y)
        conn.execute("INSERT INTO fleet_location(vehicle_id, lat, lon, heading, speed_kmh, demo, updated_at) VALUES (?,?,?,?,?,1,?)",
                     (vid, lat, lon, 0, 0, now()))
        vehicle_rows.append((vid, category, plate, dict(ORGS_BY_KEY)[org_key], driver, username, pw))

    conn.commit()
    conn.close()

    os.makedirs(os.path.dirname(CREDENTIALS_PATH), exist_ok=True)
    with open(CREDENTIALS_PATH, "w", encoding="utf-8") as f:
        f.write("# FEAR demo credentials\n\n")
        f.write(f"Generated by `seed_demo.py` on {now()[:19]}Z for local testing only. Re-running the seed with `--reset` replaces them.\n\n")
        f.write("## FEAR Command - Command & Control and administration\n\n| Account | Username | Password |\n|---|---|---|\n")
        for label, u, p in creds:
            f.write(f"| {label} | `{u}` | `{p}` |\n")
        f.write("\n## FEAR Command - drivers (sign in on the phone)\n\n| Vehicle | Category | Plate | Organization | Driver | Username | Password |\n|---|---|---|---|---|---|---|\n")
        for vid, cat, plate, org, driver, u, p in vehicle_rows:
            f.write(f"| {vid} | {cat} | {plate} | {org} | {driver} | `{u}` | `{p}` |\n")
        f.write("\n## FEAR public app\n\nSign in with any 10-digit Indian mobile number. In dev mode the OTP is printed "
                "in the fear_backend console/log (`[fear][dev-otp]`) and listed under **Dev OTP outbox** for the super admin.\n")
        f.write("\n## Phones by QR code\n\nIn the red-lights GUI (http://127.0.0.1:8765/simulation.html), sign in to the FEAR Command "
                "panel as `cmd-iccc` (or `fear-admin` / an org admin) and use **Phones -> Add phone**. The phone app's "
                "**Scan QR** connects to this server and signs in - no typing. QR codes are single-use and expire in 30 minutes.\n")
    print(f"seeded {len(ORGS)} organizations, {len(OPERATORS)} command seats, {len(VEHICLES)} vehicles with drivers")
    print(f"credentials written to {CREDENTIALS_PATH}")


ORGS_BY_KEY = [(k, n) for k, n, _, _ in ORGS]

if __name__ == "__main__":
    main()
