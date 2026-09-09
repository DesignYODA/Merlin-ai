"""
main.py — FastAPI application entry point.

Key endpoints (health, data, SSE streaming) live here.
All child endpoints are in interface/interface.py, included via router.

Start (local):
    uvicorn main:app --host 0.0.0.0 --port 3001 --reload --loop asyncio \
        --reload-exclude "data/*" --reload-exclude "logs/*"

    (data/*.sqlite-wal and -shm files change on essentially every DB read/write,
    so without these excludes --reload restarts the worker in a loop and it
    never stays up long enough to serve a request — see the reload_excludes
    comment below for the equivalent when running via `python main.py`.)

    Or simply: python main.py   (applies the same excludes automatically)

Start (AWS Lambda):
    Deploy with handler lambda_handler.handler (see lambda_handler.py) — it
    wraps this same `app` with Mangum, unchanged.
"""

import asyncio
import json
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from config.config import ANTHROPIC_API_KEY, GROQ_API_KEY, HUBSPOT_API_KEY, FIREFLIES_API_KEY, PORT
from config.logging_config import configure_logging, get_logger

configure_logging()
logger = get_logger("merlin.main")
from db.analytical_db import _get_conn as _init_analytical, close_analytical_db
from db.merlin_db import _get_conn as _init_merlin, close_db
from db.chat_db import _get_conn as _init_chat, close_chat_db
from db.hubspot import _get_conn as _init_hubspot, close_hubspot_db
from interface.classes import FinalResponseBody
from interface.interface import router
from apis.prompts import FINAL_RESPONSE_SYSTEM_PROMPT
from interface.handler import (
    build_result_context, get_combined_data, sync_hubspot_incremental, sync_new_calls,
    auth_verify_token,
)
from apis.hubspot import close_hubspot_client

# ─── HubSpot cron ─────────────────────────────────────────────────────────────
# Runs once immediately on server start, then every 30 minutes: companies →
# resolve notes/emails/contacts (+ deals) for anything new/changed → save to
# hubspot_data.sqlite. Server-owned so it keeps running with no browser tab
# open (the frontend's own 15-min poll in data-context.tsx still works too;
# this just guarantees it also happens without a client connected).
_HUBSPOT_SYNC_INTERVAL_SECONDS = 30 * 60


async def _hubspot_sync_loop() -> None:
    while True:
        if HUBSPOT_API_KEY:
            try:
                logger.info("[hubspot cron] running incremental sync...")
                status = await sync_hubspot_incremental()
                logger.info(
                    "[hubspot cron] done — companies=%s deals=%s notes=%s emails=%s contacts=%s",
                    status.get("companyCount"), status.get("dealCount"),
                    status.get("noteCount"), status.get("emailCount"), status.get("contactCount"),
                )
            except Exception as err:
                logger.error("[hubspot cron] sync failed: %s", err)
        else:
            logger.info("[hubspot cron] skipped — HubSpot API key not configured")
        await asyncio.sleep(_HUBSPOT_SYNC_INTERVAL_SECONDS)


# ─── Fireflies cron ───────────────────────────────────────────────────────────
# Same idea as the HubSpot cron above, mirrored for Fireflies: previously the
# only thing driving Fireflies sync was the frontend's 5-min setInterval in
# data-context.tsx, which stops entirely the moment no browser tab is open.
# Server-owned so new calls keep landing in merlin.sqlite with no client
# connected — the frontend's own poll still runs too, this just guarantees it
# also happens without one.
_FIREFLIES_SYNC_INTERVAL_SECONDS = 5 * 60


async def _fireflies_sync_loop() -> None:
    while True:
        if FIREFLIES_API_KEY:
            try:
                logger.info("[fireflies cron] running incremental sync...")
                status = await sync_new_calls()
                logger.info(
                    "[fireflies cron] done — totalCalls=%s newCalls=%s updatedCalls=%s",
                    status.get("totalCalls"), status.get("newCalls"), status.get("updatedCalls"),
                )
            except Exception as err:
                logger.error("[fireflies cron] sync failed: %s", err)
        else:
            logger.info("[fireflies cron] skipped — Fireflies API key not configured")
        await asyncio.sleep(_FIREFLIES_SYNC_INTERVAL_SECONDS)


# ─── Lifespan ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(_app: FastAPI):
    _init_merlin()
    _init_analytical()
    _init_chat()
    _init_hubspot()
    logger.info(f"[server] listening on http://localhost:{PORT}")
    hubspot_cron_task = asyncio.create_task(_hubspot_sync_loop())
    fireflies_cron_task = asyncio.create_task(_fireflies_sync_loop())
    yield
    hubspot_cron_task.cancel()
    fireflies_cron_task.cancel()
    for task in (hubspot_cron_task, fireflies_cron_task):
        try:
            await task
        except asyncio.CancelledError:
            pass
    close_db()
    close_analytical_db()
    close_chat_db()
    close_hubspot_db()
    await close_hubspot_client()
    logger.info("[server] databases closed")


# ─── Auth gate ────────────────────────────────────────────────────────────────
# A raw ASGI middleware (not @app.middleware("http")/BaseHTTPMiddleware, which wraps
# every request in an extra anyio task group + memory stream even for pass-through
# traffic) — this only inspects scope["headers"]/scope["path"] and either forwards
# untouched or short-circuits with its own 401, never interfering with responses
# (including /final-response's SSE stream) on the accept path. Default-deny: every
# path requires a valid session unless explicitly allowlisted here.

