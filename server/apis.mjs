import {
  kvGet,
  kvSet,
  kvDel,
  kvMdel,
  kvGetByPrefix,
  kvMset,
  // getStoredApiKey,
  getAllMeetings,
  getMeetingById,
  upsertMeetings,
  deleteMeetings,
} from "./sqlite-api.mjs";
import {
  PRODUCT_MENTIONS_EXTRACTION_SYSTEM_PROMPT,
  PRODUCT_MENTIONS_EXTRACTION_USER_TEMPLATE,
} from "./prompts.mjs";
import {
  FIREFLIES_API_URL,
  FIREFLIES_FROM_DATE,
  HUBSPOT_API_BASE,
  FIREFLIES_API_KEY,
  GROQ_API_KEY,
  HUBSPOT_API_KEY,
  REDACTED_NAMES,
  EXCLUDED_HOSTS,
  EXCLUDED_TITLES,
  INTERNAL_DOMAINS,
  HIRING_KEYWORDS,
} from "./config.mjs";

const REDACT_REGEX = REDACTED_NAMES.length
  ? new RegExp(
      REDACTED_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "gi",
    )
  : null;

// =========================
// Helpers (exported for app.mjs)
// =========================
export {
  // getStoredApiKey,
  kvGet,
  kvSet,
  kvDel,
  kvMdel,
  kvGetByPrefix,
  kvMset,
  getAllMeetings,
  getMeetingById,
  upsertMeetings,
  deleteMeetings,
};

export async function hubspotRequest(path, options = {}) {
  const apiKey = HUBSPOT_API_KEY;
  if (!apiKey) throw new Error("HUBSPOT_API_KEY not configured");

  const url = path.startsWith("http") ? path : `${HUBSPOT_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot API error: ${res.status} ${text}`);
  }
  return res.json();
}

export async function findHubSpotDealsForEmails(emails) {
  if (!emails || !Array.isArray(emails) || emails.length === 0) return [];
  const dealIds = new Set();

  for (const email of emails) {
    if (!email) continue;
    try {
      const searchRes = await hubspotRequest("/crm/v3/objects/contacts/search", {
        method: "POST",
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
          properties: ["email"]
        })
      });

      const contacts = searchRes.results || [];
      if (contacts.length === 0) continue;
      const contactId = contacts[0].id;

      const assocRes = await hubspotRequest(`/crm/v4/objects/contacts/${contactId}/associations/deals`);
      const associations = assocRes.results || [];

      for (const assoc of associations) {
        if (assoc.toObjectId) dealIds.add(String(assoc.toObjectId));
      }
    } catch (err) {
      // Ignore 404s or not configured errors silently for contact loops
      if (!err?.message?.includes("not configured")) {
        console.log(`[hubspot] Error finding deals for ${email}:`, err?.message);
      }
    }
  }

  return Array.from(dealIds);
}

function isHiringMeeting(title) {
  const lowerTitle = (title || "").toLowerCase();
  return HIRING_KEYWORDS.some((keyword) => lowerTitle.includes(keyword));
}

export function extractEmails(meeting) {
  if (Array.isArray(meeting?.meeting_attendees) && meeting.meeting_attendees.length > 0) {
    return meeting.meeting_attendees.map((a) => a.email).filter(Boolean);
  }
  return Array.isArray(meeting?.participants) ? meeting.participants : [];
}

export function getExternalEmails(meeting) {
  const emails = extractEmails(meeting);
  return emails.filter((email) => {
    if (!email || typeof email !== "string") return false;
    const lower = email.trim().toLowerCase();
    if (!lower.includes("@")) return false;
    return !INTERNAL_DOMAINS.some((domain) => lower.endsWith(`@${domain}`));
  });
}

export function shouldAnalyzeMeeting(meeting) {
  // const duration = typeof meeting?.duration === "number" ? meeting.duration : 0;
  // // if (duration > 0 && duration < 60) {
  // //   return { allowed: false, reason: `Too short (${duration}s < 60s minimum)` };
  // // }
  // no excluding based in timings 
  const organizerName = (meeting?.organizer_email || "")
    .split("@")[0]
    .replace(/[._-]/g, " ")
    .toLowerCase()
    .trim();

  for (const host of EXCLUDED_HOSTS) {
    if (organizerName === host.toLowerCase()) {
      return { allowed: false, reason: `Excluded host: ${host}` };
    }
  }

  const titleLower = (meeting?.title || "").toLowerCase().trim();
  for (const excludedTitle of EXCLUDED_TITLES) {
    if (titleLower === excludedTitle.toLowerCase()) {
      return { allowed: false, reason: `Excluded title: ${excludedTitle}` };
    }
  }

  if (isHiringMeeting(meeting?.title)) {
    return { allowed: false, reason: `Hiring/interview meeting: ${meeting?.title}` };
  }

  const participants = extractEmails(meeting);
  if (participants.length > 0) {
    const hasExternal = participants.some((email) => {
      if (!email || typeof email !== "string") return false;
      const emailLower = email.trim().toLowerCase();
      if (!emailLower.includes("@")) return true;
      return !INTERNAL_DOMAINS.some((domain) => emailLower.endsWith(`@${domain}`));
    });
    if (!hasExternal) {
      return { allowed: false, reason: "Internal-only meeting (no external participants)" };
    }
  }

  return { allowed: true };
}

