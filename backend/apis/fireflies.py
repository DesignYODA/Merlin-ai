"""
fireflies.py — Fireflies GraphQL API client + transcript helpers.
Mirrors the Fireflies-related functions from apis.mjs.
"""

import asyncio
import re
from typing import Any

import httpx

from config.config import (
    FIREFLIES_API_KEY,
    FIREFLIES_API_URL,
    FIREFLIES_FROM_DATE,
    REDACTED_NAMES,
    EXCLUDED_HOSTS,
    EXCLUDED_TITLES,
    INTERNAL_DOMAINS,
    HIRING_KEYWORDS,
)
from config.logging_config import get_logger
from db.merlin_db import get_meeting_by_id, upsert_meetings

logger = get_logger("merlin.fireflies")

# Compiled redaction regex (equivalent to JS REDACT_REGEX with gi flags)
_REDACT_RE = (
    re.compile("|".join(re.escape(n) for n in REDACTED_NAMES), re.IGNORECASE)
    if REDACTED_NAMES
    else None
)


# ─── Internal helpers ─────────────────────────────────────────────────────────

def _is_hiring_meeting(title: str | None) -> bool:
    lower = (title or "").lower()
    return any(kw in lower for kw in HIRING_KEYWORDS)


def _redact_str(val: Any) -> str:
    if val is None:
        return ""
    s = str(val) if not isinstance(val, str) else val
    if not _REDACT_RE:
        return s
    return _REDACT_RE.sub("[Redacted]", s)


def _redact_arr(val: Any) -> list[str]:
    arr: list = val if isinstance(val, list) else ([val] if isinstance(val, str) and val.strip() else [])
    if not _REDACT_RE:
        return [_redact_str(s) for s in arr if s is not None]
    return [
        _redact_str(s)
        for s in arr
        if s is not None and not _REDACT_RE.search(str(s).strip())
    ]


# ─── Public API ───────────────────────────────────────────────────────────────

def extract_emails(meeting: dict) -> list[str]:
    attendees = meeting.get("meeting_attendees") or []
    if isinstance(attendees, list) and attendees:
        return [a.get("email") for a in attendees if a.get("email")]
    return [p for p in (meeting.get("participants") or []) if p]


def get_external_emails(meeting: dict) -> list[str]:
    return [
        e for e in extract_emails(meeting)
        if e and isinstance(e, str) and "@" in e
        and not any(e.lower().endswith(f"@{d}") for d in INTERNAL_DOMAINS)
    ]


def should_analyze_meeting(meeting: dict) -> dict:
    organizer = (meeting.get("organizer_email") or "").split("@")[0]
    organizer = re.sub(r"[._\-]", " ", organizer).lower().strip()
    for host in EXCLUDED_HOSTS:
        if organizer == host.lower():
            return {"allowed": False, "reason": f"Excluded host: {host}"}

    title_lower = (meeting.get("title") or "").lower().strip()
    for ex in EXCLUDED_TITLES:
        if title_lower == ex.lower():
            return {"allowed": False, "reason": f"Excluded title: {ex}"}

    if _is_hiring_meeting(meeting.get("title")):
        return {"allowed": False, "reason": f"Hiring/interview meeting: {meeting.get('title')}"}

    participants = extract_emails(meeting)
    if participants:
        has_external = any(
            "@" in e and not any(e.lower().endswith(f"@{d}") for d in INTERNAL_DOMAINS)
            for e in participants
            if e and isinstance(e, str)
        )
        if not has_external:
            return {"allowed": False, "reason": "Internal-only meeting (no external participants)"}

    return {"allowed": True}


def classify_meeting_type(meeting: dict) -> str:
    if not should_analyze_meeting(meeting)["allowed"]:
        return "excluded"
    participants = extract_emails(meeting)
    has_external = any(
        "@" in e and not any(e.lower().endswith(f"@{d}") for d in INTERNAL_DOMAINS)
        for e in participants
        if e and isinstance(e, str)
    )
    return "external_call" if has_external else "internal_call"