_PUBLIC_EXACT_PATHS = {
    "/health",
    "/auth/signup", "/auth/login", "/auth/security-question",
    "/auth/reset-password", "/auth/logout",
}
_PUBLIC_PATH_PREFIXES = ("/docs", "/redoc", "/openapi.json")


class AuthGateMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":  # lifespan, websocket, etc.
            await self.app(scope, receive, send)
            return

        method = scope["method"]
        path = scope["path"]

        if (
            method == "OPTIONS"
            or path in _PUBLIC_EXACT_PATHS
            or path.startswith(_PUBLIC_PATH_PREFIXES)
        ):
            await self.app(scope, receive, send)
            return

        raw_auth = None
        for name, value in scope["headers"]:
            if name == b"authorization":
                raw_auth = value.decode("latin-1")
                break

        try:
            auth_verify_token(raw_auth)
        except HTTPException as exc:
            # ExceptionMiddleware (which normally turns a raised HTTPException into
            # clean JSON) wraps only the router, not middleware added via
            # add_middleware — an uncaught HTTPException here would produce a
            # generic 500 instead of a 401, so it must be caught locally.
            body = json.dumps({"detail": exc.detail}).encode("utf-8")
            await send({
                "type": "http.response.start",
                "status": exc.status_code,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            })
            await send({"type": "http.response.body", "body": body})
            return

        await self.app(scope, receive, send)


app = FastAPI(title="Merlin AI", lifespan=lifespan)

# Registration order matters: Starlette makes the *last*-added middleware outermost.
# AuthGateMiddleware must be added before CORSMiddleware so CORS ends up wrapping it —
# otherwise the auth gate's own 401 responses never pass through CORS's response-header
# injection, and the browser sees a CORS failure instead of a readable 401.
app.add_middleware(AuthGateMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_headers=["Content-Type", "Authorization"],
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    max_age=600,
)

app.include_router(router)


# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/health", tags=["core"])
def health():
    return {"status": "ok"}


# ─── Data (combined dashboard payload) ───────────────────────────────────────

@app.get("/data", tags=["core"])
async def data():
    return await get_combined_data()


# ─── Final response (SSE streaming) ──────────────────────────────────────────

@app.post("/final-response", tags=["core"])
async def final_response(body: FinalResponseBody):
    if body.resultData is None:
        raise HTTPException(status_code=400, detail="resultData is required")

    fallback     = body.formattedIntro or "Here are the results:"
    context      = build_result_context(body.resultData if isinstance(body.resultData, dict) else {})
    parsed_q     = body.parsedQuery if isinstance(body.parsedQuery, dict) else {}
    raw_query    = parsed_q.get("rawQuery") or "sales call analysis"
    user_content = (
        f"User asked: \"{raw_query}\"\n\n"
        f"Search results:\n{context}\n\n"
        "Write a natural 2-4 sentence conversational response presenting these findings."
    )

    async def _stream_anthropic():
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream(
                "POST",
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "claude-haiku-4-5-20251001",
                    "max_tokens": 300,
                    "temperature": 0.3,
                    "stream": True,
                    "system": FINAL_RESPONSE_SYSTEM_PROMPT,
                    "messages": [{"role": "user", "content": user_content}],
                },
            ) as resp:
                if not resp.is_success:
                    body_bytes = await resp.aread()
                    raise RuntimeError(f"Anthropic API error: {resp.status_code} {body_bytes.decode()}")
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    payload = line[6:].strip()
                    if payload == "[DONE]":
                        return
                    try:
                        evt = json.loads(payload)
                        if evt.get("type") == "content_block_delta":
                            token = (evt.get("delta") or {}).get("text") or ""
                            if token:
                                yield f"data: {json.dumps({'token': token})}\n\n"
                    except json.JSONDecodeError:
                        pass

    async def _stream_groq():
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream(
                "POST",
                "https://api.groq.com/openai/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {GROQ_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "openai/gpt-oss-120b",
                    "messages": [
                        {"role": "system", "content": FINAL_RESPONSE_SYSTEM_PROMPT},
                        {"role": "user",   "content": user_content},
                    ],
                    "temperature": 0.2,
                    "max_tokens":  500,
                    "stream": True,
                    # gpt-oss is a reasoning model — without this, hidden reasoning
                    # tokens can eat the whole max_tokens budget before any visible
                    # `content` delta is ever emitted.
                    "reasoning_effort": "low",
                },
            ) as resp:
                if not resp.is_success:
                    body_bytes = await resp.aread()
                    raise RuntimeError(f"Groq API error: {resp.status_code} {body_bytes.decode()}")
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    payload = line[6:].strip()
                    if payload == "[DONE]":
                        return
                    try:
                        token = (
                            (json.loads(payload).get("choices") or [{}])[0]
                            .get("delta", {}).get("content") or ""
                        )
                        if token:
                            yield f"data: {json.dumps({'token': token})}\n\n"
                    except json.JSONDecodeError:
                        pass

    async def generate():
        if not ANTHROPIC_API_KEY and not GROQ_API_KEY:
            yield f"data: {json.dumps({'token': fallback})}\n\n"
            yield "data: [DONE]\n\n"
            return

        try:
            stream = _stream_anthropic() if ANTHROPIC_API_KEY else _stream_groq()
            async for chunk in stream:
                yield chunk
        except Exception as err:
            logger.error("[final-response] Streaming error: %s", err)
            yield f"data: {json.dumps({'token': fallback})}\n\n"

        yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app", host="0.0.0.0", port=PORT, reload=False, loop="asyncio",
        reload_excludes=["data/*", "logs/*"],
    )
