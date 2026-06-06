import express from "express";
import cors from "cors";
import { fireflies_historical } from "./ingest-historical.mjs";
import {
  processAnalytics, getAnalytics,
  upsertProductAnalysis, getProductAnalysis, deleteProductAnalysis,
  closeAnalyticalDb,
} from "./analytical-store.mjs";
import {
  kvGet,
  kvSet,
  kvDel,
  closeDb,
  // getStoredApiKey,
  shouldAnalyzeMeeting,
  classifyMeetingType,
  buildMeetingMetadata,
  redactTranscript,
  firefliesQuery,
  buildTranscriptsQuery,
  fetchAllFirefliesTranscripts,
  getFullCallWithTranscript,
  buildTranscript,
  extractProductMentions,
  callLLM,
  // getHubspotApiKey,
  hubspotRequest,
  // getGroqApiKey,
  findHubSpotDealsForEmails,
  getExternalEmails,
  getAllMeetings,
  getMeetingById,
  upsertMeetings,
  deleteMeetings,
  upsertProductInsights,
  getAllProductInsights,
  deleteProductInsights,
} from "./apis.mjs";
import {
  QUERY_REWRITE_REFERENCE_RESOLUTION_SYSTEM_PROMPT,
  QUERY_REWRITE_REFERENCE_RESOLUTION_USER_TEMPLATE,
  FINAL_RESPONSE_SYSTEM_PROMPT,
} from "./prompts.mjs";
import {
  FIREFLIES_API_KEY,
  GROQ_API_KEY,
  ANTHROPIC_API_KEY,
  HUBSPOT_API_KEY,
  PORT
} from "./config.mjs";