def build_meeting_metadata(meeting: dict) -> dict:
    organizer = re.sub(r"[._\-]", " ", (meeting.get("organizer_email") or "").split("@")[0]).lower().strip()
    is_excluded_host = any(organizer == h.lower() for h in EXCLUDED_HOSTS)
    is_hiring = _is_hiring_meeting(meeting.get("title"))
    participants = extract_emails(meeting)
    has_external = bool(participants) and any(
        "@" in e and not any(e.lower().endswith(f"@{d}") for d in INTERNAL_DOMAINS)
        for e in participants if e and isinstance(e, str)
    )
    is_internal = bool(participants) and not has_external
    return {
        "is_hiring_meeting":       is_hiring,
        "is_internal_meeting":     is_internal,
        "is_excluded_host":        is_excluded_host,
        "has_external_participant":has_external,
    }


def redact_transcript(t: dict | None) -> dict | None:
    if not t:
        return t
    try:
        r = dict(t)
        r["title"] = _redact_str(t.get("title"))
        r["organizer_email"] = t.get("organizer_email") or ""
        r["participants"] = _redact_arr(t.get("participants"))
        s = t.get("summary")
        if s:
            r["summary"] = {
                **s,
                "keywords":         _redact_arr(s.get("keywords")),
                "action_items":     _redact_arr(s.get("action_items")),
                "outline":          _redact_arr(s.get("outline")),
                "shorthand_bullet": _redact_arr(s.get("shorthand_bullet")),
                "overview":         _redact_str(s.get("overview")),
                "bullet_gist":      _redact_str(s.get("bullet_gist")),
                "short_summary":    _redact_str(s.get("short_summary")),
            }
        sentences = t.get("sentences")
        if sentences:
            r["sentences"] = [
                {
                    **sen,
                    "text":         _redact_str(sen.get("text")),
                    "raw_text":     _redact_str(sen.get("raw_text")),
                    "speaker_name": _redact_str(sen.get("speaker_name")),
                }
                for sen in sentences
                if sen and not (_REDACT_RE and _REDACT_RE.search(str(sen.get("speaker_name") or "")))
            ]
        return r
    except Exception as err:
        logger.error("[redact] error: %s", err)
        return t


def build_transcripts_query(limit: int, fields: str, skip: int = 0) -> str:
    return (
        f'query {{ transcripts(limit: {limit}, skip: {skip}, fromDate: "{FIREFLIES_FROM_DATE}") '
        f"{{ {fields} }} }}"
    )


_FIREFLIES_MAX_RETRIES = 3


async def _fireflies_post_with_retry(
    client: "httpx.AsyncClient",
    body: dict,
    _retries: int = _FIREFLIES_MAX_RETRIES,
) -> "httpx.Response":
    """POST with retry/backoff on 429 (rate limit) and transient 5xx errors.
    Honors Retry-After when Fireflies sends one; otherwise backs off exponentially."""
    resp = await client.post(
        FIREFLIES_API_URL,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {FIREFLIES_API_KEY}",
        },
        json=body,
    )

    if resp.status_code == 429 or resp.status_code >= 500:
        if _retries <= 0:
            resp.raise_for_status()
            return resp
        retry_after = resp.headers.get("Retry-After")
        wait_s = float(retry_after) if retry_after else 2 ** (_FIREFLIES_MAX_RETRIES - _retries)  # 1s, 2s, 4s
        logger.warning(
            "[fireflies] returned %d — retrying in %.1fs (%d retries left)",
            resp.status_code, wait_s, _retries,
        )
        await asyncio.sleep(wait_s)
        return await _fireflies_post_with_retry(client, body, _retries=_retries - 1)

    resp.raise_for_status()
    return resp


