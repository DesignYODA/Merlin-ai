#!/usr/bin/env python3
"""
backfill_hubspot_companies.py — Backfill companies (and all associations —
deals, notes, emails, contacts) over an arbitrary historical date range.

Walks the range forward in fixed-size date chunks (--chunk-days) rather than
one single "since X" query. This matters because HubSpot's Search API hard-
fails (400) once a single query's matched result set crosses 10,000 records —
exactly what happened to the live incremental sync when its cursor got stuck
for 18 days and the "changed since" window grew past that cap. Bounding each
chunk on both ends keeps every query's result set small regardless of how
wide or dense the overall backfill range is.

Within a chunk, companies are paginated (100/page) directly against HubSpot's
companies search — each page is fully resolved (associations) and upserted
before the next page is requested, rather than buffering an entire chunk's
companies in memory before writing anything. This bounds memory use and means
an interruption mid-chunk still leaves everything fetched so far persisted.

Progress is checkpointed to the same hs_kv table the live sync uses
("hubspot:backfill:checkpoint"), so an interrupted run can be resumed with
--resume instead of restarting from --start.

Run from backend/:
    python backfill_hubspot_companies.py --start 2024-01-01
    python backfill_hubspot_companies.py --start 2024-01-01 --end 2024-06-01 --dry-run
    python backfill_hubspot_companies.py --resume
    python backfill_hubspot_companies.py --start 2024-01-01 --chunk-days 1
"""

import argparse
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config.config import HUBSPOT_API_KEY
from config.logging_config import configure_logging, get_logger
from apis.hubspot import hubspot_request, get_company_with_associations, _CO_PROPS
from interface.handler import (
    get_hubspot_deal_by_id, get_hubspot_note_by_id,
    get_hubspot_email_by_id, get_hubspot_contact_by_id,
    get_hubspot_pipelines,
)
from db.hubspot import (
    upsert_hubspot_data, backfill_deal_labels,
    get_pipeline_labels, set_pipeline_labels,
    get_deal_count, get_company_count, get_note_count, get_email_count, get_contact_count,
    hs_kv_get, hs_kv_set,
)

configure_logging()
logger = get_logger("backfill_companies")

_CHECKPOINT_KEY = "hubspot:backfill:checkpoint"
_PAGE_SIZE = 100


def _parse_date(s: str) -> int:
    """Parse 'YYYY-MM-DD' (UTC midnight) into unix milliseconds."""
    dt = datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _to_iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


async def _search_companies_page(since_iso: str, until_iso: str, after: str | None) -> dict:
    """One page (up to _PAGE_SIZE) of companies with hs_lastmodifieddate in
    [since_iso, until_iso). The Search API doesn't return associations, so
    each matched company still needs get_company_with_associations() — done
    per-page in _process_company_page(), not for the whole chunk at once."""
    body: dict = {
        "filterGroups": [{"filters": [
            {"propertyName": "hs_lastmodifieddate", "operator": "GTE", "value": since_iso},
            {"propertyName": "hs_lastmodifieddate", "operator": "LT", "value": until_iso},
        ]}],
        "sorts": [{"propertyName": "hs_lastmodifieddate", "direction": "ASCENDING"}],
        "properties": _CO_PROPS,
        "limit": _PAGE_SIZE,
    }
    if after:
        body["after"] = after
    return await hubspot_request("/crm/v3/objects/companies/search", method="POST", json_body=body)


