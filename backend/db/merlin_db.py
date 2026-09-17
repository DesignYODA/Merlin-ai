"""
merlin_db.py — MySQL access layer for the fireflies/auth side of glessio_master.
Tables: fireflies_kv, g_fireflies, g_product_insights, g_auth, g_sessions.

Was SQLite (merlin.sqlite: kv_store, meetings, product_insights, auth, sessions) —
migrated to MySQL. Every public function keeps its original name/signature/return
shape so interface.py/handler.py need no changes. See backend/db/mysql_pool.py for
the shared connection pool and full schema DDL.
"""

import json
import re
import time

from db.mysql_pool import get_connection

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


def close_db() -> None:
    """No per-module connection to close anymore — the shared pool (owned by
    mysql_pool.py) is closed once from main.py's lifespan. Kept as a no-op so
    any existing import of close_db doesn't break."""
    pass


def replicate_to_read_replica() -> None:
    """No-op — MySQL's InnoDB engine handles concurrent reads-during-writes
    natively via MVCC, so the SQLite-only "copy to a second file so reads
    don't block on writes" trick this used to do is unnecessary. Kept as a
    no-op so handler.py's existing `await asyncio.to_thread(_replicate_merlin)`
    call sites need no changes."""
    pass


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


def _row_to_meeting(r: dict) -> dict | None:
    if r is None:
        return None
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


# ─── KV store (fireflies_kv) ────────────────────────────────────────────────

def kv_get(key: str):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT `value` FROM fireflies_kv WHERE `key` = %s", (key,))
        row = cur.fetchone()
        cur.close()
        return json.loads(row[0]) if row else None


