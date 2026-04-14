import express from "express";
import cors from "cors";
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
  extractProductMentionsViaGroq,
  // getHubspotApiKey,
  hubspotRequest,
  // getGroqApiKey,
  findHubSpotDealsForEmails,
  getExternalEmails,
  getAllMeetings,
  getMeetingById,
  upsertMeetings,
  deleteMeetings,
} from "./apis.mjs";
import {
  QUERY_REWRITE_REFERENCE_RESOLUTION_SYSTEM_PROMPT,
  QUERY_REWRITE_REFERENCE_RESOLUTION_USER_TEMPLATE,
} from "./prompts.mjs";
import {
  FIREFLIES_API_KEY,
  GROQ_API_KEY,
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
      groqApiKeySet: !!GROQ_API_KEY,
      hubspotApiKeySet: !!HUBSPOT_API_KEY,
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
    const limit = req.query.limit || "100";
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
    const limit = req.query.limit || "100";
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
    const limit = req.query.limit || "100";
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
        }

        meetingsToUpsert.push(redacted);
      }

      upsertMeetings(meetingsToUpsert);
    }

    const syncStatus = {
      lastSyncAt: new Date().toISOString(),
      totalCalls: best.length,
      newCalls: newCount,
      updatedCalls: updatedCount,
    };
    kvSet("sync:status", syncStatus);

    return res.json({ success: true, ...syncStatus });
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

    return res.json({ success: true, ...syncStatus });
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
    const { callIds } = req.body || {};
    const groqApiKey = GROQ_API_KEY;
    if (!groqApiKey) {
      return res.status(400).json({ error: "GROQ_API_KEY not configured. Add it in Settings." });
    }

    const allCalls = getAllMeetings();
    const allowedCalls = allCalls.filter((c) => shouldAnalyzeMeeting(c).allowed);
    const idsToProcess =
      Array.isArray(callIds) && callIds.length > 0
        ? callIds.filter((id) => allowedCalls.some((c) => c.id === id))
        : allowedCalls.map((c) => c.id);

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

      const items = await extractProductMentionsViaGroq(fullCall, transcriptText);
      results.push({
        callId: fullCall.id,
        callTitle: fullCall.title || "Untitled",
        aeName: (fullCall.organizer_email || "").split("@")[0]?.replace(/[._-]/g, " ") || "",
        clientName: (fullCall.participants || []).find((p) => p !== fullCall.organizer_email) || fullCall.title?.split(" - ")[0] || "Unknown",
        date: fullCall.date ? (typeof fullCall.date === "number" ? new Date(fullCall.date).toLocaleDateString() : String(fullCall.date)) : "",
        transcriptUrl: fullCall.transcript_url || "#",
        items: items,
      });

      await new Promise((r) => setTimeout(r, 200));
    }

    res.json({ results });
  } catch (err) {
    console.log("Product requests analyze error:", err?.message || err);
    res.status(500).json({ error: `Analysis failed: ${err?.message || err}` });
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

    const groqApiKey = GROQ_API_KEY;
    if (!groqApiKey) {
      console.log("GROQ_API_KEY not configured, returning original query");
      return res.json({ rewrittenQuery: currentQuery, wasRewritten: false, reason: "GROQ_API_KEY not configured" });
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqApiKey}`,
        },
        body: JSON.stringify({
          model: "moonshotai/kimi-k2-instruct-0905",
          messages: [
            { role: "system", content: QUERY_REWRITE_REFERENCE_RESOLUTION_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.15,
          max_tokens: 250,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errText = await response.text();
        console.log(`Groq API error: ${response.status} ${errText}`);
        return res.json({
          rewrittenQuery: currentQuery,
          wasRewritten: false,
          reason: `Groq API error: ${response.status}`,
        });
      }

      const data = await response.json();
      const rewritten = data.choices?.[0]?.message?.content?.trim();
      if (!rewritten) {
        return res.json({ rewrittenQuery: currentQuery, wasRewritten: false, reason: "Empty response from Groq" });
      }

      const cleaned = rewritten.replace(/^["']|["']$/g, "").trim();
      const wasRewritten = cleaned.toLowerCase() !== currentQuery.toLowerCase().trim();

      console.log(`[QueryRewrite] "${currentQuery}" → "${cleaned}" (changed: ${wasRewritten})`);
      return res.json({ rewrittenQuery: cleaned, wasRewritten });
    } catch (fetchErr) {
      clearTimeout(timer);
      if (fetchErr?.name === "AbortError") {
        return res.json({ rewrittenQuery: currentQuery, wasRewritten: false, reason: "Groq API timeout" });
      }
      return res.json({
        rewrittenQuery: currentQuery,
        wasRewritten: false,
        reason: `Fetch error: ${fetchErr?.message || fetchErr}`,
      });
    }
  } catch (err) {
    console.log("Query rewrite error:", err?.message || err);
    return res.status(500).json({ error: `Query rewrite failed: ${err?.message || err}` });
  }
});

const server = app.listen(PORT, () => {
  console.log(`[sqlite-api] listening on http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`[server] ${signal} received — closing DB and exiting`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
