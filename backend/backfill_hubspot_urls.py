#!/usr/bin/env python3
"""
backfill_hubspot_urls.py — Fill in the `url` column (HubSpot's own deep link)
for notes/emails already saved locally, without re-walking companies at all.

We already have every note_id/email_id in the local DB — this just re-fetches
each by ID and writes back the `url` HubSpot returns alongside `properties`.

Run from backend/:
    python backfill_hubspot_urls.py
    python backfill_hubspot_urls.py --dry-run
    python backfill_hubspot_urls.py --limit 20
    python backfill_hubspot_urls.py --only notes     # or --only emails
"""

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config.config import HUBSPOT_API_KEY
from config.logging_config import configure_logging, get_logger
from apis.hubspot import hubspot_request
import db.hubspot as hubspot_db

configure_logging()
logger = get_logger("backfill_urls")

_NOTE_PROPS = ["hs_note_body", "hs_createdate", "hs_lastmodifieddate", "hs_timestamp", "hubspot_owner_id"]
_EMAIL_PROPS = ["hs_email_subject", "hs_email_text", "hs_createdate", "hs_lastmodifieddate", "hs_timestamp", "hubspot_owner_id"]


async def _fetch_note(note_id: str) -> dict:
    qs = "&".join([f"properties={p}" for p in _NOTE_PROPS])
    return await hubspot_request(f"/crm/v3/objects/notes/{note_id}?{qs}")


async def _fetch_email(email_id: str) -> dict:
    qs = "&".join([f"properties={p}" for p in _EMAIL_PROPS] + ["archived=false"])
    return await hubspot_request(f"/crm/v3/objects/emails/{email_id}?{qs}")


def _pending_ids(table: str, id_col: str) -> list[str]:
    with hubspot_db._lock:
        rows = hubspot_db._get_conn().execute(f"SELECT {id_col} FROM {table} WHERE url = ''").fetchall()
        return [r[id_col] for r in rows]


def _write_url(table: str, id_col: str, obj_id: str, url: str) -> None:
    with hubspot_db._lock:
        conn = hubspot_db._get_conn()
        conn.execute(f"UPDATE {table} SET url = ? WHERE {id_col} = ?", (url, obj_id))
        conn.commit()


async def _backfill(kind: str, id_col: str, table: str, fetch_fn, ids: list[str], dry_run: bool) -> tuple[int, int]:
    updated = failed = 0
    for i, obj_id in enumerate(ids):
        if (i + 1) % 25 == 0 or i == 0:
            logger.info("[%s] %d/%d", kind, i + 1, len(ids))
        try:
            obj = await fetch_fn(obj_id)
        except Exception as err:
            logger.warning("[%s] %s failed: %s", kind, obj_id, err)
            failed += 1
            await asyncio.sleep(0.2)
            continue

        url = obj.get("url") or ""
        if url:
            updated += 1
            if not dry_run:
                await asyncio.to_thread(_write_url, table, id_col, obj_id, url)
        await asyncio.sleep(0.2)
    return updated, failed


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Fetch but do not write to DB")
    parser.add_argument("--limit", type=int, default=0, help="Max rows per table to process (0 = all)")
    parser.add_argument("--only", choices=["notes", "emails"], help="Only backfill this table")
    args = parser.parse_args()

    if not HUBSPOT_API_KEY:
        logger.error("HUBSPOT_API_KEY not set — add it to backend/.env")
        sys.exit(1)

    note_ids = [] if args.only == "emails" else await asyncio.to_thread(_pending_ids, "notes", "note_id")
    email_ids = [] if args.only == "notes" else await asyncio.to_thread(_pending_ids, "emails", "email_id")

    if args.limit:
        note_ids = note_ids[: args.limit]
        email_ids = email_ids[: args.limit]

    logger.info("pending — notes: %d  emails: %d", len(note_ids), len(email_ids))

    total_updated = total_failed = 0

    if note_ids:
        u, f = await _backfill("notes", "note_id", "notes", _fetch_note, note_ids, args.dry_run)
        total_updated += u
        total_failed += f
        logger.info("notes done — updated: %d  failed: %d", u, f)

    if email_ids:
        u, f = await _backfill("emails", "email_id", "emails", _fetch_email, email_ids, args.dry_run)
        total_updated += u
        total_failed += f
        logger.info("emails done — updated: %d  failed: %d", u, f)

    label = "dry-run" if args.dry_run else "done"
    logger.info("%s — total updated: %d  total failed: %d", label, total_updated, total_failed)


if __name__ == "__main__":
    asyncio.run(main())