async def _resolve_associations(raw_companies: list[dict]) -> None:
    """Resolve every deal/note/email/contact referenced by raw_companies'
    associations and attach resolved_deals/resolved_notes/resolved_emails/
    resolved_contacts to each company in place — mirrors sync_hubspot_incremental()."""
    all_deal_ids: set[str] = set()
    all_note_ids: set[str] = set()
    all_email_ids: set[str] = set()
    all_contact_ids: set[str] = set()
    for co in raw_companies:
        assocs = co.get("associations") or {}
        for entry in (assocs.get("deals") or {}).get("results") or []:
            all_deal_ids.add(entry["id"])
        for entry in (assocs.get("notes") or {}).get("results") or []:
            all_note_ids.add(entry["id"])
        for entry in (assocs.get("emails") or {}).get("results") or []:
            all_email_ids.add(entry["id"])
        for entry in (assocs.get("contacts") or {}).get("results") or []:
            all_contact_ids.add(entry["id"])

    logger.info(
        "  -> resolving associations: %d deal(s), %d note(s), %d email(s), %d contact(s)",
        len(all_deal_ids), len(all_note_ids), len(all_email_ids), len(all_contact_ids),
    )

    deal_results, note_results, email_results, contact_results = await asyncio.gather(
        asyncio.gather(*[get_hubspot_deal_by_id(did) for did in all_deal_ids], return_exceptions=True),
        asyncio.gather(*[get_hubspot_note_by_id(nid) for nid in all_note_ids], return_exceptions=True),
        asyncio.gather(*[get_hubspot_email_by_id(eid) for eid in all_email_ids], return_exceptions=True),
        asyncio.gather(*[get_hubspot_contact_by_id(cid) for cid in all_contact_ids], return_exceptions=True),
    )
    deals_by_id    = {r["id"]: r for r in deal_results    if isinstance(r, dict) and r.get("id")}
    notes_by_id    = {r["id"]: r for r in note_results    if isinstance(r, dict) and r.get("id")}
    emails_by_id   = {r["id"]: r for r in email_results   if isinstance(r, dict) and r.get("id")}
    contacts_by_id = {r["id"]: r for r in contact_results if isinstance(r, dict) and r.get("id")}

    for label, ids, resolved in (
        ("deal", all_deal_ids, deals_by_id), ("note", all_note_ids, notes_by_id),
        ("email", all_email_ids, emails_by_id), ("contact", all_contact_ids, contacts_by_id),
    ):
        failed = len(ids) - len(resolved)
        if failed:
            logger.warning("  -> %d/%d %s(s) failed to resolve", failed, len(ids), label)
    logger.info(
        "  -> resolved: %d deal(s), %d note(s), %d email(s), %d contact(s)",
        len(deals_by_id), len(notes_by_id), len(emails_by_id), len(contacts_by_id),
    )

    for co in raw_companies:
        assocs = co.get("associations") or {}
        co["resolved_deals"] = [
            deals_by_id[e["id"]] for e in (assocs.get("deals") or {}).get("results") or [] if e["id"] in deals_by_id
        ]
        co["resolved_notes"] = [
            notes_by_id[e["id"]] for e in (assocs.get("notes") or {}).get("results") or [] if e["id"] in notes_by_id
        ]
        co["resolved_emails"] = [
            emails_by_id[e["id"]] for e in (assocs.get("emails") or {}).get("results") or [] if e["id"] in emails_by_id
        ]
        co["resolved_contacts"] = [
            contacts_by_id[e["id"]] for e in (assocs.get("contacts") or {}).get("results") or [] if e["id"] in contacts_by_id
        ]


