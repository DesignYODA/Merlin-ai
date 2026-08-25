"""
chat_db.py — SQLite access layer for chat.sqlite
Stores users (UserSchema) and chat sessions (ChatSessionSchema) with message history.
"""

import json
import os
import sqlite3
import threading
import time
import uuid

from config.config import CHAT_PATH

os.makedirs(os.path.dirname(os.path.abspath(CHAT_PATH)), exist_ok=True)

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(CHAT_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.executescript("""
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA cache_size = -8000;
            PRAGMA temp_store = MEMORY;
        """)
        _init_schema(_conn)
    return _conn


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            user_id         TEXT NOT NULL PRIMARY KEY,
            email           TEXT NOT NULL UNIQUE,
            name            TEXT DEFAULT '',
            display_name    TEXT DEFAULT '',
            phone_number    TEXT DEFAULT '',
            location        TEXT DEFAULT '',
            created_at      INTEGER NOT NULL,
            last_active_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_sessions (
            chat_id         TEXT NOT NULL PRIMARY KEY,
            user_id         TEXT NOT NULL,
            session_id      TEXT NOT NULL UNIQUE,
            messages        TEXT NOT NULL DEFAULT '[]',
            chat_summary    TEXT DEFAULT '',
            created_at      INTEGER NOT NULL,
            last_active_at  INTEGER NOT NULL,
            ttl             INTEGER NOT NULL DEFAULT 604800
        );

        CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_active  ON chat_sessions(last_active_at DESC);
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    """)
    conn.commit()


def close_chat_db() -> None:
    global _conn
    with _lock:
        if _conn:
            _conn.close()
            _conn = None


def _now_ms() -> int:
    return int(time.time() * 1000)


# ─── Users ────────────────────────────────────────────────────────────────────

def upsert_user(email: str, name: str = "", display_name: str = "") -> dict:
    now = _now_ms()
    with _lock:
        conn = _get_conn()
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if row:
            conn.execute(
                """UPDATE users
                   SET last_active_at = ?,
                       name = CASE WHEN ? != '' THEN ? ELSE name END,
                       display_name = CASE WHEN ? != '' THEN ? ELSE display_name END
                   WHERE email = ?""",
                (now, name, name, display_name, display_name, email),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        else:
            user_id = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO users (user_id, email, name, display_name, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?)",
                (user_id, email, name, display_name, now, now),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM users WHERE user_id = ?", (user_id,)).fetchone()
        return dict(row)


def get_user_by_email(email: str) -> dict | None:
    with _lock:
        row = _get_conn().execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        return dict(row) if row else None


# ─── Chat sessions ────────────────────────────────────────────────────────────

def _deserialize_session(row) -> dict:
    d = dict(row)
    d["messages"] = json.loads(d.get("messages") or "[]")
    return d


def get_sessions_for_user(user_id: str, limit: int = 20) -> list[dict]:
    with _lock:
        rows = _get_conn().execute(
            "SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY last_active_at DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
        return [_deserialize_session(r) for r in rows]


def get_session(session_id: str) -> dict | None:
    with _lock:
        row = _get_conn().execute(
            "SELECT * FROM chat_sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
        return _deserialize_session(row) if row else None


def create_session(user_id: str, session_id: str | None = None, messages: list | None = None) -> dict:
    now = _now_ms()
    chat_id = str(uuid.uuid4())
    sid = session_id or str(uuid.uuid4())
    msgs_json = json.dumps(messages or [])
    with _lock:
        conn = _get_conn()
        conn.execute(
            """INSERT INTO chat_sessions
               (chat_id, user_id, session_id, messages, created_at, last_active_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (chat_id, user_id, sid, msgs_json, now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM chat_sessions WHERE chat_id = ?", (chat_id,)).fetchone()
        return _deserialize_session(row)


def update_session(session_id: str, messages: list | None = None, chat_summary: str | None = None) -> bool:
    now = _now_ms()
    with _lock:
        conn = _get_conn()
        updates = ["last_active_at = ?"]
        params: list = [now]
        if messages is not None:
            updates.append("messages = ?")
            params.append(json.dumps(messages))
        if chat_summary is not None:
            updates.append("chat_summary = ?")
            params.append(chat_summary)
        params.append(session_id)
        n = conn.execute(
            f"UPDATE chat_sessions SET {', '.join(updates)} WHERE session_id = ?",
            params,
        ).rowcount
        conn.commit()
        return n > 0


def delete_session(session_id: str) -> bool:
    with _lock:
        conn = _get_conn()
        n = conn.execute(
            "DELETE FROM chat_sessions WHERE session_id = ?", (session_id,)
        ).rowcount
        conn.commit()
        return n > 0
