"""
handler.py — Business logic between HTTP routes and data services.
Mirrors handler.mjs. All functions raise HTTPException for non-500 errors.
"""

import asyncio
from config.logging_config import get_logger
import re
from datetime import datetime, timezone

from fastapi import HTTPException

from config.config import ANTHROPIC_API_KEY, GROQ_API_KEY, FIREFLIES_API_KEY, HUBSPOT_API_KEY
from db.merlin_db import (
    kv_get, kv_set, kv_del,
    get_all_meetings, get_all_meetings_light, get_all_meetings_light_replica,
    get_all_meeting_ids, get_meeting_by_id,
    upsert_meetings, delete_meetings,
    upsert_product_insights, get_all_product_insights, get_all_product_insights_replica,
    delete_product_insights,
    replicate_to_read_replica as _replicate_merlin,
    create_auth_user as _create_auth_user,
    get_auth_user as _get_auth_user,
    update_auth_last_logged_in as _update_auth_last_logged_in,
    update_auth_password as _update_auth_password,
    create_session as _create_auth_session,
    get_session as _get_auth_session,
    delete_session as _delete_auth_session,
)
from utils.security import hash_secret, verify_secret, generate_token
from db.analytical_db import (
    process_analytics as _process_analytics,
    get_analytics as _get_analytics,
    upsert_product_analysis, get_product_analysis, delete_product_analysis,
)
from apis.fireflies import (
    should_analyze_meeting, classify_meeting_type, build_meeting_metadata,
    redact_transcript, fireflies_query, build_transcripts_query,
    fetch_all_fireflies_transcripts, fetch_transcript_by_id, get_full_call_with_transcript,
    build_transcript, get_external_emails,
)
from apis.hubspot import hubspot_request, find_hubspot_deals_for_emails
from apis.llm import call_llm, call_anthropic, extract_product_mentions
from utils.ingest_historical import fireflies_historical
from apis.prompts import (
    QUERY_REWRITE_REFERENCE_RESOLUTION_SYSTEM_PROMPT,
    QUERY_REWRITE_REFERENCE_RESOLUTION_USER_TEMPLATE,
)

logger = get_logger("merlin.handler")

# ─── Config ───────────────────────────────────────────────────────────────────

def get_config_status() -> dict:
    return {
        "firefliesApiKeySet": bool(FIREFLIES_API_KEY),
        "anthropicApiKeySet": bool(ANTHROPIC_API_KEY),
        "groqApiKeySet":      bool(GROQ_API_KEY),
        "hubspotApiKeySet":   bool(HUBSPOT_API_KEY),
        "activeLlm": "anthropic" if ANTHROPIC_API_KEY else ("groq" if GROQ_API_KEY else "none"),
    }


def set_api_key(config_key: str, api_key: str) -> None:
    kv_set(config_key, {"apiKey": api_key})
    logger.info("[config] Updated key %s", config_key)


# ─── Data (combined dashboard) ────────────────────────────────────────────────

async def get_combined_data() -> dict:
    async def _load_calls():
        # Light query: skips the sentences blob and sorts in SQL (indexed on date) —
        # this endpoint only ever returns list-view fields, never per-sentence transcript.
        # Reads the replica — this is a pure frontend GET, never followed by a write.
        light = await asyncio.to_thread(get_all_meetings_light_replica)
        return {
            "calls": light,
            "syncStatus": kv_get("sync:status"),
            "excludedCount": 0,
        }

    async def _load_hubspot():
        if not HUBSPOT_API_KEY:
            return {"deals": [], "companies": [], "contacts": []}
        deals, companies, contacts = await asyncio.gather(
            get_hubspot_deals(limit=50),
            get_hubspot_companies(limit=50),
            get_hubspot_contacts(limit=50),
        )
        return {
            "deals":     deals.get("results") or [],
            "companies": companies.get("results") or [],
            "contacts":  contacts.get("results") or [],
        }

    calls_r, hs_r = await asyncio.gather(
        _load_calls(), _load_hubspot(), return_exceptions=True
    )

    c = calls_r if isinstance(calls_r, dict) else {"calls": [], "syncStatus": None, "excludedCount": 0}
    h = hs_r if isinstance(hs_r, dict) else {"deals": [], "companies": [], "contacts": []}

    if isinstance(calls_r, Exception):
        logger.error("[data] calls error: %s", calls_r)
    if isinstance(hs_r, Exception):
        logger.error("[data] HubSpot error: %s", hs_r)

    return {
        "calls":        c["calls"],
        "syncStatus":   c["syncStatus"],
        "totalCount":   len(c["calls"]),
        "excludedCount":c["excludedCount"],
        "deals":        h["deals"],
        "companies":    h["companies"],
        "contacts":     h["contacts"],
    }


# ─── Calls ────────────────────────────────────────────────────────────────────

def list_calls() -> dict:
    light = get_all_meetings_light_replica()
    return {
        "calls":        light,
        "totalCount":   len(light),
        "excludedCount":0,
        "syncStatus":   kv_get("sync:status"),
    }


async def get_call_by_id(call_id: str) -> dict:
    stored = await asyncio.to_thread(get_meeting_by_id, call_id)

    if stored and not should_analyze_meeting(stored)["allowed"]:
        raise HTTPException(status_code=403, detail="This meeting is excluded from analysis")

    # Serve from DB if we already have sentences or transcript text — no need to re-query Fireflies
    if stored and ((stored.get("sentences") or []) or stored.get("transcript")):
        return {"call": stored, "source": "database"}

    fields = """id title date duration organizer_email participants transcript_url audio_url transcript
        summary { keywords action_items outline shorthand_bullet overview bullet_gist short_summary }
        sentences { index text raw_text start_time end_time speaker_id speaker_name }"""

    try:
        t = await fetch_transcript_by_id(call_id, fields)
        if t:
            redacted = redact_transcript(t)
            await asyncio.to_thread(upsert_meetings, redacted)
            return {"call": redacted, "source": "fireflies"}
        logger.info("[calls] Fireflies returned no transcript for %s", call_id)
    except Exception as err:
        logger.error("[calls] Fireflies lookup failed for %s: %s", call_id, err)
        if stored:
            return {"call": stored, "source": "database"}
        raise HTTPException(status_code=502, detail=f"Fireflies API unreachable: {err}")

    if stored:
        return {"call": stored, "source": "database"}
    raise HTTPException(status_code=404, detail="Call not found")


def delete_calls() -> dict:
    existing = get_all_meetings()
    if existing:
        delete_meetings([c["id"] for c in existing])
    kv_del("sync:status")
    logger.warning("[calls] Deleted %d call(s) and cleared sync status", len(existing))
    return {"deleted": len(existing)}