async def _process_company_page(
    page_results: list[dict], label_map: dict, dry_run: bool,
) -> tuple[int, int]:
    """Fully resolve and upsert one page of company search hits — end to end —
    before the caller requests the next page. Returns (companies_processed,
    rows_upserted)."""
    ids = [c["id"] for c in page_results]
    logger.info("  -> fetching associations for %d compan%s in this page...",
                len(ids), "y" if len(ids) == 1 else "ies")
    full_companies = await asyncio.gather(*[get_company_with_associations(cid) for cid in ids])
    full_companies = [c for c in full_companies if c]
    if len(full_companies) < len(ids):
        logger.warning("  -> %d/%d compan%s failed to fetch associations",
                        len(ids) - len(full_companies), len(ids), "y" if len(ids) == 1 else "ies")

    if not full_companies:
        return 0, 0

    await _resolve_associations(full_companies)

    if dry_run:
        logger.info("  -> %d compan%s (dry-run, not written)",
                    len(full_companies), "y" if len(full_companies) == 1 else "ies")
        return len(full_companies), 0

    logger.info("  -> upserting %d compan%s to DB...",
                len(full_companies), "y" if len(full_companies) == 1 else "ies")
    new_rows = await asyncio.to_thread(upsert_hubspot_data, full_companies, label_map)
    backfilled = await asyncio.to_thread(backfill_deal_labels, label_map)
    logger.info("  -> %d compan%s, %d row(s) upserted%s",
                len(full_companies), "y" if len(full_companies) == 1 else "ies",
                new_rows, f", {backfilled} label(s) back-filled" if backfilled else "")
    return len(full_companies), new_rows


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", help="Backfill from this date (YYYY-MM-DD, UTC). Required unless --resume.")
    parser.add_argument("--end", help="Backfill up to this date (YYYY-MM-DD, UTC). Defaults to now.")
    parser.add_argument("--chunk-days", type=int, default=3, help="Days per chunk (default: 3)")
    parser.add_argument("--dry-run", action="store_true", help="Fetch but do not write to DB or advance the checkpoint")
    parser.add_argument("--resume", action="store_true", help="Continue from the last saved checkpoint instead of --start")
    args = parser.parse_args()
    logger.info(
        "Args: start=%s end=%s chunk_days=%d dry_run=%s resume=%s",
        args.start, args.end, args.chunk_days, args.dry_run, args.resume,
    )

    if not HUBSPOT_API_KEY:
        logger.error("HUBSPOT_API_KEY not set — add it to backend/.env")
        sys.exit(1)
    logger.info("HubSpot API key present")

    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    end_ms = _parse_date(args.end) if args.end else now_ms

    if args.resume:
        checkpoint = hs_kv_get(_CHECKPOINT_KEY)
        if not checkpoint:
            logger.error("No checkpoint found — run once with --start first.")
            sys.exit(1)
        start_ms = checkpoint["next_start_ms"]
        logger.info("Resuming from checkpoint: %s", datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).isoformat())
    elif args.start:
        start_ms = _parse_date(args.start)
    else:
        logger.error("--start is required (or use --resume)")
        sys.exit(1)

    if start_ms >= end_ms:
        logger.info("Nothing to do — start is already at or past end.")
        return

    chunk_ms = args.chunk_days * 24 * 60 * 60 * 1000

    logger.info("Loading pipeline stage labels (cached)...")
    label_map = get_pipeline_labels() or {}
    if label_map:
        logger.info("Using %d cached pipeline label(s)", len(label_map))
    else:
        logger.info("No cached labels — fetching pipelines from HubSpot...")
        pipelines_resp = await get_hubspot_pipelines()
        for pipeline in (pipelines_resp.get("results") or []):
            for stage in (pipeline.get("stages") or []):
                label_map[stage["id"]] = {"stageLabel": stage["label"], "pipelineLabel": pipeline["label"]}
        logger.info("Fetched %d pipeline label(s)", len(label_map))
        if label_map and not args.dry_run:
            set_pipeline_labels(label_map)
            logger.info("Cached pipeline labels to hs_kv")

    total_chunks = -(-(end_ms - start_ms) // chunk_ms)  # ceil division
    logger.info(
        "Backfilling %s -> %s in %d chunk(s) of %d day(s)%s",
        datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).date(),
        datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc).date(),
        total_chunks, args.chunk_days,
        " [DRY RUN]" if args.dry_run else "",
    )

    chunk_start = start_ms
    chunk_index = 0
    total_companies = total_rows = 0

    while chunk_start < end_ms:
        chunk_index += 1
        chunk_end = min(chunk_start + chunk_ms, end_ms)
        range_label = (
            f"{datetime.fromtimestamp(chunk_start / 1000, tz=timezone.utc).date()} -> "
            f"{datetime.fromtimestamp(chunk_end / 1000, tz=timezone.utc).date()}"
        )
        logger.info("[%d/%d] %s", chunk_index, total_chunks, range_label)

        since_iso = _to_iso(chunk_start)
        until_iso = _to_iso(chunk_end)
        page_after = None
        page_num = 0
        chunk_companies = 0
        chunk_rows = 0
        chunk_failed = False

        while True:
            page_num += 1
            logger.info("  -> page %d: searching companies changed in this window...", page_num)
            try:
                resp = await _search_companies_page(since_iso, until_iso, page_after)
            except Exception as e:
                logger.error("  -> page %d fetch failed, stopping this chunk here "
                             "(will not advance checkpoint): %s", page_num, e)
                chunk_failed = True
                break

            page_results = resp.get("results") or []
            logger.info("  -> page %d: %d compan%s found", page_num, len(page_results),
                        "y" if len(page_results) == 1 else "ies")

            if page_results:
                processed, rows = await _process_company_page(page_results, label_map, args.dry_run)
                chunk_companies += processed
                chunk_rows += rows

            paging = resp.get("paging") or {}
            page_after = (paging.get("next") or {}).get("after") or None
            if not page_after:
                break

        if chunk_failed:
            break

        if chunk_companies == 0:
            logger.info("  -> no changes in this window")
        total_companies += chunk_companies
        total_rows += chunk_rows

        if not args.dry_run:
            hs_kv_set(_CHECKPOINT_KEY, {"next_start_ms": chunk_end})
            logger.info("  -> checkpoint saved: next_start=%s",
                        datetime.fromtimestamp(chunk_end / 1000, tz=timezone.utc).isoformat())
        chunk_start = chunk_end

    label = "dry-run" if args.dry_run else "done"
    logger.info("%s — chunks: %d  companies touched: %d  rows upserted: %d",
                label, chunk_index, total_companies, total_rows)
    if not args.dry_run:
        logger.info(
            "DB totals — companies: %d  deals: %d  notes: %d  emails: %d  contacts: %d",
            await asyncio.to_thread(get_company_count), await asyncio.to_thread(get_deal_count),
            await asyncio.to_thread(get_note_count), await asyncio.to_thread(get_email_count),
            await asyncio.to_thread(get_contact_count),
        )


if __name__ == "__main__":
    asyncio.run(main())
