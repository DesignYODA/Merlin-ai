"""
hubspot.py — HubSpot REST API client with rate limiting (10 req/s).
Mirrors hubspotRequest() and findHubSpotDealsForEmails() from apis.mjs.
"""
import asyncio
import time
from datetime import datetime, timezone as _tz
import httpx
from config.config import HUBSPOT_API_BASE, HUBSPOT_API_KEY
from config.logging_config import get_logger

logger = get_logger("merlin.apis.hubspot")

_hs_timestamps: list[float] = []
_hs_lock = asyncio.Lock()


_HS_MAX_PER_SECOND = 10  # HubSpot's standard private-app limit is 100 req/10s — 10/s sustained

# Shared, pooled client — every hubspot_request() call used to open its own
# httpx.AsyncClient(), meaning a fresh TCP+TLS handshake per call. Under any
# concurrent burst (e.g. find_hubspot_deals_for_emails() fanning out over a
# batch of new call attendees) that meant dozens of simultaneous new
# connections instead of a handful of reused, keep-alive ones — the direct
# cause of the ConnectTimeout storms seen under load. One shared client with
# keep-alive reuses connections across calls instead.
_client: httpx.AsyncClient | None = None
_client_init_lock = asyncio.Lock()


async def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        async with _client_init_lock:
            if _client is None:
                _client = httpx.AsyncClient(
                    limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
                )
    return _client


async def close_hubspot_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def _hs_throttle() -> None:
    async with _hs_lock:
        now = time.monotonic() * 1000
        while _hs_timestamps and now - _hs_timestamps[0] >= 1000:
            _hs_timestamps.pop(0)
        if len(_hs_timestamps) >= _HS_MAX_PER_SECOND:
            wait_ms = 1000 - (now - _hs_timestamps[0]) + 1
            await asyncio.sleep(wait_ms / 1000)
            now = time.monotonic() * 1000
            while _hs_timestamps and now - _hs_timestamps[0] >= 1000:
                _hs_timestamps.pop(0)
        _hs_timestamps.append(time.monotonic() * 1000)


async def hubspot_request(
    path: str,
    *,
    method: str = "GET",
    json_body: dict | None = None,
    headers: dict | None = None,
    _retries: int = 3,
    timeout: float = 30.0,
) -> dict:
    if not HUBSPOT_API_KEY:
        raise ValueError("HUBSPOT_API_KEY not configured")

    await _hs_throttle()

    url = path if path.startswith("http") else f"{HUBSPOT_API_BASE}{path}"
    merged_headers = {
        "Authorization": f"Bearer {HUBSPOT_API_KEY}",
        "Content-Type": "application/json",
        **(headers or {}),
    }

    client = await _get_client()
    resp = await client.request(method, url, headers=merged_headers, json=json_body, timeout=timeout)

    if resp.status_code == 429:
        if _retries <= 0:
            raise RuntimeError("HubSpot rate limit exceeded after retries")
        retry_after = resp.headers.get("Retry-After")
        wait_s = float(retry_after) if retry_after else 1.0
        logger.warning("[hubspot] Rate limited — waiting %.1fs before retry (%d left)", wait_s, _retries)
        await asyncio.sleep(wait_s)
        return await hubspot_request(path, method=method, json_body=json_body, headers=headers, _retries=_retries - 1, timeout=timeout)

    if not resp.is_success:
        raise RuntimeError(f"HubSpot API error: {resp.status_code} {resp.text}")

    return resp.json()


# ─── Incremental fetch helpers ────────────────────────────────────────────────

_CO_PROPS = [
    "name", "domain", "phone", "city", "state", "country",
    "industry", "createdate", "lifecyclestage", "hubspot_owner_id",
    "hs_lastmodifieddate",
]
_CO_ASSOCS = ["deals", "contacts", "notes", "emails"]