def get_sync_status() -> dict:
    return kv_get("sync:status") or {"lastSyncAt": None, "totalCalls": 0, "newCalls": 0, "updatedCalls": 0}


async def ask_call(call_id: str, question: str) -> dict:
    """Answer a question about a specific call using LLM + transcript context."""
    if not GROQ_API_KEY and not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=400, detail="No LLM API key configured")

    stored = await asyncio.to_thread(get_meeting_by_id, call_id)
    if not stored:
        raise HTTPException(status_code=404, detail="Call not found")

    transcript_text = build_transcript(stored)
    summary = stored.get("summary") or {}

    context_parts: list[str] = [f"Call: {stored.get('title', 'Untitled')}"]
    if summary.get("overview"):
        context_parts.append(f"Summary: {summary['overview']}")
    bg = summary.get("bullet_gist")
    if bg:
        bullets = bg if isinstance(bg, list) else [bg]
        context_parts.append("Key points:\n" + "\n".join(f"- {b}" for b in bullets))
    if transcript_text.strip():
        context_parts.append(f"Transcript:\n{transcript_text[:12000]}")

    if len(context_parts) == 1:
        raise HTTPException(status_code=422, detail="No transcript or summary available for this call")

    context = "\n\n".join(context_parts)
    system = (
        "You are an AI assistant analyzing a sales call transcript. "
        "Answer questions concisely and accurately based only on the provided call data. "
        "If the answer is not in the content, say so clearly."
    )
    answer = await call_llm(
        system, f"{context}\n\nQuestion: {question}",
        timeout_ms=30_000, max_tokens=600, temperature=0.3,
    )
    return {"answer": answer or "Unable to generate a response. Please try again."}


_QUOTED_REPLY_RE = re.compile(r"_{8,}|\bOn\b.{0,160}?\bwrote:", re.IGNORECASE | re.DOTALL)


def _strip_quoted_reply(text: str) -> str:
    """Cut an email body at the first quoted-thread marker (Outlook's underscore
    divider or Gmail's "On <day>, <time> ... wrote:" header) so only the message
    actually sent at this email's own timestamp is used — mirrors the same
    cleanup applied in the modal UI (calls-library-page.tsx: stripQuotedReplyTail)."""
    m = _QUOTED_REPLY_RE.search(text)
    return text[:m.start()] if m else text


async def ask_hubspot_row(context: dict, question: str) -> dict:
    """Answer a question about a HubSpot company using company/deal/note/email context.
    Always uses Claude Sonnet 5 directly — no Groq fallback for this feature."""
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=400, detail="ANTHROPIC_API_KEY not configured")

    company_name     = context.get("company_name") or "Unknown"
    company_industry = context.get("company_industry") or ""
    company_country  = context.get("company_country") or ""
    company_city     = context.get("company_city") or ""
    company_stage    = context.get("company_lifecyclestage") or ""
    deals            = context.get("all_deals") or []

    # get_hubspot_flat_data() no longer embeds full note/email bodies in every
    # row (too much text to ship on every list load — see get_hubspot_flat_data()
    # docstring), so fetch them here by company_id instead of trusting the
    # caller to have them already.
    notes  = context.get("all_notes") or []
    emails = context.get("all_emails") or []
    company_id = context.get("company_id")
    if (not notes or not emails) and company_id:
        from db.hubspot import get_hubspot_company_details
        details = await asyncio.to_thread(get_hubspot_company_details, company_id)
        notes  = notes or details["all_notes"]
        emails = emails or details["all_emails"]

    # Source filter: a question that names one source specifically ("notes",
    # "email(s)") gets only that source in the context — less noise, more
    # focused answers. A question naming both, or neither, gets everything.
    mentions_notes  = bool(re.search(r"\bnotes?\b", question, re.IGNORECASE))
    mentions_emails = bool(re.search(r"\be-?mails?\b", question, re.IGNORECASE))
    if mentions_notes and not mentions_emails:
        include_notes, include_emails = True, False
    elif mentions_emails and not mentions_notes:
        include_notes, include_emails = False, True
    else:
        include_notes, include_emails = True, True

    # Notes/emails come back newest-first (get_hubspot_company_details() sorts
    # DESC) — cap to the most recent 10 and flip to old→new (chronological
    # reading order) whenever a source is included, whether that's because it
    # was named specifically or because nothing was named and everything goes.
    def _recent_oldest_first(items: list[dict]) -> list[dict]:
        return list(reversed(items[:10]))

    notes_used  = _recent_oldest_first(notes)  if include_notes  else []
    emails_used = _recent_oldest_first(emails) if include_emails else []

    deals_lines = []
    for d in deals:
        parts = [d.get("deal_name") or "Unnamed deal"]
        if d.get("deal_amount"):
            parts.append(f"${d['deal_amount']}")
        if d.get("deal_stage"):
            parts.append(d["deal_stage"])
        if d.get("deal_pipeline"):
            parts.append(d["deal_pipeline"])
        if d.get("deal_closedate"):
            parts.append(f"closes {d['deal_closedate']}")
        deals_lines.append("- " + " · ".join(parts))

    notes_lines = []
    for n in notes_used:
        body = re.sub(r"<[^>]+>", " ", n.get("note_hs_note_body") or "").strip()
        body = re.sub(r"\s+", " ", body)
        if body:
            date = (n.get("note_hs_createdate") or "")[:10]
            notes_lines.append(f"[{date}] {body[:1000]}")

    emails_lines = []
    for e in emails_used:
        body = _strip_quoted_reply(e.get("email_hs_email_text") or "")
        body = re.sub(r"<[^>]+>", " ", body).strip()
        body = re.sub(r"\s+", " ", body)
        if body:
            date = (e.get("email_hs_createdate") or "")[:10]
            subject = e.get("email_hs_email_subject") or "(No subject)"
            emails_lines.append(f"[{date}] {subject}: {body[:1000]}")

    context_sections = [
        f"Company: {company_name}",
        f"Industry: {company_industry}",
        f"Country: {company_country}  City: {company_city}",
        f"Lifecycle stage: {company_stage}",
        "",
        f"Deals ({len(deals)}):\n" + ("\n".join(deals_lines) if deals_lines else "  None"),
    ]
    if include_notes:
        label = f"Notes (most recent {len(notes_used)} of {len(notes)}, oldest first)"
        context_sections.append(f"{label}:\n" + ("\n\n".join(notes_lines) if notes_lines else "  None"))
    if include_emails:
        label = f"Emails (most recent {len(emails_used)} of {len(emails)}, oldest first)"
        context_sections.append(f"{label}:\n" + ("\n\n".join(emails_lines) if emails_lines else "  None"))
    context_text = "\n\n".join(context_sections)

    system = (
        "You are a CRM analyst assistant. Answer questions about the provided HubSpot "
        "company data concisely and accurately. Use only the supplied data; if the answer "
        "is not there, say so clearly."
    )
    answer = await call_llm(
        system, f"{context_text}\n\nQuestion: {question}",
        timeout_ms=30_000, max_tokens=600, temperature=0.3,
    )
    return {"answer": answer or "Unable to generate a response. Please try again."}