def kv_set(key: str, value) -> None:
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute(
                "INSERT INTO fireflies_kv (`key`, `value`) VALUES (%s, %s)"
                " ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
                (key, json.dumps(value)),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()


def kv_del(key: str) -> None:
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute("DELETE FROM fireflies_kv WHERE `key` = %s", (key,))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()


def kv_mdel(keys: list[str]) -> None:
    if not keys:
        return
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute(
                f"DELETE FROM fireflies_kv WHERE `key` IN ({','.join(['%s'] * len(keys))})", keys
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()


def kv_get_by_prefix(prefix: str) -> list:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT `value` FROM fireflies_kv WHERE `key` LIKE %s", (f"{prefix}%",))
        rows = cur.fetchall()
        cur.close()
        return [json.loads(r[0]) for r in rows]


def kv_mset(keys: list[str], values: list) -> None:
    if len(keys) != len(values):
        raise ValueError("kv_mset keys/values length mismatch")
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.executemany(
                "INSERT INTO fireflies_kv (`key`, `value`) VALUES (%s, %s)"
                " ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
                [(k, json.dumps(v)) for k, v in zip(keys, values)],
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()


# ─── Meetings (g_fireflies) ─────────────────────────────────────────────────

_ALL_COLS = [
    "id", "title", "date", "duration", "organizer_email", "host_email",
    "transcript_url", "audio_url", "video_url", "meeting_type",
    "meeting_attendees", "user",
    "summary_keywords", "summary_action_items", "summary_outline", "summary_shorthand_bullet",
    "summary_overview", "summary_bullet_gist", "summary_short_summary",
    "sentences", "metadata", "transcript",
]
_QUOTED_COLS = [f"`{c}`" for c in _ALL_COLS]

_UPSERT_SQL = f"""
    INSERT INTO g_fireflies ({", ".join(_QUOTED_COLS)})
    VALUES ({", ".join("%(" + c + ")s" for c in _ALL_COLS)})
    ON DUPLICATE KEY UPDATE
    {", ".join(f"`{c}` = VALUES(`{c}`)" for c in _ALL_COLS if c != "id")}
"""


def upsert_meetings(meetings: list[dict] | dict) -> None:
    global _light_cache
    arr = meetings if isinstance(meetings, list) else [meetings]
    if not arr:
        return
    rows = [_meeting_to_row(m) for m in arr]
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.executemany(_UPSERT_SQL, rows)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()
        _light_cache = None


def get_all_meetings() -> list[dict]:
    with get_connection() as conn:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT * FROM g_fireflies")
        rows = cur.fetchall()
        cur.close()
        return [_row_to_meeting(r) for r in rows]


_LIGHT_COLS = [c for c in _ALL_COLS if c != "sentences"]
_QUOTED_LIGHT_COLS = [f"`{c}`" for c in _LIGHT_COLS]

# In-process cache for get_all_meetings_light() — the meetings table only
# changes via upsert_meetings()/delete_meetings() below, both of which
# invalidate this. Reads (dashboard/list loads) vastly outnumber writes
# (only on sync), so this turns a full-table scan into a cache hit. App-level
# cache, independent of the storage engine — unaffected by the MySQL migration.
_light_cache: list[dict] | None = None


def get_all_meetings_light() -> list[dict]:
    """Same row shape as get_all_meetings() but skips the (often large)
    sentences blob and sorts in SQL (indexed on date) — for callers that
    only need list/filter fields, not the full per-sentence transcript.
    Cached until the next upsert_meetings()/delete_meetings() call."""
    global _light_cache
    if _light_cache is not None:
        return list(_light_cache)
    with get_connection() as conn:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            f"SELECT {', '.join(_QUOTED_LIGHT_COLS)} FROM g_fireflies ORDER BY `date` DESC"
        )
        rows = cur.fetchall()
        cur.close()
    _light_cache = [_row_to_meeting(r) for r in rows]
    return list(_light_cache)


def get_all_meetings_light_replica() -> list[dict]:
    """Historically read from a separate SQLite read-replica file so
    frontend-facing GETs never contended with an in-progress sync write —
    MySQL's InnoDB (MVCC) makes that unnecessary, so this now just reads the
    primary directly. Name kept for handler.py compatibility."""
    return get_all_meetings_light()


def get_all_meeting_ids() -> set[str]:
    """Just the ids — for existence checks that don't need row data at all."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM g_fireflies")
        rows = cur.fetchall()
        cur.close()
        return {r[0] for r in rows}


def get_meeting_by_id(meeting_id: str) -> dict | None:
    with get_connection() as conn:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT * FROM g_fireflies WHERE id = %s", (meeting_id,))
        row = cur.fetchone()
        cur.close()
        return _row_to_meeting(row)


def delete_meetings(ids: list[str]) -> None:
    global _light_cache
    if not ids:
        return
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute(
                f"DELETE FROM g_fireflies WHERE id IN ({','.join(['%s'] * len(ids))})", ids
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()
        _light_cache = None


# ─── Product insights (g_product_insights) ──────────────────────────────────

_UPSERT_INSIGHT_SQL = """
    INSERT INTO g_product_insights
        (call_id, call_title, ae_name, client_name, `date`, transcript_url, items, analyzed_at)
    VALUES
        (%(call_id)s, %(call_title)s, %(ae_name)s, %(client_name)s, %(date)s,
         %(transcript_url)s, %(items)s, %(analyzed_at)s)
    ON DUPLICATE KEY UPDATE
        call_title     = VALUES(call_title),
        ae_name        = VALUES(ae_name),
        client_name    = VALUES(client_name),
        `date`         = VALUES(`date`),
        transcript_url = VALUES(transcript_url),
        items          = VALUES(items),
        analyzed_at    = VALUES(analyzed_at)
"""


def upsert_product_insights(results: list[dict]) -> None:
    arr = results if isinstance(results, list) else [results]
    if not arr:
        return
    now = int(time.time() * 1000)
    rows = [{**r, "items": json.dumps(r.get("items") or []), "analyzed_at": now} for r in arr]
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.executemany(_UPSERT_INSIGHT_SQL, rows)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()


_PRODUCT_INSIGHTS_QUERY = """
    SELECT pi.*, m.summary_bullet_gist, m.summary_short_summary
    FROM g_product_insights pi
    LEFT JOIN g_fireflies m ON pi.call_id = m.id
    ORDER BY pi.analyzed_at DESC
"""


def get_all_product_insights() -> list[dict]:
    with get_connection() as conn:
        cur = conn.cursor(dictionary=True)
        cur.execute(_PRODUCT_INSIGHTS_QUERY)
        rows = cur.fetchall()
        cur.close()
        return [{**r, "items": json.loads(r["items"] or "[]")} for r in rows]


def get_all_product_insights_replica() -> list[dict]:
    """See get_all_meetings_light_replica() — no separate replica needed on
    MySQL. Name kept for handler.py compatibility."""
    return get_all_product_insights()


def delete_product_insights(ids: list[str] | None = None) -> None:
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            if not ids:
                cur.execute("DELETE FROM g_product_insights")
            else:
                cur.execute(
                    f"DELETE FROM g_product_insights WHERE call_id IN ({','.join(['%s'] * len(ids))})", ids
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()


# ─── Auth (g_auth) ────────────────────────────────────────────────────────────

def create_auth_user(emailid: str, username: str, password_hash: str, securityquestion: str, answer_hash: str, title: str = "", role: str = "member") -> dict:
    with get_connection() as conn:
        cur = conn.cursor(dictionary=True)
        try:
            cur.execute(
                "INSERT INTO g_auth (emailid, password, username, securityquestion, answer, title, `role`, lastloggedin)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, NULL)",
                (emailid, password_hash, username, securityquestion, answer_hash, title, role),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        cur.execute("SELECT * FROM g_auth WHERE emailid = %s", (emailid,))
        row = cur.fetchone()
        cur.close()
        return row


def get_auth_user(emailid: str) -> dict | None:
    with get_connection() as conn:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT * FROM g_auth WHERE emailid = %s", (emailid,))
        row = cur.fetchone()
        cur.close()
        return row if row else None


def update_auth_last_logged_in(emailid: str, ts_ms: int) -> None:
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute("UPDATE g_auth SET lastloggedin = %s WHERE emailid = %s", (ts_ms, emailid))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()


def update_auth_password(emailid: str, password_hash: str) -> None:
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute("UPDATE g_auth SET password = %s WHERE emailid = %s", (password_hash, emailid))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()


# ─── Sessions (g_sessions) ────────────────────────────────────────────────────

def create_session(token: str, emailid: str, ttl_ms: int) -> dict:
    now_ms = int(time.time() * 1000)
    expires_at = now_ms + ttl_ms
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute(
                "INSERT INTO g_sessions (token, emailid, created_at, expires_at) VALUES (%s, %s, %s, %s)",
                (token, emailid, now_ms, expires_at),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()
    return {"token": token, "emailid": emailid, "created_at": now_ms, "expires_at": expires_at}


def get_session(token: str) -> dict | None:
    with get_connection() as conn:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT * FROM g_sessions WHERE token = %s", (token,))
        row = cur.fetchone()
        if row is None:
            cur.close()
            return None
        if row["expires_at"] <= int(time.time() * 1000):
            try:
                cur.execute("DELETE FROM g_sessions WHERE token = %s", (token,))
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                cur.close()
            return None
        cur.close()
        return row


def delete_session(token: str) -> None:
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute("DELETE FROM g_sessions WHERE token = %s", (token,))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()