async def fireflies_query(query: str, timeout_ms: int = 15_000, variables: dict | None = None) -> dict:
    if not FIREFLIES_API_KEY:
        raise ValueError("FIREFLIES_API_KEY not configured")

    body: dict = {"query": query}
    logger.debug("[fireflies] query: %s vars=%s", query, variables)
    if variables:
        body["variables"] = variables

    async with httpx.AsyncClient(timeout=timeout_ms / 1000) as client:
        resp = await _fireflies_post_with_retry(client, body)
        data = resp.json()
        if data.get("errors"):
            msgs = ", ".join(e.get("message", "") for e in data["errors"])
            raise ValueError(f"GraphQL error: {msgs}")
        return data.get("data", {})


async def fetch_all_fireflies_transcripts(
    fields: str,
    per_page_timeout_ms: int = 45_000,
) -> list[dict]:
    PAGE_SIZE = 50
    MAX_PAGES = 20
    all_transcripts: list[dict] = []
    skip = 0

    reached_page_cap = True
    for page in range(MAX_PAGES):
        query = build_transcripts_query(PAGE_SIZE, fields, skip)
        logger.info("Fireflies pagination: page %d, skip=%d, limit=%d", page + 1, skip, PAGE_SIZE)
        try:
            data = await fireflies_query(query, per_page_timeout_ms)
            batch = data.get("transcripts") or []
            logger.info("Fireflies pagination: page %d returned %d transcripts", page + 1, len(batch))
            all_transcripts.extend(batch)
            if len(batch) < PAGE_SIZE:
                reached_page_cap = False
                break
            skip += PAGE_SIZE
        except Exception as err:
            reached_page_cap = False
            logger.error(
                "Fireflies pagination: page %d failed (%s), stopping with %d so far",
                page + 1, err, len(all_transcripts),
            )
            break

    if reached_page_cap:
        logger.warning(
            "Fireflies pagination: hit MAX_PAGES=%d cap (%d transcripts fetched) — "
            "there may be more transcripts than this sync retrieved",
            MAX_PAGES, len(all_transcripts),
        )
    logger.info("Fireflies pagination complete: %d total", len(all_transcripts))
    return all_transcripts


async def fetch_transcript_by_id(call_id: str, fields: str, timeout_ms: int = 15_000) -> dict | None:
    """Parameterized single-transcript fetch — call_id is passed as a GraphQL
    variable (never string-interpolated into the query) to avoid injection."""
    query = f"query($id: String!) {{ transcript(id: $id) {{ {fields} }} }}"
    data = await fireflies_query(query, timeout_ms, variables={"id": call_id})
    return data.get("transcript")


_FULL_CALL_FIELDS = """id title date duration organizer_email host_email participants transcript_url audio_url
  user { user_id email name }
  meeting_attendees { email name displayName phoneNumber location }
  summary { keywords action_items outline shorthand_bullet overview bullet_gist short_summary }
  sentences { index text raw_text start_time end_time speaker_id speaker_name
    ai_filters { question sentiment }
  }"""


async def get_full_call_with_transcript(call_id: str) -> dict | None:
    stored = get_meeting_by_id(call_id)
    if stored and not should_analyze_meeting(stored)["allowed"]:
        return None
    if stored and (stored.get("sentences") or []):
        return stored

    try:
        t = await fetch_transcript_by_id(call_id, _FULL_CALL_FIELDS, 15_000)
        if t:
            redacted = redact_transcript(t)
            upsert_meetings(redacted)
            return redacted
    except Exception as err:
        logger.error("[product-requests] Failed to fetch transcript for %s: %s", call_id, err)

    return stored


def build_transcript(call: dict | None) -> str:
    if not call:
        return ""
    sentences = call.get("sentences") or []
    if sentences:
        return "\n".join(
            f"{s.get('speaker_name') or 'Speaker'}: {s.get('text') or ''}"
            for s in sentences
        )
    s = call.get("summary") or {}
    parts = []
    if s.get("overview"):
        parts.append(s["overview"])
    if s.get("short_summary"):
        parts.append(s["short_summary"])
    bg = s.get("bullet_gist")
    if bg:
        parts.append(bg if isinstance(bg, str) else "\n".join(bg))
    return "\n\n".join(parts)