# ─── Sync ─────────────────────────────────────────────────────────────────────

_SYNC_FIELDS = """id title date dateString duration privacy
  organizer_email host_email participants
  transcript_url audio_url video_url meeting_link is_live
  user { user_id email name }
  speakers { id name }
  meeting_attendees { displayName email phoneNumber name location }
  summary {
    keywords action_items outline shorthand_bullet
    overview bullet_gist gist short_summary short_overview
    meeting_type topics_discussed
  }"""


async def sync_all_calls() -> dict:
    try:
        best = await fetch_all_fireflies_transcripts(_SYNC_FIELDS, 45_000)
    except Exception as err:
        logger.warning("Paginated fetch failed, falling back: %s", err)
        try:
            data = await fireflies_query(build_transcripts_query(500, _SYNC_FIELDS), 30_000)
            best = data.get("transcripts") or []
        except Exception as err2:
            raise HTTPException(status_code=502, detail=f"Fireflies API unreachable: {err2}")

    logger.info("Fetched %d total transcripts (paginated)", len(best))

    excluded_count = 0
    analyzable = []
    for t in best:
        check = should_analyze_meeting(t)
        if not check["allowed"]:
            excluded_count += 1
            logger.info("Ingestion excluded: %s — %s", t.get("title"), check["reason"])
        else:
            analyzable.append(t)
    logger.info("%d pass filter, %d excluded", len(analyzable), excluded_count)

    existing_calls = await asyncio.to_thread(get_all_meetings)
    existing_ids   = {c["id"] for c in existing_calls}

    to_delete = [c for c in existing_calls if not should_analyze_meeting(c)["allowed"]]
    if to_delete:
        await asyncio.to_thread(delete_meetings, [c["id"] for c in to_delete])
        logger.info("Purged %d excluded calls", len(to_delete))

    new_count = 0
    updated_count = 0
    new_call_ids: list[str] = []

    for i in range(0, len(analyzable), 10):
        batch_in = analyzable[i:i + 10]
        to_upsert = []
        for t in batch_in:
            r = redact_transcript(t) or {}
            r["meeting_type"]  = classify_meeting_type(t)
            r["metadata"]      = build_meeting_metadata(t)
            r["hubspot_deals"] = await find_hubspot_deals_for_emails(get_external_emails(t))
            if r.get("id") in existing_ids:
                ex = next((c for c in existing_calls if c["id"] == r.get("id")), None)
                if ex and ex.get("sentences") and not r.get("sentences"):
                    r["sentences"] = ex["sentences"]
                updated_count += 1
            else:
                new_count += 1
                new_call_ids.append(r["id"])
            to_upsert.append(r)
        await asyncio.to_thread(upsert_meetings, to_upsert)

    sync_status = {
        "lastSyncAt":   datetime.now(timezone.utc).isoformat(),
        "totalCalls":   len(existing_calls) - len(to_delete) + new_count,
        "newCalls":     new_count,
        "updatedCalls": updated_count,
    }
    kv_set("sync:status", sync_status)
    try:
        all_m = await asyncio.to_thread(get_all_meetings_light)
        await asyncio.to_thread(_process_analytics, all_m)
    except Exception as e:
        logger.error("[analytics] %s", e)
    try:
        await asyncio.to_thread(_replicate_merlin)
    except Exception as e:
        logger.error("[replica] merlin replicate failed: %s", e)

    return {**sync_status, "newCallIds": new_call_ids}


async def sync_new_calls() -> dict:
    try:
        data = await fireflies_query(build_transcripts_query(50, _SYNC_FIELDS, 0), 25_000)
        latest = data.get("transcripts") or []
    except Exception as err:
        logger.warning("[sync-new] Fireflies unreachable: %s", err)
        last = kv_get("sync:status") or {}
        existing_ids = await asyncio.to_thread(get_all_meeting_ids)
        return {
            "success": True,
            "lastSyncAt": last.get("lastSyncAt") or datetime.now(timezone.utc).isoformat(),
            "totalCalls": len(existing_ids),
            "newCalls": 0,
            "updatedCalls": 0,
            "newCallIds": [],
        }

    logger.info("Incremental sync: fetched %d transcripts", len(latest))

    # Only ids are needed for the new-vs-existing check — avoids fetching full rows.
    existing_ids   = await asyncio.to_thread(get_all_meeting_ids)
    new_calls      = [t for t in latest if t.get("id") not in existing_ids]

    base_status = {
        "lastSyncAt":   datetime.now(timezone.utc).isoformat(),
        "totalCalls":   len(existing_ids),
        "newCalls":     0,
        "updatedCalls": 0,
    }

    if not new_calls:
        kv_set("sync:status", base_status)
        return base_status

    analyzable_new = []
    for t in new_calls:
        check = should_analyze_meeting(t)
        if not check["allowed"]:
            logger.info("Incremental excluded: %s — %s", t.get("title"), check["reason"])
        else:
            analyzable_new.append(t)

    if not analyzable_new:
        kv_set("sync:status", base_status)
        return {**base_status, "note": f"{len(new_calls)} new call(s) excluded by filter"}

    for i in range(0, len(analyzable_new), 5):
        batch_in = analyzable_new[i:i + 5]
        to_upsert = []
        for t in batch_in:
            r = redact_transcript(t) or {}
            r["meeting_type"]  = classify_meeting_type(t)
            r["metadata"]      = build_meeting_metadata(t)
            r["hubspot_deals"] = await find_hubspot_deals_for_emails(get_external_emails(t))
            to_upsert.append(r)
        await asyncio.to_thread(upsert_meetings, to_upsert)

    sync_status = {
        "lastSyncAt":   datetime.now(timezone.utc).isoformat(),
        "totalCalls":   len(existing_ids) + len(analyzable_new),
        "newCalls":     len(analyzable_new),
        "updatedCalls": 0,
    }
    kv_set("sync:status", sync_status)
    try:
        all_m = await asyncio.to_thread(get_all_meetings_light)
        await asyncio.to_thread(_process_analytics, all_m)
    except Exception as e:
        logger.error("[analytics] %s", e)
    try:
        await asyncio.to_thread(_replicate_merlin)
    except Exception as e:
        logger.error("[replica] merlin replicate failed: %s", e)

    return {**sync_status, "newCallIds": [t["id"] for t in analyzable_new]}


