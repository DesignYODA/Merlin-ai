import React, { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import {
  formatDuration,
  formatDate,
  analyzeSentiment,
  extractAEName,
  extractTopics,
  extractAEParticipants,
  extractExternalParticipants,
  isAEEmail,
  type FirefliesTranscript,
  type FirefliesUser,
} from "./fireflies-api";

const SERVER_BASE = import.meta.env.VITE_SQLITE_SERVER_BASE ?? "http://localhost:3001";

// ---- Frontend Safety Guard (Layer 3) ----
// Even if excluded meetings leak through, filter them on the client side.
const EXCLUDED_HOSTS_FE = ["vishal jetley", "anish khadiya"];
const EXCLUDED_TITLES_FE = ["weekly sales huddle"];
const INTERNAL_DOMAINS_FE = ["itilite.com", "fireflies.ai"];

// Rule 4 — Hiring / Interview meetings
const HIRING_KEYWORDS_FE = [
  "round",
  "interview",
  "candidate",
  "hiring",
];

function isHiringMeetingFE(title: string): boolean {
  const lowerTitle = (title || "").toLowerCase();
  return HIRING_KEYWORDS_FE.some((keyword) => lowerTitle.includes(keyword));
}

function shouldShowMeeting(call: NormalizedCall): boolean {
  // Rule 0 — Exclude calls shorter than 1 minute (duration is in minutes)
  const raw = call.raw;
  if (raw && typeof raw.duration === "number" && raw.duration > 0 && raw.duration < 1) {
    return false;
  }

  // Rule 1 — Excluded hosts
  const orgLower = (call.aeName || "").toLowerCase().trim();
  for (const host of EXCLUDED_HOSTS_FE) {
    if (orgLower === host) return false;
  }

  // Rule 2 — Excluded titles
  const titleLower = (call.title || "").toLowerCase().trim();
  for (const t of EXCLUDED_TITLES_FE) {
    if (titleLower === t) return false;
  }

  // Rule 4 — Hiring / Interview meetings
  if (isHiringMeetingFE(call.title)) return false;

  // Rule 3 — Internal-only meetings
  const participants = call.participants || [];
  if (participants.length > 0) {
    const hasExternal = participants.some((p) => {
      if (!p || typeof p !== "string") return false;
      const lower = p.trim().toLowerCase();
      if (!lower.includes("@")) return true; // name-only = external
      return !INTERNAL_DOMAINS_FE.some((d) => lower.endsWith(`@${d}`));
    });
    if (!hasExternal) return false;
  }

  return true;
}

export interface NormalizedCall {
  id: string;
  title: string;
  clientName: string;
  aeName: string;
  date: string;
  dateTimestamp: number;
  duration: string;
  topics: string[];
  sentiment: "positive" | "neutral" | "negative";
  keyProductRequests: string[];
  transcript: string;
  aiSummary: string;
  competitorsMentioned: string[];
  featureRequests: string[];
  recordingUrl: string;
  transcriptUrl: string;
  participants: string[];
  aeParticipants: string[];       // itilite.com domain participants only
  externalParticipants: string[]; // non-itilite.com participants
  isAEOrganized: boolean;         // true if organizer is from itilite.com
  actionItems: string[];
  outline: string[];
  raw?: FirefliesTranscript;
}

interface SyncStatus {
  lastSyncAt: string | null;
  totalCalls: number;
  newCalls: number;
  updatedCalls: number;
}

export interface AnalyticsSummary {
  totalCalls: number;
  uniqueTopics: number;
  activeAEs: number;
  totalActionItems: number;
  positiveSentiment: number;
  neutralSentiment: number;
  negativeSentiment: number;
}

export interface Analytics {
  summary: AnalyticsSummary | null;
  callsByDay: Array<{ day: string; count: number }>;
  topTopics: Array<{ topic: string; count: number; callIds: string[] }>;
  topAEs: Array<{ aeName: string; aeEmail: string; callCount: number }>;
  callActionItems: Array<{
    callId: string;
    callTitle: string;
    aeName: string;
    aeEmail: string;
    dateTs: number;
    transcriptUrl: string;
    actionItems: string[];
  }>;
  computedAt: number | null;
}

export interface ProductInsightResult {
  callId: string;
  callTitle: string;
  aeName: string;
  clientName: string;
  date: string;
  transcriptUrl: string;
  items: string[];
  analyzedAt: number;
}

export interface HubSpotDeal {
  id: string;
  properties: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

export interface HubSpotCompany {
  id: string;
  properties: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

export interface HubSpotContact {
  id: string;
  properties: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

const EMPTY_ANALYTICS: Analytics = {
  summary: null,
  callsByDay: [],
  topTopics: [],
  topAEs: [],
  callActionItems: [],
  computedAt: null,
};

interface DataContextType {
  calls: NormalizedCall[];
  hubspotDeals: HubSpotDeal[];
  hubspotCompanies: HubSpotCompany[];
  hubspotContacts: HubSpotContact[];
  productInsights: ProductInsightResult[];
  analytics: Analytics;
  user: FirefliesUser | null;
  isLoading: boolean;
  error: string | null;
  isLive: boolean;
  refresh: () => void;
  fullSync: () => void;
  refreshHubspot: () => Promise<void>;
  isHubspotRefreshing: boolean;
  getCallDetail: (id: string) => Promise<NormalizedCall | null>;
  setProductInsights: (results: ProductInsightResult[]) => void;
  lastSynced: Date | null;
  totalCallsFetched: number;
  fetchProgress: string;
  syncStatus: SyncStatus | null;
  isSyncing: boolean;
  dbCallCount: number;
}

const DataContext = createContext<DataContextType>({
  calls: [],
  hubspotDeals: [],
  hubspotCompanies: [],
  hubspotContacts: [],
  productInsights: [],
  analytics: EMPTY_ANALYTICS,
  user: null,
  isLoading: true,
  error: null,
  isLive: false,
  refresh: () => {},
  fullSync: () => {},
  refreshHubspot: async () => {},
  isHubspotRefreshing: false,
  getCallDetail: async () => null,
  setProductInsights: () => {},
  lastSynced: null,
  totalCallsFetched: 0,
  fetchProgress: "",
  syncStatus: null,
  isSyncing: false,
  dbCallCount: 0,
});

export function useData() {
  return useContext(DataContext);
}

async function serverFetch(path: string, options?: RequestInit & { timeoutMs?: number }) {
  const timeout = options?.timeoutMs || 25000;
  const maxRetries = options?.method === "POST" ? 2 : 1; // POST routes get retries

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const { timeoutMs: _, ...fetchOptions } = options || {};
      const res = await fetch(`${SERVER_BASE}${path}`, {
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(fetchOptions?.headers || {}),
        },
      });
      if (!res.ok) {
        const body = await res.text();
        // WORKER_LIMIT (546) is retryable — the function ran out of resources temporarily
        if (res.status === 546 && attempt < maxRetries) {
          console.warn(`Server returned 546 WORKER_LIMIT on ${path}, retry ${attempt + 1}/${maxRetries} after backoff`);
          await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
          continue;
        }
        throw new Error(`Server error ${res.status}: ${body}`);
      }
      return res.json();
    } catch (err: any) {
      // Retry on abort (timeout) or network errors
      const isRetryable =
        err.name === "AbortError" ||
        err.message?.includes("signal is aborted") ||
        err.message?.includes("WORKER_LIMIT") ||
        err.message?.includes("Failed to fetch");
      if (isRetryable && attempt < maxRetries) {
        console.warn(`Retryable error on ${path} (attempt ${attempt + 1}): ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw new Error(`serverFetch ${path} exhausted all retries`);
}

function normalizeTranscript(t: FirefliesTranscript): NormalizedCall {
  const sentiment = analyzeSentiment(t.summary);
  const topics = extractTopics(t.summary);
  const aeName = extractAEName(t.organizer_email);

  const safeArray = (val: unknown): string[] => {
    if (Array.isArray(val)) return val;
    if (typeof val === "string" && val.trim()) return [val];
    return [];
  };

  const participants = safeArray(t.participants);
  const actionItems = safeArray(t.summary?.action_items);
  const outline = safeArray(t.summary?.outline);

  const clientName = participants.find((p) => p !== t.organizer_email) || t.title?.split(" - ")[0] || "Unknown Client";

  const transcriptText = t.sentences
    ? t.sentences.map((s) => `${s.speaker_name}: ${s.text}`).join("\n")
    : "";

  const productPhrases = ["don't have that feature", "not supported", "check with product", "on the roadmap", "coming soon", "not available yet", "working on"];
  const detectedRequests: string[] = [];
  if (t.summary?.overview) {
    productPhrases.forEach((phrase) => {
      if (t.summary!.overview.toLowerCase().includes(phrase)) {
        detectedRequests.push(phrase);
      }
    });
  }

  const competitors = ["Gong", "Chorus", "Salesforce", "HubSpot", "Zoom", "Teams", "Outreach", "SalesLoft", "Clari", "Drift"];
  const mentionedCompetitors = competitors.filter((comp) => {
    const text = `${t.summary?.overview || ""} ${t.summary?.short_summary || ""} ${transcriptText}`.toLowerCase();
    return text.includes(comp.toLowerCase());
  });

  return {
    id: t.id,
    title: t.title || "Untitled Call",
    clientName,
    aeName,
    date: formatDate(t.date),
    dateTimestamp: t.date,
    duration: formatDuration(t.duration),
    topics,
    sentiment,
    keyProductRequests: t.summary?.action_items?.slice(0, 3) || [],
    transcript: transcriptText,
    aiSummary: t.summary?.short_summary || t.summary?.overview || "No summary available.",
    competitorsMentioned: mentionedCompetitors,
    featureRequests: detectedRequests,
    recordingUrl: t.audio_url || "#",
    transcriptUrl: t.transcript_url || "#",
    participants,
    aeParticipants: extractAEParticipants(t.participants, t.organizer_email),
    externalParticipants: extractExternalParticipants(t.participants, t.organizer_email),
    isAEOrganized: isAEEmail(t.organizer_email),
    actionItems,
    outline,
    raw: t,
  };
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [calls, setCalls] = useState<NormalizedCall[]>([]);
  const [hubspotDeals, setHubspotDeals] = useState<HubSpotDeal[]>([]);
  const [hubspotCompanies, setHubspotCompanies] = useState<HubSpotCompany[]>([]);
  const [hubspotContacts, setHubspotContacts] = useState<HubSpotContact[]>([]);
  const [productInsights, setProductInsights] = useState<ProductInsightResult[]>([]);
  const [user, setUser] = useState<FirefliesUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [totalCallsFetched, setTotalCallsFetched] = useState(0);
  const [fetchProgress, setFetchProgress] = useState("");
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isHubspotRefreshing, setIsHubspotRefreshing] = useState(false);
  const [dbCallCount, setDbCallCount] = useState(0);
  const [analytics, setAnalytics] = useState<Analytics>(EMPTY_ANALYTICS);
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const incrementalSyncRef = useRef<() => void>(() => {});

  // Load cached product insights from SQLite
  const loadProductInsights = useCallback(async () => {
    try {
      const data = await serverFetch("/product-insights");
      setProductInsights(data.results || []);
    } catch {
      // Non-fatal — insights will be empty until first analysis
    }
  }, []);

  // Load pre-computed analytics from the analytical store
  const loadAnalytics = useCallback(async () => {
    try {
      const data = await serverFetch("/analytics");
      setAnalytics(data ?? EMPTY_ANALYTICS);
    } catch {
      // Non-fatal — UI falls back to EMPTY_ANALYTICS
    }
  }, []);

  // Analyze a specific set of call IDs and append results to the insights cache
  const analyzeCallIds = useCallback(async (callIds: string[]) => {
    if (!callIds.length) return;
    try {
      const data = await serverFetch("/product-requests/analyze", {
        method: "POST",
        body: JSON.stringify({ callIds }),
        timeoutMs: 120000,
      });
      if (data.newCount > 0) {
        // Reload from DB so state reflects everything persisted (new + previously cached)
        const fresh = await serverFetch("/product-insights");
        setProductInsights(fresh.results || []);
      }
    } catch (err: any) {
      console.warn("Background analysis failed:", err.message);
    }
  }, []);

  // Load calls + HubSpot data in parallel from /data
  const loadFromDb = useCallback(async () => {
    try {
      setFetchProgress("Loading from database...");
      const data = await serverFetch("/data");
      const hasCalls = data.calls && data.calls.length > 0;
      if (hasCalls) {
        const normalized = data.calls.map(normalizeTranscript);
        const filtered = normalized.filter(shouldShowMeeting);
        if (filtered.length < normalized.length) {
          console.log(`Frontend guard filtered ${normalized.length - filtered.length} excluded meetings`);
        }
        filtered.sort((a: NormalizedCall, b: NormalizedCall) => (b.dateTimestamp || 0) - (a.dateTimestamp || 0));
        setCalls(filtered);
        setTotalCallsFetched(filtered.length);
        // Use server's totalCount (server-filtered DB count) so "Calls Stored" in
        // Settings matches syncStatus.totalCalls, not the stricter frontend filter.
        setDbCallCount(data.totalCount ?? filtered.length);
        setFetchProgress(`${data.totalCount ?? filtered.length} calls loaded from database`);
      }
      setHubspotDeals(data.deals || []);
      setHubspotCompanies(data.companies || []);
      setHubspotContacts(data.contacts || []);
      if (data.syncStatus?.lastSyncAt) {
        setLastSynced(new Date(data.syncStatus.lastSyncAt));
        setSyncStatus(data.syncStatus);
      }
      if (hasCalls) setIsLive(true);
      return hasCalls;
    } catch (err: any) {
      console.error("Failed to load from DB:", err.message);
      return false;
    }
  }, []);

  // Full sync: fetch all from Fireflies → store in DB
  const fullSync = useCallback(async () => {
    setIsSyncing(true);
    setFetchProgress("Full sync: fetching from Fireflies...");
    try {
      const data = await serverFetch("/sync", { method: "POST", timeoutMs: 120000 });
      console.log("Full sync result:", data);
      if (data.success) {
        setSyncStatus({
          lastSyncAt: data.lastSyncAt,
          totalCalls: data.totalCalls,
          newCalls: data.newCalls,
          updatedCalls: data.updatedCalls,
        });
        setLastSynced(new Date(data.lastSyncAt));
        setFetchProgress(`Synced ${data.totalCalls} calls (${data.newCalls} new)`);
        await loadFromDb();
        loadAnalytics();
        // Analyze calls that don't yet have cached insights
        const insightsRes = await serverFetch("/product-insights");
        const cachedIds = new Set((insightsRes.results || []).map((r: { callId: string }) => r.callId));
        const uncachedIds = (data.newCallIds || []).filter((id: string) => !cachedIds.has(id));
        analyzeCallIds(uncachedIds);
      } else {
        setFetchProgress("Sync completed with warnings");
      }
    } catch (err: any) {
      console.error("Full sync failed:", err.message);
      setError(`Sync failed: ${err.message}`);
      setFetchProgress("Sync failed");
    } finally {
      setIsSyncing(false);
    }
  }, [loadFromDb, analyzeCallIds, loadAnalytics]);

  // Incremental sync: only fetch new calls
  const incrementalSync = useCallback(async () => {
    setIsSyncing(true);
    setFetchProgress("Checking for new calls...");
    try {
      const data = await serverFetch("/sync-new", { method: "POST", timeoutMs: 120000 });
      console.log("Incremental sync result:", data);
      if (data.success) {
        setSyncStatus({
          lastSyncAt: data.lastSyncAt,
          totalCalls: data.totalCalls,
          newCalls: data.newCalls,
          updatedCalls: data.updatedCalls,
        });
        setLastSynced(new Date(data.lastSyncAt));
        if (data.newCalls > 0) {
          setFetchProgress(`${data.newCalls} new call(s) found!`);
          await loadFromDb();
          loadAnalytics();
          analyzeCallIds(data.newCallIds || []);
        } else {
          setFetchProgress(`Up to date · ${data.totalCalls} calls`);
        }
      }
    } catch (err: any) {
      console.error("Incremental sync failed:", err.message);
      setFetchProgress("Auto-sync check failed");
    } finally {
      setIsSyncing(false);
    }
  }, [loadFromDb, analyzeCallIds, loadAnalytics]);

  // Initial load: show DB data immediately, sync in background
  const initialLoad = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setUser(null);

    // Load DB data, cached insights, and analytics in parallel
    loadProductInsights();
    loadAnalytics();
    const hasDbData = await loadFromDb();

    // Unblock the UI as soon as the DB read is done
    setIsLoading(false);

    // Background sync — never awaited, UI stays responsive
    if (!hasDbData) {
      setFetchProgress("Syncing from Fireflies in background…");
      fullSync();
    } else {
      incrementalSync();
    }
  }, [loadFromDb, loadProductInsights, loadAnalytics, fullSync, incrementalSync]);

  useEffect(() => {
    initialLoad();
  }, [initialLoad]);

  // Keep the ref in sync with the latest incrementalSync without restarting the interval
  useEffect(() => {
    incrementalSyncRef.current = incrementalSync;
  }, [incrementalSync]);

  // Auto-sync interval (every 5 minutes for new calls) — set up once on mount
  useEffect(() => {
    syncIntervalRef.current = setInterval(() => {
      console.log("Auto-sync: checking for new calls...");
      incrementalSyncRef.current();
    }, 5 * 60 * 1000);

    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Get call detail with sentences
  const getCallDetail = useCallback(
    async (id: string): Promise<NormalizedCall | null> => {
      try {
        const data = await serverFetch(`/calls/${id}`);
        if (data.call) {
          return normalizeTranscript(data.call);
        }
      } catch (err) {
        console.error("Failed to fetch call detail from server:", err);
      }
      // Fallback to cached
      return calls.find((c) => c.id === id) || null;
    },
    [calls]
  );

  // Refetch HubSpot deals / companies / contacts from the live API
  const refreshHubspot = useCallback(async () => {
    if (isHubspotRefreshing) return;
    setIsHubspotRefreshing(true);
    try {
      const [dealsRes, companiesRes, contactsRes] = await Promise.allSettled([
        serverFetch("/hubspot/deals"),
        serverFetch("/hubspot/companies"),
        serverFetch("/hubspot/contacts"),
      ]);
      if (dealsRes.status === "fulfilled") setHubspotDeals(dealsRes.value.results || []);
      if (companiesRes.status === "fulfilled") setHubspotCompanies(companiesRes.value.results || []);
      if (contactsRes.status === "fulfilled") setHubspotContacts(contactsRes.value.results || []);
      const errs = [dealsRes, companiesRes, contactsRes]
        .filter((r) => r.status === "rejected")
        .map((r) => (r as PromiseRejectedResult).reason?.message);
      if (errs.length) console.warn("[hubspot refresh] partial failure:", errs.join("; "));
    } catch (err: any) {
      console.error("[hubspot refresh] failed:", err.message);
    } finally {
      setIsHubspotRefreshing(false);
    }
  }, [isHubspotRefreshing]);

  // Manual refresh (incremental sync)
  const refresh = useCallback(() => {
    incrementalSync();
  }, [incrementalSync]);

  return (
    <
      DataContext.Provider
      value={{
        calls,
        hubspotDeals,
        hubspotCompanies,
        hubspotContacts,
        productInsights,
        analytics,
        user,
        isLoading,
        error,
        isLive,
        refresh,
        fullSync,
        refreshHubspot,
        isHubspotRefreshing,
        getCallDetail,
        setProductInsights,
        lastSynced,
        totalCallsFetched,
        fetchProgress,
        syncStatus,
        isSyncing,
        dbCallCount,
      }}
    >
      {children}
    </DataContext.Provider>
  );
}