export function classifyMeetingType(meeting) {
  const { allowed } = shouldAnalyzeMeeting(meeting);
  if (!allowed) return "excluded";

  const participants = extractEmails(meeting);
  const hasExternal = participants.some((email) => {
    if (!email || typeof email !== "string") return false;
    const emailLower = email.trim().toLowerCase();
    if (!emailLower.includes("@")) return true;
    return !INTERNAL_DOMAINS.some((domain) => emailLower.endsWith(`@${domain}`));
  });
  return hasExternal ? "external_call" : "internal_call";
}

export function buildMeetingMetadata(meeting) {
  const organizerName = (meeting?.organizer_email || "")
    .split("@")[0]
    .replace(/[._-]/g, " ")
    .toLowerCase()
    .trim();

  const is_excluded_host = EXCLUDED_HOSTS.some((h) => organizerName === h.toLowerCase());
  const is_hiring_meeting = isHiringMeeting(meeting?.title);

  const participants = extractEmails(meeting);
  let has_external_participant = false;
  if (participants.length > 0) {
    has_external_participant = participants.some((email) => {
      if (!email || typeof email !== "string") return false;
      const emailLower = email.trim().toLowerCase();
      if (!emailLower.includes("@")) return true;
      return !INTERNAL_DOMAINS.some((domain) => emailLower.endsWith(`@${domain}`));
    });
  }

  const is_internal_meeting = participants.length > 0 && !has_external_participant;
  return { is_hiring_meeting, is_internal_meeting, is_excluded_host, has_external_participant };
}

function redactString(val) {
  if (val === null || val === undefined) return "";
  if (typeof val !== "string") {
    try {
      return String(val);
    } catch {
      return "";
    }
  }
  if (!REDACT_REGEX) return val;
  REDACT_REGEX.lastIndex = 0;
  return val.replace(REDACT_REGEX, "[Redacted]");
}

function safeToArray(val) {
  if (val === null || val === undefined) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === "string") return val.trim() ? [val] : [];
  return [];
}

function redactArray(val) {
  const arr = safeToArray(val);
  if (!REDACT_REGEX) return arr.filter((s) => s !== null && s !== undefined).map((s) => redactString(s));
  return arr
    .filter((s) => {
      if (s === null || s === undefined) return false;
      if (typeof s !== "string") return true;
      REDACT_REGEX.lastIndex = 0;
      return !REDACT_REGEX.test(s.trim());
    })
    .map((s) => redactString(s));
}

export function redactTranscript(t) {
  if (!t) return t;
  try {
    const redacted = { ...t };
    redacted.title = redactString(t.title);
    redacted.organizer_email = t.organizer_email || "";
    redacted.participants = redactArray(t.participants);

    if (t.summary) {
      redacted.summary = {
        ...t.summary,
        keywords: redactArray(t.summary.keywords),
        action_items: redactArray(t.summary.action_items),
        outline: redactArray(t.summary.outline),
        shorthand_bullet: redactArray(t.summary.shorthand_bullet),
        overview: redactString(t.summary.overview),
        bullet_gist: redactString(t.summary.bullet_gist),
        short_summary: redactString(t.summary.short_summary),
      };
    }

    if (t.sentences && Array.isArray(t.sentences)) {
      redacted.sentences = t.sentences
        .filter((s) => {
          if (!s) return false;
          if (!REDACT_REGEX) return true;
          REDACT_REGEX.lastIndex = 0;
          return !REDACT_REGEX.test(s.speaker_name || "");
        })
        .map((s) => ({
          ...s,
          text: redactString(s.text),
          raw_text: redactString(s.raw_text),
          speaker_name: redactString(s.speaker_name),
        }));
    }
    return redacted;
  } catch (err) {
    console.log("Error in redactTranscript:", err?.message || err);
    return t;
  }
}

export function buildTranscriptsQuery(limit, fields, skip = 0) {
  return `query { transcripts(limit: ${limit}, skip: ${skip}, fromDate: "${FIREFLIES_FROM_DATE}") { ${fields} } }`;
}