# ─── HubSpot ──────────────────────────────────────────────────────────────────

def _hs_qs(params: list[tuple[str, str]]) -> str:
    return "&".join(f"{k}={v}" for k, v in params)


async def get_hubspot_deals(
    limit: int = 10,
    after: str = "",
    properties: list[str] | None = None,
) -> dict:
    props = properties or ["dealname", "amount", "dealstage", "closedate", "pipeline", "hubspot_owner_id"]
    params: list[tuple[str, str]] = [("archived", "false"), ("limit", str(min(limit, 100)))]
    if after:
        params.append(("after", after))
    params += [("properties", p) for p in props]
    return await hubspot_request(f"/crm/v3/objects/0-3?{_hs_qs(params)}")


async def get_hubspot_companies(
    limit: int = 10,
    after: str = "",
    properties: list[str] | None = None,
    associations: list[str] | None = None,
) -> dict:
    props = properties or [
        "name", "city", "country", "industry", "domain", "phone", "state",
        "lifecyclestage", "hubspot_owner_id", "createdate", "hs_lastmodifieddate",
    ]
    assocs = associations or ["deals", "contacts", "notes", "emails"]
    params: list[tuple[str, str]] = [("archived", "false"), ("limit", str(min(limit, 100)))]
    if after:
        params.append(("after", after))
    params += [("properties", p) for p in props]
    params += [("associations", a) for a in assocs]
    return await hubspot_request(f"/crm/v3/objects/companies?{_hs_qs(params)}")


_DEAL_PROPS    = ["dealname", "amount", "dealstage", "closedate", "pipeline", "hubspot_owner_id", "createdate", "hs_lastmodifieddate"]
_NOTE_PROPS    = ["hs_note_body", "hs_createdate", "hs_lastmodifieddate", "hs_timestamp", "hubspot_owner_id"]
_EMAIL_PROPS   = ["hs_email_subject", "hs_email_text", "hs_createdate", "hs_lastmodifieddate", "hs_timestamp", "hubspot_owner_id"]
_CONTACT_PROPS = ["firstname", "lastname", "email", "createdate", "lastmodifieddate"]


async def get_hubspot_deal_by_id(deal_id: str) -> dict:
    qs = _hs_qs([("properties", p) for p in _DEAL_PROPS])
    return await hubspot_request(f"/crm/v3/objects/0-3/{deal_id}?{qs}")


async def get_hubspot_note_by_id(note_id: str) -> dict:
    qs = _hs_qs([("properties", p) for p in _NOTE_PROPS])
    return await hubspot_request(f"/crm/v3/objects/notes/{note_id}?{qs}")


async def get_hubspot_email_by_id(email_id: str) -> dict:
    qs = _hs_qs([("properties", p) for p in _EMAIL_PROPS] + [("archived", "false")])
    return await hubspot_request(f"/crm/v3/objects/emails/{email_id}?{qs}")


async def get_hubspot_contact_by_id(contact_id: str) -> dict:
    qs = _hs_qs([("properties", p) for p in _CONTACT_PROPS])
    return await hubspot_request(f"/crm/v3/objects/contacts/{contact_id}?{qs}")


async def get_hubspot_companies_enriched(limit: int = 100) -> dict:
    """
    Root entity: companies with associations.
    Paginates through ALL companies (HubSpot max 100/page).
    Resolves each associated deal, note, email, and contact by individual ID endpoint.
    Returns {companies, all_deals, all_notes, all_emails, all_contacts}.
    """
    companies: list[dict] = []
    after: str = ""
    page = 0
    while True:
        res = await get_hubspot_companies(limit=limit, after=after, associations=["deals", "contacts", "notes", "emails"])
        page_results = res.get("results") or []
        companies.extend(page_results)
        page += 1
        paging = res.get("paging") or {}
        after = (paging.get("next") or {}).get("after") or ""
        logger.info("[hubspot sync] fetched page %d: %d companies (total so far: %d)", page, len(page_results), len(companies))
        if not after:
            break

    # Collect unique IDs from associations across all companies
    all_deal_ids: set[str] = set()
    all_note_ids: set[str] = set()
    all_email_ids: set[str] = set()
    all_contact_ids: set[str] = set()
    for co in companies:
        assocs = co.get("associations") or {}
        for entry in (assocs.get("deals") or {}).get("results") or []:
            all_deal_ids.add(entry["id"])
        for entry in (assocs.get("notes") or {}).get("results") or []:
            all_note_ids.add(entry["id"])
        for entry in (assocs.get("emails") or {}).get("results") or []:
            all_email_ids.add(entry["id"])
        for entry in (assocs.get("contacts") or {}).get("results") or []:
            all_contact_ids.add(entry["id"])

    # Fetch deals, notes, emails, and contacts concurrently by ID
    deal_results, note_results, email_results, contact_results = await asyncio.gather(
        asyncio.gather(*[get_hubspot_deal_by_id(did) for did in all_deal_ids], return_exceptions=True),
        asyncio.gather(*[get_hubspot_note_by_id(nid) for nid in all_note_ids], return_exceptions=True),
        asyncio.gather(*[get_hubspot_email_by_id(eid) for eid in all_email_ids], return_exceptions=True),
        asyncio.gather(*[get_hubspot_contact_by_id(cid) for cid in all_contact_ids], return_exceptions=True),
    )

    deals_by_id: dict[str, dict] = {}
    for r in deal_results:
        if isinstance(r, dict) and r.get("id"):
            deals_by_id[r["id"]] = r

    notes_by_id: dict[str, dict] = {}
    for r in note_results:
        if isinstance(r, dict) and r.get("id"):
            notes_by_id[r["id"]] = r

    emails_by_id: dict[str, dict] = {}
    for r in email_results:
        if isinstance(r, dict) and r.get("id"):
            emails_by_id[r["id"]] = r

    contacts_by_id: dict[str, dict] = {}
    for r in contact_results:
        if isinstance(r, dict) and r.get("id"):
            contacts_by_id[r["id"]] = r

    # Attach resolved objects back to each company
    for co in companies:
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

    return {
        "companies":    companies,
        "all_deals":    list(deals_by_id.values()),
        "all_notes":    list(notes_by_id.values()),
        "all_emails":   list(emails_by_id.values()),
        "all_contacts": list(contacts_by_id.values()),
    }


async def get_hubspot_contacts(
    limit: int = 10,
    after: str = "",
    properties: list[str] | None = None,
) -> dict:
    props = properties or ["firstname", "lastname", "email"]
    params: list[tuple[str, str]] = [("archived", "false"), ("limit", str(min(limit, 100)))]
    if after:
        params.append(("after", after))
    params += [("properties", p) for p in props]
    return await hubspot_request(f"/crm/v3/objects/contacts?{_hs_qs(params)}")


