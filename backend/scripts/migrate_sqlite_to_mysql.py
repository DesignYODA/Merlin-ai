#!/usr/bin/env python3
"""
migrate_sqlite_to_mysql.py — one-time data migration: copies existing rows
from merlin.sqlite (meetings, product_insights, kv_store, auth) and
hubspot_data.sqlite (companies, deals, notes, emails, contacts, hs_kv) into
the new MySQL tables in glessio_master (see backend/db/mysql_pool.py for the
schema). Column names match 1:1 between the old SQLite tables and their new
MySQL counterparts, so this is a straight per-table copy.

`sessions` (SQLite) is NOT migrated — login tokens are short-lived; migrating
stale ones isn't useful. Users just log in again after cutover. The new
g_sessions table is created fresh (empty) by mysql_pool.py's schema init.

Uses INSERT ... ON DUPLICATE KEY UPDATE — safe to re-run.

Run from backend/:
    python scripts/migrate_sqlite_to_mysql.py
    python scripts/migrate_sqlite_to_mysql.py --only meetings
    python scripts/migrate_sqlite_to_mysql.py --dry-run
"""

import argparse
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config.config import SQLITE_PATH, HUBSPOT_PATH
from config.logging_config import configure_logging, get_logger
from db.mysql_pool import get_connection, init_pool

configure_logging()
logger = get_logger("migrate_sqlite_to_mysql")


def _sqlite_rows(db_path: str, table: str) -> list[dict]:
    if not os.path.exists(db_path):
        logger.warning("[%s] source file not found: %s — skipping", table, db_path)
        return []
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        if table not in tables:
            logger.warning("[%s] table not found in %s — skipping", table, db_path)
            return []
        rows = [dict(r) for r in conn.execute(f"SELECT * FROM {table}").fetchall()]
        return rows
    finally:
        conn.close()


def _copy(db_path: str, table: str, mysql_table: str, columns: list[str], dry_run: bool) -> int:
    rows = _sqlite_rows(db_path, table)
    if not rows:
        return 0
    quoted_cols = [f"`{c}`" for c in columns]
    sql = (
        f"INSERT INTO {mysql_table} ({', '.join(quoted_cols)}) "
        f"VALUES ({', '.join('%(' + c + ')s' for c in columns)}) "
        f"ON DUPLICATE KEY UPDATE "
        f"{', '.join(f'`{c}` = VALUES(`{c}`)' for c in columns if c not in _PRIMARY_KEYS[mysql_table])}"
    )
    params = [{c: r.get(c) for c in columns} for r in rows]
    if dry_run:
        logger.info("[dry-run] would upsert %d row(s) into %s", len(params), mysql_table)
        return len(params)
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.executemany(sql, params)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()
    logger.info("[%s] upserted %d row(s) into %s", table, len(params), mysql_table)
    return len(params)


_PRIMARY_KEYS = {
    "g_fireflies": {"id"},
    "g_product_insights": {"call_id"},
    "fireflies_kv": {"key"},
    "g_auth": {"emailid"},
    "hs_companies": {"company_id"},
    "hs_deals": {"deal_id"},
    "hs_notes": {"note_id"},
    "hs_emails": {"email_id"},
    "hs_contacts": {"contact_id"},
    "hs_kv": {"key"},
}

_MEETINGS_COLS = [
    "id", "title", "date", "duration", "organizer_email", "host_email",
    "transcript_url", "audio_url", "video_url", "meeting_type",
    "meeting_attendees", "user",
    "summary_keywords", "summary_action_items", "summary_outline", "summary_shorthand_bullet",
    "summary_overview", "summary_bullet_gist", "summary_short_summary",
    "sentences", "metadata", "transcript",
]
_PRODUCT_INSIGHTS_COLS = [
    "call_id", "call_title", "ae_name", "client_name", "date",
    "transcript_url", "items", "analyzed_at",
]
_KV_COLS = ["key", "value"]
_AUTH_COLS = [
    "emailid", "password", "username", "securityquestion", "answer",
    "title", "role", "lastloggedin",
]
_COMPANY_COLS = [
    "company_id", "name", "domain", "phone", "city", "state", "country",
    "industry", "createdate", "lifecyclestage", "hubspot_owner_id",
    "hs_lastmodifieddate", "synced_at",
]
_DEAL_COLS = [
    "deal_id", "company_id", "dealname", "amount", "dealstage", "dealstage_label",
    "closedate", "pipeline", "pipeline_label", "hubspot_owner_id", "createdate",
    "hs_lastmodifieddate", "synced_at",
]
_NOTE_COLS = [
    "note_id", "company_id", "hs_note_body", "hs_createdate", "hs_lastmodifieddate",
    "hubspot_owner_id", "hs_timestamp", "url", "synced_at",
]
_EMAIL_COLS = [
    "email_id", "company_id", "hs_email_subject", "hs_email_text", "hs_createdate",
    "hs_lastmodifieddate", "hubspot_owner_id", "hs_timestamp", "url", "synced_at",
]
_CONTACT_COLS = [
    "contact_id", "company_id", "firstname", "lastname", "email",
    "createdate", "lastmodifieddate", "url", "synced_at",
]

_TASKS = [
    ("meetings",          SQLITE_PATH,  "meetings",         "g_fireflies",         _MEETINGS_COLS),
    ("product_insights",  SQLITE_PATH,  "product_insights", "g_product_insights",  _PRODUCT_INSIGHTS_COLS),
    ("kv_store",          SQLITE_PATH,  "kv_store",          "fireflies_kv",       _KV_COLS),
    ("auth",              SQLITE_PATH,  "auth",              "g_auth",             _AUTH_COLS),
    ("hs_companies",      HUBSPOT_PATH, "companies",         "hs_companies",       _COMPANY_COLS),
    ("hs_deals",          HUBSPOT_PATH, "deals",             "hs_deals",           _DEAL_COLS),
    ("hs_notes",          HUBSPOT_PATH, "notes",             "hs_notes",           _NOTE_COLS),
    ("hs_emails",         HUBSPOT_PATH, "emails",            "hs_emails",          _EMAIL_COLS),
    ("hs_contacts",       HUBSPOT_PATH, "contacts",          "hs_contacts",        _CONTACT_COLS),
    ("hs_kv",             HUBSPOT_PATH, "hs_kv",             "hs_kv",              _KV_COLS),
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Read source rows but do not write to MySQL")
    parser.add_argument("--only", help="Comma-separated task names to run (see _TASKS names), default: all")
    args = parser.parse_args()

    only = {t.strip() for t in args.only.split(",")} if args.only else None

    if not args.dry_run:
        init_pool()

    total = 0
    for name, db_path, table, mysql_table, columns in _TASKS:
        if only and name not in only:
            continue
        n = _copy(db_path, table, mysql_table, columns, args.dry_run)
        total += n

    label = "dry-run — would migrate" if args.dry_run else "migrated"
    logger.info("%s %d total row(s)", label, total)


if __name__ == "__main__":
    main()
