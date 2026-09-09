const BASE = import.meta.env.VITE_SQLITE_SERVER_BASE ?? "http://localhost:3001";

// ─── Session token ────────────────────────────────────────────────────────────

export const AUTH_TOKEN_KEY = "glisseo_auth_token";
const AUTH_EMAIL_KEY = "glisseo_auth_email";

function getStoredToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

// Any 401 means the session is missing/expired server-side — clear the stale
// client state and force back to the login screen instead of letting callers
// (e.g. data-context.tsx's 5-min sync loop) degrade into a silent, permanent
// "Offline Mode" with no prompt to re-authenticate. Skipped for /auth/* paths
// so the login page's own inline "invalid credentials" handling isn't hijacked.
function _handleUnauthorized(path: string) {
  if (path.startsWith("/auth/")) return;
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_EMAIL_KEY);
  } catch { /* ignore */ }
  window.location.assign("/login");
}

// ─── Core fetch (retries + timeout) ──────────────────────────────────────────

export async function apiFetch<T = unknown>(
  path: string,
  options?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const timeout = options?.timeoutMs ?? 25_000;
  // 2 retries (3 attempts total) for every method — GET requests are idempotent
  // and safe to retry just as aggressively as POST; the previous 1-retry budget
  // for GET (including the HubSpot modal's flat-data/company-details reads)
  // gave up too early under transient contention (e.g. a sync holding a DB lock).
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    // abort() with no reason rejects fetch() with a bare DOMException whose
    // message is the unhelpful browser default "signal is aborted without
    // reason" — passing a real Error here means callers (and any UI showing
    // err.message, like the HubSpot modal's error state) see an actual,
    // diagnosable message instead.
    const tid = setTimeout(
      () => controller.abort(new Error(`Request to ${path} timed out after ${timeout}ms`)),
      timeout,
    );
    try {
      const { timeoutMs: _, ...fetchOptions } = options ?? {};
      const token = getStoredToken();
      const res = await fetch(`${BASE}${path}`, {
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(fetchOptions?.headers ?? {}),
        },
      });
      if (!res.ok) {
        const bodyText = await res.text();
        if (res.status === 546 && attempt < maxRetries) {
          console.warn(`546 WORKER_LIMIT on ${path}, retry ${attempt + 1}/${maxRetries}`);
          await _backoff(attempt);
          continue;
        }
        if (res.status === 401) {
          _handleUnauthorized(path);
        }
        // FastAPI's HTTPException wraps the real message as {"detail": "..."}
        // — surface just that instead of dumping the raw JSON envelope into
        // every error banner in the UI.
        let message = bodyText;
        try {
          const parsed = JSON.parse(bodyText);
          if (parsed && typeof parsed.detail === "string") message = parsed.detail;
        } catch { /* not JSON — show the raw text */ }
        throw new Error(`Server error ${res.status}: ${message}`);
      }
      return res.json() as Promise<T>;
    } catch (err: unknown) {
      const e = err as Error;
      const retryable =
        e.name === "AbortError" ||
        e.message?.includes("timed out") ||
        e.message?.includes("signal is aborted") ||
        e.message?.includes("WORKER_LIMIT") ||
        e.message?.includes("Failed to fetch");
      if (retryable && attempt < maxRetries) {
        console.warn(`Retryable error on ${path} (attempt ${attempt + 1}): ${e.message || e.name || "unknown error"}`);
        await _backoff(attempt);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(tid);
    }
  }
  throw new Error(`apiFetch ${path} exhausted all retries`);
}

function _backoff(attempt: number) {
  return new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)));
}

// ─── Response shapes ──────────────────────────────────────────────────────────

export interface SyncResult {
  success: boolean;
  lastSyncAt: string;
  totalCalls: number;
  newCalls: number;
  updatedCalls: number;
  newCallIds?: string[];
}

export interface SyncStatus {
  lastSyncAt: string | null;
  totalCalls: number;
  newCalls: number;
  updatedCalls: number;
}