async def get_hubspot_notes(
    limit: int = 10,
    after: str = "",
    properties: list[str] | None = None,
    associations: list[str] | None = None,
) -> dict:
    props = properties or ["hs_note_body", "hs_createdate", "hs_lastmodifieddate", "hs_timestamp", "hubspot_owner_id"]
    params: list[tuple[str, str]] = [("archived", "false"), ("limit", str(min(limit, 100)))]
    if after:
        params.append(("after", after))
    params += [("properties", p) for p in props]
    if associations:
        params += [("associations", a) for a in associations]
    return await hubspot_request(f"/crm/v3/objects/notes?{_hs_qs(params)}")


async def get_hubspot_pipelines() -> dict:
    return await hubspot_request("/crm/v3/pipelines/deals")


async def get_hubspot_company_details(company_id: str) -> dict:
    """Full note/email bodies for one company — fetched lazily when its modal
    opens, since get_hubspot_flat_data() intentionally omits this per-company
    detail for every company at once (see its docstring)."""
    from db.hubspot import get_hubspot_company_details as _get_details
    return await asyncio.to_thread(_get_details, company_id)


async def search_hubspot_notes(body: dict) -> dict:
    return await hubspot_request("/crm/v3/objects/notes/search", method="POST", json_body=body)


async def search_hubspot_emails(body: dict) -> dict:
    return await hubspot_request("/crm/v3/objects/emails/search", method="POST", json_body=body)


async def sync_hubspot() -> dict:
    """
    Fetch enriched HubSpot data (companies → deals + notes by ID) and
    flatten into the hubspot_data SQLite table.
    """
    from db.hubspot import (
        upsert_hubspot_data, backfill_deal_labels,
        get_deal_count, get_company_count, get_note_count, get_email_count, get_contact_count,
        set_hubspot_sync_status, set_pipeline_labels,
        replicate_to_read_replica as _replicate_hubspot,
    )

    if not HUBSPOT_API_KEY:
        raise HTTPException(status_code=400, detail="HubSpot API key not configured")

    try:
        enriched, pipelines_resp = await asyncio.gather(
            get_hubspot_companies_enriched(),
            get_hubspot_pipelines(),
        )
    except Exception as err:
        logger.error("[hubspot sync] fetch failed: %s", err)
        raise HTTPException(status_code=502, detail=f"HubSpot fetch failed: {err}")

    companies = enriched.get("companies") or []

    # Build stage-id → label map from pipelines API and cache it
    label_map: dict = {}
    for pipeline in (pipelines_resp.get("results") or []):
        for stage in (pipeline.get("stages") or []):
            label_map[stage["id"]] = {
                "stageLabel":    stage["label"],
                "pipelineLabel": pipeline["label"],
            }
    await asyncio.to_thread(set_pipeline_labels, label_map)
    backfilled = await asyncio.to_thread(backfill_deal_labels, label_map)
    if backfilled:
        logger.info("[hubspot sync] back-filled labels on %d existing deal(s)", backfilled)

    new_rows = await asyncio.to_thread(upsert_hubspot_data, companies, label_map)
    logger.info("[hubspot sync] upserted %d rows from %d companies", new_rows, len(companies))

    # lastSyncAt must advance the moment the upsert above succeeds, independent of
    # whatever happens next — a failure while counting rows or replicating must never
    # be able to leave the cursor stuck (see sync_hubspot_incremental()'s comment for
    # why a stuck cursor is actively harmful, not just a stale-looking stat).
    status = {"lastSyncAt": datetime.now(timezone.utc).isoformat()}
    try:
        status = {
            **status,
            "dealCount":    await asyncio.to_thread(get_deal_count),
            "companyCount": await asyncio.to_thread(get_company_count),
            "noteCount":    await asyncio.to_thread(get_note_count),
            "emailCount":   await asyncio.to_thread(get_email_count),
            "contactCount": await asyncio.to_thread(get_contact_count),
        }
    except Exception as e:
        logger.error("[hubspot sync] status count fetch failed (cursor still advances): %s", e)
    await asyncio.to_thread(set_hubspot_sync_status, status)
    try:
        await asyncio.to_thread(_replicate_hubspot)
    except Exception as e:
        logger.error("[replica] hubspot replicate failed: %s", e)
    return status


_HUBSPOT_INCREMENTAL_LIMIT = 10


