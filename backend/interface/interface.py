"""
interface.py — All child endpoint routers.
Grouped by domain: config, calls, sync, hubspot, product, analytics, query, ingest.
Included into main.py via app.include_router(router).
"""

import asyncio
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Query, Request
from config.logging_config import get_logger

logger = get_logger("merlin.api")

from interface.classes import (
    ApiKeyBody,
    AnalyzeBody,
    HubSpotSearchBody,
    IngestHistoricalBody,
    RewriteQueryBody,
    UpsertUserBody,
    CreateSessionBody,
    UpdateSessionBody,
    GenerateTitleBody,
    AskHubspotRowBody,
)
from interface.handler import (
    analyze_product_requests,
    clear_product_insights,
    clear_product_analysis,
    ask_call,
    ask_hubspot_row,
    delete_calls,
    get_call_by_id,
    get_config_status,
    get_hubspot_companies,
    get_hubspot_contacts,
    get_hubspot_deals,
    get_hubspot_notes,
    get_hubspot_pipelines,
    get_hubspot_company_details,
    get_hubspot_companies_enriched,
    sync_hubspot,
    sync_hubspot_incremental,
    get_analytics,
    get_product_insights_list,
    get_sync_status,
    ingest_historical,
    list_calls,
    list_product_analysis,
    rewrite_query,
    run_process_analytics,
    search_hubspot_emails,
    search_hubspot_notes,
    set_api_key,
    sync_all_calls,
    sync_new_calls,
    chat_upsert_user,
    chat_get_sessions,
    chat_get_session,
    chat_create_session,
    chat_update_session,
    chat_delete_session,
    chat_generate_title,
)

router = APIRouter()


def _hubspot_status(err: Exception) -> int:
    return 400 if "not configured" in str(err) else 502


# ─── Config ───────────────────────────────────────────────────────────────────

@router.get("/config/status", tags=["config"])
def config_status():
    return get_config_status()


@router.post("/config/fireflies-api-key", tags=["config"])
def config_fireflies_key(body: ApiKeyBody):
    if not body.apiKey.strip():
        raise HTTPException(status_code=400, detail="apiKey must be a non-empty string")
    set_api_key("config:fireflies_api_key", body.apiKey)
    logger.info("[config] Fireflies API key updated")
    return {"success": True}


@router.post("/config/groq-api-key", tags=["config"])
def config_groq_key(body: ApiKeyBody):
    if not body.apiKey.strip():
        raise HTTPException(status_code=400, detail="apiKey must be a non-empty string")
    set_api_key("config:groq_api_key", body.apiKey)
    logger.info("[config] Groq API key updated")
    return {"success": True}


@router.post("/config/hubspot-api-key", tags=["config"])
def config_hubspot_key(body: ApiKeyBody):
    if not body.apiKey.strip():
        raise HTTPException(status_code=400, detail="apiKey must be a non-empty string")
    set_api_key("config:hubspot_api_key", body.apiKey)
    logger.info("[config] HubSpot API key updated")
    return {"success": True}


# ─── Calls ────────────────────────────────────────────────────────────────────

@router.get("/calls", tags=["calls"])
def calls_list():
    return list_calls()


@router.get("/calls/{call_id}", tags=["calls"])
async def call_detail(call_id: str):
    return await get_call_by_id(call_id)


