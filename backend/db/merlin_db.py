"""
merlin_db.py — SQLite access layer for merlin.sqlite
Mirrors sqlite-api.mjs: kv_store, meetings, product_insights tables.
"""

import json
import os
import re
import sqlite3
import threading
from config.config import SQLITE_PATH, MERLIN_REPLICA_PATH

_TS_RE = re.compile(r"\[(\d{2}):(\d{2}):(\d{2})\]")


def _duration_from_transcript(transcript: str) -> float | None:
    """Return duration in minutes from the last [HH:MM:SS] timestamp in transcript."""
    # Check the tail first (fast path); fall back to full scan if not found
    tail = transcript[-300:]
    matches = _TS_RE.findall(tail) or _TS_RE.findall(transcript)
    if not matches:
        return None
    h, m, s = matches[-1]
    sec = int(h) * 3600 + int(m) * 60 + int(s)
    return sec / 60 if sec > 0 else None

os.makedirs(os.path.dirname(os.path.abspath(SQLITE_PATH)), exist_ok=True)

# RLock, not Lock: replica readers hold _lock while calling _get_replica_conn(),
# which self-heals a missing replica file by calling replicate_to_read_replica() —
# itself also acquiring _lock. A plain Lock would deadlock the calling thread.
_lock = threading.RLock()
_conn: sqlite3.Connection | None = None


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(SQLITE_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.executescript("""
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA cache_size = -16000;
            PRAGMA temp_store = MEMORY;
        """)
        _init_schema(_conn)
    return _conn


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS kv_store (
            key   TEXT NOT NULL PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS product_insights (
            call_id       TEXT NOT NULL PRIMARY KEY,
            call_title    TEXT,
            ae_name       TEXT,
            client_name   TEXT,
            date          TEXT,
            transcript_url TEXT,
            items         TEXT NOT NULL,
            analyzed_at   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS meetings (
            id                       TEXT NOT NULL PRIMARY KEY,
            title                    TEXT,
            date                     INTEGER,
            duration                 INTEGER,
            organizer_email          TEXT,
            host_email               TEXT,
            transcript_url           TEXT,
            audio_url                TEXT,
            video_url                TEXT,
            meeting_type             TEXT,
            meeting_attendees        TEXT,
            user                     TEXT,
            summary_keywords         TEXT,
            summary_action_items     TEXT,
            summary_outline          TEXT,
            summary_shorthand_bullet TEXT,
            summary_overview         TEXT,
            summary_bullet_gist      TEXT,
            summary_short_summary    TEXT,
            sentences                TEXT,
            metadata                 TEXT,
            transcript               TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date DESC);
    """)
    conn.commit()
    # Migrations: add columns that didn't exist in earlier schema versions
    for col, typedef in [("transcript", "TEXT"), ("video_url", "TEXT")]:
        try:
            conn.execute(f"ALTER TABLE meetings ADD COLUMN {col} {typedef}")
            conn.commit()
        except Exception:
            pass  # column already exists

    # Backfill: populate transcript for rows that have sentences but no transcript yet
    rows = conn.execute(
        "SELECT id, sentences FROM meetings WHERE transcript IS NULL AND sentences IS NOT NULL AND sentences != '[]'"
    ).fetchall()
    updated = 0
    for row in rows:
        try:
            sentences = json.loads(row["sentences"] or "[]")
            parts = []
            for s in sentences:
                text = (s.get("text") or "").strip()
                if not text:
                    continue
                sec = int(float(s.get("start_time") or 0))
                ts = f"[{sec // 3600:02d}:{(sec % 3600) // 60:02d}:{sec % 60:02d}]"
                speaker = (s.get("speaker_name") or "Speaker").strip()
                parts.append(f"{ts} {speaker}: {text}")
            transcript_text = "\n".join(parts)
            if transcript_text:
                conn.execute("UPDATE meetings SET transcript = ? WHERE id = ?", (transcript_text, row["id"]))
                updated += 1
        except Exception:
            pass
    if updated:
        conn.commit()
        print(f"[db] backfilled transcript for {updated} meeting(s)")


def close_db() -> None:
    global _conn
    with _lock:
        if _conn:
            _conn.close()
            _conn = None
    close_replica()


# ─── Read replica ─────────────────────────────────────────────────────────────
# A separate file, read-only, that frontend-facing GET endpoints query instead
# of the primary. Refreshed via SQLite's online backup API (safe to run while
# the primary is mid-write) right after each sync writes to the primary —
# see replicate_to_read_replica() callers in interface/handler.py.

_replica_conn: sqlite3.Connection | None = None


def replicate_to_read_replica() -> None:
    """Snapshot the primary DB into the read replica file.

    The actual page-by-page copy (multi-second for a 150MB+ DB) runs with NO
    lock held: it uses its own read-only connection to the primary file (WAL
    mode gives it a consistent snapshot without blocking/being blocked by
    concurrent writers) and writes into a fresh temp file nobody else has
    open. _lock is only taken twice, briefly: once to make sure the primary
    is initialized, and once at the end to close the old replica handle and
    atomically swap the temp file into place. Previously the whole backup()
    call ran under _lock, so every frontend-facing GET request (which also
    takes _lock to read the replica) queued up behind it for the full copy
    duration every sync — e.g. /data or the calls library timing out while a
    Fireflies/HubSpot cron sync was replicating.
    """
    global _replica_conn
    with _lock:
        _get_conn()  # ensure primary connection/schema exists

    tmp_path = MERLIN_REPLICA_PATH + ".tmp"
    for suffix in ("", "-wal", "-shm", "-journal"):
        try:
            os.remove(tmp_path + suffix)
        except FileNotFoundError:
            pass

    src = sqlite3.connect(f"file:{SQLITE_PATH}?mode=ro", uri=True)
    dest = sqlite3.connect(tmp_path)
    try:
        src.backup(dest)
    finally:
        src.close()
        dest.close()

    with _lock:
        if _replica_conn is not None:
            _replica_conn.close()
            _replica_conn = None
        os.replace(tmp_path, MERLIN_REPLICA_PATH)


def _get_replica_conn() -> sqlite3.Connection:
    global _replica_conn
    if _replica_conn is None:
        if not os.path.exists(MERLIN_REPLICA_PATH):
            replicate_to_read_replica()
        _replica_conn = sqlite3.connect(f"file:{MERLIN_REPLICA_PATH}?mode=ro", uri=True, check_same_thread=False)
        _replica_conn.row_factory = sqlite3.Row
        _replica_conn.executescript("""
            PRAGMA cache_size = -65536;
            PRAGMA mmap_size = 268435456;
            PRAGMA temp_store = MEMORY;
        """)
    return _replica_conn


def close_replica() -> None:
    global _replica_conn
    with _lock:
        if _replica_conn:
            _replica_conn.close()
            _replica_conn = None


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _safe_json(val, fallback):
    if val is None:
        return fallback
    if isinstance(val, (dict, list)):
        return val
    try:
        return json.loads(val)
    except Exception:
        return fallback


def _meeting_to_row(m: dict) -> dict:
    summary = m.get("summary") or {}

    attendees = m.get("meeting_attendees") or []
    if not attendees and m.get("participants"):
        attendees = [
            {"email": e, "name": "", "displayName": "", "phoneNumber": "", "location": ""}
            for e in (m.get("participants") or [])
        ]

    bg = summary.get("bullet_gist")
    if isinstance(bg, list):
        bullet_gist_str = json.dumps(bg)
    elif isinstance(bg, str):
        bullet_gist_str = bg
    else:
        bullet_gist_str = ""

    # Build plain-text transcript from sentences with [HH:MM:SS] timestamps
    sentences = m.get("sentences") or []
    if isinstance(sentences, str):
        try:
            sentences = json.loads(sentences)
        except Exception:
            sentences = []
    transcript_parts = []
    for s in sentences:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        sec = int(float(s.get("start_time") or 0))
        ts = f"[{sec // 3600:02d}:{(sec % 3600) // 60:02d}:{sec % 60:02d}]"
        speaker = (s.get("speaker_name") or "Speaker").strip()
        transcript_parts.append(f"{ts} {speaker}: {text}")
    transcript_text = "\n".join(transcript_parts)

    # Extra fields from the official Fireflies schema stored in metadata
    extra_meta = {
        **(m.get("metadata") or {}),
        "dateString":      m.get("dateString"),
        "privacy":         m.get("privacy"),
        "meeting_link":    m.get("meeting_link"),
        "is_live":         m.get("is_live"),
        "speakers":        m.get("speakers") or [],
        "summary_gist":             summary.get("gist"),
        "summary_short_overview":   summary.get("short_overview"),
        "summary_meeting_type":     summary.get("meeting_type"),
        "summary_topics_discussed": summary.get("topics_discussed") or [],
    }

    return {
        "id":                      m.get("id"),
        "title":                   m.get("title"),
        "date":                    m.get("date"),
        "duration":                m.get("duration"),
        "organizer_email":         m.get("organizer_email"),
        "host_email":              m.get("host_email"),
        "transcript_url":          m.get("transcript_url"),
        "audio_url":               m.get("audio_url"),
        "video_url":               m.get("video_url"),
        "meeting_type":            m.get("meeting_type"),
        "meeting_attendees":       json.dumps(attendees),
        "user":                    json.dumps(m.get("user")),
        "summary_keywords":        json.dumps(summary.get("keywords") or []),
        "summary_action_items":    json.dumps(summary.get("action_items") or []),
        "summary_outline":         json.dumps(summary.get("outline") or []),
        "summary_shorthand_bullet":json.dumps(summary.get("shorthand_bullet") or []),
        "summary_overview":        summary.get("overview"),
        "summary_bullet_gist":     bullet_gist_str or None,
        "summary_short_summary":   summary.get("short_summary"),
        "sentences":               json.dumps(m.get("sentences") or []),
        "metadata":                json.dumps(extra_meta),
        "transcript":              transcript_text or m.get("transcript") or None,
    }


def _row_to_meeting(row) -> dict | None:
    if row is None:
        return None
    r = dict(row)
    attendees = _safe_json(r.get("meeting_attendees"), [])
    meta = _safe_json(r.get("metadata"), {}) or {}
    duration = r["duration"]
    if not duration:
        transcript = r.get("transcript") or ""
        if transcript:
            duration = _duration_from_transcript(transcript)
    return {
        "id":               r["id"],
        "title":            r["title"],
        "date":             r["date"],
        "dateString":       meta.get("dateString"),
        "duration":         duration,
        "privacy":          meta.get("privacy"),
        "organizer_email":  r["organizer_email"],
        "host_email":       r["host_email"],
        "transcript_url":   r["transcript_url"],
        "audio_url":        r["audio_url"],
        "video_url":        r.get("video_url"),
        "meeting_link":     meta.get("meeting_link"),
        "is_live":          meta.get("is_live"),
        "meeting_type":     r["meeting_type"],
        "meeting_attendees": attendees,
        "participants":     [a["email"] for a in attendees if a.get("email")],
        "speakers":         meta.get("speakers") or [],
        "user":             _safe_json(r.get("user"), None),
        "summary": {
            "keywords":          _safe_json(r.get("summary_keywords"), []),
            "action_items":      _safe_json(r.get("summary_action_items"), []),
            "outline":           _safe_json(r.get("summary_outline"), []),
            "shorthand_bullet":  _safe_json(r.get("summary_shorthand_bullet"), []),
            "overview":          r.get("summary_overview") or "",
            "bullet_gist":       r.get("summary_bullet_gist") or "",
            "short_summary":     r.get("summary_short_summary") or "",
            "gist":              meta.get("summary_gist") or "",
            "short_overview":    meta.get("summary_short_overview") or "",
            "meeting_type":      meta.get("summary_meeting_type") or "",
            "topics_discussed":  meta.get("summary_topics_discussed") or [],
        },
        "sentences":  _safe_json(r.get("sentences"), []),
        "metadata":   meta,
        "transcript": r.get("transcript") or "",
    }


# ─── KV store ─────────────────────────────────────────────────────────────────

_ALL_COLS = [
    "id", "title", "date", "duration", "organizer_email", "host_email",
    "transcript_url", "audio_url", "video_url", "meeting_type",
    "meeting_attendees", "user",
    "summary_keywords", "summary_action_items", "summary_outline", "summary_shorthand_bullet",
    "summary_overview", "summary_bullet_gist", "summary_short_summary",
    "sentences", "metadata", "transcript",
]

_UPSERT_SQL = f"""
    INSERT INTO meetings ({", ".join(_ALL_COLS)})
    VALUES ({", ".join(":" + c for c in _ALL_COLS)})
    ON CONFLICT(id) DO UPDATE SET
    {", ".join(f"{c} = excluded.{c}" for c in _ALL_COLS if c != "id")}
"""


def kv_get(key: str):
    with _lock:
        row = _get_conn().execute("SELECT value FROM kv_store WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else None


def kv_set(key: str, value) -> None:
    with _lock:
        conn = _get_conn()
        conn.execute(
            "INSERT INTO kv_store (key, value) VALUES (?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )
        conn.commit()


def kv_del(key: str) -> None:
    with _lock:
        conn = _get_conn()
        conn.execute("DELETE FROM kv_store WHERE key = ?", (key,))
        conn.commit()


def kv_mdel(keys: list[str]) -> None:
    if not keys:
        return
    with _lock:
        conn = _get_conn()
        conn.execute(f"DELETE FROM kv_store WHERE key IN ({','.join('?' * len(keys))})", keys)
        conn.commit()


def kv_get_by_prefix(prefix: str) -> list:
    with _lock:
        rows = _get_conn().execute(
            "SELECT value FROM kv_store WHERE key LIKE ?", (f"{prefix}%",)
        ).fetchall()
        return [json.loads(r["value"]) for r in rows]


def kv_mset(keys: list[str], values: list) -> None:
    if len(keys) != len(values):
        raise ValueError("kv_mset keys/values length mismatch")
    with _lock:
        conn = _get_conn()
        with conn:
            for k, v in zip(keys, values):
                conn.execute(
                    "INSERT INTO kv_store (key, value) VALUES (?, ?)"
                    " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (k, json.dumps(v)),
                )


# ─── Meetings ─────────────────────────────────────────────────────────────────

def upsert_meetings(meetings: list[dict] | dict) -> None:
    global _light_cache
    arr = meetings if isinstance(meetings, list) else [meetings]
    if not arr:
        return
    rows = [_meeting_to_row(m) for m in arr]
    with _lock:
        conn = _get_conn()
        with conn:
            conn.executemany(_UPSERT_SQL, rows)
        _light_cache = None


def get_all_meetings() -> list[dict]:
    with _lock:
        rows = _get_conn().execute("SELECT * FROM meetings").fetchall()
        return [_row_to_meeting(r) for r in rows]


_LIGHT_COLS = [c for c in _ALL_COLS if c != "sentences"]

# In-process cache for get_all_meetings_light() — the meetings table only
# changes via upsert_meetings()/delete_meetings() below, both of which
# invalidate this. Reads (dashboard/list loads) vastly outnumber writes
# (only on sync), so this turns a ~200ms+ full-table scan into a cache hit.
_light_cache: list[dict] | None = None


def get_all_meetings_light() -> list[dict]:
    """Same row shape as get_all_meetings() but skips the (often large)
    sentences blob and sorts in SQL (indexed on date) — for callers that
    only need list/filter fields, not the full per-sentence transcript.
    Cached until the next upsert_meetings()/delete_meetings() call."""
    global _light_cache
    with _lock:
        if _light_cache is not None:
            return list(_light_cache)
        rows = _get_conn().execute(
            f"SELECT {', '.join(_LIGHT_COLS)} FROM meetings ORDER BY date DESC"
        ).fetchall()
        _light_cache = [_row_to_meeting(r) for r in rows]
        return list(_light_cache)


def get_all_meetings_light_replica() -> list[dict]:
    """Same as get_all_meetings_light() but reads from the read replica file
    instead of the primary — for frontend-facing GET endpoints (list_calls(),
    get_combined_data()) so they never contend with an in-progress sync write."""
    with _lock:
        rows = _get_replica_conn().execute(
            f"SELECT {', '.join(_LIGHT_COLS)} FROM meetings ORDER BY date DESC"
        ).fetchall()
        return [_row_to_meeting(r) for r in rows]


def get_all_meeting_ids() -> set[str]:
    """Just the ids — for existence checks that don't need row data at all."""
    with _lock:
        rows = _get_conn().execute("SELECT id FROM meetings").fetchall()
        return {r["id"] for r in rows}


def get_meeting_by_id(meeting_id: str) -> dict | None:
    with _lock:
        row = _get_conn().execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        return _row_to_meeting(row)


def delete_meetings(ids: list[str]) -> None:
    global _light_cache
    if not ids:
        return
    with _lock:
        conn = _get_conn()
        conn.execute(
            f"DELETE FROM meetings WHERE id IN ({','.join('?' * len(ids))})", ids
        )
        conn.commit()
        _light_cache = None


# ─── Product insights ─────────────────────────────────────────────────────────

_UPSERT_INSIGHT_SQL = """
    INSERT INTO product_insights
        (call_id, call_title, ae_name, client_name, date, transcript_url, items, analyzed_at)
    VALUES
        (:call_id, :call_title, :ae_name, :client_name, :date, :transcript_url, :items, :analyzed_at)
    ON CONFLICT(call_id) DO UPDATE SET
        call_title    = excluded.call_title,
        ae_name       = excluded.ae_name,
        client_name   = excluded.client_name,
        date          = excluded.date,
        transcript_url= excluded.transcript_url,
        items         = excluded.items,
        analyzed_at   = excluded.analyzed_at
"""


def upsert_product_insights(results: list[dict]) -> None:
    arr = results if isinstance(results, list) else [results]
    if not arr:
        return
    import time
    now = int(time.time() * 1000)
    rows = [{**r, "items": json.dumps(r.get("items") or []), "analyzed_at": now} for r in arr]
    with _lock:
        conn = _get_conn()
        with conn:
            conn.executemany(_UPSERT_INSIGHT_SQL, rows)


_PRODUCT_INSIGHTS_QUERY = """
    SELECT pi.*, m.summary_bullet_gist, m.summary_short_summary
    FROM product_insights pi
    LEFT JOIN meetings m ON pi.call_id = m.id
    ORDER BY pi.analyzed_at DESC
"""


def get_all_product_insights() -> list[dict]:
    with _lock:
        rows = _get_conn().execute(_PRODUCT_INSIGHTS_QUERY).fetchall()
        return [{**dict(r), "items": json.loads(r["items"] or "[]")} for r in rows]


def get_all_product_insights_replica() -> list[dict]:
    """Same as get_all_product_insights() but reads from the read replica —
    for the frontend-facing GET /product-insights endpoint."""
    with _lock:
        rows = _get_replica_conn().execute(_PRODUCT_INSIGHTS_QUERY).fetchall()
        return [{**dict(r), "items": json.loads(r["items"] or "[]")} for r in rows]


def delete_product_insights(ids: list[str] | None = None) -> None:
    with _lock:
        conn = _get_conn()
        if not ids:
            conn.execute("DELETE FROM product_insights")
        else:
            conn.execute(
                f"DELETE FROM product_insights WHERE call_id IN ({','.join('?' * len(ids))})", ids
            )
        conn.commit()