async def sync_hubspot_incremental() -> dict:
    """
    Incremental sync — fetch the _HUBSPOT_INCREMENTAL_LIMIT most recently
    changed companies (with associations) and upsert them. No "since lastSyncAt"
    cursor: mirrors apis/fireflies.py's incremental pattern (sync_new_calls()
    always fetches the latest 50 transcripts and diffs locally) rather than a
    stored timestamp cursor.

    A stored cursor can get stuck — this project's original implementation did,
    for 18 days, after which the "changed since" window grew large enough to
    exceed HubSpot's 10k search-result cap and 400 on every single run, with no
    way to self-recover. Always asking for "the N most recent" is a fixed,
    small amount of work every single time regardless of how much or how little
    changed upstream, so there's nothing that can get stuck or grow unbounded.
    upsert_hubspot_data() only inserts/updates, never deletes, so re-fetching
    the same few companies on back-to-back runs (when nothing new changed) is
    harmless — it just re-writes what's already there.
    """
    from db.hubspot import (
        upsert_hubspot_data,
        get_deal_count, get_company_count, get_note_count, get_email_count, get_contact_count,
        set_hubspot_sync_status, get_hubspot_sync_status,
        replicate_to_read_replica as _replicate_hubspot,
    )
    from apis.hubspot import get_recently_updated_companies

    if not HUBSPOT_API_KEY:
        raise HTTPException(status_code=400, detail="HubSpot API key not configured")

    last_status = await asyncio.to_thread(get_hubspot_sync_status)
    if not last_status.get("lastSyncAt"):
        return await sync_hubspot()

    try:
        raw_companies = await get_recently_updated_companies(_HUBSPOT_INCREMENTAL_LIMIT)
    except Exception as err:
        logger.error("[hubspot incremental] fetch failed: %s", err)
        raise HTTPException(status_code=502, detail=f"HubSpot incremental fetch failed: {err}")

    logger.info("[hubspot incremental] %d recently-changed companies fetched", len(raw_companies))

    if not raw_companies:
        status = {**last_status, "lastSyncAt": datetime.now(timezone.utc).isoformat()}
        await asyncio.to_thread(set_hubspot_sync_status, status)
        return status

    # Resolve deals, notes, emails, and contacts (mirrors get_hubspot_companies_enriched logic)
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

    deal_results, note_results, email_results, contact_results = await asyncio.gather(
        asyncio.gather(*[get_hubspot_deal_by_id(did) for did in all_deal_ids], return_exceptions=True),
        asyncio.gather(*[get_hubspot_note_by_id(nid) for nid in all_note_ids], return_exceptions=True),
        asyncio.gather(*[get_hubspot_email_by_id(eid) for eid in all_email_ids], return_exceptions=True),
        asyncio.gather(*[get_hubspot_contact_by_id(cid) for cid in all_contact_ids], return_exceptions=True),
    )
    deals_by_id = {r["id"]: r for r in deal_results if isinstance(r, dict) and r.get("id")}
    notes_by_id = {r["id"]: r for r in note_results if isinstance(r, dict) and r.get("id")}
    emails_by_id = {r["id"]: r for r in email_results if isinstance(r, dict) and r.get("id")}
    contacts_by_id = {r["id"]: r for r in contact_results if isinstance(r, dict) and r.get("id")}

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

    from db.hubspot import get_pipeline_labels, backfill_deal_labels
    label_map = await asyncio.to_thread(get_pipeline_labels) or {}
    backfilled = await asyncio.to_thread(backfill_deal_labels, label_map)
    if backfilled:
        logger.info("[hubspot incremental] back-filled labels on %d existing deal(s)", backfilled)
    new_rows = await asyncio.to_thread(upsert_hubspot_data, raw_companies, label_map)
    logger.info("[hubspot incremental] upserted %d rows", new_rows)

    # lastSyncAt here is purely a "when did this last run" display value now —
    # get_recently_updated_companies() has no cursor tied to it, so there's no
    # risk of advancing past unprocessed changes the way the old since-based
    # approach had to guard against.
    status = {"lastSyncAt": datetime.now(timezone.utc).isoformat()}
    try:
        status = {
            **status,
            "dealCount":    await asyncio.to_thread(get_deal_count),
            "companyCount": await asyncio.to_thread(get_company_count),
            "noteCount":    await asyncio.to_thread(get_note_count),
            "emailCount":   await asyncio.to_thread(get_email_count),
            "contactCount": await asyncio.to_thread(get_contact_count),
        }
    except Exception as e:
        logger.error("[hubspot incremental] status count fetch failed: %s", e)
    await asyncio.to_thread(set_hubspot_sync_status, status)
    try:
        await asyncio.to_thread(_replicate_hubspot)
    except Exception as e:
        logger.error("[replica] hubspot replicate failed: %s", e)
    return status


# ─── Product requests ─────────────────────────────────────────────────────────

async def analyze_product_requests(call_ids: list[str] | None = None, force: bool = False) -> dict:
    if not ANTHROPIC_API_KEY and not GROQ_API_KEY:
        raise HTTPException(
            status_code=400,
            detail="No LLM API key configured. Add ANTHROPIC_API_KEY (recommended) or GROQ_API_KEY to .env.",
        )

    # Light fetch is enough here — this pass only filters by organizer/participants,
    # the actual transcript is fetched per-id later via get_full_call_with_transcript.
    all_calls     = await asyncio.to_thread(get_all_meetings_light)
    allowed_calls = [c for c in all_calls if should_analyze_meeting(c)["allowed"]]

    if call_ids:
        allowed_ids = {c["id"] for c in allowed_calls}
        candidates  = [cid for cid in call_ids if cid in allowed_ids]
    else:
        candidates = [c["id"] for c in allowed_calls]

    analyzed_ids: set[str] = set()
    if not force:
        insights = await asyncio.to_thread(get_all_product_insights)
        analyzed_ids = {r["call_id"] for r in insights}

    ids_to_process = [cid for cid in candidates if cid not in analyzed_ids]
    skipped_count  = len(candidates) - len(ids_to_process)

    if not ids_to_process:
        logger.info("[analyze] All %d candidate(s) already analyzed — skipping", skipped_count)
        return {"results": [], "skipped": skipped_count, "newCount": 0}

    logger.info("[analyze] Processing %d call(s), skipping %d", len(ids_to_process), skipped_count)
    results = []

    for call_id in ids_to_process:
        full_call = await get_full_call_with_transcript(call_id)
        if not full_call:
            continue

        transcript_text = build_transcript(full_call)
        call_summary    = full_call.get("summary") or {}
        bg = call_summary.get("bullet_gist")
        summary_bullet_gist = ("\n".join(bg) if isinstance(bg, list) else bg) or None
        short_summary = call_summary.get("short_summary") or None

        organizer = (full_call.get("organizer_email") or "")
        ae_name   = re.sub(r"[._\-]", " ", organizer.split("@")[0]).strip()
        participants = full_call.get("participants") or []
        client_name  = (
            next((p for p in participants if p != organizer), None)
            or (full_call.get("title") or "").split(" - ")[0]
            or "Unknown"
        )
        date_val = full_call.get("date")
        if isinstance(date_val, (int, float)):
            from datetime import datetime
            date_str = datetime.fromtimestamp(date_val / 1000).strftime("%m/%d/%Y")
        else:
            date_str = str(date_val) if date_val else ""

        base = {
            "callId":       full_call.get("id"),
            "callTitle":    full_call.get("title") or "Untitled",
            "aeName":       ae_name,
            "clientName":   client_name,
            "date":         date_str,
            "transcriptUrl":full_call.get("transcript_url") or "#",
            "summaryBulletGist": summary_bullet_gist,
            "shortSummary":      short_summary,
        }

        if not transcript_text.strip():
            results.append({**base, "items": []})
            continue

        items = await extract_product_mentions(full_call, transcript_text)
        results.append({**base, "items": items})
        await asyncio.sleep(0.2)

    if results:
        await asyncio.to_thread(
            upsert_product_insights,
            [
                {
                    "call_id":        r["callId"],
                    "call_title":     r["callTitle"],
                    "ae_name":        r["aeName"],
                    "client_name":    r["clientName"],
                    "date":           r["date"],
                    "transcript_url": r["transcriptUrl"],
                    "items":          r["items"],
                }
                for r in results
            ],
        )
        try:
            await asyncio.to_thread(
                upsert_product_analysis,
                [
                    {
                        "uuid":                r["callId"],
                        "call_title":          r["callTitle"],
                        "ae_name":             r["aeName"],
                        "date":                r["date"],
                        "summary_bullet_gist": r["summaryBulletGist"],
                        "short_summary":       r["shortSummary"],
                    }
                    for r in results
                ],
            )
        except Exception as e:
            logger.error("[analytics] product_analysis upsert error: %s", e)

    return {"results": results, "skipped": skipped_count, "newCount": len(results)}


