"""
llm.py — Unified LLM caller (Anthropic first, Groq fallback).
Mirrors callLLM() and extractProductMentions() from apis.mjs.
"""

import asyncio
import json
import re

import httpx

from config.config import ANTHROPIC_API_KEY, GROQ_API_KEY
from config.logging_config import get_logger

logger = get_logger("merlin.llm")
from apis.prompts import (
    PRODUCT_MENTIONS_EXTRACTION_SYSTEM_PROMPT,
    PRODUCT_MENTIONS_EXTRACTION_USER_TEMPLATE,
)

_MAX_RETRIES = 3


async def _post_with_retry(
    client: httpx.AsyncClient,
    url: str,
    *,
    headers: dict,
    json_body: dict,
    provider: str,
    _retries: int = _MAX_RETRIES,
) -> httpx.Response:
    """POST with retry/backoff on 429 (rate limit) and transient 5xx errors.
    Honors Retry-After when the provider sends one; otherwise backs off exponentially."""
    resp = await client.post(url, headers=headers, json=json_body)

    if resp.status_code == 429 or resp.status_code >= 500:
        if _retries <= 0:
            logger.error("[llm] %s failed after retries: %d %s", provider, resp.status_code, resp.text)
            raise RuntimeError(f"{provider} API error {resp.status_code}: {resp.text}")
        retry_after = resp.headers.get("Retry-After")
        if retry_after:
            wait_s = float(retry_after)
        else:
            wait_s = 2 ** (_MAX_RETRIES - _retries)  # 1s, 2s, 4s
        logger.warning(
            "[llm] %s returned %d — retrying in %.1fs (%d retries left)",
            provider, resp.status_code, wait_s, _retries,
        )
        await asyncio.sleep(wait_s)
        return await _post_with_retry(
            client, url, headers=headers, json_body=json_body,
            provider=provider, _retries=_retries - 1,
        )

    if not resp.is_success:
        # resp.raise_for_status()'s str() only carries status+URL — the
        # provider's actual reason (e.g. Anthropic's "`temperature` is
        # deprecated for this model") lives in the body and was getting
        # silently dropped from both the log and the HTTPException detail
        # the frontend renders. Log and surface it explicitly instead.
        logger.error("[llm] %s request failed: %d %s", provider, resp.status_code, resp.text)
        raise RuntimeError(f"{provider} API error {resp.status_code}: {resp.text}")

    return resp


async def call_llm(
    system_prompt: str,
    user_content: str,
    *,
    timeout_ms: int = 15_000,
    max_tokens: int = 800,
    temperature: float = 0.2,
) -> str:
    if not ANTHROPIC_API_KEY and not GROQ_API_KEY:
        raise ValueError("No LLM API key configured (set ANTHROPIC_API_KEY or GROQ_API_KEY)")

    timeout = timeout_ms / 1000

    async with httpx.AsyncClient(timeout=timeout) as client:
        if ANTHROPIC_API_KEY:
            resp = await _post_with_retry(
                client,
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "Content-Type": "application/json",
                },
                json_body={
                    "model": "claude-haiku-4-5-20251001",
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                    "system": system_prompt,
                    "messages": [{"role": "user", "content": user_content}],
                },
                provider="anthropic",
            )
            content = resp.json().get("content") or []
            return (content[0].get("text") or "").strip() if content else ""

        # Groq fallback
        resp = await _post_with_retry(
            client,
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "Content-Type": "application/json",
            },
            json_body={
                "model": "openai/gpt-oss-120b",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user",   "content": user_content},
                ],
                "temperature": temperature,
                "max_tokens":  max_tokens,
                # gpt-oss is a reasoning model — without this, hidden reasoning
                # tokens can consume the whole max_tokens budget and leave
                # `content` empty (finish_reason "length" with nothing to show).
                "reasoning_effort": "low",
            },
            provider="groq",
        )
        choices = resp.json().get("choices") or []
        return (choices[0].get("message", {}).get("content") or "").strip() if choices else ""


async def call_anthropic(
    system_prompt: str,
    user_content: str,
    *,
    model: str = "claude-sonnet-5",
    timeout_ms: int = 30_000,
    max_tokens: int = 800,
    temperature: float | None = 0.2,
) -> str:
    """Call Anthropic directly — no Groq fallback. For features that should
    always use Claude regardless of whether GROQ_API_KEY happens to be set."""
    if not ANTHROPIC_API_KEY:
        raise ValueError("ANTHROPIC_API_KEY not configured")

    timeout = timeout_ms / 1000
    json_body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_content}],
    }
    # claude-sonnet-5 rejects `temperature` outright ("deprecated for this
    # model") — 400s the whole request rather than ignoring it, so it must be
    # omitted entirely rather than passed through as a default.
    if temperature is not None and model != "claude-sonnet-5":
        json_body["temperature"] = temperature

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await _post_with_retry(
            client,
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json_body=json_body,
            provider="anthropic",
        )
        content = resp.json().get("content") or []
        return (content[0].get("text") or "").strip() if content else ""


async def extract_product_mentions(call: dict, transcript_text: str) -> list[str]:
    if not ANTHROPIC_API_KEY and not GROQ_API_KEY:
        return []

    participants = call.get("participants") or []
    client_name = (
        next((p for p in participants if p != call.get("organizer_email")), None)
        or (call.get("title") or "").split(" - ")[0]
        or "Unknown"
    )
    organizer = (
        (call.get("organizer_email") or "").split("@")[0]
        .replace(".", " ").replace("_", " ").replace("-", " ")
        or "Unknown"
    )
    title = call.get("title") or "Untitled"

    user_content = (
        PRODUCT_MENTIONS_EXTRACTION_USER_TEMPLATE
        .replace("{{title}}", title)
        .replace("{{clientName}}", client_name)
        .replace("{{organizer}}", organizer)
        .replace("{{transcript}}", (transcript_text or "")[:6000])
    )

    try:
        raw = await call_llm(
            PRODUCT_MENTIONS_EXTRACTION_SYSTEM_PROMPT,
            user_content,
            timeout_ms=15_000,
            max_tokens=800,
            temperature=0.2,
        )
        if not raw:
            return []
        cleaned = re.sub(r"^```json\s*|\s*```$", "", raw.strip())
        parsed = json.loads(cleaned)
        return [x for x in parsed if isinstance(x, str) and x.strip()] if isinstance(parsed, list) else []
    except Exception as err:
        call_id = call.get("id", "?")
        logger.error("[product-requests] LLM parse/error for call %s: %s", call_id, err)
        return []