# HubSpot's Search API hard-fails (400) once pagination crosses 10,000 total
# results for a single query — it cannot be paginated past that regardless of
# filters. This only bites when the "since" cutoff is old enough that the
# matched set grows past 10k (e.g. a stuck sync cursor re-scanning weeks of
# history). Capping here means a stale cursor degrades to "process the most
# overdue 10k changes and let the cursor catch up next run" instead of
# hard-failing the entire incremental sync every single time.
_SEARCH_RESULT_CAP = 10_000


async def _search_hs_since(
    object_type: str,
    since_iso: str,
    properties: list[str] | None = None,
    date_property: str = "hs_lastmodifieddate",
    until_iso: str | None = None,
) -> list[dict]:
    """
    Search HubSpot objects with `date_property` >= since_iso (and, if given,
    < until_iso). Paginates all results (up to HubSpot's 10k search cap — see
    _SEARCH_RESULT_CAP).
    Most objects (companies, deals, notes, emails) use `hs_lastmodifieddate` — contacts
    are the exception and use plain `lastmodifieddate` instead, so callers searching
    contacts must pass date_property="lastmodifieddate".
    `until_iso` bounds the window on both ends — used by the backfill script to walk
    a large historical range in fixed-size date chunks, so no single chunk's query
    can approach the 10k cap regardless of how old (and dense) the range is.
    """
    filters = [{"propertyName": date_property, "operator": "GTE", "value": since_iso}]
    if until_iso:
        filters.append({"propertyName": date_property, "operator": "LT", "value": until_iso})
    base_body: dict = {
        "filterGroups": [{"filters": filters}],
        "limit": 100,
    }
    if properties:
        base_body["properties"] = properties

    all_results: list[dict] = []
    after: str | None = None
    while True:
        body = {**base_body}
        if after:
            body["after"] = after
        resp = await hubspot_request(f"/crm/v3/objects/{object_type}/search", method="POST", json_body=body)
        page = resp.get("results") or []
        all_results.extend(page)
        paging = resp.get("paging") or {}
        after = (paging.get("next") or {}).get("after") or None
        if not after:
            break
        if len(all_results) >= _SEARCH_RESULT_CAP:
            logger.warning(
                "[hubspot incremental] %s search hit the %d-result cap (since=%s until=%s) — "
                "remaining changes will be picked up once the sync cursor catches up",
                object_type, _SEARCH_RESULT_CAP, since_iso, until_iso,
            )
            break
    return all_results


async def _batch_assoc_company_ids(object_type: str, object_ids: list[str]) -> set[str]:
    """Return company IDs for all given object IDs in bulk (max 100 per request)."""
    if not object_ids:
        return set()
    company_ids: set[str] = set()
    for i in range(0, len(object_ids), 100):
        batch = object_ids[i : i + 100]
        try:
            resp = await hubspot_request(
                f"/crm/v4/associations/{object_type}/companies/batch/read",
                method="POST",
                json_body={"inputs": [{"id": oid} for oid in batch]},
            )
            for item in (resp.get("results") or []):
                for assoc in (item.get("to") or []):
                    if assoc.get("toObjectId"):
                        company_ids.add(str(assoc["toObjectId"]))
        except Exception:
            pass
    return company_ids


async def get_company_with_associations(company_id: str) -> dict | None:
    """Fetch a single company with deals/contacts/notes/emails associations."""
    qs = "&".join(
        [f"properties={p}" for p in _CO_PROPS] +
        [f"associations={a}" for a in _CO_ASSOCS]
    )
    try:
        return await hubspot_request(f"/crm/v3/objects/companies/{company_id}?{qs}")
    except Exception:
        return None