export async function firefliesQuery(query, timeoutMs = 15000, variables) {
  const apiKey = FIREFLIES_API_KEY;
  if (!apiKey) throw new Error("FIREFLIES_API_KEY not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const bodyObj = { query };
    if (variables) bodyObj.variables = variables;

    const response = await fetch(FIREFLIES_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(bodyObj),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Fireflies API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (data.errors) {
      throw new Error(`GraphQL error: ${data.errors.map((e) => e.message).join(", ")}`);
    }
    return data.data;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAllFirefliesTranscripts(fields, perPageTimeoutMs = 45000) {
  const PAGE_SIZE = 50;
  const allTranscripts = [];
  let skip = 0;
  const MAX_PAGES = 20;

  for (let page = 0; page < MAX_PAGES; page++) {
    const query = buildTranscriptsQuery(PAGE_SIZE, fields, skip);
    console.log(`Fireflies pagination: page ${page + 1}, skip=${skip}, limit=${PAGE_SIZE}`);
    try {
      const data = await firefliesQuery(query, perPageTimeoutMs);
      const batch = data.transcripts || [];
      console.log(`Fireflies pagination: page ${page + 1} returned ${batch.length} transcripts`);
      allTranscripts.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      skip += PAGE_SIZE;
    } catch (pageErr) {
      console.log(
        `Fireflies pagination: page ${page + 1} failed (${pageErr?.message || pageErr}), returning ${allTranscripts.length} transcripts collected so far`,
      );
      break;
    }
  }

  console.log(`Fireflies pagination complete: ${allTranscripts.length} total transcripts fetched`);
  return allTranscripts;
}

export async function getFullCallWithTranscript(callId) {
  let stored = getMeetingById(callId);
  if (stored && !shouldAnalyzeMeeting(stored).allowed) return null;

  if (stored?.sentences?.length > 0) return stored;

  try {
    const query = `query {
      transcript(id: "${callId}") {
        id
        title
        date
        duration
        organizer_email
        host_email
        participants
        transcript_url
        audio_url
        user {
          user_id
          email
          name
        }
        meeting_attendees {
          email
          name
          displayName
          phoneNumber
          location
        }
        summary {
          keywords
          action_items
          outline
          shorthand_bullet
          overview
          bullet_gist
          short_summary
        }
        sentences {
          index
          text
          raw_text
          start_time
          end_time
          speaker_id
          speaker_name
          ai_filters {
            question
            sentiment
          }
        }
      }
    }`;
    const data = await firefliesQuery(query, 15000);
    if (data?.transcript) {
      const redacted = redactTranscript(data.transcript);
      upsertMeetings(redacted);
      return redacted;
    }
  } catch (err) {
    console.log(`[product-requests] Failed to fetch transcript for ${callId}:`, err?.message);
  }
  return stored;
}

export function buildTranscript(call) {
  if (!call) return "";
  if (call.sentences?.length > 0) {
    return call.sentences.map((s) => `${s.speaker_name || "Speaker"}: ${s.text || ""}`).join("\n");
  }
  const parts = [];
  const s = call.summary;
  if (s?.overview) parts.push(s.overview);
  if (s?.short_summary) parts.push(s.short_summary);
  if (s?.bullet_gist) parts.push(typeof s.bullet_gist === "string" ? s.bullet_gist : (s.bullet_gist || []).join("\n"));
  return parts.join("\n\n");
}

export async function extractProductMentionsViaGroq(call, transcriptText) {
  const groqApiKey = GROQ_API_KEY;
  if (!groqApiKey) return [];

  const clientName = (call.participants || []).find((p) => p !== call.organizer_email) || call.title?.split(" - ")[0] || "Unknown";
  const organizer = (call.organizer_email || "").split("@")[0]?.replace(/[._-]/g, " ") || "Unknown";
  const title = call.title || "Untitled";

  const userContent = PRODUCT_MENTIONS_EXTRACTION_USER_TEMPLATE.replace("{{title}}", title)
    .replace("{{clientName}}", clientName)
    .replace("{{organizer}}", organizer)
    .replace("{{transcript}}", (transcriptText || "").slice(0, 6000));

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-70b-versatile",
        messages: [
          { role: "system", content: PRODUCT_MENTIONS_EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
        max_tokens: 800,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      console.log(`[product-requests] Groq error ${response.status} for call ${call.id}`);
      return [];
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return [];

    const cleaned = raw.replace(/^```json\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string" && x.trim()) : [];
  } catch (err) {
    if (err.name === "AbortError") console.log(`[product-requests] Groq timeout for call ${call.id}`);
    else console.log(`[product-requests] Groq parse/error for call ${call.id}:`, err?.message);
    return [];
  }
}
