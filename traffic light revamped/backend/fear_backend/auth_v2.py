"""Sessions for the two apps - the same opaque bearer tokens as main.py (the
existing sessions table), with subject_type 'gov' (gov_users.id) or 'citizen'
(citizens.id). A token for one app is useless against the other's endpoints."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

import aiosqlite
from fastapi import Depends, Header, HTTPException

from . import config, schema_v2, security


async def create_session(conn: aiosqlite.Connection, subject_type: str, subject_id: str) -> str:
    token = security.gen_token()
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=config.SESSION_TTL_SECONDS)).isoformat()
    await conn.execute(
        "INSERT INTO sessions(token, subject_type, subject_id, expires_at) VALUES (?,?,?,?)",
        (token, subject_type, subject_id, expires_at),
    )
    await conn.commit()
    return token


async def subject_for_token(conn: aiosqlite.Connection, token: Optional[str], subject_type: str) -> Optional[str]:
    if not token:
        return None
    cur = await conn.execute("SELECT * FROM sessions WHERE token=? AND subject_type=?", (token, subject_type))
    row = await cur.fetchone()
    if row is None:
        return None
    if datetime.fromisoformat(row["expires_at"]) < datetime.now(timezone.utc):
        await conn.execute("DELETE FROM sessions WHERE token=?", (token,))
        await conn.commit()
        return None
    return row["subject_id"]


def bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return authorization[len("Bearer "):].strip()


async def load_gov_user(conn: aiosqlite.Connection, user_id: str):
    cur = await conn.execute(
        """SELECT g.*, o.name AS org_name, o.kind AS org_kind, o.verified AS org_verified
           FROM gov_users g LEFT JOIN organizations o ON o.id = g.org_id WHERE g.id=?""",
        (user_id,),
    )
    return await cur.fetchone()


async def current_gov_user(authorization: Optional[str] = Header(None),
                           conn: aiosqlite.Connection = Depends(schema_v2.get_db)):
    uid = await subject_for_token(conn, bearer(authorization), "gov")
    if uid is None:
        raise HTTPException(401, "sign in required")
    user = await load_gov_user(conn, uid)
    if user is None or not user["active"]:
        raise HTTPException(401, "account disabled")
    return user


async def current_citizen(authorization: Optional[str] = Header(None),
                          conn: aiosqlite.Connection = Depends(schema_v2.get_db)):
    cid = await subject_for_token(conn, bearer(authorization), "citizen")
    if cid is None:
        raise HTTPException(401, "sign in required")
    cur = await conn.execute("SELECT * FROM citizens WHERE id=? AND deleted_at IS NULL", (cid,))
    c = await cur.fetchone()
    if c is None:
        raise HTTPException(401, "account not found")
    return c


def require_roles(user, *roles: str) -> None:
    if user["role"] not in roles:
        raise HTTPException(403, "your role cannot do this")
