"""
analytical_db.py — SQLite access layer for analytical.sqlite
Mirrors analytical-store.mjs: summary, calls_by_day, top_topics,
top_aes, call_action_items, product_analysis tables.
"""

import json
import os
import sqlite3
import threading
from config.config import ANALYTICAL_PATH

os.makedirs(os.path.dirname(os.path.abspath(ANALYTICAL_PATH)), exist_ok=True)

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(ANALYTICAL_PATH, check_same_thread=False)
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
        CREATE TABLE IF NOT EXISTS summary (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            total_calls         INTEGER NOT NULL DEFAULT 0,
            unique_topics       INTEGER NOT NULL DEFAULT 0,
            active_aes          INTEGER NOT NULL DEFAULT 0,
            total_action_items  INTEGER NOT NULL DEFAULT 0,
            positive_sentiment  INTEGER NOT NULL DEFAULT 0,
            neutral_sentiment   INTEGER NOT NULL DEFAULT 0,
            negative_sentiment  INTEGER NOT NULL DEFAULT 0,
            computed_at         INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS calls_by_day (
            day         TEXT NOT NULL PRIMARY KEY,
            count       INTEGER NOT NULL DEFAULT 0,
            computed_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS top_topics (
            topic       TEXT NOT NULL PRIMARY KEY,
            count       INTEGER NOT NULL DEFAULT 0,
            call_ids    TEXT NOT NULL DEFAULT '[]',
            computed_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS top_aes (
            ae_name     TEXT NOT NULL PRIMARY KEY,
            ae_email    TEXT,
            call_count  INTEGER NOT NULL DEFAULT 0,
            computed_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS call_action_items (
            call_id        TEXT NOT NULL PRIMARY KEY,
            call_title     TEXT,
            ae_name        TEXT,
            ae_email       TEXT,
            date_ts        INTEGER,
            transcript_url TEXT,
            action_items   TEXT NOT NULL DEFAULT '[]',
            computed_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS product_analysis (
            uuid                TEXT NOT NULL PRIMARY KEY,
            analysis_dt         TEXT NOT NULL,
            call_title          TEXT,
            ae_name             TEXT,
            date                TEXT,
            summary_bullet_gist TEXT,
            short_summary       TEXT
        );

        CREATE TABLE IF NOT EXISTS marketing_analytics (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            data        TEXT NOT NULL DEFAULT '{}',
            computed_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS sales_analytics (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            data        TEXT NOT NULL DEFAULT '{}',
            computed_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS product_analytics (
            id               INTEGER PRIMARY KEY CHECK (id = 1),
            keyword_ranking  TEXT NOT NULL DEFAULT '[]',
            keyword_trending TEXT NOT NULL DEFAULT '[]',
            computed_at      INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS founders_analytics (
            id                      INTEGER PRIMARY KEY CHECK (id = 1),
            key_initiators          INTEGER NOT NULL DEFAULT 0,
            call_sentiment_trending TEXT NOT NULL DEFAULT '[]',
            competitors_trend       TEXT NOT NULL DEFAULT '[]',
            computed_at             INTEGER NOT NULL DEFAULT 0
        );
    """)
    conn.commit()


def close_analytical_db() -> None:
    global _conn
    with _lock:
        if _conn:
            _conn.close()
            _conn = None


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


def _extract_ae_name(email: str | None) -> str:
    if not email:
        return "Unknown"
    name = email.split("@")[0].replace(".", " ").replace("_", " ").replace("-", " ")
    return " ".join(w.capitalize() for w in name.split())


def _analyze_sentiment(summary: dict | None) -> str:
    if not summary:
        return "neutral"
    bg = summary.get("bullet_gist", "")
    if isinstance(bg, list):
        bg = " ".join(bg)
    text = f"{summary.get('overview', '')} {summary.get('short_summary', '')} {bg}".lower()

    positive = ["great", "excellent", "happy", "excited", "love", "perfect", "amazing",
                "wonderful", "agreed", "successful", "positive", "pleased", "impressed", "opportunity"]
    negative = ["concern", "issue", "problem", "difficult", "frustrated", "unhappy",
                "disappointed", "risk", "blocker", "objection", "worried", "complaint", "unfortunately"]

    score = sum(1 for w in positive if w in text) - sum(1 for w in negative if w in text)
    return "positive" if score > 0 else "negative" if score < 0 else "neutral"


def _extract_topics(summary: dict | None) -> list[str]:
    if not summary or not summary.get("keywords"):
        return []
    seen: set[str] = set()
    result: list[str] = []
    for kw in summary.get("keywords") or []:
        if not kw or not isinstance(kw, str):
            continue
        cleaned = kw.strip()
        if not cleaned:
            continue
        lower = cleaned.lower()
        if lower in seen:
            continue
        seen.add(lower)
        result.append(cleaned)
        if len(result) >= 5:
            break
    return result


# ─── Core processing ──────────────────────────────────────────────────────────

def process_analytics(meetings: list[dict]) -> dict:
    import time
    now = int(time.time() * 1000)

    derived = []
    for m in meetings:
        summary = m.get("summary") or {}
        action_items = summary.get("action_items") or []
        if not isinstance(action_items, list):
            action_items = []
        derived.append({
            "id":           m.get("id"),
            "title":        m.get("title") or "Untitled",
            "ae_email":     m.get("organizer_email") or "",
            "ae_name":      _extract_ae_name(m.get("organizer_email")),
            "date_ts":      m.get("date"),
            "transcript_url": m.get("transcript_url"),
            "sentiment":    _analyze_sentiment(summary),
            "topics":       _extract_topics(summary),
            "action_items": action_items,
        })

    total_calls    = len(derived)
    all_topics     = [t.lower() for d in derived for t in d["topics"]]
    unique_topics  = len(set(all_topics))
    active_aes     = len({d["ae_email"] for d in derived if d["ae_email"]})
    total_ai       = sum(len(d["action_items"]) for d in derived)
    pos_s = sum(1 for d in derived if d["sentiment"] == "positive")
    neu_s = sum(1 for d in derived if d["sentiment"] == "neutral")
    neg_s = sum(1 for d in derived if d["sentiment"] == "negative")

    day_map = {d: 0 for d in _DAY_NAMES}
    for d in derived:
        if d["date_ts"]:
            import datetime
            dt = datetime.datetime.fromtimestamp(d["date_ts"] / 1000)
            day_map[_DAY_NAMES[dt.weekday() + 1 if dt.weekday() < 6 else 0]]  # Sun=0
            # Use Python's isoweekday() — Mon=1..Sun=7; map to our Sun-first array
            # date_ts is ms epoch; weekday() Mon=0..Sun=6
            dow = dt.weekday()  # 0=Mon, 6=Sun
            # We want Sun=0 so shift: Sun→0, Mon→1, ..., Sat→6
            day_idx = (dow + 1) % 7
            day_map[_DAY_NAMES[day_idx]] = day_map.get(_DAY_NAMES[day_idx], 0) + 1

    # rebuild correctly (the loop above double-counts due to the first invalid access)
    day_map = {d: 0 for d in _DAY_NAMES}
    for d in derived:
        if d["date_ts"]:
            import datetime
            dt = datetime.datetime.fromtimestamp(d["date_ts"] / 1000)
            dow = dt.weekday()  # Mon=0..Sun=6
            day_idx = (dow + 1) % 7  # Mon→1, Tue→2, ..., Sun→0
            day_map[_DAY_NAMES[day_idx]] += 1

    topic_map: dict[str, dict] = {}
    for d in derived:
        for t in d["topics"]:
            key = t.lower()
            if key not in topic_map:
                topic_map[key] = {"topic": t, "count": 0, "call_ids": []}
            topic_map[key]["count"] += 1
            topic_map[key]["call_ids"].append(d["id"])

    ae_map: dict[str, dict] = {}
    for d in derived:
        if not d["ae_email"]:
            continue
        if d["ae_name"] not in ae_map:
            ae_map[d["ae_name"]] = {"ae_name": d["ae_name"], "ae_email": d["ae_email"], "call_count": 0}
        ae_map[d["ae_name"]]["call_count"] += 1

    with _lock:
        conn = _get_conn()
        with conn:
            conn.execute("""
                INSERT INTO summary (id, total_calls, unique_topics, active_aes, total_action_items,
                    positive_sentiment, neutral_sentiment, negative_sentiment, computed_at)
                VALUES (1,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                    total_calls        = excluded.total_calls,
                    unique_topics      = excluded.unique_topics,
                    active_aes         = excluded.active_aes,
                    total_action_items = excluded.total_action_items,
                    positive_sentiment = excluded.positive_sentiment,
                    neutral_sentiment  = excluded.neutral_sentiment,
                    negative_sentiment = excluded.negative_sentiment,
                    computed_at        = excluded.computed_at
            """, (total_calls, unique_topics, active_aes, total_ai, pos_s, neu_s, neg_s, now))

            for day, count in day_map.items():
                conn.execute("""
                    INSERT INTO calls_by_day (day, count, computed_at) VALUES (?,?,?)
                    ON CONFLICT(day) DO UPDATE SET count = excluded.count, computed_at = excluded.computed_at
                """, (day, count, now))

            conn.execute("DELETE FROM top_topics")
            for tv in topic_map.values():
                conn.execute(
                    "INSERT INTO top_topics (topic, count, call_ids, computed_at) VALUES (?,?,?,?)",
                    (tv["topic"], tv["count"], json.dumps(tv["call_ids"]), now),
                )

            conn.execute("DELETE FROM top_aes")
            for av in ae_map.values():
                conn.execute(
                    "INSERT INTO top_aes (ae_name, ae_email, call_count, computed_at) VALUES (?,?,?,?)",
                    (av["ae_name"], av["ae_email"], av["call_count"], now),
                )

            conn.execute("DELETE FROM call_action_items")
            for d in derived:
                if d["action_items"]:
                    conn.execute("""
                        INSERT INTO call_action_items
                            (call_id, call_title, ae_name, ae_email, date_ts, transcript_url, action_items, computed_at)
                        VALUES (?,?,?,?,?,?,?,?)
                    """, (d["id"], d["title"], d["ae_name"], d["ae_email"],
                          d["date_ts"], d["transcript_url"], json.dumps(d["action_items"]), now))

    print(f"[analytics] processed {total_calls} meetings — {unique_topics} topics, {active_aes} AEs")
    return {"totalCalls": total_calls, "computedAt": now}


# ─── Read helpers ─────────────────────────────────────────────────────────────

def get_analytics() -> dict:
    with _lock:
        conn = _get_conn()
        summary_row = conn.execute("SELECT * FROM summary WHERE id = 1").fetchone()
        day_rows = conn.execute("""
            SELECT day, count FROM calls_by_day
            ORDER BY CASE day
                WHEN 'Mon' THEN 1 WHEN 'Tue' THEN 2 WHEN 'Wed' THEN 3
                WHEN 'Thu' THEN 4 WHEN 'Fri' THEN 5 WHEN 'Sat' THEN 6 WHEN 'Sun' THEN 7 END
        """).fetchall()
        topic_rows = conn.execute(
            "SELECT topic, count, call_ids FROM top_topics ORDER BY count DESC"
        ).fetchall()
        ae_rows = conn.execute(
            "SELECT ae_name, ae_email, call_count FROM top_aes ORDER BY call_count DESC"
        ).fetchall()
        ai_rows = conn.execute("""
            SELECT call_id, call_title, ae_name, ae_email, date_ts, transcript_url, action_items
            FROM call_action_items ORDER BY date_ts DESC
        """).fetchall()

    return {
        "summary": {
            "totalCalls":      summary_row["total_calls"],
            "uniqueTopics":    summary_row["unique_topics"],
            "activeAEs":       summary_row["active_aes"],
            "totalActionItems":summary_row["total_action_items"],
            "positiveSentiment":summary_row["positive_sentiment"],
            "neutralSentiment": summary_row["neutral_sentiment"],
            "negativeSentiment":summary_row["negative_sentiment"],
        } if summary_row else None,
        "callsByDay": [dict(r) for r in day_rows],
        "topTopics": [
            {"topic": r["topic"], "count": r["count"], "callIds": json.loads(r["call_ids"] or "[]")}
            for r in topic_rows
        ],
        "topAEs": [
            {"aeName": r["ae_name"], "aeEmail": r["ae_email"], "callCount": r["call_count"]}
            for r in ae_rows
        ],
        "callActionItems": [
            {
                "callId":       r["call_id"],
                "callTitle":    r["call_title"],
                "aeName":       r["ae_name"],
                "aeEmail":      r["ae_email"],
                "dateTs":       r["date_ts"],
                "transcriptUrl":r["transcript_url"],
                "actionItems":  json.loads(r["action_items"] or "[]"),
            }
            for r in ai_rows
        ],
        "computedAt": dict(summary_row)["computed_at"] if summary_row else None,
    }


# ─── Product analysis ─────────────────────────────────────────────────────────

_UPSERT_PA_SQL = """
    INSERT INTO product_analysis
        (uuid, analysis_dt, call_title, ae_name, date, summary_bullet_gist, short_summary)
    VALUES
        (:uuid, :analysis_dt, :call_title, :ae_name, :date, :summary_bullet_gist, :short_summary)
    ON CONFLICT(uuid) DO UPDATE SET
        analysis_dt         = excluded.analysis_dt,
        call_title          = excluded.call_title,
        ae_name             = excluded.ae_name,
        date                = excluded.date,
        summary_bullet_gist = excluded.summary_bullet_gist,
        short_summary       = excluded.short_summary
"""


def upsert_product_analysis(results: list[dict]) -> None:
    arr = results if isinstance(results, list) else [results]
    if not arr:
        return
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    rows = [
        {
            "uuid":                r["uuid"],
            "analysis_dt":         r.get("analysis_dt") or now,
            "call_title":          r.get("call_title"),
            "ae_name":             r.get("ae_name"),
            "date":                r.get("date"),
            "summary_bullet_gist": r.get("summary_bullet_gist"),
            "short_summary":       r.get("short_summary"),
        }
        for r in arr
    ]
    with _lock:
        conn = _get_conn()
        with conn:
            conn.executemany(_UPSERT_PA_SQL, rows)


def get_product_analysis() -> list[dict]:
    with _lock:
        rows = _get_conn().execute(
            "SELECT * FROM product_analysis ORDER BY analysis_dt DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def delete_product_analysis(ids: list[str] | None = None) -> None:
    with _lock:
        conn = _get_conn()
        if not ids:
            conn.execute("DELETE FROM product_analysis")
        else:
            conn.execute(
                f"DELETE FROM product_analysis WHERE uuid IN ({','.join('?' * len(ids))})", ids
            )
        conn.commit()
