#!/usr/bin/env python3
"""
backfill_transcripts.py — Fetch and store transcript text for meetings
that have a Fireflies ID but no transcript text yet.

Run from backend/:
    python backfill_transcripts.py               # fill missing transcripts
    python backfill_transcripts.py --dry-run
    python backfill_transcripts.py --limit 20
    python backfill_transcripts.py --fix-timestamps   # re-fetch 349 broken [MM:SS] transcripts
"""

import argparse
import asyncio
import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config.config import FIREFLIES_API_KEY, SQLITE_PATH
from config.logging_config import configure_logging, get_logger
from apis.fireflies import fireflies_query

configure_logging()
logger = get_logger("backfill")

_QUERY = """query {{
  transcript(id: "{call_id}") {{
    id
    sentences {{ text start_time end_time speaker_name }}
  }}
}}"""


def _build_text(t: dict) -> str:
    parts = []
    for s in (t.get("sentences") or []):
        text = (s.get("text") or "").strip()
        if not text:
            continue
        sec = int(s.get("start_time") or 0)
        ts = f"[{sec // 3600:02d}:{(sec % 3600) // 60:02d}:{sec % 60:02d}]"
        speaker = (s.get("speaker_name") or "Speaker").strip()
        parts.append(f"{ts} {speaker}: {text}")
    return "\n".join(parts)


async def _fetch_sentences_text(call_id: str) -> str | None:
    try:
        data = await fireflies_query(_QUERY.format(call_id=call_id), timeout_ms=30_000)
        t = data.get("transcript")
        if not t:
            return None
        return _build_text(t) or None
    except Exception as err:
        logger.error("  → Fireflies error: %s", err)
        return None


# Detects old [MM:SS] format written by the first broken backfill run
_OLD_TS_RE = re.compile(r"\[\d{2}:\d{2}\]")
_NEW_TS_RE = re.compile(r"\[\d{2}:\d{2}:\d{2}\]")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Fetch but do not write to DB")
    parser.add_argument("--limit", type=int, default=0, help="Max rows to process (0 = all)")
    parser.add_argument(
        "--fix-timestamps", action="store_true",
        help="Re-fetch calls whose transcript has the old broken [MM:SS] format",
    )
    args = parser.parse_args()

    if not FIREFLIES_API_KEY:
        logger.error("FIREFLIES_API_KEY not set — add it to backend/.env")
        sys.exit(1)

    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row

    total   = conn.execute("SELECT COUNT(*) FROM meetings").fetchone()[0]
    has_tx  = conn.execute("SELECT COUNT(*) FROM meetings WHERE transcript IS NOT NULL AND transcript != ''").fetchone()[0]
    missing = total - has_tx
    logger.info("DB: %d total  |  %d have transcript  |  %d missing", total, has_tx, missing)

    if args.fix_timestamps:
        # Fetch all with a transcript and filter to those with old [MM:SS] format
        all_rows = conn.execute("SELECT id, title, transcript FROM meetings WHERE transcript IS NOT NULL AND transcript != ''").fetchall()
        broken = [r for r in all_rows if _OLD_TS_RE.search(r["transcript"] or "") and not _NEW_TS_RE.search(r["transcript"] or "")]
        logger.info("--fix-timestamps: %d calls with broken [MM:SS] timestamps", len(broken))
        rows = broken[:args.limit] if args.limit else broken
    else:
        sql = "SELECT id, title FROM meetings WHERE transcript IS NULL OR transcript = ''"
        if args.limit:
            sql += f" LIMIT {args.limit}"
        rows = conn.execute(sql).fetchall()

    if not rows:
        logger.info("Nothing to backfill.")
        conn.close()
        return

    updated = failed = 0

    for i, row in enumerate(rows):
        call_id, title = row["id"], row["title"] or row["id"]
        logger.info("[%d/%d] %s (%s)", i + 1, len(rows), title, call_id)

        text = await _fetch_sentences_text(call_id)
        if not text:
            logger.info("  → not present, skipping")
            failed += 1
        else:
            logger.info("  → %d chars", len(text))
            if not args.dry_run:
                conn.execute("UPDATE meetings SET transcript = ? WHERE id = ?", (text, call_id))
                conn.commit()
            updated += 1

        await asyncio.sleep(0.4)   # ~2.5 req/s — within Fireflies rate limits

    conn.close()
    label = "dry-run" if args.dry_run else "done"
    logger.info("%s — updated: %d  failed: %d", label, updated, failed)


if __name__ == "__main__":
    asyncio.run(main())
