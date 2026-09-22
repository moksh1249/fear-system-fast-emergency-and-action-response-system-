"""SQLite (via aiosqlite - already in the shared venv, no ORM) storage for
fear_backend: employer/employee/driver accounts, the vehicle+owner records an
employee registers, and each vehicle's last known GPS fix."""

import aiosqlite

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS employers(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pw_hash TEXT NOT NULL,
    pw_salt TEXT NOT NULL,
    company_name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employer_id INTEGER NOT NULL REFERENCES employers(id),
    username TEXT UNIQUE NOT NULL,
    pw_hash TEXT NOT NULL,
    pw_salt TEXT NOT NULL,
    full_name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicles(
    id TEXT PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    owner_name TEXT NOT NULL,
    owner_phone TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    owner_id_number TEXT NOT NULL,
    vehicle_type TEXT NOT NULL,
    plate_number TEXT NOT NULL,
    make_model TEXT,
    driver_username TEXT UNIQUE NOT NULL,
    driver_pw_hash TEXT NOT NULL,
    driver_pw_salt TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions(
    token TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS last_location(
    vehicle_id TEXT PRIMARY KEY REFERENCES vehicles(id),
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    heading REAL,
    speed_kmh REAL,
    updated_at TEXT NOT NULL
);
"""


async def init_db() -> None:
    async with aiosqlite.connect(config.DB_PATH) as conn:
        await conn.executescript(SCHEMA)
        await conn.commit()


async def get_conn():
    conn = await aiosqlite.connect(config.DB_PATH)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
    finally:
        await conn.close()