export interface ProductAnalysisRow {
  uuid: string;
  analysis_dt: string;
  call_title: string | null;
  ae_name: string | null;
  date: string | null;
  summary_bullet_gist: string | null;
  short_summary: string | null;
}

// ─── Health ───────────────────────────────────────────────────────────────────

export const health = () => apiFetch<{ status: string }>("/health");

// ─── Config ───────────────────────────────────────────────────────────────────

export const getConfigStatus = () =>
  apiFetch<Record<string, unknown>>("/config/status");

export const setFirefliesApiKey = (apiKey: string) =>
  apiFetch<{ success: boolean }>("/config/fireflies-api-key", {
    method: "POST",
    body: JSON.stringify({ apiKey }),
  });

export const setGroqApiKey = (apiKey: string) =>
  apiFetch<{ success: boolean }>("/config/groq-api-key", {
    method: "POST",
    body: JSON.stringify({ apiKey }),
  });

export const setHubSpotApiKey = (apiKey: string) =>
  apiFetch<{ success: boolean }>("/config/hubspot-api-key", {
    method: "POST",
    body: JSON.stringify({ apiKey }),
  });

// ─── Combined data ────────────────────────────────────────────────────────────

export const getCombinedData = () =>
  apiFetch<{
    calls: unknown[];
    deals: unknown[];
    companies: unknown[];
    contacts: unknown[];
    totalCount: number;
    syncStatus: SyncStatus | null;
  }>("/data");

// ─── Calls ────────────────────────────────────────────────────────────────────

export const listCalls = () => apiFetch<{ calls: unknown[] }>("/calls");

export const getCallById = (id: string) =>
  apiFetch<{ call: unknown }>(`/calls/${id}`);

export const deleteAllCalls = () =>
  apiFetch<{ success: boolean }>("/calls", { method: "DELETE" });

export const askCall = (callId: string, question: string) =>
  apiFetch<{ answer: string }>(`/calls/${encodeURIComponent(callId)}/ask`, {
    method: "POST",
    body: JSON.stringify({ question }),
    timeoutMs: 45_000,
  });

// ─── Sync ─────────────────────────────────────────────────────────────────────

export const syncAll = (opts?: { timeoutMs?: number }) =>
  apiFetch<SyncResult>("/sync", { method: "POST", timeoutMs: 120_000, ...opts });

export const syncNew = (opts?: { timeoutMs?: number }) =>
  apiFetch<SyncResult>("/sync-new", { method: "POST", timeoutMs: 120_000, ...opts });

export const getSyncStatus = () =>
  apiFetch<SyncStatus>("/sync-status");

// ─── HubSpot ──────────────────────────────────────────────────────────────────

export const getHubSpotDeals = (params?: Record<string, string>) => {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  return apiFetch<{ results: unknown[] }>(`/hubspot/deals${qs}`);
};

export const getHubSpotCompanies = (params?: Record<string, string>) => {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  return apiFetch<{ results: unknown[] }>(`/hubspot/companies${qs}`);
};

export const getHubSpotContacts = (params?: Record<string, string>) => {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  return apiFetch<{ results: unknown[] }>(`/hubspot/contacts${qs}`);
};

export const getHubSpotCompaniesEnriched = (limit = 25) =>
  apiFetch<{
    companies: unknown[];
    all_deals: unknown[];
    all_notes: unknown[];
  }>(`/hubspot/companies/enriched?limit=${limit}`);

export const getHubSpotPipelines = () =>
  apiFetch<{ results: { id: string; label: string; stages: { id: string; label: string }[] }[] }>(
    "/hubspot/pipelines/deals"
  );

export const resetHubspot = () =>
  apiFetch<{ success: boolean }>("/hubspot/reset", { method: "POST" });

export const backfillHubspotLabels = () =>
  apiFetch<{ success: boolean; updated: number; labelCount: number }>("/hubspot/backfill-labels", {
    method: "POST",
    timeoutMs: 30_000,
  });

