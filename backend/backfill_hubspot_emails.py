#!/usr/bin/env python3
"""
backfill_hubspot_emails.py — Fetch and store HubSpot emails for companies
already saved locally (hubspot_data.sqlite), without re-syncing companies,
deals, or notes.

Existing rows were synced before email resolution was wired up, so their
`emails` table is empty even though HubSpot has email engagements associated
with them. This walks every company_id already in the local DB that doesn't
already have emails saved, re-fetches just its `emails` association, resolves
each email by ID, and upserts into the `emails` table only.

Run from backend/:
    python backfill_hubspot_emails.py
    python backfill_hubspot_emails.py --dry-run
    python backfill_hubspot_emails.py --limit 20
    python backfill_hubspot_emails.py --force   # re-fetch companies that already have emails saved
"""

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config.config import HUBSPOT_API_KEY
from config.logging_config import configure_logging, get_logger
from apis.hubspot import hubspot_request, get_company_with_associations
from db.hubspot import get_all_company_ids, get_company_ids_with_emails, upsert_hubspot_data, get_email_count

configure_logging()
logger = get_logger("backfill_emails")

_EMAIL_PROPS = ["hs_email_subject", "hs_email_text", "hs_createdate", "hs_lastmodifieddate", "hs_timestamp", "hubspot_owner_id"]


async def _get_hubspot_email_by_id(email_id: str) -> dict:
    qs = "&".join([f"properties={p}" for p in _EMAIL_PROPS] + ["archived=false"])
    return await hubspot_request(f"/crm/v3/objects/emails/{email_id}?{qs}")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Fetch but do not write to DB")
    parser.add_argument("--limit", type=int, default=0, help="Max pending companies to process (0 = all)")
    parser.add_argument("--force", action="store_true", help="Re-fetch even companies that already have emails saved")
    args = parser.parse_args()

    if not HUBSPOT_API_KEY:
        logger.error("HUBSPOT_API_KEY not set — add it to backend/.env")
        sys.exit(1)

    all_company_ids = get_all_company_ids()
    total = len(all_company_ids)

    if not all_company_ids:
        logger.info("No companies saved locally — run a HubSpot sync first.")
        return

    already_filled_ids = set() if args.force else get_company_ids_with_emails()
    pending_ids = [cid for cid in all_company_ids if cid not in already_filled_ids]
    already_filled = total - len(pending_ids)

    logger.info(
        "companies — total: %d  already filled: %d  pending: %d",
        total, already_filled, len(pending_ids),
    )

    if args.limit:
        pending_ids = pending_ids[: args.limit]

    if not pending_ids:
        logger.info("Nothing to backfill — every company already has emails saved. Use --force to re-fetch anyway.")
        return

    logger.info("Backfilling emails for %d pending compan%s", len(pending_ids), "y" if len(pending_ids) == 1 else "ies")

    processed = failed = 0
    total_emails = 0

    for i, company_id in enumerate(pending_ids):
        logger.info("[%d/%d] company %s", i + 1, len(pending_ids), company_id)

        co = await get_company_with_associations(company_id)
        if not co:
            logger.warning("  → could not fetch company, skipping")
            failed += 1
            continue

        assocs = co.get("associations") or {}
        email_ids = [e["id"] for e in (assocs.get("emails") or {}).get("results") or []]
        if not email_ids:
            logger.info("  → no email associations")
            processed += 1
            continue

        results = await asyncio.gather(
            *[_get_hubspot_email_by_id(eid) for eid in email_ids],
            return_exceptions=True,
        )
        resolved = [r for r in results if isinstance(r, dict) and r.get("id")]
        for r, eid in zip(results, email_ids):
            if isinstance(r, Exception):
                logger.warning("  → email %s failed: %s", eid, r)
        logger.info("  → %d/%d emails resolved", len(resolved), len(email_ids))
        total_emails += len(resolved)

        if not args.dry_run:
            # resolved_deals/resolved_notes intentionally omitted — upsert_hubspot_data
            # only inserts/updates, never deletes, so existing deal/note rows are untouched.
            co["resolved_emails"] = resolved
            await asyncio.to_thread(upsert_hubspot_data, [co])

        processed += 1
        await asyncio.sleep(0.2)  # gentle pacing on top of the client's own 5 req/s throttle

    label = "dry-run" if args.dry_run else "done"
    logger.info("%s — companies processed: %d  failed: %d  emails resolved: %d", label, processed, failed, total_emails)
    if not args.dry_run:
        logger.info("emails table now has %d row(s)", get_email_count())


if __name__ == "__main__":
    asyncio.run(main())
