"""
User accounts: signup/login backed by SQLite (same simple stdlib-sqlite3
approach as storage.py - swap for a real user-store/IdP before this handles
real customer data). Sessions themselves are handled by Starlette's
SessionMiddleware (a signed cookie, via the `itsdangerous` package) in
server.py - this module only owns the users table and password hashing.

Password hashing uses stdlib hashlib.pbkdf2_hmac (no extra dependency) with
a random per-user salt and a deliberately high iteration count. This is a
reasonable, dependency-free choice for a prototype; bcrypt/argon2 would be
preferable in production and are drop-in replacements for `_hash_password`.
"""
from __future__ import annotations

import hashlib
import os
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

PBKDF2_ITERATIONS = 260_000

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    created_at REAL NOT NULL
);
"""


@dataclass
class User:
    id: int
    email: str
    plan: str


class EmailAlreadyRegistered(Exception):
    pass


class InvalidCredentials(Exception):
    pass


def _hash_password(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS).hex()


class AccountStore:
    def __init__(self, db_path: str):
        self._db_path = db_path
        # See the matching comment in storage.py: DB_PATH usually points at
        # a mounted volume in production, and creating the parent directory
        # up front turns a missing-volume mistake into a working (if
        # not-yet-persistent) database instead of a crash loop.
        parent = Path(db_path).parent
        if str(parent) not in ("", "."):
            parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        conn = self._connect()
        conn.executescript(_SCHEMA)
        conn.commit()
        conn.close()

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self._db_path, check_same_thread=False)

    def create_user(self, email: str, password: str) -> User:
        email = email.strip().lower()
        if not email or "@" not in email:
            raise ValueError("A valid email is required.")
        if len(password) < 8:
            raise ValueError("Password must be at least 8 characters.")

        salt = os.urandom(16)
        password_hash = _hash_password(password, salt)
        with self._lock:
            conn = self._connect()
            try:
                cur = conn.execute(
                    "INSERT INTO users (email, password_hash, salt, plan, created_at) VALUES (?, ?, ?, 'free', ?)",
                    (email, password_hash, salt.hex(), time.time()),
                )
                conn.commit()
                return User(id=cur.lastrowid, email=email, plan="free")
            except sqlite3.IntegrityError:
                raise EmailAlreadyRegistered(f"{email} is already registered.")
            finally:
                conn.close()

    def verify_login(self, email: str, password: str) -> User:
        email = email.strip().lower()
        with self._lock:
            conn = self._connect()
            try:
                row = conn.execute(
                    "SELECT id, password_hash, salt, plan FROM users WHERE email = ?", (email,)
                ).fetchone()
            finally:
                conn.close()
        if row is None:
            raise InvalidCredentials("No account with that email.")
        user_id, stored_hash, salt_hex, plan = row
        if _hash_password(password, bytes.fromhex(salt_hex)) != stored_hash:
            raise InvalidCredentials("Incorrect password.")
        return User(id=user_id, email=email, plan=plan)

    def get_user(self, user_id: int) -> Optional[User]:
        with self._lock:
            conn = self._connect()
            try:
                row = conn.execute("SELECT id, email, plan FROM users WHERE id = ?", (user_id,)).fetchone()
            finally:
                conn.close()
        return User(*row) if row else None

    def set_plan(self, user_id: int, plan: str) -> None:
        with self._lock:
            conn = self._connect()
            try:
                conn.execute("UPDATE users SET plan = ? WHERE id = ?", (plan, user_id))
                conn.commit()
            finally:
                conn.close()