export const getHubspotDbData = () =>
  apiFetch<{ deals: unknown[]; companies: unknown[]; notes: unknown[] }>("/hubspot/db-data");

export const getHubspotFlatData = () =>
  apiFetch<{ rows: unknown[] }>("/hubspot/flat-data");

export interface HubspotCompanyDetails {
  all_notes: Array<{ note_id: string; note_hs_note_body: string; note_hs_createdate: string; note_hubspot_owner_id: string; note_url: string }>;
  all_emails: Array<{ email_id: string; email_hs_email_subject: string; email_hs_email_text: string; email_hs_createdate: string; email_hubspot_owner_id: string; email_url: string }>;
}

export const getHubspotCompanyDetails = (companyId: string) =>
  apiFetch<HubspotCompanyDetails>(`/hubspot/companies/${encodeURIComponent(companyId)}/details`);

export const askHubspotRow = (context: Record<string, unknown>, question: string) =>
  apiFetch<{ answer: string }>("/hubspot/ask-row", {
    method: "POST",
    body: JSON.stringify({ context, question }),
    timeoutMs: 45_000,
  });

export const getHubspotDbPipelineLabels = () =>
  apiFetch<Record<string, { stageLabel: string; pipelineLabel: string }>>("/hubspot/db-pipeline-labels");

export const getHubSpotNotes = (params?: Record<string, string>) => {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  return apiFetch<{ results: unknown[] }>(`/hubspot/notes${qs}`);
};

export interface HubSpotSyncStatus {
  lastSyncAt: string | null;
  dealCount: number;
  companyCount: number;
  noteCount: number;
  emailCount?: number;
  contactCount?: number;
  newDeals?: number;
  newCompanies?: number;
  newNotes?: number;
}

export const syncHubspot = (opts?: { timeoutMs?: number }) =>
  apiFetch<{ success: boolean } & HubSpotSyncStatus>("/hubspot/sync", {
    method: "POST",
    timeoutMs: 60_000,
    ...opts,
  });

export const syncHubspotIncremental = (opts?: { timeoutMs?: number }) =>
  apiFetch<{ success: boolean } & HubSpotSyncStatus>("/hubspot/sync-incremental", {
    method: "POST",
    timeoutMs: 60_000,
    ...opts,
  });

export const getHubspotSyncStatus = () =>
  apiFetch<HubSpotSyncStatus>("/hubspot/sync-status");

