import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Send, Sparkles, Copy, Download, Bot, User, AlertTriangle, Search,
  Loader2, BarChart3, Users, Clock, ThumbsUp, ListChecks, Hash, TrendingUp,
  MessageSquare, ChevronDown, ChevronUp, Headphones, ExternalLink, Lightbulb,
  RefreshCw, ShieldAlert, PlusCircle, ArrowLeft, MoreHorizontal, Trash2, Pencil,
} from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";
import { useData } from "./data-context";
import { useAuth } from "../auth";
import { GlisseoLogo } from "./glisseo-mark";
import React from "react";
import {
  chatUpsertUser, chatGetSessions, chatCreateSession, chatUpdateSession, chatGenerateTitle,
  chatDeleteSession, askCall, askHubspotRow,
  type StoredMessage, type ChatSession,
} from "../api";
import {
  checkInputGuardrails,
  queryNeedsRewrite,
  rewriteQueryViaGroq,
  classifyPlannerIntent,
  extractCoreTopic,
  parseQuery,
  executeSearch,
  extractCallCountFilter,
  fetchWithRetry,
  deepTranscriptSearch,
  generateResultSummary,
  formatResponse,
  streamFinalResponse,
  generateFollowUpSuggestions,
  renderMarkdownSafe,
  suggestedQueries,
  AIUnderstandingPanel,
  FollowUpSuggestions,
  ResultRenderer,
  type ChatMessage,
  type ConversationMemory,
  EMPTY_MEMORY,
  type ResultData,
  type ParsedQuery,
} from "../../../utils/ask-ai-functions";

// =====================================================================
// Seeded ask — navigated in from Calls Library with rows pre-selected
// =====================================================================

export type AskAiSeedItem =
  | { type: "call"; id: string; title: string }
  | { type: "hubspot"; id: string; label: string; context: Record<string, unknown> };

export interface AskAiSeedState {
  seedQuestion: string;
  seedItems: AskAiSeedItem[];
}

// =====================================================================
// Main Component
// =====================================================================

