"""Password hashing / token generation - stdlib only (hashlib PBKDF2-HMAC,
secrets), deliberately not bcrypt/passlib/jwt since none of those are in the
project's shared venv and this doesn't need anything they'd add: sessions are
opaque server-side tokens (see db.py's sessions table), not signed JWTs."""

import hashlib
import hmac
import secrets
import string

PBKDF2_ITERATIONS = 200_000


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERATIONS)
    return digest.hex(), salt


def verify_password(password: str, pw_hash: str, salt: str) -> bool:
    digest, _ = hash_password(password, salt)
    return hmac.compare_digest(digest, pw_hash)


def gen_username(prefix: str) -> str:
    return f"{prefix}{secrets.token_hex(3)}"


def gen_password(length: int = 12) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def gen_token() -> str:
    return secrets.token_urlsafe(32)


def gen_vehicle_id() -> str:
    return f"FV-{secrets.token_hex(3).upper()}"