async def get_companies_updated_since(since_ms: int, until_ms: int | None = None) -> list[dict]:
    """
    Return raw company objects (with associations) for companies that were
    directly modified, or whose associated deals/notes/emails/contacts were
    modified, since `since_ms` (unix milliseconds), optionally bounded above
    by `until_ms` — used by the backfill script to walk a historical range in
    fixed-size date chunks so no single query risks the 10k search cap.
    """
    since_iso = datetime.fromtimestamp(since_ms / 1000, tz=_tz.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    until_iso = (
        datetime.fromtimestamp(until_ms / 1000, tz=_tz.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        if until_ms is not None else None
    )

    # Search companies, deals, notes, emails, and contacts modified since the cutoff concurrently.
    # return_exceptions=True: one object type failing (rate limit, transient 5xx, etc.) must not
    # discard the other four — a plain gather() would abort the whole incremental fetch on any
    # single failure, which is exactly what kept it from ever completing (and from ever advancing
    # the sync cursor) when one search type hit an error.
    labels = ["companies", "deals", "notes", "emails", "contacts"]
    results = await asyncio.gather(
        _search_hs_since("companies", since_iso, _CO_PROPS, until_iso=until_iso),
        _search_hs_since("0-3", since_iso, until_iso=until_iso),
        _search_hs_since("notes", since_iso, until_iso=until_iso),
        _search_hs_since("emails", since_iso, until_iso=until_iso),
        _search_hs_since("contacts", since_iso, date_property="lastmodifieddate", until_iso=until_iso),
        return_exceptions=True,
    )
    for label, r in zip(labels, results):
        if isinstance(r, Exception):
            logger.error("[hubspot incremental] %s search failed, treating as no changes this run: %s", label, r)
    co_hits, deal_hits, note_hits, email_hits, contact_hits = [
        r if not isinstance(r, Exception) else [] for r in results
    ]

    company_ids: set[str] = {c["id"] for c in co_hits}

    # Find companies affected by changed deals/notes/emails/contacts — 4 batch requests max
    if deal_hits or note_hits or email_hits or contact_hits:
        deal_co_ids, note_co_ids, email_co_ids, contact_co_ids = await asyncio.gather(
            _batch_assoc_company_ids("0-3",      [d["id"] for d in deal_hits]),
            _batch_assoc_company_ids("notes",    [n["id"] for n in note_hits]),
            _batch_assoc_company_ids("emails",   [e["id"] for e in email_hits]),
            _batch_assoc_company_ids("contacts", [c["id"] for c in contact_hits]),
        )
        company_ids.update(deal_co_ids)
        company_ids.update(note_co_ids)
        company_ids.update(email_co_ids)
        company_ids.update(contact_co_ids)

    if not company_ids:
        return []

    # Fetch all affected companies with full associations
    results = await asyncio.gather(*[get_company_with_associations(cid) for cid in company_ids])
    return [c for c in results if c]


async def _search_hs_recent(
    object_type: str,
    limit: int,
    properties: list[str] | None = None,
    date_property: str = "hs_lastmodifieddate",
) -> list[dict]:
    """
    Return the `limit` most-recently-modified objects of this type — one
    unpaginated request, sorted newest-first. No "since" cursor at all: this
    mirrors apis/fireflies.py's fetch_all_fireflies_transcripts()'s incremental
    sibling (fireflies_query for the latest 50, diffed locally) rather than
    HubSpot's own since-timestamp search. A stored cursor can get stuck (as
    happened here) and then re-scan an ever-growing window; asking for "the
    N most recent" is always the same fixed amount of work no matter how much
    or how little actually changed upstream, so there's nothing to get stuck.
    """
    body: dict = {
        "sorts": [{"propertyName": date_property, "direction": "DESCENDING"}],
        "limit": limit,
    }
    if properties:
        body["properties"] = properties
    resp = await hubspot_request(f"/crm/v3/objects/{object_type}/search", method="POST", json_body=body)
    return resp.get("results") or []


async def get_recently_updated_companies(limit: int = 10) -> list[dict]:
    """
    Return up to `limit` companies (with full associations) — the most recently
    modified companies directly, plus companies whose most recently modified
    deals/notes/emails/contacts point back to them. Companies are capped at
    `limit` *before* the expensive per-company get_company_with_associations()
    fan-out, so a single call never does more than a fixed, small amount of
    work regardless of how much changed upstream (unlike the old cursor-based
    get_companies_updated_since(), which could resolve associations for
    thousands of companies before any cap applied).
    """
    labels = ["companies", "deals", "notes", "emails", "contacts"]
    results = await asyncio.gather(
        _search_hs_recent("companies", limit, _CO_PROPS),
        _search_hs_recent("0-3", limit),
        _search_hs_recent("notes", limit),
        _search_hs_recent("emails", limit),
        _search_hs_recent("contacts", limit, date_property="lastmodifieddate"),
        return_exceptions=True,
    )
    for label, r in zip(labels, results):
        if isinstance(r, Exception):
            logger.error("[hubspot incremental] %s recent-fetch failed, treating as no changes: %s", label, r)
    co_hits, deal_hits, note_hits, email_hits, contact_hits = [
        r if not isinstance(r, Exception) else [] for r in results
    ]

    company_ids: set[str] = {c["id"] for c in co_hits}
    if deal_hits or note_hits or email_hits or contact_hits:
        deal_co_ids, note_co_ids, email_co_ids, contact_co_ids = await asyncio.gather(
            _batch_assoc_company_ids("0-3",      [d["id"] for d in deal_hits]),
            _batch_assoc_company_ids("notes",    [n["id"] for n in note_hits]),
            _batch_assoc_company_ids("emails",   [e["id"] for e in email_hits]),
            _batch_assoc_company_ids("contacts", [c["id"] for c in contact_hits]),
        )
        company_ids.update(deal_co_ids)
        company_ids.update(note_co_ids)
        company_ids.update(email_co_ids)
        company_ids.update(contact_co_ids)

    if not company_ids:
        return []

    bounded_ids = list(company_ids)[:limit]
    results = await asyncio.gather(*[get_company_with_associations(cid) for cid in bounded_ids])
    return [c for c in results if c]


# ─── Email → deal lookup ──────────────────────────────────────────────────────

async def _find_deals_for_one_email(email: str) -> set[str]:
    deal_ids: set[str] = set()
    try:
        search = await hubspot_request(
            "/crm/v3/objects/contacts/search",
            method="POST",
            json_body={
                "filterGroups": [
                    {"filters": [{"propertyName": "email", "operator": "EQ", "value": email}]}
                ],
                "properties": ["email"],
            },
            _retries=1, timeout=8.0,
        )
        contacts = search.get("results") or []
        if not contacts:
            return deal_ids
        contact_id = contacts[0]["id"]
        assoc = await hubspot_request(
            f"/crm/v4/objects/contacts/{contact_id}/associations/deals",
            _retries=1, timeout=8.0,
        )
        for a in (assoc.get("results") or []):
            if a.get("toObjectId"):
                deal_ids.add(str(a["toObjectId"]))
    except Exception as err:
        if "not configured" not in str(err):
            # httpx timeout/connection exceptions often stringify to "" — log the
            # type too, otherwise failures show up as "Error finding deals for x: "
            # with nothing useful after the colon.
            logger.warning("[hubspot] deal lookup failed for %s: %s: %s", email, type(err).__name__, err or "(no message)")
    return deal_ids


async def find_hubspot_deals_for_emails(emails: list[str]) -> list[str]:
    """
    Best-effort deal linking for Fireflies calls — must never meaningfully delay
    the caller. Previously ran one email at a time, each doing up to 2 HubSpot
    calls with up to 3 retries at a 30s timeout — under any HubSpot rate
    limiting (e.g. a concurrent sync), a transcript with several external
    participants could stall the whole Fireflies sync for minutes. Lookups now
    run concurrently (still throttled by the shared _hs_throttle rate limiter)
    with a short timeout and a single retry, so a slow/rate-limited HubSpot
    degrades to "no deals found for this email" quickly instead of blocking.
    """
    valid_emails = [e for e in emails if e]
    if not valid_emails:
        return []

    results = await asyncio.gather(*[_find_deals_for_one_email(e) for e in valid_emails])
    deal_ids: set[str] = set()
    for r in results:
        deal_ids.update(r)

    return list(deal_ids)