export function AskAiPage() {
  const { calls, isLive, isLoading, error, totalCallsFetched, fetchProgress } = useData();
  const { email } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const greetingMessage: ChatMessage = useMemo(() => ({
    id: "greeting-initial",
    role: "assistant",
    content: "Hi, I'm Glisseo, your sales companion to easy understanding of our calls. Ask me anything about your meetings — I'll dig through transcripts, surface patterns, and give you evidence-backed insights.",
    timestamp: new Date().toISOString(),
  }), []);

  const [messages, setMessages] = useState<ChatMessage[]>([greetingMessage]);
  const [input, setInput] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const memoryRef = useRef<ConversationMemory>({ ...EMPTY_MEMORY });
  const [expandedEvidence, setExpandedEvidence] = useState<Set<string>>(new Set());

  // ─── "In Progress" badge — shown briefly after the video intro fades out ───
  const [showInProgress, setShowInProgress] = useState(true);
  const [inProgressFading, setInProgressFading] = useState(false);
  useEffect(() => {
    const fadeTimer = setTimeout(() => setInProgressFading(true), 2500);
    const hideTimer = setTimeout(() => setShowInProgress(false), 3200);
    return () => { clearTimeout(fadeTimer); clearTimeout(hideTimer); };
  }, []);

  // ─── Session persistence ───────────────────────────────────────────────────
  const userIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleGeneratedRef = useRef<Set<string>>(new Set());
  const [userReady, setUserReady] = useState(false);
  const seedHandledRef = useRef(false);

  // ─── Session 3-dot menu + rename ──────────────────────────────────────────────
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close 3-dot menu on outside click
  useEffect(() => {
    if (!menuOpenId) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
        setMenuPos(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpenId]);

  const toStoredMessages = (msgs: ChatMessage[]): StoredMessage[] =>
    msgs
      .filter((m) => !m.isSearching)
      .map((m) => ({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp }));

  const scheduleSave = useCallback((msgs: ChatMessage[]) => {
    if (!sessionIdRef.current) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      const stored = toStoredMessages(msgs);
      const firstAssistant = msgs.find((m) => m.role === "assistant" && !m.isSearching && m.content);
      chatUpdateSession(sessionIdRef.current!, stored, firstAssistant?.content?.slice(0, 120)).catch(() => {});
    }, 800);
  }, []);

  // Load most-recent session (or create one) on mount
  useEffect(() => {
    if (!email) return;
    let cancelled = false;
    (async () => {
      try {
        const user = await chatUpsertUser(email);
        if (cancelled) return;
        userIdRef.current = user.user_id;
        setUserReady(true);
        const { sessions: existing } = await chatGetSessions(user.user_id);
        if (cancelled) return;
        setSessions(existing);
        if (existing.length > 0) {
          const latest = existing[0];
          sessionIdRef.current = latest.session_id;
          setActiveSessionId(latest.session_id);
          if (latest.chat_summary) titleGeneratedRef.current.add(latest.session_id);
          if (latest.messages.length > 0) {
            setMessages([greetingMessage, ...latest.messages.map((m) => ({ ...m, isSearching: false }))]);
          }
        } else {
          const session = await chatCreateSession(user.user_id);
          if (cancelled) return;
          sessionIdRef.current = session.session_id;
          setActiveSessionId(session.session_id);
          setSessions([session]);
        }
      } catch {
        // Non-fatal — chat works without persistence
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  const startNewChat = useCallback(async () => {
    if (!userIdRef.current) return;
    try {
      const session = await chatCreateSession(userIdRef.current);
      sessionIdRef.current = session.session_id;
      setActiveSessionId(session.session_id);
      setSessions((prev) => [session, ...prev]);
      setMessages([greetingMessage]);
      memoryRef.current = { ...EMPTY_MEMORY };
    } catch { /* non-fatal */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [greetingMessage]);

  // ─── Seeded ask — arrived here from Calls Library with rows selected ───────
  // Creates a fresh session, then answers the question using each selected
  // call/company's summary + key points (via the same per-item ask endpoints
  // the detail panels already use), combining multiple answers into one reply.
  useEffect(() => {
    const state = location.state as Partial<AskAiSeedState> | null;
    const seedQuestion = state?.seedQuestion;
    const seedItems = state?.seedItems;
    if (!seedQuestion || !seedItems?.length) return;
    if (!userReady || seedHandledRef.current) return;
    seedHandledRef.current = true;

    navigate(location.pathname, { replace: true, state: null });

    (async () => {
      await startNewChat();

      const searchingId = `searching-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: `user-${Date.now()}`, role: "user", content: seedQuestion, timestamp: new Date().toISOString() },
        {
          id: searchingId,
          role: "assistant",
          content: "Searching...",
          timestamp: new Date().toISOString(),
          isSearching: true,
          searchProgress: `Reading ${seedItems.length} selected ${seedItems.length === 1 ? "item" : "items"}…`,
        },
      ]);

      try {
        const answers = await Promise.all(seedItems.map(async (item) => {
          if (item.type === "call") {
            const r = await askCall(item.id, seedQuestion);
            return { label: item.title, answer: r.answer };
          }
          const r = await askHubspotRow(item.context, seedQuestion);
          return { label: item.label, answer: r.answer };
        }));

        const combined = answers.length === 1
          ? answers[0].answer
          : answers.map((a) => `**${a.label}**\n\n${a.answer}`).join("\n\n---\n\n");

        setMessages((prev) => {
          const updated = prev.map((m) =>
            m.id === searchingId
              ? { id: `response-${Date.now()}`, role: "assistant" as const, content: combined, timestamp: new Date().toISOString(), isSearching: false }
              : m
          );
          scheduleSave(updated);
          return updated;
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        setMessages((prev) => prev.map((m) =>
          m.id === searchingId
            ? { id: `error-${Date.now()}`, role: "assistant" as const, content: `Try Later. Issue: ${errMsg}`, timestamp: new Date().toISOString(), isSearching: false }
            : m
        ));
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, userReady]);

  const switchSession = useCallback((session: ChatSession) => {
    sessionIdRef.current = session.session_id;
    setActiveSessionId(session.session_id);
    if (session.chat_summary) titleGeneratedRef.current.add(session.session_id);
    setMessages(
      session.messages.length > 0
        ? [greetingMessage, ...session.messages.map((m) => ({ ...m, isSearching: false }))]
        : [greetingMessage]
    );
    memoryRef.current = { ...EMPTY_MEMORY };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [greetingMessage]);

  // ─── Session actions ───────────────────────────────────────────────────────────
  const deleteSession = useCallback(async (sessionId: string) => {
    setMenuOpenId(null);
    try {
      await chatDeleteSession(sessionId);
    } catch { /* non-fatal if backend fails */ }
    setSessions((prev) => {
      const next = prev.filter((s) => s.session_id !== sessionId);
      // If deleted session was active, switch to first remaining or create new
      if (sessionId === sessionIdRef.current) {
        if (next.length > 0) {
          sessionIdRef.current = next[0].session_id;
          setActiveSessionId(next[0].session_id);
          setMessages(
            next[0].messages.length > 0
              ? [greetingMessage, ...next[0].messages.map((m) => ({ ...m, isSearching: false }))]
              : [greetingMessage]
          );
          memoryRef.current = { ...EMPTY_MEMORY };
        } else {
          // All deleted — create a fresh session
          if (userIdRef.current) {
            chatCreateSession(userIdRef.current).then((s) => {
              sessionIdRef.current = s.session_id;
              setActiveSessionId(s.session_id);
              setSessions([s]);
              setMessages([greetingMessage]);
              memoryRef.current = { ...EMPTY_MEMORY };
            }).catch(() => {});
          }
        }
      }
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [greetingMessage]);

  const startRename = useCallback((s: ChatSession) => {
    setMenuOpenId(null);
    setRenamingId(s.session_id);
    setRenamingValue(s.chat_summary || "");
  }, []);

  const finishRename = useCallback(async (sessionId: string) => {
    const trimmed = renamingValue.trim();
    setRenamingId(null);
    if (!trimmed) return;
    setSessions((prev) =>
      prev.map((s) => s.session_id === sessionId ? { ...s, chat_summary: trimmed } : s)
    );
    try {
      await chatUpdateSession(sessionId, [], trimmed);
    } catch { /* non-fatal */ }
  }, [renamingValue]);

  const copySession = useCallback((s: ChatSession) => {
    setMenuOpenId(null);
    const text = s.messages
      .map((m) => `${m.role === "user" ? "You" : "Glisseo"}: ${m.content}`)
      .join("\n\n");
    try { navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* */ }
      document.body.removeChild(ta);
    }
  }, []);

  const toggleEvidence = (msgId: string) => {
    setExpandedEvidence((prev) => {
      const next = new Set(prev);
      next.has(msgId) ? next.delete(msgId) : next.add(msgId);
      return next;
    });
  };

  function evidenceSummary(data: ResultData): string {
    if (data.totalMentions !== undefined)
      return `${data.totalMentions} mention${data.totalMentions !== 1 ? "s" : ""} · ${data.totalMeetings ?? 0} call${(data.totalMeetings ?? 0) !== 1 ? "s" : ""}`;
    if (data.topicRankings?.length) return `${data.topicRankings.length} topics`;
    if (data.participantRankings?.length) return `${data.participantRankings.length} participants`;
    if (data.actionItems?.length) return `${data.actionItems.length} action item${data.actionItems.length !== 1 ? "s" : ""}`;
    if (data.sentiment) return `${data.sentiment.positive + data.sentiment.neutral + data.sentiment.negative} calls`;
    if (data.durationList?.length) return `${data.durationList.length} calls`;
    if (data.competitorMentions?.length) return `${data.competitorMentions.length} competitor${data.competitorMentions.length !== 1 ? "s" : ""}`;
    if (data.overviewStats) return `${data.overviewStats.totalCalls} calls`;
    return "results";
  }

  // ─── Streaming greeting animation ───
  const GREETING_DESC =
    "An AI Intelligence to help navigate your sales calls. Ask me anything about your meetings.";
  const [streamedDesc, setStreamedDesc] = useState("");
  const [streamingDone, setStreamingDone] = useState(false);
  const [visibleSuggestions, setVisibleSuggestions] = useState(0);

  useEffect(() => {
    let i = 0;
    const iv = setInterval(() => {
      i++;
      setStreamedDesc(GREETING_DESC.slice(0, i));
      if (i >= GREETING_DESC.length) {
        clearInterval(iv);
        setStreamingDone(true);
      }
    }, 16);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (!streamingDone) return;
    let n = 0;
    const iv = setInterval(() => {
      n++;
      setVisibleSuggestions(n);
      if (n >= suggestedQueries.length) clearInterval(iv);
    }, 65);
    return () => clearInterval(iv);
  }, [streamingDone]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isSearching) return;

    // ─── GUARDRAIL CHECK ───
    const guardrail = checkInputGuardrails(input);
    if (guardrail.blocked) {
      const blockedMsg: ChatMessage = {
        id: `blocked-${Date.now()}`,
        role: "assistant",
        content: guardrail.reason || "I can only answer questions about your sales calls.",
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [
        ...prev,
        { id: `user-${Date.now()}`, role: "user", content: input, timestamp: new Date().toISOString() },
        blockedMsg,
      ]);
      setInput("");
      return;
    }

    if (calls.length === 0 && !isLoading) {
      const noDataMsg: ChatMessage = {
        id: `nodata-${Date.now()}`,
        role: "assistant",
        content: error
          ? `Unable to search — data failed to load: ${error}. Try refreshing.`
          : "No call data loaded yet. Wait for loading to finish or check your API key in Settings.",
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [
        ...prev,
        { id: `user-${Date.now()}`, role: "user", content: input, timestamp: new Date().toISOString() },
        noDataMsg,
      ]);
      setInput("");
      return;
    }

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: input,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    const query = input;
    setInput("");
    setIsSearching(true);

    const searchingId = `searching-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: searchingId,
        role: "assistant",
        content: "Searching...",
        timestamp: new Date().toISOString(),
        isSearching: true,
        searchProgress: "Analyzing query intent...",
      },
    ]);

    try {
      // ─── STEP 0: Query Rewrite via Groq LLM ───
      const memory = memoryRef.current;
      let effectiveQuery = query;
      let rewrittenQuery: string | undefined;
      let wasRewritten = false;

      if (queryNeedsRewrite(query, memory)) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === searchingId
              ? { ...m, searchProgress: "Rewriting query with AI context..." }
              : m
          )
        );

        const rewriteResult = await rewriteQueryViaGroq(query, memory);
        if (rewriteResult.wasRewritten) {
          effectiveQuery = rewriteResult.rewrittenQuery;
          rewrittenQuery = rewriteResult.rewrittenQuery;
          wasRewritten = true;
          console.log(`[QueryRewrite] "${query}" → "${effectiveQuery}"`);
        }
      }

      // ─── STEP 1: Query Planner (Agent 1) ───
      const plannerIntent = classifyPlannerIntent(effectiveQuery, memory);

      console.log(`[QueryPlanner] Intent: ${plannerIntent}, Memory topic: "${memory.lastQueryTopic}", Turn: ${memory.turnCount}`);

      // ─── STEP 2: Handle FOLLOW_UP — no new search ───
      if (plannerIntent === "FOLLOW_UP" && memory.lastResultData && memory.lastParsedQuery) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === searchingId
              ? { ...m, searchProgress: "Re-evaluating previous results..." }
              : m
          )
        );

        await new Promise((r) => setTimeout(r, 300));

        const prevResult = memory.lastResultData;
        const prevParsed = memory.lastParsedQuery;
        const topic = memory.lastQueryTopic || prevParsed.entities.join(" ") || "your previous query";

        let followUpContent = "";
        if (/\b(recheck|verify|revalidate|re-check|re-validate)\b/i.test(effectiveQuery)) {
          followUpContent = `I've re-evaluated the evidence for **"${topic}"**. My previous analysis found **${prevResult.totalMentions || 0} mentions** across **${prevResult.totalMeetings || prevResult.searchedCallCount} calls**. The transcript snippets below are the same evidence I retrieved — each one is sourced directly from call recordings.`;
        } else if (/\b(explain|elaborate|clarify|expand|more)\b/i.test(effectiveQuery)) {
          followUpContent = `Let me elaborate on my findings for **"${topic}"**. I analyzed ${prevResult.searchedCallCount} calls and found the evidence shown below. Each snippet is pulled directly from the transcript or summary — I don't infer or fabricate evidence.`;
        } else {
          followUpContent = `Based on my previous analysis of **"${topic}"** across ${prevResult.searchedCallCount} calls, here's the data again. If you want me to search for something different, just ask a new question.`;
        }

        // Update memory turn count + track raw query & response summary
        memoryRef.current = {
          ...memory,
          turnCount: memory.turnCount + 1,
          previousRawQueries: [query, ...memory.previousRawQueries].slice(0, 5),
          previousResponseSummaries: [followUpContent.slice(0, 300), ...memory.previousResponseSummaries].slice(0, 5),
        };

        setMessages((prev) =>
          prev.map((m) =>
            m.id === searchingId
              ? {
                  id: `response-${Date.now()}`,
                  role: "assistant" as const,
                  content: followUpContent,
                  timestamp: new Date().toISOString(),
                  isSearching: false,
                  resultData: prevResult,
                  parsedQuery: prevParsed,
                  plannerIntent,
                  plannerTopic: topic,
                  plannerScope: prevParsed.timeFilter?.label || `${prevResult.searchedCallCount} calls`,
                  rewrittenQuery: wasRewritten ? rewrittenQuery : undefined,
                  wasRewritten,
                }
              : m
          )
        );
        setIsSearching(false);
        setSearchStatus("");
        return;
      }

      // ─── STEP 3: Handle CORRECTION — re-run with previous topic ───
      let parsed: ParsedQuery;
      if (plannerIntent === "CORRECTION" && memory.lastParsedQuery) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === searchingId
              ? { ...m, searchProgress: `Re-running search for "${memory.lastQueryTopic}" with fresh analysis...` }
              : m
          )
        );

        // Re-parse using the previous query's entities but apply any new filters from current query
        parsed = { ...memory.lastParsedQuery, rawQuery: effectiveQuery };

        // Check if user added a new filter like "last 5 calls"
        const callCountFilter = extractCallCountFilter(effectiveQuery);
        if (callCountFilter) {
          // Will be applied after filtering
          (parsed as any)._callCountLimit = callCountFilter;
        }

        // Re-detect time filter from current query
        const timePatterns: [RegExp, number, string][] = [
          [/last\s+(\d+)\s+days?/i, 0, ""],
          [/last\s+week/i, 7, "last 7 days"],
          [/last\s+month/i, 30, "last 30 days"],
        ];
        for (const [pattern, defaultDays, label] of timePatterns) {
          const match = effectiveQuery.match(pattern);
          if (match) {
            let days = defaultDays;
            if (match[1]) days = parseInt(match[1]);
            parsed.timeFilter = { days, label: label || `last ${days} days` };
            break;
          }
        }
      } else if (plannerIntent === "DRILL_DOWN" && memory.lastParsedQuery) {
        // ─── STEP 3b: Handle DRILL_DOWN — use previous entities ───
        setMessages((prev) =>
          prev.map((m) =>
            m.id === searchingId
              ? { ...m, searchProgress: `Drilling deeper into "${memory.lastQueryTopic}"...` }
              : m
          )
        );

        // Use the smart topic extraction to get entities from this query OR fall back to memory
        const coreTopics = extractCoreTopic(effectiveQuery, plannerIntent, memory);
        parsed = parseQuery(effectiveQuery);
        if (parsed.entities.length === 0 && coreTopics.length > 0) {
          parsed.entities = coreTopics;
        }
      } else {
        // ─── STEP 4: New search — use smart topic extraction ───
        parsed = parseQuery(effectiveQuery);

        // Override entities with smarter extraction
        const smartEntities = extractCoreTopic(effectiveQuery, plannerIntent, memory);
        if (smartEntities.length > 0) {
          parsed.entities = smartEntities;
        }
      }

      console.log(`[QueryPlanner] Final entities: [${parsed.entities.join(", ")}], intent: ${parsed.intent}`);

      setMessages((prev) =>
        prev.map((m) =>
          m.id === searchingId
            ? { ...m, searchProgress: `Running ${parsed.intent.replace(/_/g, " ")} across ${calls.length} calls...` }
            : m
        )
      );

      await new Promise((r) => setTimeout(r, 400));

      // Apply call count limit if specified (e.g., "last 5 calls")
      let searchCalls = calls;
      const callLimit = (parsed as any)._callCountLimit || extractCallCountFilter(effectiveQuery);
      if (callLimit && callLimit > 0) {
        searchCalls = calls.slice(0, callLimit);
      }

      // Execute search with retry for empty results
      let result: ResultData;
      const searchAttempt = () => {
        return executeSearch(searchCalls, parsed);
      };

      const { result: retriedResult, error: searchError } = await fetchWithRetry(
        async () => searchAttempt(),
        (r: ResultData) => {
          // Consider valid if: has results OR explicitly noResults (that's a valid state)
          return r !== null && r !== undefined;
        },
        3,
      );

      if (!retriedResult) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === searchingId
              ? {
                  id: `error-${Date.now()}`,
                  role: "assistant" as const,
                  content: `Try Later. Issue: ${searchError || "Search returned empty after 3 retries"}`,
                  timestamp: new Date().toISOString(),
                  isSearching: false,
                }
              : m
          )
        );
        setIsSearching(false);
        setSearchStatus("");
        return;
      }

      result = retriedResult;

      // Deep transcript enrichment for text / topic search with mentions
      if (
        (parsed.intent === "text_search" || parsed.intent === "topic_search" || parsed.intent === "keyword_search") &&
        parsed.entities.length > 0 &&
        result.mentions &&
        result.mentions.length > 0
      ) {
        const needsDeep = result.mentions.filter((m) => m.source !== "transcript").map((m) => m.callId);
        if (needsDeep.length > 0) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === searchingId
                ? { ...m, searchProgress: `Enriching ${needsDeep.length} results with transcripts...` }
                : m
            )
          );
          try {
            const deepResults = await deepTranscriptSearch(needsDeep, parsed.entities, (msg) => {
              setMessages((prev) => prev.map((m) => m.id === searchingId ? { ...m, searchProgress: msg } : m));
            });
            for (const mention of result.mentions) {
              const deep = deepResults.get(mention.callId);
              if (deep && deep.length > 0) { mention.snippets = deep; mention.source = "transcript"; }
            }
          } catch (e) {
            console.warn("Deep search failed (non-fatal):", e);
          }
        }
      }

      // Generate the detail section header (used as LLM context + fallback)
      const detailHeader = formatResponse(result, parsed);

      // ─── STEP 5: Update conversation memory ───
      const responseSummaryForMemory = generateResultSummary(result, parsed).slice(0, 400);
      memoryRef.current = {
        lastQueryTopic: parsed.entities.join(" ") || memory.lastQueryTopic,
        lastParsedQuery: parsed,
        lastResultData: result,
        lastRetrievedCallIds: result.mentions?.map((m) => m.callId) || memory.lastRetrievedCallIds,
        lastAnswer: detailHeader,
        turnCount: memory.turnCount + 1,
        previousRawQueries: [query, ...memory.previousRawQueries].slice(0, 5),
        previousResponseSummaries: [responseSummaryForMemory, ...memory.previousResponseSummaries].slice(0, 5),
      };

      const resolvedTopic = parsed.entities.join(" ") || memory.lastQueryTopic || "";
      const resolvedScope = parsed.timeFilter?.label
        || (callLimit ? `last ${callLimit} calls` : `${result.searchedCallCount} calls`);

      // Create the message immediately with empty content — LLM streams into it
      const finalMsgId = `response-${Date.now()}`;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === searchingId
            ? {
                id: finalMsgId,
                role: "assistant" as const,
                content: "",
                timestamp: new Date().toISOString(),
                isSearching: false,
                isStreaming: true,
                resultData: result,
                parsedQuery: parsed,
                plannerIntent,
                plannerTopic: resolvedTopic,
                plannerScope: resolvedScope,
                rewrittenQuery: wasRewritten ? rewrittenQuery : undefined,
                wasRewritten,
              }
            : m
        )
      );

      // Stream LLM narrative token-by-token into the message
      try {
        await streamFinalResponse(result, parsed, detailHeader, (token) => {
          setMessages((prev) =>
            prev.map((m) => m.id === finalMsgId ? { ...m, content: m.content + token } : m)
          );
        });
      } catch {
        // Streaming failed — use static fallback only if content is still empty
        setMessages((prev) =>
          prev.map((m) =>
            m.id === finalMsgId && m.content === ""
              ? { ...m, content: `${responseSummaryForMemory}\n\n${detailHeader}` }
              : m
          )
        );
      } finally {
        let capturedMsgs: ChatMessage[] = [];
        setMessages((prev) => {
          const updated = prev.map((m) => m.id === finalMsgId ? { ...m, isStreaming: false } : m);
          capturedMsgs = updated;
          scheduleSave(updated);
          return updated;
        });

        // Generate session title after first user message
        const sid = sessionIdRef.current;
        if (sid && !titleGeneratedRef.current.has(sid)) {
          const userMsgs = capturedMsgs.filter((m) => m.role === "user" && !m.isSearching);
          if (userMsgs.length === 1) {
            titleGeneratedRef.current.add(sid);
            const rawQuery = userMsgs[0].content;

            // Immediately show a cleaned-up version of the query in the sidebar
            const quickTitle = rawQuery.length > 42
              ? rawQuery.slice(0, 40).trimEnd() + "…"
              : rawQuery;
            setSessions((prev) =>
              prev.map((s) => s.session_id === sid ? { ...s, chat_summary: quickTitle } : s)
            );

            // Replace with Groq-generated 3-5 word title when ready
            chatGenerateTitle(sid, rawQuery)
              .then(({ title }) => {
                setSessions((prev) =>
                  prev.map((s) => s.session_id === sid ? { ...s, chat_summary: title } : s)
                );
              })
              .catch(() => { titleGeneratedRef.current.delete(sid); });
          }
        }
      }
    } catch (err) {
      console.error("Ask Glisseo search error:", err);
      const errMsg = err instanceof Error ? err.message : String(err);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === searchingId
            ? { id: `error-${Date.now()}`, role: "assistant" as const, content: `Try Later. Issue: ${errMsg}`, timestamp: new Date().toISOString(), isSearching: false }
            : m
        )
      );
    } finally {
      setIsSearching(false);
      setSearchStatus("");
    }
  }, [input, isSearching, calls, isLoading, error]);

  const handleCopy = (text: string) => {
    try { navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* */ }
      document.body.removeChild(ta);
    }
  };

  const handleExportCSV = (data: ResultData) => {
    let csv = "";
    if (data.mentions) {
      csv = "Call Title,Organizer,Date,Mentions,Source,Snippet\n" +
        data.mentions.map((m) => `"${m.callTitle}","${m.aeName}","${m.date}","${m.mentionCount}","${m.source}","${(m.snippets[0]?.text || "").replace(/"/g, '""')}"`).join("\n");
    } else if (data.topicRankings) {
      csv = "Topic,Mentions,Calls,Trend\n" +
        data.topicRankings.map((t) => `"${t.topic}","${t.count}","${t.callCount}","${t.trend}"`).join("\n");
    } else if (data.actionItems) {
      csv = "Action Item,Call,Date\n" +
        data.actionItems.map((a) => `"${a.item.replace(/"/g, '""')}","${a.callTitle}","${a.date}"`).join("\n");
    } else if (data.participantRankings) {
      csv = "Participant,Calls\n" +
        data.participantRankings.map((p) => `"${p.name}","${p.callCount}"`).join("\n");
    }
    if (!csv) return;
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `glisseo-ai-${data.intent}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="flex items-stretch h-full w-full p-4"
      style={{
        background: "radial-gradient(ellipse at 50% 20%, rgba(236,93,37,0.10) 0%, transparent 60%), var(--app-base)",
      }}
    >
    <div
      className="flex flex-row flex-1 rounded-3xl overflow-hidden"
      style={{
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
      }}
    >

      {/* ── Left chat sidebar (glass) ── */}
      <div
        style={{
          width: 232, minWidth: 232, display: "flex", flexDirection: "column",
          background: "rgba(24,8,2,0.45)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          borderRight: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        {/* Logo + back to dashboard */}
        <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <Link to="/" className="flex items-center gap-2 mb-3">
            <GlisseoLogo size={22} />
            <span style={{ fontFamily: "'Fustat', sans-serif", fontWeight: 700, fontSize: "0.9rem", color: "#fff" }}>
              Glisseo<span style={{ color: "var(--brand-orange)" }}>.</span>AI
            </span>
          </Link>
          <Link
            to="/dashboard"
            className="flex items-center gap-2 text-[#a89088] hover:text-white transition-colors"
            style={{ fontSize: "0.72rem" }}
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Dashboard
          </Link>
        </div>

        {/* New Chat */}
        <div style={{ padding: "12px 12px 6px" }}>
          <button
            onClick={startNewChat}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl transition-colors"
            style={{
              fontSize: "0.75rem", color: "#e8e0da",
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.09)",
              backdropFilter: "blur(8px)",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(236,93,37,0.4)"; e.currentTarget.style.background = "rgba(236,93,37,0.08)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.09)"; e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
          >
            <PlusCircle className="w-3.5 h-3.5" />
            New Chat
          </button>
        </div>

        {/* Sessions list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 8px 12px" }}>
          {sessions.length > 0 && (
            <p style={{ fontSize: "0.6rem", color: "rgba(255,255,255,0.28)", fontWeight: 700, padding: "6px 6px 4px", textTransform: "uppercase", letterSpacing: "0.1em" }}>
              Recent
            </p>
          )}
          {sessions.map((s, i) => {
            const isActive = s.session_id === activeSessionId;
            const isRen = renamingId === s.session_id;
            const isMenu = menuOpenId === s.session_id;
            const label = s.chat_summary || `Chat ${sessions.length - i}`;
            return (
              <div
                key={s.session_id}
                className="group relative flex items-center gap-1 rounded-xl px-2.5 py-2 mb-1 cursor-pointer transition-colors"
                style={{
                  background: isActive ? "rgba(255,255,255,0.08)" : "transparent",
                  border: isActive ? "1px solid rgba(255,255,255,0.08)" : "1px solid transparent",
                }}
                onClick={() => !isRen && switchSession(s)}
              >
                {isRen ? (
                  <input
                    autoFocus
                    value={renamingValue}
                    onChange={(e) => setRenamingValue(e.target.value)}
                    onBlur={() => finishRename(s.session_id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") finishRename(s.session_id);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    className="flex-1 bg-white/10 border border-[var(--brand-orange)]/40 rounded px-2 py-0.5 text-white outline-none"
                    style={{ fontSize: "0.75rem" }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="flex-1 truncate"
                    style={{ fontSize: "0.75rem", color: isActive ? "#f0ece8" : "#8a7a70" }}
                  >
                    {label}
                  </span>
                )}

                {/* 3-dot button — shown on hover */}
                {!isRen && (
                  <button
                    className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 rounded text-[#8a7a70] hover:text-white transition-all"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isMenu) {
                        setMenuOpenId(null);
                        setMenuPos(null);
                      } else {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setMenuPos({ top: rect.top, left: rect.right + 6 });
                        setMenuOpenId(s.session_id);
                      }
                    }}
                  >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Main chat area (glass) ── */}
      <div
        className="flex flex-col flex-1 min-w-0"
        style={{ background: "rgba(13,2,0,0.35)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
      >

      {/* Header — floating pills */}
      <div className="px-6 py-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {showInProgress && (
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-full"
              style={{
                background: "rgba(236,93,37,0.10)", border: "1px solid rgba(236,93,37,0.22)", backdropFilter: "blur(8px)",
                opacity: inProgressFading ? 0 : 1,
                transition: "opacity 700ms cubic-bezier(0.4, 0, 0.2, 1)",
              }}
            >
              <div className="w-2 h-2 rounded-full bg-[var(--brand-orange)] animate-pulse" />
              <span style={{ fontSize: "0.7rem", fontWeight: 500, color: "var(--brand-orange)" }}>In Progress</span>
            </div>
          )}
          {isLive && (
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-full"
              style={{ background: "rgba(16,185,129,0.10)", border: "1px solid rgba(16,185,129,0.22)", backdropFilter: "blur(8px)" }}
            >
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-emerald-400" style={{ fontSize: "0.7rem", fontWeight: 500 }}>{totalCallsFetched} indexed</span>
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-8 py-2">
        {messages.length <= 1 && messages[0]?.id === "greeting-initial" ? (
          <div className="flex flex-col items-center justify-center h-full max-w-xl mx-auto text-center">
            {/* Glowing orb */}

            <h1 style={{ fontFamily: "'Fustat', sans-serif", fontSize: "1.2rem", fontWeight: 700, color: "#fff", margin: "0 0 12px" }}>
              Hi, I'm Glisseo
            </h1>
            <p className="text-[#c0b4ac]" style={{ fontSize: "0.65rem", lineHeight: "1.6", minHeight: "3.2rem" }}>
              {streamedDesc}
              {!streamingDone && (
                <span className="inline-block w-0.5 h-2.5 bg-[var(--brand-orange)] ml-0.5 align-middle animate-pulse" />
              )}
            </p>
            {streamingDone && isLive && (
              <p className="text-[#8a7a70] mt-1" style={{ fontSize: "0.35rem" }}>
                Currently indexing <span className="text-[var(--brand-orange)]">{totalCallsFetched} calls</span> — ready to explore.
              </p>
            )}
            {streamingDone && fetchProgress && <p style={{ fontSize: "0.52rem", color: "var(--brand-orange)" }}>{fetchProgress}</p>}

            {/* Suggested queries — progressive reveal after streaming */}
            {streamingDone && (
              <div className="mt-7 w-full">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 w-full">
                  {suggestedQueries.slice(0, visibleSuggestions).map((q) => (
                    <button
                      key={q}
                      onClick={() => setInput(q)}
                      className="text-left px-3.5 py-2.5 rounded-xl transition-all cursor-pointer"
                      style={{
                        fontSize: "0.66rem", color: "#c0b4ac",
                        background: "rgba(255,255,255,0.05)",
                        border: "1px solid rgba(255,255,255,0.08)",
                        backdropFilter: "blur(8px)",
                        animation: "fadeSlideIn 0.25s ease-out both",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(236,93,37,0.4)"; e.currentTarget.style.color = "#fff"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; e.currentTarget.style.color = "#c0b4ac"; }}
                    >
                      "{q}"
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="max-w-4xl mx-auto space-y-6">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                {msg.role === "assistant" && (
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-1 ${
                    msg.id.startsWith("blocked-")
                      ? "bg-gradient-to-br from-red-500/20 to-red-600/20 border border-red-500/30"
                      : "bg-gradient-to-br from-[#ec5d25] to-[#c4400e]"
                  }`}>
                    {msg.id.startsWith("blocked-")
                      ? <ShieldAlert className="w-4 h-4 text-red-400" />
                      : <Bot className="w-4 h-4 text-white" />
                    }
                  </div>
                )}
                <div className={`${msg.role === "user" ? "max-w-[70%] bg-[#d44a1a] rounded-2xl rounded-tr-sm px-4 py-3" : "max-w-[90%] space-y-3"}`}>
                  {msg.isSearching ? (
                    <div className="flex items-center gap-3 px-4 py-3 bg-app-card border border-[#1e1e2e] rounded-xl">
                      <div
                        className="w-6 h-6 rounded-full bg-gradient-to-br from-[var(--brand-orange)] to-[#c4400e] flex items-center justify-center shrink-0"
                        style={{ animation: "floatYIcon 1.5s ease-in-out infinite" }}
                      >
                        <Sparkles className="w-3.5 h-3.5 text-white" />
                      </div>
                      <span className="text-[#c0c0d0]" style={{ fontSize: "0.82rem" }}>{msg.searchProgress || "Thinking..."}</span>
                    </div>
                  ) : (
                    <>
                      {msg.plannerIntent && (
                        <AIUnderstandingPanel
                          plannerIntent={msg.plannerIntent}
                          topic={msg.plannerTopic}
                          scope={msg.plannerScope}
                          rewrittenQuery={msg.rewrittenQuery}
                          wasRewritten={msg.wasRewritten}
                        />
                      )}
                      <p
                        className={msg.role === "user" ? "text-white" : "text-[#e0e0ee]"}
                        style={{ fontSize: "0.85rem" }}
                      >
                        <span dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(msg.content) }} />
                        {msg.isStreaming && (
                          <span className="inline-block w-0.5 h-3.5 bg-[#ec5d25] ml-0.5 align-middle animate-pulse" />
                        )}
                      </p>

                      {msg.resultData && !msg.resultData.noResults && (
                        <div className="space-y-2">
                          {/* Evidence toggle button */}
                          <button
                            onClick={() => toggleEvidence(msg.id)}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-app-elevated border border-[#2a2a3e] text-[#8888a0] hover:border-[#ec5d25]/40 hover:text-[#c0c0d0] transition-all"
                            style={{ fontSize: "0.72rem" }}
                          >
                            {expandedEvidence.has(msg.id)
                              ? <><ChevronUp className="w-3.5 h-3.5" /> Hide Evidence</>
                              : <><ChevronDown className="w-3.5 h-3.5" /> Show Evidence</>}
                            {!expandedEvidence.has(msg.id) && (
                              <span className="ml-1 px-1.5 py-0.5 rounded bg-[#ec5d25]/15 text-[#f5a07a] border border-[#ec5d25]/20" style={{ fontSize: "0.62rem", fontWeight: 600 }}>
                                {evidenceSummary(msg.resultData)}
                              </span>
                            )}
                          </button>

                          {/* Collapsible evidence panel */}
                          {expandedEvidence.has(msg.id) && (
                            <div className="space-y-3 pt-1">
                              <ResultRenderer data={msg.resultData} />

                              {/* Grounding + actions */}
                              <div className="flex items-center justify-between pt-1">
                                <div className="flex items-center gap-2 text-emerald-400" style={{ fontSize: "0.65rem" }}>
                                  <Search className="w-3 h-3" />
                                  <span>Every claim backed by transcript evidence</span>
                                </div>
                                <div className="flex gap-2">
                                  <button onClick={() => handleCopy(JSON.stringify(msg.resultData, null, 2))} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-app-overlay text-[#8888a0] hover:text-white transition-colors" style={{ fontSize: "0.68rem" }}>
                                    <Copy className="w-3 h-3" /> Copy
                                  </button>
                                  <button onClick={() => handleExportCSV(msg.resultData!)} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-app-overlay text-[#8888a0] hover:text-white transition-colors" style={{ fontSize: "0.68rem" }}>
                                    <Download className="w-3 h-3" /> CSV
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Follow-up suggestions always visible */}
                          {msg.parsedQuery && (
                            <FollowUpSuggestions
                              suggestions={generateFollowUpSuggestions(msg.resultData, msg.parsedQuery)}
                              onSelect={(q) => { setInput(q); }}
                            />
                          )}
                        </div>
                      )}

                      {msg.resultData?.noResults && (
                        <div className="flex items-start gap-3 p-4 bg-amber-500/5 border border-amber-500/20 rounded-xl">
                          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                          <div>
                            <p className="text-amber-300" style={{ fontSize: "0.82rem", fontWeight: 500 }}>No transcript evidence found</p>
                            <p className="text-[#8888a0] mt-1" style={{ fontSize: "0.78rem" }}>
                              I searched through {msg.resultData.searchedCallCount} calls but couldn't find a match. Here are a few things you could try:
                            </p>
                            <ul className="text-[#8888a0] mt-2 space-y-1" style={{ fontSize: "0.75rem" }}>
                              <li className="flex items-center gap-1.5">• Use broader or alternative keywords</li>
                              <li className="flex items-center gap-1.5">• Expand the time range (e.g., "last 30 days")</li>
                              <li className="flex items-center gap-1.5">• Try a more general question like "what topics came up?"</li>
                            </ul>
                            <div className="flex flex-wrap gap-2 mt-3">
                              {["What are the top topics?", "Give me an overview of all my calls", "What were the main concerns in recent demos?"].map((s) => (
                                <button
                                  key={s}
                                  onClick={() => setInput(s)}
                                  className="px-2.5 py-1 rounded-lg bg-app-elevated border border-[#2a2a3e] text-[#c0c0d0] hover:border-amber-500/40 hover:text-white transition-all cursor-pointer"
                                  style={{ fontSize: "0.68rem" }}
                                >
                                  {s}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
                {msg.role === "user" && (
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0 mt-1">
                    <User className="w-4 h-4 text-white" />
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="px-8 py-5">
        <div className="max-w-3xl mx-auto">
          <div
            className="flex items-center gap-3 rounded-full px-5 py-3.5 transition-colors"
            style={{
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.10)",
              backdropFilter: "blur(16px)",
              WebkitBackdropFilter: "blur(16px)",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "rgba(236,93,37,0.45)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.10)"; }}
          >
            <Sparkles className="w-4 h-4 text-[var(--brand-orange)] shrink-0" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder="Ask Anything…"
              className="flex-1 bg-transparent border-none outline-none text-white placeholder-[#8a7a70]"
              style={{ fontSize: "0.85rem" }}
              disabled={isSearching}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || isSearching}
              className="w-9 h-9 rounded-full bg-[var(--brand-orange)] hover:bg-[#f07848] disabled:opacity-30 disabled:hover:bg-[var(--brand-orange)] flex items-center justify-center transition-colors shrink-0"
            >
              {isSearching ? <Loader2 className="w-4 h-4 text-white animate-spin" /> : <Send className="w-4 h-4 text-white" />}
            </button>
          </div>
          {isSearching && searchStatus && (
            <p className="text-center mt-2" style={{ fontSize: "0.68rem", color: "var(--brand-orange)" }}>{searchStatus}</p>
          )}
        </div>
      </div>

      </div>{/* end flex-col flex-1 main chat area */}

      {/* ── Session 3-dot dropdown — fixed, above everything ── */}
      {menuOpenId && menuPos && (() => {
        const s = sessions.find((x) => x.session_id === menuOpenId);
        if (!s) return null;
        return (
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              top: menuPos.top,
              left: menuPos.left,
              zIndex: 9999,
              background: "#13131f",
              border: "1px solid #2a2a3e",
              borderRadius: 8,
              padding: "4px 0",
              minWidth: 140,
              boxShadow: "0 8px 32px rgba(0,0,0,0.7)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-[#c0c0d0] hover:bg-[#1e1e2e] hover:text-white transition-colors"
              style={{ fontSize: "0.75rem" }}
              onClick={() => startRename(s)}
            >
              <Pencil className="w-3 h-3" /> Rename
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-[#c0c0d0] hover:bg-[#1e1e2e] hover:text-white transition-colors"
              style={{ fontSize: "0.75rem" }}
              onClick={() => copySession(s)}
            >
              <Copy className="w-3 h-3" /> Copy
            </button>
            <div style={{ borderTop: "1px solid #1e1e2e", margin: "2px 0" }} />
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors"
              style={{ fontSize: "0.75rem" }}
              onClick={() => {
                setMenuOpenId(null);
                setMenuPos(null);
                setDeleteConfirmId(s.session_id);
              }}
            >
              <Trash2 className="w-3 h-3" /> Delete
            </button>
          </div>
        );
      })()}

      {/* ── Delete confirmation modal ── */}
      {deleteConfirmId && (() => {
        const s = sessions.find((x) => x.session_id === deleteConfirmId);
        const label = s?.chat_summary || "this chat";
        return (
          <div
            style={{
              position: "fixed", inset: 0, zIndex: 10000,
              background: "rgba(0,0,0,0.6)",
              backdropFilter: "blur(4px)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
            onClick={() => setDeleteConfirmId(null)}
          >
            <div
              style={{
                background: "#13131f",
                border: "1px solid #2a2a3e",
                borderRadius: 12,
                padding: "28px 28px 22px",
                width: 340,
                boxShadow: "0 24px 64px rgba(0,0,0,0.8)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-3">
                <div style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.25)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Trash2 className="w-4 h-4 text-red-400" />
                </div>
                <p className="text-white" style={{ fontSize: "0.95rem", fontWeight: 600 }}>Delete chat?</p>
              </div>
              <p className="text-[#8888a0]" style={{ fontSize: "0.8rem", lineHeight: 1.6, marginBottom: 20 }}>
                "<span className="text-[#c0c0d0]">{label.length > 50 ? label.slice(0, 48) + "…" : label}</span>" will be permanently deleted and cannot be recovered.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setDeleteConfirmId(null)}
                  className="px-4 py-2 rounded-lg border border-[#2a2a3e] text-[#8888a0] hover:text-white hover:border-[#3a3a4e] transition-colors"
                  style={{ fontSize: "0.8rem" }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    const id = deleteConfirmId;
                    setDeleteConfirmId(null);
                    deleteSession(id);
                  }}
                  className="px-4 py-2 rounded-lg bg-red-500/90 hover:bg-red-500 text-white transition-colors"
                  style={{ fontSize: "0.8rem", fontWeight: 500 }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        );
      })()}

    </div>
    </div>
  );
}