def get_product_insights_list() -> list[dict]:
    return [
        {
            "callId":            r["call_id"],
            "callTitle":         r["call_title"],
            "aeName":            r["ae_name"],
            "clientName":        r["client_name"],
            "date":              r["date"],
            "transcriptUrl":     r["transcript_url"],
            "items":             r["items"],
            "analyzedAt":        r["analyzed_at"],
            "summaryBulletGist": r.get("summary_bullet_gist"),
            "shortSummary":      r.get("summary_short_summary"),
        }
        for r in get_all_product_insights_replica()
    ]


def clear_product_insights() -> None:
    delete_product_insights()


# ─── Analytics ────────────────────────────────────────────────────────────────

def get_analytics() -> dict:
    return _get_analytics()


def run_process_analytics() -> dict:
    return _process_analytics(get_all_meetings_light())


def list_product_analysis() -> list[dict]:
    return get_product_analysis()


def clear_product_analysis(ids: list[str] | None = None) -> None:
    delete_product_analysis(ids)


# ─── Query rewrite ────────────────────────────────────────────────────────────

_INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)", re.IGNORECASE),
    re.compile(r"\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|UNION)\s+(ALL\s+)?", re.IGNORECASE),
    re.compile(r"system\s*[:=]\s*", re.IGNORECASE),
    re.compile(r"\[system\]", re.IGNORECASE),
    re.compile(r"override\s+(system|instructions?|guardrails?)", re.IGNORECASE),
    re.compile(r"bypass\s+(system|safety|filters?)", re.IGNORECASE),
]


async def rewrite_query(
    current_query: str,
    previous_response_summary: str | None = None,
    previous_queries: list[str] | None = None,
    conversation_history: list[dict] | None = None,
) -> dict:
    if not current_query:
        raise HTTPException(status_code=400, detail="currentQuery is required")

    if any(p.search(current_query) for p in _INJECTION_PATTERNS):
        logger.warning("[QueryRewrite] Blocked suspicious query: %r", current_query[:80])
        return {"rewrittenQuery": current_query, "wasRewritten": False, "reason": "Query blocked by guardrails"}

    if not ANTHROPIC_API_KEY and not GROQ_API_KEY:
        return {"rewrittenQuery": current_query, "wasRewritten": False, "reason": "No LLM API key configured"}

    conversation_context = ""
    if conversation_history:
        conversation_context = "CONVERSATION HISTORY (oldest → newest):\n"
        for i, turn in enumerate(conversation_history):
            conversation_context += f"Turn {i + 1}:\n  User: \"{turn.get('query')}\"\n"
            if turn.get("responseSummary"):
                conversation_context += f"  Assistant: {turn['responseSummary']}\n"
    elif previous_queries:
        conversation_context = "Previous user queries (most recent first):\n"
        conversation_context += "\n".join(f"{i + 1}. \"{q}\"" for i, q in enumerate(previous_queries))
        if previous_response_summary:
            conversation_context += f"\n\nSummary of the most recent assistant response:\n{previous_response_summary}"

    user_prompt = (
        QUERY_REWRITE_REFERENCE_RESOLUTION_USER_TEMPLATE
        .replace("{{conversationContext}}", conversation_context)
        .replace("{{currentQuery}}", current_query)
    )

    try:
        rewritten = await call_llm(
            QUERY_REWRITE_REFERENCE_RESOLUTION_SYSTEM_PROMPT,
            user_prompt,
            timeout_ms=12_000,
            max_tokens=400,
            temperature=0.2,
        )
        if not rewritten:
            return {"rewrittenQuery": current_query, "wasRewritten": False, "reason": "Empty LLM response"}
        cleaned = rewritten.strip().strip("\"'")
        was_rewritten = cleaned.lower() != current_query.lower().strip()
        logger.info("[QueryRewrite] %r → %r (changed: %s)", current_query, cleaned, was_rewritten)
        return {"rewrittenQuery": cleaned, "wasRewritten": was_rewritten}
    except Exception as err:
        return {"rewrittenQuery": current_query, "wasRewritten": False, "reason": f"LLM error: {err}"}


# ─── Result context builder (for SSE streaming) ───────────────────────────────

def build_result_context(result_data: dict) -> str:
    r = result_data
    parts: list[str] = []

    if r.get("queryEntity"):      parts.append(f"Topic: \"{r['queryEntity']}\"")
    if r.get("searchedCallCount"):parts.append(f"Calls analyzed: {r['searchedCallCount']}")
    if r.get("timeFilter"):       parts.append(f"Time range: {r['timeFilter']}")

    if r.get("noResults"):
        return "\n".join([*parts, "Result: No matches found"])

    if r.get("totalMentions") is not None: parts.append(f"Total mentions: {r['totalMentions']}")
    if r.get("totalMeetings") is not None: parts.append(f"Matching meetings: {r['totalMeetings']}")

    for t in (r.get("topTopics") or [])[:5]:
        parts.append(f"Top topics: \"{t['topic']}\" ({t['count']} mentions / {t.get('callCount')} calls, trend: {t.get('trend')})")

    for m in (r.get("mentions") or [])[:3]:
        parts.append(f"- \"{m.get('callTitle')}\" ({m.get('date')}, {m.get('mentionCount')} hits)")
        snip = (((m.get("snippets") or [{}])[0]).get("text") or "")[:150]
        if snip:
            parts.append(f"  Quote: \"{snip}\"")

    rankings = r.get("participantRankings") or []
    aes = [p for p in rankings if p.get("isAE")]
    ext = [p for p in rankings if not p.get("isAE")]
    if rankings:
        parts.append(f"Participants: {len(aes)} AEs, {len(ext)} external")
        if aes:
            parts.append(f"Most active AE: {aes[0]['name']} ({aes[0]['callCount']} calls)")

    action_items = r.get("actionItems") or []
    if action_items:
        parts.append(f"Action items found: {len(action_items)}")
        sample = (action_items[0].get("item") or "")[:100]
        if sample:
            parts.append(f"Sample: \"{sample}\"")

    if r.get("sentiment"):
        s = r["sentiment"]
        total = (s.get("positive", 0) + s.get("neutral", 0) + s.get("negative", 0)) or 1
        parts.append(
            f"Sentiment: {s.get('positive')} positive ({round(s.get('positive', 0) / total * 100)}%), "
            f"{s.get('neutral')} neutral, {s.get('negative')} negative"
        )

    dur = r.get("durationList") or []
    if dur:
        parts.append(f"Longest: \"{dur[0]['title']}\" at {dur[0]['duration']}")
        parts.append(f"Shortest: \"{dur[-1]['title']}\" at {dur[-1]['duration']}")

    for c in (r.get("competitorMentions") or [])[:5]:
        parts.append(f"Competitors mentioned: {c['competitor']} ({c['callCount']} calls)")

    if r.get("overviewStats"):
        s = r["overviewStats"]
        parts.append(
            f"Overview: {s.get('totalCalls')} total calls, {s.get('totalDuration')} total, "
            f"avg {s.get('avgDuration')}, {s.get('uniqueParticipants')} participants"
        )
        if s.get("topTopics"):
            parts.append("Top topics: " + ", ".join(s["topTopics"][:5]))

    return "\n".join(parts)