const app = express();
app.use(
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    maxAge: 600,
  }),
);
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/config/status", (_req, res) => {
  try {
    res.json({
      firefliesApiKeySet: !!FIREFLIES_API_KEY,
      anthropicApiKeySet: !!ANTHROPIC_API_KEY,
      groqApiKeySet: !!GROQ_API_KEY,
      hubspotApiKeySet: !!HUBSPOT_API_KEY,
      activeLlm: ANTHROPIC_API_KEY ? "anthropic" : GROQ_API_KEY ? "groq" : "none",
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/config/fireflies-api-key", (req, res) => {
  try {
    const { apiKey } = req.body || {};
    if (!apiKey || typeof apiKey !== "string") return res.status(400).json({ error: "apiKey must be a string" });
    kvSet("config:fireflies_api_key", { apiKey });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/config/groq-api-key", (req, res) => {
  try {
    const { apiKey } = req.body || {};
    if (!apiKey || typeof apiKey !== "string") return res.status(400).json({ error: "apiKey must be a string" });
    kvSet("config:groq_api_key", { apiKey });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/config/hubspot-api-key", (req, res) => {
  try {
    const { apiKey } = req.body || {};
    if (!apiKey || typeof apiKey !== "string") return res.status(400).json({ error: "apiKey must be a string" });
    kvSet("config:hubspot_api_key", { apiKey });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get("/data", async (_req, res) => {
  try {
    const [callsResult, hubspotResult] = await Promise.allSettled([
      (async () => {
        const allCalls = getAllMeetings();
        const calls = allCalls.filter((call) => {
          const { allowed } = shouldAnalyzeMeeting(call);
          return allowed;
        });
        calls.sort((a, b) => (b.date || 0) - (a.date || 0));
        const lightCalls = calls.map((call) => {
          const { sentences, ...rest } = call;
          return rest;
        });
        const syncStatus = kvGet("sync:status");
        return {
          calls: lightCalls,
          syncStatus: syncStatus || null,
          excludedCount: allCalls.length - calls.length,
        };
      })(),
      (async () => {
        if (!HUBSPOT_API_KEY) return { deals: [], companies: [], contacts: [] };
        const [dealsRes, companiesRes, contactsRes] = await Promise.all([
          hubspotRequest("/crm/v3/objects/deals?limit=100&properties=dealname,amount,dealstage,closedate,pipeline"),
          hubspotRequest("/crm/v3/objects/companies?limit=100&properties=name,domain"),
          hubspotRequest("/crm/v3/objects/contacts?limit=100&properties=firstname,lastname,email"),
        ]);
        return {
          deals: dealsRes.results || [],
          companies: companiesRes.results || [],
          contacts: contactsRes.results || [],
        };
      })(),
    ]);

    const callsData = callsResult.status === "fulfilled" ? callsResult.value : { calls: [], syncStatus: null };
    const hubspotData =
      hubspotResult.status === "fulfilled"
        ? hubspotResult.value
        : { deals: [], companies: [], contacts: [] };

    if (callsResult.status === "rejected") {
      console.log("[/data] Fireflies/calls error:", callsResult.reason?.message);
    }
    if (hubspotResult.status === "rejected") {
      console.log("[/data] HubSpot error:", hubspotResult.reason?.message);
    }

    res.json({
      calls: callsData.calls || [],
      syncStatus: callsData.syncStatus || null,
      totalCount: (callsData.calls || []).length,
      excludedCount: callsData.excludedCount ?? 0,
      deals: hubspotData.deals || [],
      companies: hubspotData.companies || [],
      contacts: hubspotData.contacts || [],
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch data: ${err?.message || err}` });
  }
});

app.get("/hubspot/deals", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 100);
    const after = req.query.after || "";
    const properties = req.query.properties || "dealname,amount,dealstage,closedate,pipeline";
    let path = `/crm/v3/objects/deals?limit=${limit}&properties=${properties}`;
    if (after) path += `&after=${after}`;
    const data = await hubspotRequest(path);
    res.json(data);
  } catch (err) {
    res.status(err?.message?.includes("not configured") ? 400 : 502).json({
      error: err?.message || "HubSpot API error",
    });
  }
});

app.get("/hubspot/companies", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 100);
    const after = req.query.after || "";
    const properties = req.query.properties || "name,domain";
    let path = `/crm/v3/objects/companies?limit=${limit}&properties=${properties}`;
    if (after) path += `&after=${after}`;
    const data = await hubspotRequest(path);
    res.json(data);
  } catch (err) {
    res.status(err?.message?.includes("not configured") ? 400 : 502).json({
      error: err?.message || "HubSpot API error",
    });
  }
});

app.get("/hubspot/contacts", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 100);
    const after = req.query.after || "";
    const properties = req.query.properties || "firstname,lastname,email";
    let path = `/crm/v3/objects/contacts?limit=${limit}&properties=${properties}`;
    if (after) path += `&after=${after}`;
    const data = await hubspotRequest(path);
    res.json(data);
  } catch (err) {
    res.status(err?.message?.includes("not configured") ? 400 : 502).json({
      error: err?.message || "HubSpot API error",
    });
  }
});

app.post("/hubspot/notes/search", async (req, res) => {
  try {
    const body = req.body || {};
    const data = await hubspotRequest("/crm/v3/objects/notes/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
    res.json(data);
  } catch (err) {
    res.status(err?.message?.includes("not configured") ? 400 : 502).json({
      error: err?.message || "HubSpot API error",
    });
  }
});

app.post("/hubspot/emails/search", async (req, res) => {
  try {
    const body = req.body || {};
    const data = await hubspotRequest("/crm/v3/objects/emails/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
    res.json(data);
  } catch (err) {
    res.status(err?.message?.includes("not configured") ? 400 : 502).json({
      error: err?.message || "HubSpot API error",
    });
  }
});

app.get("/calls", (_req, res) => {
  try {
    const allCalls = getAllMeetings();
    const calls = allCalls.filter((call) => {
      const { allowed, reason } = shouldAnalyzeMeeting(call);
      if (!allowed) console.log(`Query guard excluded call ${call.id} (${call.title}): ${reason}`);
      return allowed;
    });

    calls.sort((a, b) => (b.date || 0) - (a.date || 0));
    const lightCalls = calls.map((call) => {
      const { sentences, ...rest } = call;
      return rest;
    });

    const syncStatus = kvGet("sync:status");
    res.json({
      calls: lightCalls,
      totalCount: lightCalls.length,
      excludedCount: allCalls.length - calls.length,
      syncStatus: syncStatus || null,
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch calls from DB: ${err?.message || err}` });
  }
});

app.get("/calls/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const stored = getMeetingById(id);

    if (stored && !shouldAnalyzeMeeting(stored).allowed) {
      return res.status(403).json({ error: "This meeting is excluded from analysis" });
    }

    if (stored && stored.sentences && stored.sentences.length > 0) {
      return res.json({ call: stored, source: "database" });
    }

    const query = `query { transcript(id: "${id}") {
      id title date duration organizer_email participants transcript_url audio_url
      summary { keywords action_items outline shorthand_bullet overview bullet_gist short_summary }
      sentences { index text raw_text start_time end_time speaker_id speaker_name }
    }}`;

    const data = await firefliesQuery(query);
    if (data?.transcript) {
      const redacted = redactTranscript(data.transcript);
      upsertMeetings(redacted);
      return res.json({ call: redacted, source: "fireflies" });
    }

    if (stored) return res.json({ call: stored, source: "database" });
    return res.status(404).json({ error: "Call not found" });
  } catch (err) {
    console.log(`Error fetching call ${id}:`, err?.message || err);
    const stored = getMeetingById(id);
    if (stored) return res.json({ call: stored, source: "database" });
    return res.status(500).json({ error: `Failed to fetch call: ${err?.message || err}` });
  }
});

app.post("/sync", async (_req, res) => {
  try {
    const fields = `id title date duration organizer_email host_email participants transcript_url audio_url video_url
      user { user_id email name }
      meeting_attendees { email name displayName phoneNumber location }
      summary { keywords action_items outline shorthand_bullet overview bullet_gist short_summary }`;

    let best = [];
    try {
      best = await fetchAllFirefliesTranscripts(fields, 45000);
    } catch (err) {
      console.log("Paginated fetch failed, falling back to single large request:", err?.message || err);
      try {
        const query = buildTranscriptsQuery(500, fields);
        const data = await firefliesQuery(query, 30000);
        best = data.transcripts || [];
      } catch (err2) {
        console.log("Fallback single-request also failed:", err2?.message || err2);
        return res.status(502).json({ error: `Fireflies API unreachable: ${err2?.message || err2}` });
      }
    }

    console.log(`Fetched ${best.length} total transcripts from Fireflies (paginated)`);

    let excludedCount = 0;
    const analyzable = best.filter((t) => {
      const { allowed, reason } = shouldAnalyzeMeeting(t);
      if (!allowed) {
        excludedCount++;
        console.log(`Ingestion filter excluded: ${t.title} (${t.id}) — ${reason}`);
        return false;
      }
      return true;
    });
    console.log(`${analyzable.length} meetings pass filter, ${excludedCount} excluded`);

    const existingCalls = getAllMeetings();
    const existingIds = new Set(existingCalls.map((c) => c.id));

    const callsToDelete = existingCalls.filter((c) => !shouldAnalyzeMeeting(c).allowed);
    if (callsToDelete.length > 0) {
      deleteMeetings(callsToDelete.map((c) => c.id));
      console.log(`Purged ${callsToDelete.length} previously stored excluded calls`);
    }

    let newCount = 0;
    let updatedCount = 0;
    const newCallIds = [];

    const BATCH = 10;
    for (let i = 0; i < analyzable.length; i += BATCH) {
      const batch = analyzable.slice(i, i + BATCH);
      const meetingsToUpsert = [];

      for (const t of batch) {
        const redacted = redactTranscript(t);
        redacted.meeting_type = classifyMeetingType(t);
        redacted.metadata = buildMeetingMetadata(t);

        const externalEmails = getExternalEmails(t);
        redacted.hubspot_deals = await findHubSpotDealsForEmails(externalEmails);

        if (existingIds.has(redacted.id)) {
          const existing = existingCalls.find((c) => c.id === redacted.id);
          if (existing?.sentences && !redacted.sentences) {
            redacted.sentences = existing.sentences;
          }
          updatedCount++;
        } else {
          newCount++;
          newCallIds.push(redacted.id);
        }

        meetingsToUpsert.push(redacted);
      }

      upsertMeetings(meetingsToUpsert);
    }

    const syncStatus = {
      lastSyncAt: new Date().toISOString(),
      totalCalls: existingCalls.length - callsToDelete.length + newCount, // actual post-sync DB count
      newCalls: newCount,
      updatedCalls: updatedCount,
    };
    kvSet("sync:status", syncStatus);

    // Rebuild analytical store in the background — don't block the response
    try { processAnalytics(getAllMeetings()); } catch (e) { console.warn("[analytics] process error:", e.message); }

    return res.json({ success: true, ...syncStatus, newCallIds });
  } catch (err) {
    console.log("Sync error:", err?.message || err);
    return res.status(500).json({ error: `Sync failed: ${err?.message || err}` });
  }
});

app.post("/sync-new", async (_req, res) => {
  try {
    const fields = `id title date duration organizer_email host_email participants transcript_url audio_url video_url
      user { user_id email name }
      meeting_attendees { email name displayName phoneNumber location }
      summary { keywords action_items outline shorthand_bullet overview bullet_gist short_summary }`;

    let latest = [];
    try {
      const query = buildTranscriptsQuery(50, fields, 0);
      console.log("Incremental sync: fetching latest 50 transcripts");
      const data = await firefliesQuery(query, 25000);
      latest = data.transcripts || [];
    } catch (fetchErr) {
      console.log("Incremental sync: fetch failed:", fetchErr?.message || fetchErr);
      return res.status(502).json({
        error: `Fireflies API unreachable during incremental sync: ${fetchErr?.message || fetchErr}`,
      });
    }

    console.log(`Incremental sync: fetched ${latest.length} transcripts from Fireflies`);

    const existingCalls = getAllMeetings();
    const existingIds = new Set(existingCalls.map((c) => c.id));

    const newCalls = latest.filter((t) => !existingIds.has(t.id));
    if (newCalls.length === 0) {
      const syncStatus = {
        lastSyncAt: new Date().toISOString(),
        totalCalls: existingCalls.length,
        newCalls: 0,
        updatedCalls: 0,
      };
      kvSet("sync:status", syncStatus);
      return res.json({ success: true, ...syncStatus });
    }

    const analyzableNew = newCalls.filter((t) => {
      const { allowed, reason } = shouldAnalyzeMeeting(t);
      if (!allowed) {
        console.log(`Incremental ingestion filter excluded: ${t.title} (${t.id}) — ${reason}`);
        return false;
      }
      return true;
    });

    if (analyzableNew.length === 0) {
      const syncStatus = {
        lastSyncAt: new Date().toISOString(),
        totalCalls: existingCalls.length,
        newCalls: 0,
        updatedCalls: 0,
      };
      kvSet("sync:status", syncStatus);
      return res.json({
        success: true,
        ...syncStatus,
        note: `${newCalls.length} new call(s) excluded by filter`,
      });
    }

    const BATCH = 5;
    for (let i = 0; i < analyzableNew.length; i += BATCH) {
      const batch = analyzableNew.slice(i, i + BATCH);
      const meetingsToUpsert = [];
      for (const t of batch) {
        const redacted = redactTranscript(t);
        redacted.meeting_type = classifyMeetingType(t);
        redacted.metadata = buildMeetingMetadata(t);
        
        const externalEmails = getExternalEmails(t);
        redacted.hubspot_deals = await findHubSpotDealsForEmails(externalEmails);
        
        meetingsToUpsert.push(redacted);
      }
      upsertMeetings(meetingsToUpsert);
    }

    const syncStatus = {
      lastSyncAt: new Date().toISOString(),
      totalCalls: existingCalls.length + analyzableNew.length,
      newCalls: analyzableNew.length,
      updatedCalls: 0,
    };
    kvSet("sync:status", syncStatus);

    try { processAnalytics(getAllMeetings()); } catch (e) { console.warn("[analytics] process error:", e.message); }

    return res.json({ success: true, ...syncStatus, newCallIds: analyzableNew.map((t) => t.id) });
  } catch (err) {
    console.log("Incremental sync error:", err?.message || err);
    return res.status(500).json({ error: `Incremental sync failed: ${err?.message || err}` });
  }
});

app.get("/sync-status", (_req, res) => {
  try {
    const status = kvGet("sync:status");
    return res.json(status || { lastSyncAt: null, totalCalls: 0, newCalls: 0, updatedCalls: 0 });
  } catch (err) {
    return res.status(500).json({ error: err?.message || err });
  }
});

app.post("/product-requests/analyze", async (req, res) => {
  try {
    const { callIds, force = false } = req.body || {};
    if (!ANTHROPIC_API_KEY && !GROQ_API_KEY) {
      return res.status(400).json({ error: "No LLM API key configured. Add ANTHROPIC_API_KEY (recommended) or GROQ_API_KEY to .env." });
    }

    const allCalls = getAllMeetings();
    const allowedCalls = allCalls.filter((c) => shouldAnalyzeMeeting(c).allowed);

    const candidates =
      Array.isArray(callIds) && callIds.length > 0
        ? callIds.filter((id) => allowedCalls.some((c) => c.id === id))
        : allowedCalls.map((c) => c.id);

    // Skip calls that already have cached insights unless force=true
    const analyzedIds = force
      ? new Set()
      : new Set(getAllProductInsights().map((r) => r.call_id));

    const idsToProcess = candidates.filter((id) => !analyzedIds.has(id));
    const skippedCount = candidates.length - idsToProcess.length;

    if (idsToProcess.length === 0) {
      console.log(`[analyze] All ${skippedCount} candidate(s) already analyzed — skipping`);
      return res.json({ results: [], skipped: skippedCount, newCount: 0 });
    }

    console.log(`[analyze] Processing ${idsToProcess.length} call(s), skipping ${skippedCount} already analyzed`);

    const results = [];

    for (const id of idsToProcess) {
      const fullCall = await getFullCallWithTranscript(id);
      if (!fullCall) continue;

      const transcriptText = buildTranscript(fullCall);
      if (!transcriptText.trim()) {
        results.push({
          callId: fullCall.id,
          callTitle: fullCall.title || "Untitled",
          aeName: (fullCall.organizer_email || "").split("@")[0]?.replace(/[._-]/g, " ") || "",
          clientName: (fullCall.participants || []).find((p) => p !== fullCall.organizer_email) || fullCall.title?.split(" - ")[0] || "Unknown",
          date: fullCall.date ? (typeof fullCall.date === "number" ? new Date(fullCall.date).toLocaleDateString() : String(fullCall.date)) : "",
          transcriptUrl: fullCall.transcript_url || "#",
          items: [],
        });
        continue;
      }

      const items = await extractProductMentions(fullCall, transcriptText);
      const result = {
        callId: fullCall.id,
        callTitle: fullCall.title || "Untitled",
        aeName: (fullCall.organizer_email || "").split("@")[0]?.replace(/[._-]/g, " ") || "",
        clientName: (fullCall.participants || []).find((p) => p !== fullCall.organizer_email) || fullCall.title?.split(" - ")[0] || "Unknown",
        date: fullCall.date ? (typeof fullCall.date === "number" ? new Date(fullCall.date).toLocaleDateString() : String(fullCall.date)) : "",
        transcriptUrl: fullCall.transcript_url || "#",
        items: items,
      };
      results.push(result);

      await new Promise((r) => setTimeout(r, 200));
    }

    // Persist to both SQLite stores
    if (results.length > 0) {
      const rows = results.map((r) => ({
        call_id:        r.callId,
        call_title:     r.callTitle,
        ae_name:        r.aeName,
        client_name:    r.clientName,
        date:           r.date,
        transcript_url: r.transcriptUrl,
        items:          r.items,
      }));
      upsertProductInsights(rows);
      try { upsertProductAnalysis(rows); } catch (e) { console.warn("[analytics] product_analysis upsert error:", e.message); }
    }

    res.json({ results, skipped: skippedCount, newCount: results.length });
  } catch (err) {
    console.log("Product requests analyze error:", err?.message || err);
    res.status(500).json({ error: `Analysis failed: ${err?.message || err}` });
  }
});

app.get("/product-insights", (_req, res) => {
  try {
    const rows = getAllProductInsights();
    const results = rows.map((r) => ({
      callId: r.call_id,
      callTitle: r.call_title,
      aeName: r.ae_name,
      clientName: r.client_name,
      date: r.date,
      transcriptUrl: r.transcript_url,
      items: r.items,
      analyzedAt: r.analyzed_at,
    }));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.delete("/product-insights", (_req, res) => {
  try {
    deleteProductInsights();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.delete("/calls", (_req, res) => {
  try {
    const existingCalls = getAllMeetings();
    if (existingCalls.length > 0) {
      deleteMeetings(existingCalls.map((c) => c.id));
    }
    kvDel("sync:status");
    return res.json({ success: true, deleted: existingCalls.length });
  } catch (err) {
    return res.status(500).json({ error: `Failed to clear calls: ${err?.message || err}` });
  }
});

app.post("/rewrite-query", async (req, res) => {
  try {
    // todo: add config 
    const { currentQuery, previousResponseSummary, previousQueries, conversationHistory } = req.body || {};

    if (!currentQuery || typeof currentQuery !== "string") {
      return res.status(400).json({ error: "currentQuery is required" });
    }

    const injectionPatterns = [
      /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
      /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|UNION)\s+(ALL\s+)?/i,
      /system\s*[:=]\s*/i,
      /\[system\]/i,
      /override\s+(system|instructions?|guardrails?)/i,
      /bypass\s+(system|safety|filters?)/i,
    ];

    if (injectionPatterns.some((p) => p.test(currentQuery))) {
      console.log(`[QueryRewrite] Blocked suspicious query: "${currentQuery.slice(0, 80)}"`);
      return res.json({ rewrittenQuery: currentQuery, wasRewritten: false, reason: "Query blocked by guardrails" });
    }

    if (!ANTHROPIC_API_KEY && !GROQ_API_KEY) {
      console.log("No LLM API key configured, returning original query");
      return res.json({ rewrittenQuery: currentQuery, wasRewritten: false, reason: "No LLM API key configured" });
    }

    let conversationContext = "";
    if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      conversationContext = "CONVERSATION HISTORY (oldest → newest):\n";
      conversationHistory.forEach((turn, i) => {
        conversationContext += `Turn ${i + 1}:\n`;
        conversationContext += `  User: "${turn.query}"\n`;
        if (turn.responseSummary) conversationContext += `  Assistant: ${turn.responseSummary}\n`;
      });
    } else if (Array.isArray(previousQueries) && previousQueries.length > 0) {
      conversationContext = "Previous user queries (most recent first):\n";
      conversationContext += previousQueries.map((q, i) => `${i + 1}. "${q}"`).join("\n");
      if (previousResponseSummary) {
        conversationContext += `\n\nSummary of the most recent assistant response:\n${previousResponseSummary}`;
      }
    }

    const userPrompt = QUERY_REWRITE_REFERENCE_RESOLUTION_USER_TEMPLATE.replace(
      "{{conversationContext}}",
      conversationContext
    ).replace("{{currentQuery}}", currentQuery);

    try {
      const rewritten = await callLLM(
        QUERY_REWRITE_REFERENCE_RESOLUTION_SYSTEM_PROMPT,
        userPrompt,
        { timeoutMs: 12000, maxTokens: 400, temperature: 0.2 },
      );

      if (!rewritten) {
        return res.json({ rewrittenQuery: currentQuery, wasRewritten: false, reason: "Empty LLM response" });
      }

      const cleaned = rewritten.replace(/^["']|["']$/g, "").trim();
      const wasRewritten = cleaned.toLowerCase() !== currentQuery.toLowerCase().trim();

      console.log(`[QueryRewrite] "${currentQuery}" → "${cleaned}" (changed: ${wasRewritten})`);
      return res.json({ rewrittenQuery: cleaned, wasRewritten });
    } catch (fetchErr) {
      if (fetchErr?.name === "AbortError" || fetchErr?.message?.includes("timeout")) {
        return res.json({ rewrittenQuery: currentQuery, wasRewritten: false, reason: "LLM timeout" });
      }
      return res.json({
        rewrittenQuery: currentQuery,
        wasRewritten: false,
        reason: `LLM error: ${fetchErr?.message || fetchErr}`,
      });
    }
  } catch (err) {
    console.log("Query rewrite error:", err?.message || err);
    return res.status(500).json({ error: `Query rewrite failed: ${err?.message || err}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /final-response
// Streams an LLM-generated conversational narrative for a search result set.
// Uses SSE (text/event-stream): each chunk is  data: {"token":"..."}\n\n
// Terminates with  data: [DONE]\n\n
// Falls back to formattedIntro as a single token when no LLM key is configured.
// ─────────────────────────────────────────────────────────────────────────────

function buildResultContext(resultData) {
  const r = resultData;
  const parts = [];

  if (r.queryEntity) parts.push(`Topic: "${r.queryEntity}"`);
  if (r.searchedCallCount) parts.push(`Calls analyzed: ${r.searchedCallCount}`);
  if (r.timeFilter) parts.push(`Time range: ${r.timeFilter}`);

  if (r.noResults) return [...parts, "Result: No matches found"].join("\n");

  if (r.totalMentions !== undefined) parts.push(`Total mentions: ${r.totalMentions}`);
  if (r.totalMeetings !== undefined) parts.push(`Matching meetings: ${r.totalMeetings}`);

  if (r.topTopics?.length) {
    const top = r.topTopics.slice(0, 5)
      .map(t => `"${t.topic}" (${t.count} mentions / ${t.callCount} calls, trend: ${t.trend})`)
      .join("; ");
    parts.push(`Top topics: ${top}`);
  }

  if (r.mentions?.length) {
    r.mentions.slice(0, 3).forEach(m => {
      parts.push(`- "${m.callTitle}" (${m.date}, ${m.mentionCount} hits)`);
      const snip = m.snippets?.[0]?.text?.slice(0, 150);
      if (snip) parts.push(`  Quote: "${snip}"`);
    });
  }

  if (r.participantRankings?.length) {
    const aes = r.participantRankings.filter(p => p.isAE);
    const ext = r.participantRankings.filter(p => !p.isAE);
    parts.push(`Participants: ${aes.length} AEs, ${ext.length} external`);
    if (aes[0]) parts.push(`Most active AE: ${aes[0].name} (${aes[0].callCount} calls)`);
  }

  if (r.actionItems?.length) {
    parts.push(`Action items found: ${r.actionItems.length}`);
    const sample = r.actionItems[0]?.item?.slice(0, 100);
    if (sample) parts.push(`Sample: "${sample}"`);
  }

  if (r.sentiment) {
    const s = r.sentiment;
    const total = (s.positive + s.neutral + s.negative) || 1;
    const posPct = Math.round(s.positive / total * 100);
    parts.push(`Sentiment: ${s.positive} positive (${posPct}%), ${s.neutral} neutral, ${s.negative} negative`);
  }

  if (r.durationList?.length) {
    const first = r.durationList[0];
    const last = r.durationList[r.durationList.length - 1];
    parts.push(`Longest: "${first.title}" at ${first.duration}`);
    parts.push(`Shortest: "${last.title}" at ${last.duration}`);
  }

  if (r.competitorMentions?.length) {
    const comps = r.competitorMentions.slice(0, 5)
      .map(c => `${c.competitor} (${c.callCount} calls)`).join(", ");
    parts.push(`Competitors mentioned: ${comps}`);
  }

  if (r.overviewStats) {
    const s = r.overviewStats;
    parts.push(`Overview: ${s.totalCalls} total calls, ${s.totalDuration} total, avg ${s.avgDuration}, ${s.uniqueParticipants} participants`);
    if (s.topTopics?.length) parts.push(`Top topics: ${s.topTopics.slice(0, 5).join(", ")}`);
  }

  return parts.join("\n");
}

app.post("/final-response", async (req, res) => {
  const { resultData, parsedQuery, formattedIntro } = req.body || {};

  if (!resultData) return res.status(400).json({ error: "resultData is required" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const fallback = formattedIntro || "Here are the results:";

  if (!ANTHROPIC_API_KEY && !GROQ_API_KEY) {
    res.write(`data: ${JSON.stringify({ token: fallback })}\n\n`);
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  const context = buildResultContext(resultData);
  const userContent = `User asked: "${parsedQuery?.rawQuery || "sales call analysis"}"\n\nSearch results:\n${context}\n\nWrite a natural 2-4 sentence conversational response presenting these findings.`;

  try {
    if (ANTHROPIC_API_KEY) {
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 300,
          temperature: 0.3,
          stream: true,
          system: FINAL_RESPONSE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userContent }],
        }),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        throw new Error(`Anthropic API error: ${upstream.status} ${errText}`);
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
          try {
            const evt = JSON.parse(payload);
            if (evt.type === "content_block_delta" && evt.delta?.text) {
              res.write(`data: ${JSON.stringify({ token: evt.delta.text })}\n\n`);
            }
          } catch { /* skip malformed chunk */ }
        }
      }
    } else {
      // Groq (OpenAI-compatible streaming)
      const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: FINAL_RESPONSE_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          temperature: 0.2,
          max_tokens: 500,
          stream: true,
        }),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        throw new Error(`Groq API error: ${upstream.status} ${errText}`);
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
          try {
            const evt = JSON.parse(payload);
            const token = evt.choices?.[0]?.delta?.content;
            if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
          } catch { /* skip malformed chunk */ }
        }
      }
    }
  } catch (err) {
    console.error("[final-response] Streaming error:", err?.message || err);
    // Emit fallback as a single token if nothing was sent yet
    res.write(`data: ${JSON.stringify({ token: fallback })}\n\n`);
  }

  res.write("data: [DONE]\n\n");
  res.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET  /analytics        — serve pre-computed analytical store
// POST /analytics/process — trigger a manual recompute
// ─────────────────────────────────────────────────────────────────────────────
app.get("/analytics", (_req, res) => {
  try {
    res.json(getAnalytics());
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/analytics/process", (_req, res) => {
  try {
    const meetings = getAllMeetings();
    const result = processAnalytics(meetings);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// product_analysis routes (analytical.sqlite)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/analytics/product-analysis", (_req, res) => {
  try {
    res.json({ results: getProductAnalysis() });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.delete("/analytics/product-analysis", (_req, res) => {
  try {
    deleteProductAnalysis();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /ingest-historical
// Body: { "dir": "/abs/path/to/historical_data" }
// Triggers the fireflies_historical pipeline and streams a JSON result.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/ingest-historical", async (req, res) => {
  const dir = req.body?.dir;
  if (!dir || typeof dir !== "string") {
    return res.status(400).json({ error: 'Request body must include a "dir" string field.' });
  }
  try {
    console.log(`[ingest-historical] Starting import from: ${dir}`);
    const result = await fireflies_historical(dir, {
      onProgress: (done, total) => {
        if (done % 10 === 0 || done === total) {
          console.log(`[ingest-historical] Progress: ${done}/${total}`);
        }
      },
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("[ingest-historical] Fatal error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`[sqlite-api] listening on http://localhost:${PORT}`);
});

// Track open sockets so keep-alive connections don't block shutdown
const _openSockets = new Set();
server.on("connection", (socket) => {
  _openSockets.add(socket);
  socket.once("close", () => _openSockets.delete(socket));
});

let _shuttingDown = false;

function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[server] ${signal} received — shutting down gracefully`);

  // Force-exit after 10 s if graceful close hangs
  const force = setTimeout(() => {
    console.error("[server] Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 10_000);
  force.unref();

  // Destroy idle keep-alive sockets so server.close() callback fires promptly
  for (const socket of _openSockets) socket.destroy();

  server.close(() => {
    console.log("[server] HTTP server closed");
    try { closeDb(); } catch (e) { console.error("[server] closeDb error:", e.message); }
    try { closeAnalyticalDb(); } catch (e) { console.error("[server] closeAnalyticalDb error:", e.message); }
    clearTimeout(force);
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception:", err);
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled rejection:", reason);
  shutdown("unhandledRejection");
});