export const searchHubSpotNotes = (body: Record<string, unknown>) =>
  apiFetch<{ results: unknown[] }>("/hubspot/notes/search", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const searchHubSpotEmails = (body: Record<string, unknown>) =>
  apiFetch<{ results: unknown[] }>("/hubspot/emails/search", {
    method: "POST",
    body: JSON.stringify(body),
  });

// ─── Product insights ─────────────────────────────────────────────────────────

export const analyzeProductRequests = (params: { callIds?: string[]; force?: boolean } = {}) =>
  apiFetch<{ newCount: number }>("/product-requests/analyze", {
    method: "POST",
    body: JSON.stringify(params),
    timeoutMs: 120_000,
  });

export const getProductInsights = () =>
  apiFetch<{ results: unknown[] }>("/product-insights");

export const clearProductInsights = () =>
  apiFetch<{ success: boolean }>("/product-insights", { method: "DELETE" });

// ─── Analytics ────────────────────────────────────────────────────────────────

export const getAnalytics = () => apiFetch<unknown>("/analytics");

export const processAnalytics = () =>
  apiFetch<{ success: boolean }>("/analytics/process", { method: "POST" });

export const listProductAnalysis = () =>
  apiFetch<{ results: ProductAnalysisRow[] }>("/analytics/product-analysis");

export const clearProductAnalysis = (ids?: string[]) =>
  apiFetch<{ success: boolean }>("/analytics/product-analysis", {
    method: "DELETE",
    body: ids?.length ? JSON.stringify({ ids }) : undefined,
  });

// ─── Query rewrite ────────────────────────────────────────────────────────────

export const rewriteQuery = (body: Record<string, unknown>) =>
  apiFetch<unknown>("/rewrite-query", {
    method: "POST",
    body: JSON.stringify(body),
  });

// ─── Chat ─────────────────────────────────────────────────────────────────────

export interface ChatUser {
  user_id: string;
  email: string;
  name: string;
  display_name: string;
  created_at: number;
  last_active_at: number;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface ChatSession {
  chat_id: string;
  user_id: string;
  session_id: string;
  messages: StoredMessage[];
  chat_summary: string;
  created_at: number;
  last_active_at: number;
  ttl: number;
}

export const chatUpsertUser = (email: string, name?: string) =>
  apiFetch<ChatUser>("/chat/user", {
    method: "POST",
    body: JSON.stringify({ email, name: name ?? "" }),
  });

export const chatGetSessions = (userId: string) =>
  apiFetch<{ sessions: ChatSession[] }>(`/chat/sessions?user_id=${encodeURIComponent(userId)}`);

export const chatCreateSession = (userId: string, sessionId?: string) =>
  apiFetch<ChatSession>("/chat/sessions", {
    method: "POST",
    body: JSON.stringify({ user_id: userId, session_id: sessionId }),
  });

export const chatUpdateSession = (sessionId: string, messages: StoredMessage[], chatSummary?: string) =>
  apiFetch<{ success: boolean }>(`/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PUT",
    body: JSON.stringify({ messages, chat_summary: chatSummary }),
  });

export const chatDeleteSession = (sessionId: string) =>
  apiFetch<{ success: boolean }>(`/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });

export const chatGenerateTitle = (sessionId: string, firstMessage: string) =>
  apiFetch<{ title: string }>(`/chat/sessions/${encodeURIComponent(sessionId)}/title`, {
    method: "POST",
    body: JSON.stringify({ first_message: firstMessage }),
  });

// ─── Historical ingest ────────────────────────────────────────────────────────

export const ingestHistorical = (dir: string) =>
  apiFetch<{ success: boolean; ingested: number }>("/ingest-historical", {
    method: "POST",
    body: JSON.stringify({ dir }),
    timeoutMs: 300_000,
  });

// ─── Final response (SSE streaming) ──────────────────────────────────────────

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onDone?: () => void;
  onError?: (err: Error) => void;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  email: string;
  username: string;
  securityquestion: string;
  lastloggedin: number | null;
}

export const authSignup = (params: {
  email: string;
  username: string;
  password: string;
  securityquestion: string;
  answer: string;
}) =>
  apiFetch<AuthUser>("/auth/signup", {
    method: "POST",
    body: JSON.stringify(params),
  });

export interface AuthLoginResult extends AuthUser {
  token: string;
}

export const authLogin = (email: string, password: string) =>
  apiFetch<AuthLoginResult>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

export const authGetSecurityQuestion = (email: string) =>
  apiFetch<{ securityquestion: string }>("/auth/security-question", {
    method: "POST",
    body: JSON.stringify({ email }),
  });

export const authResetPassword = (params: { email: string; answer: string; new_password: string }) =>
  apiFetch<{ success: boolean }>("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify(params),
  });

export const authLogout = () =>
  apiFetch<{ success: boolean }>("/auth/logout", { method: "POST" });

export async function streamFinalResponse(
  body: { resultData: unknown; parsedQuery?: unknown; formattedIntro?: string },
  { onToken, onDone, onError }: StreamCallbacks
): Promise<void> {
  let res: Response;
  try {
    const token = getStoredToken();
    res = await fetch(`${BASE}/final-response`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 401) _handleUnauthorized("/final-response");
      throw new Error(`Server error ${res.status}`);
    }
  } catch (err) {
    onError?.(err as Error);
    return;
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") { onDone?.(); return; }
        try {
          const evt = JSON.parse(payload);
          if (evt.token) onToken(evt.token);
        } catch { /* skip malformed chunk */ }
      }
    }
  } catch (err) {
    onError?.(err as Error);
  } finally {
    reader.releaseLock();
    onDone?.();
  }
}