# ─── Historical ingest ────────────────────────────────────────────────────────

async def ingest_historical(directory: str | None, on_progress=None) -> dict:
    if not directory or not isinstance(directory, str):
        raise HTTPException(status_code=400, detail='Request body must include a "dir" string field.')
    return await fireflies_historical(directory, on_progress=on_progress)


# ─── Chat (users + sessions) ──────────────────────────────────────────────────

from db.chat_db import (
    upsert_user as _upsert_user,
    get_user_by_email as _get_user_by_email,
    get_sessions_for_user as _get_sessions_for_user,
    get_session as _get_session,
    create_session as _create_session,
    update_session as _update_session,
    delete_session as _delete_session,
)


def chat_upsert_user(email: str, name: str = "", display_name: str = "") -> dict:
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Valid email is required")
    user = _upsert_user(email=email, name=name, display_name=display_name)
    logger.debug("[chat] upserted user %s (id=%s)", email, user.get("user_id"))
    return user


def chat_get_sessions(user_id: str) -> list[dict]:
    return _get_sessions_for_user(user_id)


def chat_get_session(session_id: str) -> dict:
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


def chat_create_session(user_id: str, session_id: str | None = None, messages: list | None = None) -> dict:
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id is required")
    session = _create_session(user_id=user_id, session_id=session_id, messages=messages)
    logger.info("[chat] created session %s for user %s", session.get("session_id"), user_id)
    return session


def chat_update_session(session_id: str, messages: list | None = None, chat_summary: str | None = None) -> dict:
    updated = _update_session(session_id=session_id, messages=messages, chat_summary=chat_summary)
    if not updated:
        raise HTTPException(status_code=404, detail="Session not found")
    logger.debug("[chat] updated session %s", session_id)
    return {"success": True}


def chat_delete_session(session_id: str) -> dict:
    deleted = _delete_session(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
    logger.info("[chat] deleted session %s", session_id)
    return {"success": True}


async def chat_generate_title(session_id: str, first_message: str) -> dict:
    """Generate a 3-5 word session title from the first user message using Groq's gpt-oss-20b."""
    title = (first_message[:60] + "…") if len(first_message) > 60 else first_message
    if GROQ_API_KEY:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
                    json={
                        "model": "openai/gpt-oss-20b",
                        "messages": [
                            {"role": "system", "content": "Generate a concise 3-5 word chat title for this query. Return only the title, no quotes, no trailing punctuation."},
                            {"role": "user", "content": first_message[:300]},
                        ],
                        "temperature": 0.3,
                        "max_tokens": 60,
                        # gpt-oss is a reasoning model — without this, hidden
                        # reasoning tokens can eat the whole max_tokens budget
                        # before any visible content is emitted.
                        "reasoning_effort": "low",
                    },
                )
                if resp.is_success:
                    gen = (resp.json().get("choices") or [{}])[0].get("message", {}).get("content", "").strip().strip("\"'").rstrip(".")
                    if gen:
                        title = gen
        except Exception as e:
            logger.error("[chat-title] Groq error: %s", e)
    _update_session(session_id=session_id, chat_summary=title)
    logger.info("[chat-title] session=%s title=%r", session_id, title)
    return {"title": title}


# ─── Auth ─────────────────────────────────────────────────────────────────────

_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000  # 7 days


def _extract_token(auth_header: str | None) -> str | None:
    if not auth_header:
        return None
    auth_header = auth_header.strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip() or None
    return auth_header or None  # tolerate a bare token, no "Bearer " prefix


def _public_auth_user(user: dict) -> dict:
    return {
        "email": user["emailid"],
        "username": user["username"],
        "securityquestion": user["securityquestion"],
        "lastloggedin": user.get("lastloggedin"),
    }


def auth_signup(email: str, username: str, password: str, securityquestion: str, answer: str) -> dict:
    email = (email or "").strip().lower()
    username = (username or "").strip()
    securityquestion = (securityquestion or "").strip()
    answer = (answer or "").strip()

    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Valid email is required")
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")
    if not password or len(password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    if not securityquestion or not answer:
        raise HTTPException(status_code=400, detail="Security question and answer are required")
    if _get_auth_user(email):
        raise HTTPException(status_code=409, detail="An account with this email already exists")

    user = _create_auth_user(
        emailid=email,
        username=username,
        password_hash=hash_secret(password),
        securityquestion=securityquestion,
        answer_hash=hash_secret(answer.lower()),
    )
    logger.info("[auth] signup for %s", email)
    return _public_auth_user(user)


def auth_login(email: str, password: str) -> dict:
    email = (email or "").strip().lower()
    user = _get_auth_user(email)
    if not user or not verify_secret(password or "", user["password"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    _update_auth_last_logged_in(email, now_ms)
    user["lastloggedin"] = now_ms

    token = generate_token()
    _create_auth_session(token, email, _SESSION_TTL_MS)

    logger.info("[auth] login for %s", email)
    return {**_public_auth_user(user), "token": token}


def auth_logout(authorization: str | None) -> dict:
    token = _extract_token(authorization)
    if token:
        try:
            _delete_auth_session(token)
        except Exception:
            pass
    return {"success": True}


def auth_verify_token(authorization: str | None) -> str:
    token = _extract_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    session = _get_auth_session(token)
    if not session:
        raise HTTPException(status_code=401, detail="Session expired or invalid")
    return session["emailid"]


def auth_get_security_question(email: str) -> dict:
    email = (email or "").strip().lower()
    user = _get_auth_user(email)
    if not user:
        raise HTTPException(status_code=404, detail="No account found with this email")
    return {"securityquestion": user["securityquestion"]}


def auth_reset_password(email: str, answer: str, new_password: str) -> dict:
    email = (email or "").strip().lower()
    user = _get_auth_user(email)
    if not user:
        raise HTTPException(status_code=404, detail="No account found with this email")
    if not verify_secret((answer or "").strip().lower(), user["answer"]):
        raise HTTPException(status_code=401, detail="Security answer is incorrect")
    if not new_password or len(new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    _update_auth_password(email, hash_secret(new_password))
    logger.info("[auth] password reset for %s", email)
    return {"success": True}
