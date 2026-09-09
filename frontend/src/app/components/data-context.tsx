import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
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
import { apiFetch, syncHubspot, syncHubspotIncremental, getHubspotSyncStatus, type HubSpotSyncStatus } from "../api";

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
  summaryBulletGist?: string | null;
  shortSummary?: string | null;
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
  runHubspotSync: () => Promise<void>;
  runHubspotIncrementalSync: () => Promise<void>;
  isHubspotSyncing: boolean;
  hubspotSyncStatus: HubSpotSyncStatus | null;
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
  runHubspotSync: async () => {},
  runHubspotIncrementalSync: async () => {},
  isHubspotSyncing: false,
  hubspotSyncStatus: null,
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

  const transcriptText = t.sentences?.length
    ? t.sentences.map((s) => `${s.speaker_name}: ${s.text}`).join("\n")
    : (t.transcript || "");

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
  const [isHubspotSyncing, setIsHubspotSyncing] = useState(false);
  const [hubspotSyncStatus, setHubspotSyncStatus] = useState<HubSpotSyncStatus | null>(null);
  const [dbCallCount, setDbCallCount] = useState(0);
  const hubspotSyncRef = useRef<() => void>(() => {});
  const [analytics, setAnalytics] = useState<Analytics>(EMPTY_ANALYTICS);
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const incrementalSyncRef = useRef<() => void>(() => {});

  // Load cached product insights from SQLite
  const loadProductInsights = useCallback(async () => {
    try {
      const data = await apiFetch("/product-insights");
      setProductInsights(data.results || []);
    } catch {
      // Non-fatal — insights will be empty until first analysis
    }
  }, []);

  // Load pre-computed analytics from the analytical store.
  // If the analytical DB is empty but meetings exist, trigger a recompute.
  const loadAnalytics = useCallback(async () => {
    try {
      const data = await apiFetch<Analytics>("/analytics");
      setAnalytics(data ?? EMPTY_ANALYTICS);
      if (!data?.summary || data.summary.totalCalls === 0) {
        apiFetch("/analytics/process", { method: "POST" })
          .then(() => apiFetch<Analytics>("/analytics"))
          .then((fresh) => setAnalytics(fresh ?? EMPTY_ANALYTICS))
          .catch(() => {});
      }
    } catch {
      // Non-fatal — UI falls back to EMPTY_ANALYTICS
    }
  }, []);

  // Analyze a specific set of call IDs and append results to the insights cache
  const analyzeCallIds = useCallback(async (callIds: string[]) => {
    if (!callIds.length) return;
    try {
      const data = await apiFetch("/product-requests/analyze", {
        method: "POST",
        body: JSON.stringify({ callIds }),
        timeoutMs: 120000,
      });
      if (data.newCount > 0) {
        // Reload from DB so state reflects everything persisted (new + previously cached)
        const fresh = await apiFetch("/product-insights");
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
      const data = await apiFetch("/data");
      const hasCalls = data.calls && data.calls.length > 0;
      if (hasCalls) {
        const normalized = data.calls.map(normalizeTranscript);
        normalized.sort((a: NormalizedCall, b: NormalizedCall) => (b.dateTimestamp || 0) - (a.dateTimestamp || 0));
        setCalls(normalized);
        setTotalCallsFetched(normalized.length);
        setDbCallCount(data.totalCount ?? normalized.length);
        setFetchProgress(`${data.totalCount ?? normalized.length} calls loaded from database`);
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
    setError(null);
    setFetchProgress("Full sync: fetching from Fireflies...");
    try {
      const data = await apiFetch("/sync", { method: "POST", timeoutMs: 120000 });
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
        const insightsRes = await apiFetch("/product-insights");
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
      const data = await apiFetch("/sync-new", { method: "POST", timeoutMs: 120000 });
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
        const data = await apiFetch(`/calls/${id}`);
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
        apiFetch("/hubspot/deals"),
        apiFetch("/hubspot/companies"),
        apiFetch("/hubspot/contacts"),
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

  // HubSpot sync — fetch from HubSpot API and persist to hubspot_data.sqlite
  const runHubspotSync = useCallback(async () => {
    if (isHubspotSyncing) return;
    setIsHubspotSyncing(true);
    try {
      const result = await syncHubspot();
      if (result.success) {
        setHubspotSyncStatus({
          lastSyncAt:   result.lastSyncAt,
          dealCount:    result.dealCount,
          companyCount: result.companyCount,
          noteCount:    result.noteCount,
          emailCount:   result.emailCount,
          contactCount: result.contactCount,
        });
      }
    } catch (err: unknown) {
      console.warn("[hubspot sync] failed:", (err as Error).message);
    } finally {
      setIsHubspotSyncing(false);
    }
  }, [isHubspotSyncing]);

  // Keep the ref in sync with the latest runHubspotSync (used by manual button)
  useEffect(() => {
    hubspotSyncRef.current = runHubspotSync;
  }, [runHubspotSync]);

  // Incremental HubSpot cron — only fetches companies changed since last sync
  const runHubspotIncrementalSync = useCallback(async () => {
    if (isHubspotSyncing) return;
    setIsHubspotSyncing(true);
    try {
      const result = await syncHubspotIncremental();
      if (result.success) {
        setHubspotSyncStatus({
          lastSyncAt:   result.lastSyncAt,
          dealCount:    result.dealCount,
          companyCount: result.companyCount,
          noteCount:    result.noteCount,
          emailCount:   result.emailCount,
          contactCount: result.contactCount,
        });
      }
    } catch (err: unknown) {
      console.warn("[hubspot incremental] failed:", (err as Error).message);
    } finally {
      setIsHubspotSyncing(false);
    }
  }, [isHubspotSyncing]);

  // Load HubSpot sync status from DB on mount
  useEffect(() => {
    getHubspotSyncStatus()
      .then((s) => setHubspotSyncStatus(s))
      .catch(() => {});
  }, []);

  // HubSpot auto-sync — incremental, every 15 minutes
  useEffect(() => {
    const id = setInterval(() => {
      console.log("[hubspot] incremental auto-sync...");
      runHubspotIncrementalSync();
    }, 15 * 60 * 1000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Manual refresh (incremental sync)
  const refresh = useCallback(() => {
    incrementalSync();
  }, [incrementalSync]);

  // Every consumer of useData() re-renders whenever this value's reference
  // identity changes — an inline object literal here would give it a new
  // identity on every DataProvider render (e.g. every setFetchProgress()
  // call during a sync), cascading a re-render through every page that
  // reads from context regardless of whether the fields it actually uses
  // changed. Memoizing keeps identity stable across renders that don't
  // touch any of these values.
  const contextValue = useMemo<DataContextType>(() => ({
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
    runHubspotSync,
    runHubspotIncrementalSync,
    isHubspotSyncing,
    hubspotSyncStatus,
    getCallDetail,
    setProductInsights,
    lastSynced,
    totalCallsFetched,
    fetchProgress,
    syncStatus,
    isSyncing,
    dbCallCount,
  }), [
    calls, hubspotDeals, hubspotCompanies, hubspotContacts, productInsights, analytics,
    user, isLoading, error, isLive, refresh, fullSync, refreshHubspot, isHubspotRefreshing,
    runHubspotSync, runHubspotIncrementalSync, isHubspotSyncing, hubspotSyncStatus,
    getCallDetail, setProductInsights, lastSynced, totalCallsFetched, fetchProgress,
    syncStatus, isSyncing, dbCallCount,
  ]);

  return (
    <DataContext.Provider value={contextValue}>
      {children}
    </DataContext.Provider>
  );
}