@router.post("/calls/{call_id}/ask", tags=["calls"])
async def call_ask(call_id: str, request: Request):
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    question = (body.get("question") or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")
    try:
        return await ask_call(call_id, question)
    except HTTPException:
        raise
    except Exception as err:
        logger.error("[calls/ask] error for call %s: %s", call_id, err)
        raise HTTPException(status_code=500, detail=str(err))


@router.delete("/calls", tags=["calls"])
def calls_delete():
    logger.warning("[calls] Deleting all calls")
    result = delete_calls()
    logger.info("[calls] Deleted %d call(s)", result.get("deleted", 0))
    return {"success": True, **result}


# ─── Sync ─────────────────────────────────────────────────────────────────────

@router.post("/sync", tags=["sync"])
async def sync():
    try:
        return {"success": True, **(await sync_all_calls())}
    except HTTPException:
        raise
    except Exception as err:
        logger.error("Sync error: %s", err)
        raise HTTPException(status_code=500, detail=str(err))


@router.post("/sync-new", tags=["sync"])
async def sync_new():
    try:
        return {"success": True, **(await sync_new_calls())}
    except HTTPException:
        raise
    except Exception as err:
        logger.error("Incremental sync error: %s", err)
        raise HTTPException(status_code=500, detail=str(err))


@router.get("/sync-status", tags=["sync"])
def sync_status():
    return get_sync_status()


# ─── HubSpot ──────────────────────────────────────────────────────────────────

@router.get("/hubspot/deals", tags=["hubspot"])
async def hubspot_deals(
    limit: int = Query(10),
    after: str = Query(""),
    properties: Optional[List[str]] = Query(default=None),
):
    try:
        return await get_hubspot_deals(limit=limit, after=after, properties=properties)
    except Exception as err:
        logger.error("[hubspot/deals] error: %s", err)
        raise HTTPException(status_code=_hubspot_status(err), detail=str(err))


@router.get("/hubspot/companies", tags=["hubspot"])
async def hubspot_companies(
    limit: int = Query(10),
    after: str = Query(""),
    properties: Optional[List[str]] = Query(default=None),
    associations: Optional[List[str]] = Query(default=None),
):
    try:
        return await get_hubspot_companies(limit=limit, after=after, properties=properties, associations=associations)
    except Exception as err:
        logger.error("[hubspot/companies] error: %s", err)
        raise HTTPException(status_code=_hubspot_status(err), detail=str(err))


@router.get("/hubspot/contacts", tags=["hubspot"])
async def hubspot_contacts(
    limit: int = Query(10),
    after: str = Query(""),
    properties: Optional[List[str]] = Query(default=None),
):
    try:
        return await get_hubspot_contacts(limit=limit, after=after, properties=properties)
    except Exception as err:
        logger.error("[hubspot/contacts] error: %s", err)
        raise HTTPException(status_code=_hubspot_status(err), detail=str(err))


@router.get("/hubspot/notes", tags=["hubspot"])
async def hubspot_notes(
    limit: int = Query(10),
    after: str = Query(""),
    properties: Optional[List[str]] = Query(default=None),
    associations: Optional[List[str]] = Query(default=None),
):
    try:
        return await get_hubspot_notes(limit=limit, after=after, properties=properties, associations=associations)
    except Exception as err:
        logger.error("[hubspot/notes] error: %s", err)
        raise HTTPException(status_code=_hubspot_status(err), detail=str(err))


@router.get("/hubspot/companies/enriched", tags=["hubspot"])
async def hubspot_companies_enriched(limit: int = Query(25)):
    try:
        return await get_hubspot_companies_enriched(limit=limit)
    except Exception as err:
        logger.error("[hubspot/companies/enriched] error: %s", err)
        raise HTTPException(status_code=_hubspot_status(err), detail=str(err))


@router.get("/hubspot/pipelines/deals", tags=["hubspot"])
async def hubspot_pipelines_deals():
    try:
        return await get_hubspot_pipelines()
    except Exception as err:
        logger.error("[hubspot/pipelines/deals] error: %s", err)
        raise HTTPException(status_code=_hubspot_status(err), detail=str(err))


@router.post("/hubspot/sync", tags=["hubspot"])
async def hubspot_sync():
    try:
        return {"success": True, **(await sync_hubspot())}
    except HTTPException:
        raise
    except Exception as err:
        logger.error("[hubspot/sync] error: %s", err)
        raise HTTPException(status_code=_hubspot_status(err), detail=str(err))


@router.post("/hubspot/sync-incremental", tags=["hubspot"])
async def hubspot_sync_incremental():
    try:
        return {"success": True, **(await sync_hubspot_incremental())}
    except HTTPException:
        raise
    except Exception as err:
        logger.error("[hubspot/sync-incremental] error: %s", err)
        raise HTTPException(status_code=_hubspot_status(err), detail=str(err))


@router.post("/hubspot/reset", tags=["hubspot"])
async def hubspot_reset():
    from db.hubspot import clear_hubspot_data
    logger.warning("[hubspot/reset] Clearing all HubSpot data")
    try:
        await asyncio.to_thread(clear_hubspot_data)
        return {"success": True}
    except Exception as err:
        logger.error("[hubspot/reset] error: %s", err)
        raise HTTPException(status_code=500, detail=str(err))


@router.get("/hubspot/sync-status", tags=["hubspot"])
def hubspot_sync_status_route():
    from db.hubspot import get_hubspot_sync_status
    return get_hubspot_sync_status()


@router.get("/hubspot/db-data", tags=["hubspot"])
def hubspot_db_data():
    from db.hubspot import get_hubspot_db_entities
    return get_hubspot_db_entities()


@router.get("/hubspot/flat-data", tags=["hubspot"])
def hubspot_flat_data():
    from db.hubspot import get_hubspot_flat_data
    return {"rows": get_hubspot_flat_data()}


@router.get("/hubspot/companies/{company_id}/details", tags=["hubspot"])
async def hubspot_company_details(company_id: str):
    try:
        return await get_hubspot_company_details(company_id)
    except Exception as err:
        logger.error("[hubspot/companies/%s/details] error: %s", company_id, err)
        raise HTTPException(status_code=500, detail=str(err))


@router.get("/hubspot/db-pipeline-labels", tags=["hubspot"])
def hubspot_db_pipeline_labels():
    from db.hubspot import get_pipeline_labels
    return get_pipeline_labels()


@router.post("/hubspot/backfill-labels", tags=["hubspot"])
async def hubspot_backfill_labels():
    """
    Resolve dealstage_label / pipeline_label for all existing deals that still
    have empty labels.  Uses cached pipeline map; fetches fresh from HubSpot API
    if no cached map exists yet.
    """
    from db.hubspot import get_pipeline_labels, set_pipeline_labels, backfill_deal_labels
    try:
        label_map = await asyncio.to_thread(get_pipeline_labels) or {}
        if not label_map:
            pipelines_resp = await get_hubspot_pipelines()
            for pipeline in (pipelines_resp.get("results") or []):
                for stage in (pipeline.get("stages") or []):
                    label_map[stage["id"]] = {
                        "stageLabel":    stage["label"],
                        "pipelineLabel": pipeline["label"],
                    }
            if label_map:
                await asyncio.to_thread(set_pipeline_labels, label_map)
        updated = await asyncio.to_thread(backfill_deal_labels, label_map)
        logger.info("[hubspot/backfill-labels] updated %d deal(s), %d label(s) cached", updated, len(label_map))
        return {"success": True, "updated": updated, "labelCount": len(label_map)}
    except Exception as err:
        logger.error("[hubspot/backfill-labels] error: %s", err)
        raise HTTPException(status_code=500, detail=str(err))


@router.post("/hubspot/ask-row", tags=["hubspot"])
async def hubspot_ask_row(body: AskHubspotRowBody):
    q = body.question.strip()
    if not q:
        raise HTTPException(status_code=400, detail="question is required")
    logger.info("[hubspot/ask-row] question=%r company=%s", q, body.context.get("company_name", "?"))
    try:
        return await ask_hubspot_row(body.context, q)
    except HTTPException:
        raise
    except Exception as err:
        logger.error("[hubspot/ask-row] error: %s", err)
        raise HTTPException(status_code=500, detail=str(err))


@router.post("/hubspot/notes/search", tags=["hubspot"])
async def hubspot_notes_search(body: HubSpotSearchBody):
    try:
        return await search_hubspot_notes(body.model_dump())
    except Exception as err:
        logger.error("[hubspot/notes/search] error: %s", err)
        raise HTTPException(status_code=_hubspot_status(err), detail=str(err))


@router.post("/hubspot/emails/search", tags=["hubspot"])
async def hubspot_emails_search(body: HubSpotSearchBody):
    try:
        return await search_hubspot_emails(body.model_dump())
    except Exception as err:
        logger.error("[hubspot/emails/search] error: %s", err)
        raise HTTPException(status_code=_hubspot_status(err), detail=str(err))


# ─── Product insights ─────────────────────────────────────────────────────────

@router.post("/product-requests/analyze", tags=["product"])
async def product_requests_analyze(body: AnalyzeBody):
    try:
        return await analyze_product_requests(call_ids=body.callIds, force=body.force)
    except HTTPException:
        raise
    except Exception as err:
        logger.error("Product requests analyze error: %s", err)
        raise HTTPException(status_code=500, detail=str(err))


@router.get("/product-insights", tags=["product"])
def product_insights():
    return {"results": get_product_insights_list()}


@router.delete("/product-insights", tags=["product"])
def product_insights_delete():
    logger.warning("[product-insights] Clearing all product insights")
    clear_product_insights()
    return {"success": True}


# ─── Analytics ────────────────────────────────────────────────────────────────

@router.get("/analytics", tags=["analytics"])
def analytics():
    return get_analytics()


@router.post("/analytics/process", tags=["analytics"])
def analytics_process():
    return {"success": True, **run_process_analytics()}


@router.get("/analytics/product-analysis", tags=["analytics"])
def analytics_product_analysis():
    return {"results": list_product_analysis()}


@router.delete("/analytics/product-analysis", tags=["analytics"])
async def analytics_product_analysis_delete(request: Request):
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    ids = body.get("ids") if body else None
    logger.warning("[analytics/product-analysis] Clearing %s", f"{len(ids)} id(s)" if ids else "all rows")
    clear_product_analysis(ids)
    return {"success": True}


# ─── Query rewrite ────────────────────────────────────────────────────────────

@router.post("/rewrite-query", tags=["query"])
async def rewrite_query_endpoint(body: RewriteQueryBody):
    try:
        return await rewrite_query(
            current_query=body.currentQuery,
            previous_response_summary=body.previousResponseSummary,
            previous_queries=body.previousQueries,
            conversation_history=body.conversationHistory,
        )
    except HTTPException:
        raise
    except Exception as err:
        logger.error("Query rewrite error: %s", err)
        raise HTTPException(status_code=500, detail=str(err))


# ─── Historical ingest ────────────────────────────────────────────────────────

@router.post("/ingest-historical", tags=["ingest"])
async def ingest_historical_endpoint(body: IngestHistoricalBody):
    try:
        def _progress(done, total):
            if done % 10 == 0 or done == total:
                logger.info("[ingest-historical] %d/%d", done, total)

        return {"success": True, **(await ingest_historical(body.dir, on_progress=_progress))}
    except HTTPException:
        raise
    except Exception as err:
        logger.error("[ingest-historical] Fatal error: %s", err)
        raise HTTPException(status_code=500, detail=str(err))


# ─── Chat — users ─────────────────────────────────────────────────────────────

@router.post("/chat/user", tags=["chat"])
def chat_user_upsert(body: UpsertUserBody):
    try:
        return chat_upsert_user(email=body.email, name=body.name, display_name=body.display_name)
    except HTTPException:
        raise
    except Exception as err:
        logger.error("[chat/user] error for %s: %s", body.email, err)
        raise HTTPException(status_code=500, detail=str(err))


# ─── Chat — sessions ──────────────────────────────────────────────────────────

@router.get("/chat/sessions", tags=["chat"])
def chat_sessions_list(user_id: str = Query(...)):
    try:
        return {"sessions": chat_get_sessions(user_id)}
    except HTTPException:
        raise
    except Exception as err:
        logger.error("[chat/sessions] list error for user %s: %s", user_id, err)
        raise HTTPException(status_code=500, detail=str(err))


@router.post("/chat/sessions", tags=["chat"])
def chat_sessions_create(body: CreateSessionBody):
    try:
        return chat_create_session(
            user_id=body.user_id,
            session_id=body.session_id,
            messages=body.messages,
        )
    except HTTPException:
        raise
    except Exception as err:
        logger.error("[chat/sessions] create error for user %s: %s", body.user_id, err)
        raise HTTPException(status_code=500, detail=str(err))


@router.get("/chat/sessions/{session_id}", tags=["chat"])
def chat_sessions_get(session_id: str):
    try:
        return chat_get_session(session_id)
    except HTTPException:
        raise
    except Exception as err:
        logger.error("[chat/sessions] get error for %s: %s", session_id, err)
        raise HTTPException(status_code=500, detail=str(err))


@router.put("/chat/sessions/{session_id}", tags=["chat"])
def chat_sessions_update(session_id: str, body: UpdateSessionBody):
    try:
        return chat_update_session(
            session_id=session_id,
            messages=body.messages,
            chat_summary=body.chat_summary,
        )
    except HTTPException:
        raise
    except Exception as err:
        logger.error("[chat/sessions] update error for %s: %s", session_id, err)
        raise HTTPException(status_code=500, detail=str(err))


@router.delete("/chat/sessions/{session_id}", tags=["chat"])
def chat_sessions_delete(session_id: str):
    try:
        return chat_delete_session(session_id)
    except HTTPException:
        raise
    except Exception as err:
        logger.error("[chat/sessions] delete error for %s: %s", session_id, err)
        raise HTTPException(status_code=500, detail=str(err))


@router.post("/chat/sessions/{session_id}/title", tags=["chat"])
async def chat_sessions_title(session_id: str, body: GenerateTitleBody):
    try:
        return await chat_generate_title(session_id, body.first_message)
    except HTTPException:
        raise
    except Exception as err:
        logger.error("[chat/sessions/title] error for %s: %s", session_id, err)
        raise HTTPException(status_code=500, detail=str(err))
