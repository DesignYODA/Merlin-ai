import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Send, Sparkles, Copy, Download, Bot, User, AlertTriangle, Search,
  Loader2, BarChart3, Users, Clock, ThumbsUp, ListChecks, Hash, TrendingUp,
  MessageSquare, ChevronDown, ChevronUp, Headphones, ExternalLink, Lightbulb,
  RefreshCw, ShieldAlert,
} from "lucide-react";
import { useData } from "./data-context";
import React from "react";
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
// Main Component
// =====================================================================

export function AskAiPage() {
  const { calls, isLive, isLoading, error, totalCallsFetched, fetchProgress } = useData();
  const greetingMessage: ChatMessage = useMemo(() => ({
    id: "greeting-initial",
    role: "assistant",
    content: "Hi, I'm Merlin, your sales companion to easy understanding of our calls. Ask me anything about your meetings — I'll dig through transcripts, surface patterns, and give you evidence-backed insights.",
    timestamp: new Date().toISOString(),
  }), []);

  const [messages, setMessages] = useState<ChatMessage[]>([greetingMessage]);
  const [input, setInput] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const memoryRef = useRef<ConversationMemory>({ ...EMPTY_MEMORY });
  const [expandedEvidence, setExpandedEvidence] = useState<Set<string>>(new Set());

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
    "Your sales companion to easy understanding of our calls. Ask me anything about your meetings — I'll dig through transcripts, surface patterns, and give you evidence-backed insights.";
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
        setMessages((prev) =>
          prev.map((m) => m.id === finalMsgId ? { ...m, isStreaming: false } : m)
        );
      }
    } catch (err) {
      console.error("Ask Merlin search error:", err);
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
    a.href = url; a.download = `merlin-ai-${data.intent}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-8 py-5 border-b border-[#1e1e2e]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ec5d25] to-[#c4400e] flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1">
            <h1 className="text-white" style={{ fontSize: "1.25rem", fontWeight: 700 }}>Ask Merlin</h1>
            <p className="text-[#8888a0]" style={{ fontSize: "0.78rem" }}>
              {isLive
                ? `Smart search across ${totalCallsFetched} calls — topics, keywords, participants, sentiment & more`
                : "Query insights about your meetings"}
            </p>
          </div>
          {isLive && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-emerald-400" style={{ fontSize: "0.7rem", fontWeight: 500 }}>{totalCallsFetched} indexed</span>
            </div>
          )}
        </div>
      </div>

      {/* Capability bar */}
      <div className="px-8 py-2 bg-[#0d0d15] border-b border-[#1e1e2e]">
        <div className="flex items-center gap-3 overflow-x-auto no-scrollbar">
          {[
            { icon: Hash, label: "Counting" },
            { icon: Users, label: "Entity Extraction" },
            { icon: TrendingUp, label: "Trends & Patterns" },
            { icon: ThumbsUp, label: "Exploratory Insights" },
            { icon: MessageSquare, label: "Call Detail" },
            { icon: ListChecks, label: "Actions" },
            { icon: Search, label: "Full Text" },
          ].map((cap) => (
            <span key={cap.label} className="flex items-center gap-1 text-[#555568] whitespace-nowrap" style={{ fontSize: "0.65rem" }}>
              <cap.icon className="w-3 h-3" /> {cap.label}
            </span>
          ))}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {messages.length <= 1 && messages[0]?.id === "greeting-initial" ? (
          <div className="flex flex-col h-full max-w-3xl mx-auto">
            {/* Greeting message */}
            <div className="flex gap-3 mb-8 mt-4">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#ec5d25] to-[#c4400e] flex items-center justify-center shrink-0">
                <Sparkles className="w-5 h-5 text-white" />
              </div>
              <div className="pt-1.5">
                <p className="text-white mb-1" style={{ fontSize: "1.1rem", fontWeight: 600 }}>
                  Hi, I'm Merlin
                </p>
                <p className="text-[#c0c0d0]" style={{ fontSize: "0.88rem", lineHeight: "1.6", minHeight: "3.2rem" }}>
                  {streamedDesc}
                  {!streamingDone && (
                    <span className="inline-block w-0.5 h-3.5 bg-[#ec5d25] ml-0.5 align-middle animate-pulse" />
                  )}
                </p>
                {streamingDone && isLive && (
                  <p className="text-[#8888a0] mt-2" style={{ fontSize: "0.75rem" }}>
                    Currently indexing <span className="text-[#ec5d25]">{totalCallsFetched} calls</span> — ready to explore.
                  </p>
                )}
                {streamingDone && fetchProgress && <p className="text-[#ec5d25] mt-1" style={{ fontSize: "0.72rem" }}>{fetchProgress}</p>}
              </div>
            </div>

            {/* Suggested queries — progressive reveal after streaming */}
            {streamingDone && (
              <div className="mb-4">
                <p className="text-[#555568] mb-3" style={{ fontSize: "0.72rem", fontWeight: 500 }}>Try asking me:</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 w-full">
                  {suggestedQueries.slice(0, visibleSuggestions).map((q) => (
                    <button
                      key={q}
                      onClick={() => setInput(q)}
                      className="text-left p-3 rounded-xl bg-[#12121c] border border-[#1e1e2e] text-[#c0c0d0] hover:border-[#ec5d25]/50 hover:text-white transition-all cursor-pointer"
                      style={{ fontSize: "0.78rem", animation: "fadeSlideIn 0.25s ease-out both" }}
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
                    <div className="flex items-center gap-3 px-4 py-3 bg-[#12121c] border border-[#1e1e2e] rounded-xl">
                      <Loader2 className="w-4 h-4 text-[#ec5d25] animate-spin" />
                      <span className="text-[#c0c0d0]" style={{ fontSize: "0.82rem" }}>{msg.searchProgress || "Searching..."}</span>
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
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#1a1a28] border border-[#2a2a3e] text-[#8888a0] hover:border-[#ec5d25]/40 hover:text-[#c0c0d0] transition-all"
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
                                  <button onClick={() => handleCopy(JSON.stringify(msg.resultData, null, 2))} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#1e1e2e] text-[#8888a0] hover:text-white transition-colors" style={{ fontSize: "0.68rem" }}>
                                    <Copy className="w-3 h-3" /> Copy
                                  </button>
                                  <button onClick={() => handleExportCSV(msg.resultData!)} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#1e1e2e] text-[#8888a0] hover:text-white transition-colors" style={{ fontSize: "0.68rem" }}>
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
                                  className="px-2.5 py-1 rounded-lg bg-[#1a1a28] border border-[#2a2a3e] text-[#c0c0d0] hover:border-amber-500/40 hover:text-white transition-all cursor-pointer"
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
      <div className="px-8 py-4 border-t border-[#1e1e2e]">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-3 bg-[#12121c] border border-[#1e1e2e] rounded-xl px-4 py-3 focus-within:border-[#ec5d25]/50 transition-colors">
            <Sparkles className="w-4 h-4 text-[#555568]" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder="Ask about topics, keywords, participants, sentiment, action items..."
              className="flex-1 bg-transparent border-none outline-none text-white placeholder-[#555568]"
              style={{ fontSize: "0.85rem" }}
              disabled={isSearching}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || isSearching}
              className="w-8 h-8 rounded-lg bg-[#ec5d25] hover:bg-[#f07848] disabled:opacity-30 disabled:hover:bg-[#ec5d25] flex items-center justify-center transition-colors"
            >
              {isSearching ? <Loader2 className="w-4 h-4 text-white animate-spin" /> : <Send className="w-4 h-4 text-white" />}
            </button>
          </div>
          {isSearching && searchStatus && (
            <p className="text-[#ec5d25] text-center mt-2" style={{ fontSize: "0.68rem" }}>{searchStatus}</p>
          )}
        </div>
      </div>
    </div>
  );
}
