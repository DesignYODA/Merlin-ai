import { useState } from "react";
import {
  Send, Sparkles, Copy, Download, Bot, User, AlertTriangle, Search,
  Loader2, BarChart3, Users, Clock, ThumbsUp, ListChecks, Hash, TrendingUp,
  MessageSquare, ChevronDown, ChevronUp, Headphones, ExternalLink, Lightbulb,
  RefreshCw, ShieldAlert,
} from "lucide-react";
import { type NormalizedCall } from "../src/app/components/data-context";
import { isAEEmail, AE_DOMAIN } from "../src/app/components/fireflies-api";
import React from "react";

const SERVER_BASE = import.meta.env.VITE_SQLITE_SERVER_BASE ?? "http://localhost:3001";

// =====================================================================
// AI Output Sanitization
// =====================================================================

// Strips any leaked HTML tags, CSS classes, and style attributes from AI-generated text.
function sanitizeAIContent(text: string): string {
  if (!text) return "";
  return text
    // Remove HTML tags (span, div, p, etc.) but keep their inner text
    .replace(/<\/?(span|div|p|br|strong|em|b|i|u|a|h[1-6]|ul|ol|li|table|tr|td|th|thead|tbody|code|pre)[^>]*>/gi, "")
    // Remove standalone class="..." attributes that leaked outside tags
    .replace(/class="[^"]*"/g, "")
    // Remove standalone style="..." attributes
    .replace(/style="[^"]*"/g, "")
    // Remove orphaned CSS class references like text-white"> or text-gray-500">
    .replace(/text-[a-z0-9[\]#()-]+"\s*>/g, "")
    // Remove orphaned closing angle brackets from stripped tags
    .replace(/^\s*"?\s*>/gm, "")
    // Clean up multiple consecutive spaces
    .replace(/ {2,}/g, " ")
    // Clean up multiple consecutive newlines (keep max 2)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Converts sanitized markdown to safe HTML for rendering.
// Handles **bold**, "quoted text", and newlines.
export function renderMarkdownSafe(raw: string): string {
  // Step 1: sanitize any leaked HTML/CSS from AI content
  let text = sanitizeAIContent(raw);

  // Step 2: escape HTML entities in the cleaned text to prevent injection
  text = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Step 3: apply markdown formatting (order matters — bold first, then quotes)
  text = text
    // Bold: **text**
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Quoted text: "text"
    .replace(/"([^"]+)"/g, '<em style="color:#a78bfa">"$1"</em>')
    // Newlines to <br>
    .replace(/\n/g, "<br>");

  return text;
}

// =====================================================================
// Input Guardrails — prompt injection, secrets, SQL injection detection
// =====================================================================

interface GuardrailResult {
  blocked: boolean;
  reason?: string;
  category?: "prompt_injection" | "secrets_probe" | "sql_injection" | "hidden_state" | "system_manipulation";
}

export function checkInputGuardrails(query: string): GuardrailResult {
  const lower = query.toLowerCase().trim();

  // 1. Prompt injection patterns — attempts to override system instructions
  const promptInjectionPatterns = [
    /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|directives?)/i,
    /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
    /forget\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
    /you\s+are\s+now\s+(a|an)\s+/i,
    /pretend\s+(you\s+are|to\s+be|you'?re)\s+/i,
    /act\s+as\s+(if\s+you\s+are|a|an)\s+/i,
    /new\s+(system\s+)?instructions?\s*[:=]/i,
    /system\s*[:=]\s*/i,
    /\[system\]/i,
    /\{system\}/i,
    /<<\s*system\s*>>/i,
    /override\s+(system|instructions?|rules?|guardrails?|safety|filters?)/i,
    /bypass\s+(system|instructions?|rules?|guardrails?|safety|filters?)/i,
    /jailbreak/i,
    /DAN\s+mode/i,
    /developer\s+mode/i,
    /do\s+anything\s+now/i,
    /ignore\s+safety/i,
    /you\s+must\s+(obey|comply|follow)\s+(my|these|the\s+following)/i,
  ];

  for (const pattern of promptInjectionPatterns) {
    if (pattern.test(query)) {
      return { blocked: true, reason: "This looks like a prompt injection attempt. I can only answer questions about your sales calls.", category: "prompt_injection" };
    }
  }

  // 2. Secrets / API key probing
  const secretsPatterns = [
    /\b(api[_\s]?key|secret[_\s]?key|access[_\s]?token|auth[_\s]?token|password|credentials?|private[_\s]?key)\b/i,
    /\b(supabase|fireflies|groq|openai)\s*(api|secret|key|token|url)/i,
    /\benv(ironment)?\s*var(iable)?s?\b/i,
    /\b(SUPABASE_|FIREFLIES_|GROQ_|OPENAI_)\w*KEY\b/i,
    /show\s+(me\s+)?(your|the)\s+(api|secret|key|token|password|credentials?|config)/i,
    /reveal\s+(your|the)\s+(api|secret|key|token|password|credentials?|config)/i,
    /what\s+(is|are)\s+(your|the)\s+(api|secret|key|token|password|credentials?)/i,
    /print\s+(your|the)\s+(api|secret|key|token|password|credentials?|config|env)/i,
    /leak\s+(your|the)\s+(api|secret|key|token|password|credentials?)/i,
    /dump\s+(your|the)\s+(api|secret|key|token|password|credentials?|config|env|database)/i,
  ];

  for (const pattern of secretsPatterns) {
    if (pattern.test(query)) {
      return { blocked: true, reason: "I can't share system credentials or API keys. I'm here to help you analyze your sales calls.", category: "secrets_probe" };
    }
  }

  // 3. SQL injection patterns
  const sqlPatterns = [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|UNION)\b\s+(ALL\s+)?)/i,
    /;\s*(DROP|DELETE|ALTER|TRUNCATE|INSERT|UPDATE)\s/i,
    /'\s*(OR|AND)\s+['"]\d*['"]\s*=\s*['"]\d*['"]/i,
    /'\s*(OR|AND)\s+\d+\s*=\s*\d+/i,
    /--\s*$/m,
    /\/\*.*\*\//,
    /\bUNION\s+(ALL\s+)?SELECT\b/i,
    /\bINTO\s+(OUTFILE|DUMPFILE)\b/i,
    /\bLOAD_FILE\b/i,
    /\bINFORMATION_SCHEMA\b/i,
    /\bsys\.(tables|columns|objects)\b/i,
  ];

  for (const pattern of sqlPatterns) {
    if (pattern.test(query)) {
      return { blocked: true, reason: "That looks like a database query. I only understand natural language questions about your sales calls.", category: "sql_injection" };
    }
  }

  // 4. Hidden state / internal system probing
  const hiddenStatePatterns = [
    /\b(internal\s+state|hidden\s+state|system\s+state|memory\s+state|context\s+window)\b/i,
    /\b(show|reveal|dump|print|display|output)\s+(your\s+)?(system\s+prompt|instructions?|training|model|weights|parameters|architecture)\b/i,
    /what\s+(is|are)\s+your\s+(system\s+prompt|instructions?|rules?|constraints?|training\s+data)\b/i,
    /\b(repeat|echo|recite)\s+(your\s+)?(system|initial|original)\s+(prompt|instructions?|message)\b/i,
    /\bsource\s+code\b/i,
    /\braw\s+(prompt|instructions?|system)\b/i,
  ];

  for (const pattern of hiddenStatePatterns) {
    if (pattern.test(query)) {
      return { blocked: true, reason: "I can't share details about my internal workings. Ask me anything about your sales calls instead!", category: "hidden_state" };
    }
  }

  return { blocked: false };
}

// =====================================================================
// Summary generator — creates 2-3 line conversational summary
// =====================================================================

export function generateResultSummary(result: ResultData, parsed: ParsedQuery): string {
  const tc = parsed.timeFilter ? ` in the ${parsed.timeFilter.label}` : "";
  
  if (result.noResults) {
    return `I searched across ${result.searchedCallCount} calls${tc} but couldn't find any transcript evidence matching your query. Try different keywords or a broader time range.`;
  }

  switch (result.intent) {
    case "topic_ranking": {
      const top = result.topTopics;
      if (top && top.length > 0) {
        const topNames = top.slice(0, 3).map(t => `"${t.topic}"`).join(", ");
        return `Across ${result.searchedCallCount} calls${tc}, the most discussed topics are ${topNames}. "${top[0].topic}" leads with ${top[0].count} mentions across ${top[0].callCount} calls${top[0].trend === "up" ? " and is trending upward" : ""}.`;
      }
      return `Analyzed ${result.searchedCallCount} calls${tc} for topic rankings.`;
    }
    case "topic_search":
    case "keyword_search":
    case "text_search": {
      const entity = result.queryEntity;
      const mentions = result.totalMentions || 0;
      const meetings = result.totalMeetings || 0;
      if (mentions > 0) {
        return `Found **${mentions} mention${mentions !== 1 ? "s" : ""}** of "${entity}" across **${meetings} call${meetings !== 1 ? "s" : ""}**${tc}. Evidence is pulled directly from transcripts and summaries — each snippet below is sourced from an actual recording.`;
      }
      return `Searched for "${entity}" across ${result.searchedCallCount} calls${tc}.`;
    }
    case "participant_query": {
      const allRanks = result.participantRankings || [];
      const aeCount = allRanks.filter(p => p.isAE).length;
      const extCount = allRanks.filter(p => !p.isAE).length;
      if (aeCount > 0) {
        const topAE = allRanks.filter(p => p.isAE)[0];
        return `Identified **${aeCount} AEs** and **${extCount} external participants** across ${result.searchedCallCount} calls${tc}. ${topAE ? `Most active: **${topAE.name}** with ${topAE.callCount} calls.` : ""}`;
      }
      return `Found **${allRanks.length} participants** across ${result.searchedCallCount} calls${tc}.`;
    }
    case "action_items": {
      const count = result.actionItems?.length || 0;
      const aboutStr = result.queryEntity ? ` related to "${result.queryEntity}"` : "";
      return `Pulled **${count} action item${count !== 1 ? "s" : ""}**${aboutStr}${tc}. Each item is linked back to its source meeting for traceability.`;
    }
    case "sentiment": {
      const s = result.sentiment;
      if (s) {
        const total = s.positive + s.neutral + s.negative;
        const posPct = total ? Math.round((s.positive / total) * 100) : 0;
        return `Sentiment across **${total} calls**${tc}: **${posPct}% positive** (${s.positive} positive, ${s.neutral} neutral, ${s.negative} negative). ${posPct >= 60 ? "Overall the tone is healthy." : posPct >= 40 ? "Mixed sentiment — worth investigating." : "Notable negative sentiment detected."}`;
      }
      return `Analyzed sentiment across ${result.searchedCallCount} calls${tc}.`;
    }
    case "duration": {
      const list = result.durationList;
      if (list && list.length > 0) {
        return `Ranked ${list.length} calls by duration${tc}. The longest was "${list[0].title}" at ${list[0].duration}, while the shortest was "${list[list.length - 1].title}" at ${list[list.length - 1].duration}.`;
      }
      return `Analyzed call durations across ${result.searchedCallCount} calls${tc}.`;
    }
    case "competitor": {
      const comps = result.competitorMentions;
      if (comps && comps.length > 0) {
        return `Found **${comps.length} competitor${comps.length !== 1 ? "s" : ""}** mentioned across your calls${tc}. **${comps[0].competitor}** was the most referenced, appearing in ${comps[0].callCount} call${comps[0].callCount !== 1 ? "s" : ""}.`;
      }
      return `No significant competitor mentions found${tc}.`;
    }
    case "general_overview": {
      const stats = result.overviewStats;
      if (stats) {
        return `Your call portfolio${tc}: **${stats.totalCalls} calls** totaling **${stats.totalDuration}** of recorded conversation with **${stats.uniqueParticipants} unique participants**. Average call length is ${stats.avgDuration}.`;
      }
      return `Overview of ${result.searchedCallCount} calls${tc}.`;
    }
    default:
      return `Searched across ${result.searchedCallCount} calls${tc}.`;
  }
}

// =====================================================================
// Exponential retry backoff for AI responses
// =====================================================================

export async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  validate: (result: T) => boolean,
  maxRetries = 3,
): Promise<{ result: T | null; error: string | null; retries: number }> {
  let lastError = "";
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await fn();
      if (validate(result)) {
        return { result, error: null, retries: attempt };
      }
      lastError = "Empty or invalid response from AI";
    } catch (err: any) {
      lastError = err?.message || String(err);
    }
    // Exponential backoff: 1s, 2s, 4s
    if (attempt < maxRetries - 1) {
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return { result: null, error: lastError, retries: maxRetries };
}

// =====================================================================
// Types
// =====================================================================

interface TranscriptSnippet {
  text: string;
  speakerName: string;
  matchHighlight: string;
  startTime?: number; // seconds into the call when this snippet occurs
}

interface GroundedMention {
  callId: string;
  callTitle: string;
  aeName: string;
  date: string;
  dateTimestamp: number;
  mentionCount: number;
  snippets: TranscriptSnippet[];
  source: "transcript" | "summary" | "keywords" | "action_items";
  recordingUrl?: string;
}

interface TopicRank {
  topic: string;
  count: number;
  callCount: number;
  trend: "up" | "down" | "stable";
  recentCallTitles: string[];
}

interface ParticipantRank {
  name: string;
  email: string;
  callCount: number;
  recentCalls: string[];
  isAE: boolean;
  lastActiveDate: string;
  lastActiveTimestamp: number;
}

interface ActionItemEntry {
  item: string;
  callTitle: string;
  callId: string;
  date: string;
  recordingUrl?: string;
}

interface SentimentData {
  positive: number;
  neutral: number;
  negative: number;
  calls: { title: string; sentiment: string; date: string; id: string; recordingUrl?: string }[];
}

interface DurationEntry {
  title: string;
  duration: string;
  durationSeconds: number;
  date: string;
  id: string;
  recordingUrl?: string;
}

type QueryIntent =
  | "topic_ranking"
  | "topic_search"
  | "keyword_search"
  | "participant_query"
  | "action_items"
  | "sentiment"
  | "duration"
  | "competitor"
  | "general_overview"
  | "summary"
  | "text_search";

// Query Planner intent types — classifies BEFORE retrieval
type PlannerIntent =
  | "SEARCH_QUERY"     // User wants to find mentions of a topic/keyword
  | "COUNT_QUERY"      // User wants totals or frequency
  | "TREND_QUERY"      // User wants patterns or top topics
  | "FOLLOW_UP"        // User is referring to a previous answer
  | "DRILL_DOWN"       // User wants deeper detail on previous results
  | "CORRECTION"      // User is questioning accuracy of previous answer
  | "COMPETITION";    //  User wants analysis on competition

// Conversation memory for follow-up context
export interface ConversationMemory {
  lastQueryTopic: string;
  lastParsedQuery: ParsedQuery | null;
  lastResultData: ResultData | null;
  lastRetrievedCallIds: string[];
  lastAnswer: string;
  turnCount: number;
  // Track last 5 conversation turns (Q&A pairs) for query rewrite context
  previousRawQueries: string[];
  // Paired response summaries — same index as previousRawQueries
  previousResponseSummaries: string[];
}

export const EMPTY_MEMORY: ConversationMemory = {
  lastQueryTopic: "",
  lastParsedQuery: null,
  lastResultData: null,
  lastRetrievedCallIds: [],
  lastAnswer: "",
  turnCount: 0,
  previousRawQueries: [],
  previousResponseSummaries: [],
};

// Sales Call Analyst response categories (Step 1 from system prompt)
type AnalystCategory =
  | "counting"          // "How many times was X mentioned?"
  | "entity_extraction" // "Who asked about X?"
  | "trend_pattern"     // "What capabilities were discussed most?"
  | "exploratory"       // "What were the main concerns?"
  | "specific_call";    // "What was discussed in the Acme demo?"

function classifyAnalystCategory(q: string, intent: QueryIntent): AnalystCategory {
  const lower = q.toLowerCase();

  // Counting / Quantitative
  if (
    /\b(how many|count|total|number of|how often|frequency|times)\b/i.test(lower) ||
    intent === "duration"
  ) return "counting";

  // Entity Extraction
  if (
    /\b(who|which\s+(clients?|companies|people|teams?))\b/i.test(lower) ||
    intent === "participant_query"
  ) return "entity_extraction";

  // Trend / Pattern
  if (
    /\b(most|trend|pattern|common|popular|frequent|ranking|top|main)\b/i.test(lower) ||
    intent === "topic_ranking" || intent === "competitor"
  ) return "trend_pattern";

  // Specific Call Detail
  if (
    /\b(in the|specific|particular|that call|the demo|the meeting)\b/i.test(lower) &&
    /\b(what|discuss|talk|ask|happen|cover)\b/i.test(lower)
  ) return "specific_call";

  // Exploratory / Insight
  if (
    intent === "general_overview" || intent === "sentiment" || intent === "action_items" ||
    /\b(concerns?|feedback|insights?|issues?|problems?|product|objections?|challenges?)\b/i.test(lower)
  ) return "exploratory";

  // Default based on intent
  if (intent === "text_search" || intent === "topic_search" || intent === "keyword_search") {
    if (/\b(how many|count|total)\b/i.test(lower)) return "counting";
    return "trend_pattern";
  }

  return "exploratory";
}

/** Fields shared by `executeSearch` and all search helpers; must include everything `ResultData` needs besides `intent` and branch-specific fields. */
type SearchResultBase = {
  searchedCallCount: number;
  queryEntity: string;
  timeFilter?: string;
  analystCategory: AnalystCategory;
};

export interface ResultData {
  intent: QueryIntent;
  analystCategory: AnalystCategory;
  searchedCallCount: number;
  queryEntity: string;
  timeFilter?: string;
  noResults: boolean;
  // text / topic search
  totalMentions?: number;
  totalMeetings?: number;
  mentions?: GroundedMention[];
  // topic rankings
  topicRankings?: TopicRank[];
  topTopics?: TopicRank[];
  // participants
  participantRankings?: ParticipantRank[];
  // action items
  actionItems?: ActionItemEntry[];
  // sentiment
  sentiment?: SentimentData;
  // duration
  durationList?: DurationEntry[];
  // competitor
  competitorMentions?: { competitor: string; callCount: number; callTitles: string[] }[];
  // overview stats
  overviewStats?: {
    totalCalls: number;
    totalDuration: string;
    avgDuration: string;
    topTopics: string[];
    uniqueParticipants: number;
    sentimentBreakdown: { positive: number; neutral: number; negative: number };
  };
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  isSearching?: boolean;
  searchProgress?: string;
  resultData?: ResultData;
  parsedQuery?: ParsedQuery;
  plannerIntent?: PlannerIntent;
  plannerTopic?: string;
  plannerScope?: string;
  rewrittenQuery?: string;
  wasRewritten?: boolean;
}

// =====================================================================
// Intent Detection — much smarter query parser
// =====================================================================

export interface ParsedQuery {
  intent: QueryIntent;
  entities: string[];
  timeFilter: { days: number; label: string } | null;
  rawQuery: string;
  sortOrder?: "asc" | "desc";
}

function detectIntent(q: string): QueryIntent {
  const lower = q.toLowerCase();

  // Topic ranking patterns
  if (
    /(?:top|most|popular|common|frequent|trending|rank|main)\s*(?:topics?|themes?|subjects?|keywords?)/i.test(lower) ||
    /(?:topics?|themes?|keywords?)\s*(?:rank|trend|most|top|common|popular|frequent)/i.test(lower) ||
    /what\s+(?:topics?|themes?|keywords?)\s+(?:are|were|come|came|appear)/i.test(lower) ||
    /(?:which|what)\s+(?:are|were)\s+(?:the\s+)?(?:most|top|main|common|popular)/i.test(lower) ||
    /(?:discussed|talked)\s+(?:most|the most)/i.test(lower) ||
    /trending/i.test(lower)
  ) {
    return "topic_ranking";
  }

  // Topic search — "calls about X", "meetings about Y", "which calls discussed X"
  if (
    /(?:calls?|meetings?)\s+(?:about|regarding|related\s+to|involving|on|discussing)/i.test(lower) ||
    /(?:which|what)\s+(?:calls?|meetings?)\s+(?:discussed|mentioned|covered|talked|had|involved|were\s+about)/i.test(lower) ||
    /(?:find|show|list)\s+(?:calls?|meetings?)\s+(?:about|with\s+topic|on)/i.test(lower) ||
    /(?:topic|keyword)\s*[:=]\s*/i.test(lower)
  ) {
    return "topic_search";
  }

  // Keyword search — "search for X in keywords", "keyword mentions"
  if (
    /(?:keyword|tag)\s+(?:mention|search|find|frequency|analysis)/i.test(lower) ||
    /(?:search|find|look)\s+(?:for\s+)?(?:keyword|tag)/i.test(lower)
  ) {
    return "keyword_search";
  }

  // Participant & AE queries
  if (
    /(?:who|which)\s+(?:participants?|people|attendees?|speakers?)/i.test(lower) ||
    /(?:participants?|attendees?|speakers?)\s+(?:most|rank|top|list|across)/i.test(lower) ||
    /(?:most\s+active|most\s+frequent)\s+(?:participants?|attendees?|speakers?|people|AEs?|reps?)/i.test(lower) ||
    /(?:calls?\s+with|meetings?\s+with)\s+\w/i.test(lower) ||
    /\b(AEs?|account\s+executives?|sales\s+reps?|reps?|itilite|team\s+members?|active\s+AEs?)\b/i.test(lower) ||
    /(?:who|which|list|show|give)\s+(?:me\s+)?(?:the\s+)?(?:\d+\s+)?(?:AEs?|account\s+executives?|reps?|sales)/i.test(lower)
  ) {
    return "participant_query";
  }

  // Action items
  if (
    /(?:action\s+items?|tasks?|to[\s-]?dos?|follow[\s-]?ups?|next\s+steps?|pending)/i.test(lower)
  ) {
    return "action_items";
  }

  // Sentiment
  if (
    /(?:sentiment|mood|tone|positive|negative|feeling|emotion)/i.test(lower) ||
    /(?:how\s+did|how\s+were)\s+(?:the\s+)?(?:calls?|meetings?)\s+(?:go|feel)/i.test(lower) ||
    /(?:good|bad|happy|unhappy)\s+(?:calls?|meetings?)/i.test(lower)
  ) {
    return "sentiment";
  }

  // Duration queries
  if (
    /(?:longest|shortest|duration|length|how\s+long)/i.test(lower) ||
    /(?:most|least)\s+(?:time|minutes|hours)/i.test(lower)
  ) {
    return "duration";
  }

  // Competitor mentions
  if (
    /(?:competitor|competition|gong|chorus|salesforce|hubspot|outreach|salesloft|clari|drift)/i.test(lower) &&
    /(?:mention|discuss|talked|brought|come|came)/i.test(lower)
  ) {
    return "competitor";
  }

  // General overview / recent / summary
  if (
    /(?:overview|summary|recap|dashboard|stats|statistics|general)/i.test(lower) ||
    /(?:give|show|tell)\s+(?:me\s+)?(?:an?\s+)?(?:overview|summary|recap)/i.test(lower) ||
    /(?:recent|latest)\s+(?:calls?|meetings?|activity)/i.test(lower) ||
    /(?:how\s+many|total)\s+(?:calls?|meetings?)/i.test(lower)
  ) {
    return "general_overview";
  }

  return "text_search";
}

export function parseQuery(query: string): ParsedQuery {
  const q = query.toLowerCase().trim();
  const intent = detectIntent(q);

  // Time filter detection
  let timeFilter: ParsedQuery["timeFilter"] = null;
  const timePatterns: [RegExp, number, string][] = [
    [/last\s+(\d+)\s+days?/i, 0, ""],
    [/last\s+week/i, 7, "last 7 days"],
    [/last\s+month/i, 30, "last 30 days"],
    [/last\s+(\d+)\s+weeks?/i, 0, ""],
    [/past\s+(\d+)\s+days?/i, 0, ""],
    [/today/i, 1, "today"],
    [/yesterday/i, 2, "last 2 days"],
    [/this\s+week/i, 7, "this week"],
    [/this\s+month/i, 30, "this month"],
    [/last\s+quarter/i, 90, "last quarter"],
    [/last\s+(\d+)\s+months?/i, 0, ""],
  ];

  for (const [pattern, defaultDays, label] of timePatterns) {
    const match = q.match(pattern);
    if (match) {
      let days = defaultDays;
      if (match[1]) {
        days = parseInt(match[1]);
        if (/weeks?/i.test(match[0])) days *= 7;
        if (/months?/i.test(match[0])) days *= 30;
      }
      timeFilter = { days, label: label || `last ${days} days` };
      break;
    }
  }

  // Sort order
  let sortOrder: "asc" | "desc" | undefined;
  if (/\b(least|fewest|lowest|shortest|smallest|bottom)\b/i.test(q)) sortOrder = "asc";
  if (/\b(most|top|highest|longest|largest|best)\b/i.test(q)) sortOrder = "desc";

  // Entity extraction — strip common stop words + instruction/follow-up words
  // need to update this to LLM based analysis -- probably groq based kimi
  const stopWords = new Set([
    "show", "me", "all", "my", "the", "in", "from", "about", "what", "which",
    "how", "many", "times", "was", "were", "are", "is", "had", "have", "did",
    "do", "last", "recent", "calls", "meetings", "mentioned", "discussed",
    "list", "give", "find", "search", "for", "with", "and", "or", "that",
    "this", "those", "these", "can", "you", "tell", "week", "month", "day",
    "days", "weeks", "months", "today", "yesterday", "past", "number", "count",
    "been", "being", "any", "of", "to", "a", "an", "it", "its", "has", "on",
    "at", "by", "not", "but", "if", "so", "no", "up", "out", "who", "when",
    "where", "why", "most", "top", "common", "popular", "frequent", "trending",
    "topics", "topic", "keywords", "keyword", "themes", "theme", "rank",
    "ranking", "participants", "participant", "attendees", "speakers",
    "action", "items", "tasks", "sentiment", "duration", "length",
    "longest", "shortest", "positive", "negative", "neutral", "overview",
    "summary", "recap", "stats", "statistics", "general", "go", "feel",
    "came", "come", "brought", "talked", "discussed", "covered",
    "regarding", "related", "involving", "often", "frequently",
    // Follow-up / instruction words — should NEVER be treated as search terms
    "recheck", "re-check", "verify", "revalidate", "re-validate",
    "again", "please", "explain", "elaborate", "clarify", "expand",
    "check", "look", "try", "also", "just", "could", "would", "should",
    "right", "wrong", "correct", "incorrect", "more", "less",
    "details", "detail", "deeper", "further", "continue",
    "evidence", "evidences", "shared", "showed", "found",
    "your", "answer", "response", "results", "result",
    "earlier", "before", "previous", "above", "back",
  ]);

  let cleanedQ = q.replace(/last\s+\d+\s+(days?|weeks?|months?)/gi, "");
  cleanedQ = cleanedQ.replace(/last\s+(week|month|quarter)/gi, "");
  cleanedQ = cleanedQ.replace(/this\s+(week|month)/gi, "");

  const entities = cleanedQ
    .split(/[\s,;?!.]+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .map((w) => w.replace(/['"]/g, ""));

  return {
    intent,
    entities: [...new Set(entities)],
    timeFilter,
    rawQuery: query,
    sortOrder,
  };
}

// =====================================================================
// Query Planner — Two-Agent System (Agent 1)
// Classifies prompt intent BEFORE any retrieval happens.
// Follow-up / correction / drill-down prompts should NOT trigger
// a new keyword search — they reuse previous context.
// =====================================================================

// Words that signal the user is NOT searching for new content
const PLANNER_FOLLOW_UP_SIGNALS = new Set([
  "recheck", "re-check", "revalidate", "re-validate", "verify",
  "again", "more", "elaborate", "explain", "clarify", "expand",
  "detail", "details", "deeper", "further", "continue",
  "same", "those", "these", "that", "them", "previous",
  "above", "earlier", "before", "prior", "back",
]);

const PLANNER_CORRECTION_SIGNALS = new Set([
  "wrong", "incorrect", "mistake", "error", "inaccurate",
  "doesn't look right", "not right", "doesn't seem right",
  "fix", "redo", "retry", "recount",
]);

const PLANNER_DRILL_DOWN_SIGNALS = new Set([
  "show", "full", "entire", "complete", "transcript",
  "snippet", "snippets", "evidence", "conversation",
  "context", "quote", "quotes",
]);

export function classifyPlannerIntent(query: string, memory: ConversationMemory): PlannerIntent {
  const lower = query.toLowerCase().trim();
  const words = lower.split(/\s+/);

  // No previous context → must be a new search
  if (memory.turnCount === 0 || !memory.lastResultData) {
    if (/\b(how many|count|total|number of|how often|frequency)\b/i.test(lower)) return "COUNT_QUERY";
    if (/\b(most|top|trend|pattern|common|popular|frequent|ranking)\b/i.test(lower)) return "TREND_QUERY";
    return "SEARCH_QUERY";
  }

  // Check for correction signals
  if (
    words.some((w) => PLANNER_CORRECTION_SIGNALS.has(w)) ||
    /doesn'?t\s+(look|seem)\s+right/i.test(lower) ||
    /that('?s| is)\s+(wrong|incorrect|not right)/i.test(lower) ||
    /\brecheck\s+(the\s+)?(calls?|data|results?|count)/i.test(lower)
  ) {
    return "CORRECTION";
  }

  // Check for follow-up signals (referring to previous answer)
  const followUpPatterns = [
    /^(can you|could you|please)\s+(recheck|verify|explain|elaborate|clarify|expand)/i,
    /^(recheck|verify|explain|elaborate|clarify|expand|show)\s+(the|that|those|this|more|again)/i,
    /\b(the evidence|the snippets?|the results?|the data|the answer|your (answer|response|findings?))\b/i,
    /\b(you (shared|showed|found|mentioned|said|gave))\b/i,
    /^(tell me more|go on|continue|and\??|what else)/i,
    /^(explain|elaborate|clarify)(\s+that|\s+more|\s+further)?\.?$/i,
    /^(show|give)\s+(me\s+)?(more|the)\s+(details?|evidence|snippets?|context)/i,
  ];

  if (followUpPatterns.some((p) => p.test(lower))) {
    return "FOLLOW_UP";
  }

  // If most words are follow-up signals and few are domain words
  const followUpWordCount = words.filter((w) => PLANNER_FOLLOW_UP_SIGNALS.has(w)).length;
  const totalMeaningfulWords = words.filter((w) => w.length > 2).length;
  if (totalMeaningfulWords > 0 && followUpWordCount / totalMeaningfulWords >= 0.6) {
    return "FOLLOW_UP";
  }

  // Check for drill-down: user asks for deeper detail on a previous result
  const drillDownPatterns = [
    /\bshow\s+(me\s+)?(the\s+)?(full|entire|complete)\s+(transcript|conversation|call|meeting)/i,
    /\bshow\s+(me\s+)?(the\s+)?snippet/i,
    /\b(from that (meeting|call|conversation))\b/i,
    /\bwhat (was|were) (said|discussed|talked|covered) in that\b/i,
  ];

  if (drillDownPatterns.some((p) => p.test(lower))) {
    return "DRILL_DOWN";
  }

  // Check for drill-down signal words with reference to previous context
  if (
    words.some((w) => PLANNER_DRILL_DOWN_SIGNALS.has(w)) &&
    /\b(that|those|the|from|of)\s+(call|meeting|result|conversation)\b/i.test(lower)
  ) {
    return "DRILL_DOWN";
  }

  // Otherwise it's a new search
  if (/\b(how many|count|total|number of|how often|frequency)\b/i.test(lower)) return "COUNT_QUERY";
  if (/\b(most|top|trend|pattern|common|popular|frequent|ranking)\b/i.test(lower)) return "TREND_QUERY";
  return "SEARCH_QUERY";
}

// Smart topic extraction — extracts meaningful multi-word phrases, NOT every word
export function extractCoreTopic(query: string, plannerIntent: PlannerIntent, memory: ConversationMemory): string[] {
  // For follow-ups and corrections, reuse the previous query's topic
  if (
    (plannerIntent === "FOLLOW_UP" || plannerIntent === "CORRECTION" || plannerIntent === "DRILL_DOWN") &&
    memory.lastParsedQuery
  ) {
    return memory.lastParsedQuery.entities.length > 0
      ? memory.lastParsedQuery.entities
      : memory.lastQueryTopic ? [memory.lastQueryTopic] : [];
  }

  const lower = query.toLowerCase().trim();

  // Extended stop words — includes action/instruction words that are NOT search terms
  const extendedStopWords = new Set([
    // Original stop words
    "show", "me", "all", "my", "the", "in", "from", "about", "what", "which",
    "how", "many", "times", "was", "were", "are", "is", "had", "have", "did",
    "do", "last", "recent", "calls", "meetings", "mentioned", "discussed",
    "list", "give", "find", "search", "for", "with", "and", "or", "that",
    "this", "those", "these", "can", "you", "tell", "week", "month", "day",
    "days", "weeks", "months", "today", "yesterday", "past", "number", "count",
    "been", "being", "any", "of", "to", "a", "an", "it", "its", "has", "on",
    "at", "by", "not", "but", "if", "so", "no", "up", "out", "who", "when",
    "where", "why", "most", "top", "common", "popular", "frequent", "trending",
    "topics", "topic", "keywords", "keyword", "themes", "theme", "rank",
    "ranking", "participants", "participant", "attendees", "speakers",
    "action", "items", "tasks", "sentiment", "duration", "length",
    "longest", "shortest", "positive", "negative", "neutral", "overview",
    "summary", "recap", "stats", "statistics", "general", "go", "feel",
    "came", "come", "brought", "talked", "discussed", "covered",
    "regarding", "related", "involving", "often", "frequently",
    // Follow-up / instruction words (should NEVER be search terms)
    "recheck", "re-check", "verify", "revalidate", "re-validate",
    "again", "please", "explain", "elaborate", "clarify", "expand",
    "check", "look", "try", "also", "just", "could", "would", "should",
    "right", "wrong", "correct", "incorrect", "more", "less",
    "details", "detail", "deeper", "further", "continue",
    "evidence", "evidences", "shared", "showed", "found",
    "your", "answer", "response", "results", "result",
    "earlier", "before", "previous", "above", "back",
  ]);

  // Try to extract quoted phrases first
  const quotedPhrases: string[] = [];
  const quoteMatches = query.match(/["']([^"']+)["']/g);
  if (quoteMatches) {
    for (const m of quoteMatches) {
      const phrase = m.replace(/["']/g, "").trim();
      if (phrase.length > 1) quotedPhrases.push(phrase.toLowerCase());
    }
    if (quotedPhrases.length > 0) return quotedPhrases;
  }

  // Try to extract multi-word domain phrases using patterns
  const phrasePatterns = [
    /(?:about|regarding|related to|involving|on|for|of)\s+(.+?)(?:\s+(?:in|from|during|across|over|last|this|was|were|are|is)\b|[?.,!]|$)/gi,
    /(?:mentioned|discussed|covered|talked about|asked about)\s+(.+?)(?:\s+(?:in|from|during|across|over|last|this)\b|[?.,!]|$)/gi,
    /(?:where|when)\s+(?:was|were|is|are)\s+(.+?)(?:\s+(?:discussed|mentioned|covered|talked|brought)\b|[?.,!]|$)/gi,
  ];

  for (const pattern of phrasePatterns) {
    const match = pattern.exec(lower);
    if (match && match[1]) {
      const phrase = match[1].trim().replace(/\b(the|a|an)\b/gi, "").trim();
      if (phrase.length > 2 && !extendedStopWords.has(phrase)) {
        // Split multi-word into separate entities if very long
        if (phrase.split(/\s+/).length <= 4) {
          return [phrase];
        }
      }
    }
  }

  // Fallback: extract individual meaningful words
  let cleanedQ = lower.replace(/last\s+\d+\s+(days?|weeks?|months?)/gi, "");
  cleanedQ = cleanedQ.replace(/last\s+(week|month|quarter)/gi, "");
  cleanedQ = cleanedQ.replace(/this\s+(week|month)/gi, "");

  const entities = cleanedQ
    .split(/[\s,;?!.]+/)
    .filter((w) => w.length > 2 && !extendedStopWords.has(w))
    .map((w) => w.replace(/['"]/g, ""));

  return [...new Set(entities)];
}

// =====================================================================
// Query Rewrite via Groq LLM
// =====================================================================

// Build a short summary of the last response for rewrite context
function buildResponseSummary(memory: ConversationMemory): string {
  if (!memory.lastResultData) return "";
  const r = memory.lastResultData;
  const parts: string[] = [];

  if (r.queryEntity) parts.push(`Topic searched: "${r.queryEntity}"`);
  if (r.totalMentions !== undefined) parts.push(`Found ${r.totalMentions} mentions across ${r.totalMeetings || 0} meetings`);
  if (r.topicRankings && r.topicRankings.length > 0) {
    parts.push(`Top topics: ${r.topicRankings.slice(0, 5).map(t => t.topic).join(", ")}`);
  }
  if (r.participantRankings && r.participantRankings.length > 0) {
    parts.push(`Participants found: ${r.participantRankings.slice(0, 5).map(p => p.name).join(", ")}`);
  }
  if (r.actionItems && r.actionItems.length > 0) {
    parts.push(`${r.actionItems.length} action items found`);
  }
  if (r.sentiment) {
    parts.push(`Sentiment: ${r.sentiment.positive} positive, ${r.sentiment.neutral} neutral, ${r.sentiment.negative} negative`);
  }
  if (r.mentions && r.mentions.length > 0) {
    parts.push(`Matching calls: ${r.mentions.slice(0, 5).map(m => m.callTitle).join(", ")}`);
  }
  if (r.overviewStats) {
    parts.push(`Overview: ${r.overviewStats.totalCalls} total calls, top topics: ${r.overviewStats.topTopics.join(", ")}`);
  }

  return parts.join(". ");
}

// Detect if a query likely needs rewriting (has ambiguous references)
export function queryNeedsRewrite(query: string, memory: ConversationMemory): boolean {
  if (memory.turnCount === 0 || !memory.lastResultData) return false;
  const lower = query.toLowerCase();
  // Check for pronouns / vague references / demonstratives
  const ambiguousPatterns = [
    /\b(these|them|those|they|their|its?|this)\b/,
    /\b(the same|that topic|the ones|the results?|the calls?|the meetings?)\b/,
    /\b(above|earlier|previous|mentioned|said)\b/,
    /\b(more about|tell me more|dig deeper|what about)\b/,
    /\b(also|and what|how about)\b/,
    // "that" as demonstrative — "what about that?", "expand on that", "show me that"
    /\b(about that|on that|for that|of that|like that|with that)\b/,
    // "the first one", "the second", "the top one" — ordinal references
    /\b(the (first|second|third|last|top|bottom) (one|topic|item|call|result))\b/,
    // Bare follow-ups that imply continuation — "and?", "why?", "when?"
    /^(and|but|why|when|where|who|which)\??$/,
    // "there" references — "how many were there?", "what was discussed there?"
    /\b(in there|from there|over there|discussed there)\b/,
    // "here" as reference — "show me everything here"
    /\b(right here|show here)\b/,
  ];
  return ambiguousPatterns.some(p => p.test(lower));
}

export async function rewriteQueryViaGroq(
  currentQuery: string,
  memory: ConversationMemory,
): Promise<{ rewrittenQuery: string; wasRewritten: boolean; retryInfo?: string }> {
  // Build full conversation history as Q&A pairs (up to last 5 turns)
  const conversationHistory: { query: string; responseSummary: string }[] = [];
  const maxTurns = Math.min(memory.previousRawQueries.length, 5);
  for (let i = maxTurns - 1; i >= 0; i--) {
    conversationHistory.push({
      query: memory.previousRawQueries[i] || "",
      responseSummary: memory.previousResponseSummaries[i] || "",
    });
  }

  const doFetch = async () => {
    const response = await fetch(`${SERVER_BASE}/rewrite-query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        currentQuery,
        previousResponseSummary: buildResponseSummary(memory),
        previousQueries: memory.previousRawQueries.slice(0, 5),
        conversationHistory,
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return response.json();
  };

  const { result, error, retries } = await fetchWithRetry(
    doFetch,
    (data: any) => {
      // Validate: must have a non-empty rewrittenQuery
      return !!(data?.rewrittenQuery && typeof data.rewrittenQuery === "string" && data.rewrittenQuery.trim().length > 0);
    },
    3,
  );

  if (result) {
    return {
      rewrittenQuery: result.rewrittenQuery || currentQuery,
      wasRewritten: result.wasRewritten || false,
      retryInfo: retries > 0 ? `Succeeded after ${retries} retries` : undefined,
    };
  }

  console.warn(`Query rewrite failed after 3 retries: ${error}`);
  return { rewrittenQuery: currentQuery, wasRewritten: false };
}

// Apply time filter override from query (e.g., "last 5 calls" → slice)
export function extractCallCountFilter(query: string): number | null {
  const match = query.match(/\b(?:last|recent|past|first|top)\s+(\d+)\s+(?:calls?|meetings?)\b/i);
  if (match) return parseInt(match[1]);
  return null;
}

// =====================================================================
// Search Engine — intent-aware
// =====================================================================

function filterByTime(calls: NormalizedCall[], days: number): NormalizedCall[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return calls.filter((c) => c.dateTimestamp >= cutoff);
}

function safeArray(val: unknown): string[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string" && val.trim()) return [val];
  return [];
}

// Build aggregated topic index
function buildTopicIndex(calls: NormalizedCall[]): Map<string, { count: number; callIds: Set<string>; recentTitles: string[] }> {
  const index = new Map<string, { count: number; callIds: Set<string>; recentTitles: string[] }>();

  for (const call of calls) {
    const topics = safeArray(call.topics);
    const rawKeywords = safeArray(call.raw?.summary?.keywords);
    const allKeywords = [...topics, ...rawKeywords];

    const seen = new Set<string>();
    for (const kw of allKeywords) {
      if (!kw || typeof kw !== "string") continue;
      const key = kw.trim().toLowerCase();
      if (!key || key.length < 2 || seen.has(key)) continue;
      seen.add(key);

      const entry = index.get(key) || { count: 0, callIds: new Set(), recentTitles: [] };
      entry.count++;
      entry.callIds.add(call.id);
      if (entry.recentTitles.length < 3 && !entry.recentTitles.includes(call.title)) {
        entry.recentTitles.push(call.title);
      }
      index.set(key, entry);
    }
  }

  return index;
}

// Try to find a sentence with timestamp matching the search term from raw sentences data
function findSentenceWithTimestamp(call: NormalizedCall, term: string): TranscriptSnippet | null {
  const sentences = call.raw?.sentences;
  if (!sentences || !Array.isArray(sentences)) return null;
  const termLower = term.toLowerCase();
  for (const sentence of sentences) {
    if (sentence.text && sentence.text.toLowerCase().includes(termLower)) {
      return {
        text: sentence.text,
        speakerName: sentence.speaker_name || "",
        matchHighlight: term,
        startTime: sentence.start_time,
      };
    }
  }
  return null;
}

function getSearchableText(call: NormalizedCall): string {
  const parts: string[] = [];
  try {
    if (call.aiSummary) parts.push(call.aiSummary);
    if (call.transcript) parts.push(call.transcript);
    // CRITICAL RULE: Never infer information from meeting titles alone — title excluded
    if (Array.isArray(call.topics) && call.topics.length) parts.push(call.topics.join(" "));
    if (Array.isArray(call.actionItems) && call.actionItems.length) parts.push(call.actionItems.join(" "));
    if (Array.isArray(call.outline) && call.outline.length) parts.push(call.outline.join(" "));
    if (Array.isArray(call.participants) && call.participants.length) parts.push(call.participants.join(" "));
    const raw = call.raw?.summary;
    if (raw) {
      if (typeof raw.overview === "string" && raw.overview) parts.push(raw.overview);
      if (typeof raw.short_summary === "string" && raw.short_summary) parts.push(raw.short_summary);
      if (Array.isArray(raw.bullet_gist)) parts.push(raw.bullet_gist.join(" "));
      else if (typeof raw.bullet_gist === "string" && raw.bullet_gist) parts.push(raw.bullet_gist);
      if (Array.isArray(raw.shorthand_bullet)) parts.push(raw.shorthand_bullet.join(" "));
    }
  } catch (e) {
    console.warn("Error building searchable text for call", call.id, e);
  }
  return parts.join("\n");
}

function extractSnippet(text: string, term: string, contextChars = 200): string {
  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  const idx = lowerText.indexOf(lowerTerm);
  if (idx === -1) return "";
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + term.length + contextChars);
  let snippet = "";
  if (start > 0) snippet += "...";
  snippet += text.slice(start, end);
  if (end < text.length) snippet += "...";
  return snippet;
}

function countOccurrences(text: string, term: string): number {
  const lt = text.toLowerCase();
  const tt = term.toLowerCase();
  let count = 0, pos = 0;
  while ((pos = lt.indexOf(tt, pos)) !== -1) { count++; pos += tt.length; }
  return count;
}

function formatTimestamp(seconds?: number): string {
  if (seconds === undefined || seconds === null || seconds < 0) return "";
  const totalSec = Math.round(seconds);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildFirefliesTimestampUrl(callId: string, seconds?: number): string | null {
  if (!callId) return null;
  const base = `https://app.fireflies.ai/view/${callId}`;
  if (seconds !== undefined && seconds >= 0) {
    return `${base}?t=${Math.floor(seconds)}`;
  }
  return base;
}

function parseDurationToSeconds(dur: string): number {
  const hMatch = dur.match(/(\d+)h/);
  const mMatch = dur.match(/(\d+)\s*m/);
  return (hMatch ? parseInt(hMatch[1]) * 3600 : 0) + (mMatch ? parseInt(mMatch[1]) * 60 : 0);
}

// ---- Main search dispatcher ----

export function executeSearch(calls: NormalizedCall[], parsed: ParsedQuery): ResultData {
  let filtered = calls;
  if (parsed.timeFilter) {
    filtered = filterByTime(calls, parsed.timeFilter.days);
  }
  const analystCategory = classifyAnalystCategory(parsed.rawQuery, parsed.intent);
  const base = {
    searchedCallCount: filtered.length,
    queryEntity: parsed.entities.join(" "),
    timeFilter: parsed.timeFilter?.label,
    analystCategory,
  };

  try {
    switch (parsed.intent) {
      case "topic_ranking":
        return searchTopicRanking(filtered, parsed, base);
      case "topic_search":
      case "keyword_search":
        return searchTopicOrKeyword(filtered, parsed, base);
      case "participant_query":
        return searchParticipants(filtered, parsed, base);
      case "action_items":
        return searchActionItems(filtered, parsed, base);
      case "sentiment":
        return searchSentiment(filtered, parsed, base);
      case "duration":
        return searchDuration(filtered, parsed, base);
      case "competitor":
        return searchCompetitor(filtered, parsed, base);
      case "general_overview":
        return searchOverview(filtered, parsed, base);
      case "text_search":
      default:
        return searchText(filtered, parsed, base);
    }
  } catch (err) {
    console.error("Search execution error:", err);
    return { ...base, intent: parsed.intent, noResults: true };
  }
}

// ---- Topic Ranking ----
function searchTopicRanking(
  calls: NormalizedCall[],
  parsed: ParsedQuery,
  base: SearchResultBase
): ResultData {
  const index = buildTopicIndex(calls);

  // Determine trend by comparing recent half vs older half
  const midpoint = calls.length > 1 ? Math.floor(calls.length / 2) : 0;
  const recentCalls = new Set(calls.slice(0, midpoint).map((c) => c.id));

  const rankings: TopicRank[] = [];
  for (const [topic, data] of index.entries()) {
    const recentCount = [...data.callIds].filter((id) => recentCalls.has(id)).length;
    const olderCount = data.callIds.size - recentCount;
    const trend: "up" | "down" | "stable" =
      recentCount > olderCount ? "up" : recentCount < olderCount ? "down" : "stable";
    rankings.push({
      topic,
      count: data.count,
      callCount: data.callIds.size,
      trend,
      recentCallTitles: data.recentTitles,
    });
  }

  const order = parsed.sortOrder === "asc" ? 1 : -1;
  rankings.sort((a, b) => (b.count - a.count) * order);

  // Filter by entity if user asked "top topics about X"
  let finalRankings = rankings;
  if (parsed.entities.length > 0) {
    finalRankings = rankings.filter((r) =>
      parsed.entities.some((e) => r.topic.includes(e.toLowerCase()))
    );
    if (finalRankings.length === 0) finalRankings = rankings; // fallback to all
  }

  return {
    ...base,
    intent: "topic_ranking",
    noResults: finalRankings.length === 0,
    topicRankings: finalRankings, // Keep ALL topic rankings
    topTopics: finalRankings.slice(0, 5),
  };
}

// ---- Topic / Keyword Search ----
function searchTopicOrKeyword(
  calls: NormalizedCall[],
  parsed: ParsedQuery,
  base: SearchResultBase
): ResultData {
  const entities = parsed.entities;
  if (entities.length === 0) {
    // Fallback to topic ranking
    return searchTopicRanking(calls, parsed, base);
  }

  // Find calls whose topics/keywords match any entity
  const matchedCalls: GroundedMention[] = [];

  for (const call of calls) {
    const allKeywords = [
      ...safeArray(call.topics),
      ...safeArray(call.raw?.summary?.keywords),
    ].map((k) => (typeof k === "string" ? k.toLowerCase() : ""));

    let matched = false;
    let mentionCount = 0;
    const snippets: TranscriptSnippet[] = [];

    for (const entity of entities) {
      const eLower = entity.toLowerCase();
      // Check topic/keyword match
      const topicMatch = allKeywords.some((k) => k.includes(eLower));
      if (topicMatch) {
        matched = true;
        mentionCount++;
        // Try sentence-level match first (has timestamps)
        const sentenceMatch = findSentenceWithTimestamp(call, entity);
        if (sentenceMatch) {
          snippets.push(sentenceMatch);
        } else {
          // Get context from summary
          const snippet = extractSnippet(call.aiSummary || "", entity) ||
                          extractSnippet(call.transcript || "", entity) ||
                          call.aiSummary.slice(0, 180);
          snippets.push({ text: snippet, speakerName: "", matchHighlight: entity });
        }
      }
      // Also count in full text
      const fullText = getSearchableText(call);
      const count = countOccurrences(fullText, entity);
      if (count > 0 && !matched) {
        matched = true;
        mentionCount += count;
        const sentenceMatch2 = findSentenceWithTimestamp(call, entity);
        if (sentenceMatch2) {
          snippets.push(sentenceMatch2);
        } else {
          const snippet = extractSnippet(fullText, entity);
          if (snippet) snippets.push({ text: snippet, speakerName: "", matchHighlight: entity });
        }
      } else {
        mentionCount += count;
      }
    }

    // CRITICAL RULE: Only include results with transcript/summary evidence (snippets)
    if (matched && snippets.length > 0) {
      matchedCalls.push({
        callId: call.id,
        callTitle: call.title,
        aeName: call.aeName,
        date: call.date,
        dateTimestamp: call.dateTimestamp,
        mentionCount,
        snippets, // Keep ALL snippets — do not truncate during processing
        source: "keywords",
        recordingUrl: call.recordingUrl,
      });
    }
  }

  matchedCalls.sort((a, b) => b.mentionCount - a.mentionCount);

  return {
    ...base,
    intent: "topic_search",
    noResults: matchedCalls.length === 0,
    totalMentions: matchedCalls.reduce((s, m) => s + m.mentionCount, 0),
    totalMeetings: matchedCalls.length,
    mentions: matchedCalls, // Keep ALL matched calls — do not truncate during processing
  };
}

// ---- Participants ----
function searchParticipants(
  calls: NormalizedCall[],
  parsed: ParsedQuery,
  base: SearchResultBase
): ResultData {
  const participantMap = new Map<string, { count: number; calls: string[]; email: string; isAE: boolean; lastDate: string; lastTimestamp: number }>();

  // Determine if user is asking specifically for AEs
  const wantsAEOnly = /\b(AEs?|account\s+executives?|sales\s+reps?|reps?|itilite|team\s+members?|active\s+AEs?)\b/i.test(parsed.rawQuery);

  for (const call of calls) {
    const parts = safeArray(call.participants);
    for (const p of parts) {
      if (!p || typeof p !== "string") continue;
      const trimmed = p.trim();
      const key = trimmed.toLowerCase();
      if (!key || key.length < 2) continue;

      const ae = isAEEmail(trimmed);
      // Extract display name from email
      const displayName = trimmed.includes("@")
        ? trimmed.split("@")[0].replace(/[._-]/g, " ").split(" ").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
        : trimmed;

      const entry = participantMap.get(key) || { count: 0, calls: [], email: trimmed, isAE: ae, lastDate: call.date, lastTimestamp: call.dateTimestamp };
      entry.count++;
      if (entry.calls.length < 5) entry.calls.push(call.title);
      // Track most recent activity
      if (call.dateTimestamp > entry.lastTimestamp) {
        entry.lastDate = call.date;
        entry.lastTimestamp = call.dateTimestamp;
      }
      participantMap.set(key, entry);
    }
  }

  let rankings: ParticipantRank[] = [...participantMap.entries()]
    .map(([_key, data]) => {
      const displayName = data.email.includes("@")
        ? data.email.split("@")[0].replace(/[._-]/g, " ").split(" ").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
        : data.email;
      return {
        name: displayName,
        email: data.email,
        callCount: data.count,
        recentCalls: data.calls,
        isAE: data.isAE,
        lastActiveDate: data.lastDate,
        lastActiveTimestamp: data.lastTimestamp,
      };
    })
    .sort((a, b) => b.callCount - a.callCount);

  // If user specifically asked for AEs, filter to itilite.com only
  if (wantsAEOnly) {
    rankings = rankings.filter((r) => r.isAE);
  }

  // Filter by entity if searching for specific participant
  if (parsed.entities.length > 0 && !wantsAEOnly) {
    const filtered = rankings.filter((r) =>
      parsed.entities.some((e) => r.name.toLowerCase().includes(e.toLowerCase()) || r.email.toLowerCase().includes(e.toLowerCase()))
    );
    if (filtered.length > 0) rankings = filtered;
  }

  // Extract requested count from query (e.g., "15 AEs", "top 10 reps")
  const countMatch = parsed.rawQuery.match(/\b(\d+)\s*(?:AEs?|reps?|participants?|people|members?)/i) ||
                     parsed.rawQuery.match(/(?:top|first|show)\s+(\d+)/i);
  const requestedCount = countMatch ? parseInt(countMatch[1]) : 20;

  return {
    ...base,
    intent: "participant_query",
    noResults: rankings.length === 0,
    participantRankings: rankings.slice(0, requestedCount),
  };
}

// ---- Action Items ----
function searchActionItems(
  calls: NormalizedCall[],
  parsed: ParsedQuery,
  base: SearchResultBase
): ResultData {
  const items: ActionItemEntry[] = [];

  for (const call of calls) {
    const ai = safeArray(call.actionItems);
    for (const item of ai) {
      if (!item || typeof item !== "string" || item.trim().length < 5) continue;
      // Filter by entity if present
      if (parsed.entities.length > 0) {
        const itemLower = item.toLowerCase();
        if (!parsed.entities.some((e) => itemLower.includes(e.toLowerCase()))) continue;
      }
      items.push({ item: item.trim(), callTitle: call.title, callId: call.id, date: call.date, recordingUrl: call.recordingUrl });
    }
  }

  return {
    ...base,
    intent: "action_items",
    noResults: items.length === 0,
    actionItems: items, // Keep ALL action items — do not truncate
  };
}

// ---- Sentiment ----
function searchSentiment(
  calls: NormalizedCall[],
  parsed: ParsedQuery,
  base: SearchResultBase
): ResultData {
  let pos = 0, neu = 0, neg = 0;
  const sentimentCalls: SentimentData["calls"] = [];

  for (const call of calls) {
    if (call.sentiment === "positive") pos++;
    else if (call.sentiment === "negative") neg++;
    else neu++;
    sentimentCalls.push({ title: call.title, sentiment: call.sentiment, date: call.date, id: call.id, recordingUrl: call.recordingUrl });
  }

  // If user asks specifically for "positive" or "negative" calls, filter
  const entityStr = parsed.entities.join(" ").toLowerCase();
  let filteredCalls = sentimentCalls;
  if (entityStr.includes("positive") || entityStr.includes("good") || entityStr.includes("happy")) {
    filteredCalls = sentimentCalls.filter((c) => c.sentiment === "positive");
  } else if (entityStr.includes("negative") || entityStr.includes("bad") || entityStr.includes("unhappy")) {
    filteredCalls = sentimentCalls.filter((c) => c.sentiment === "negative");
  }

  return {
    ...base,
    intent: "sentiment",
    noResults: calls.length === 0,
    sentiment: { positive: pos, neutral: neu, negative: neg, calls: filteredCalls }, // Keep ALL sentiment calls
  };
}

// ---- Duration ----
function searchDuration(
  calls: NormalizedCall[],
  parsed: ParsedQuery,
  base: SearchResultBase
): ResultData {
  const list: DurationEntry[] = calls.map((c) => ({
    title: c.title,
    duration: c.duration,
    durationSeconds: parseDurationToSeconds(c.duration),
    date: c.date,
    id: c.id,
    recordingUrl: c.recordingUrl,
  }));

  const order = parsed.sortOrder === "asc" || /shortest|least/i.test(parsed.rawQuery) ? 1 : -1;
  list.sort((a, b) => (b.durationSeconds - a.durationSeconds) * order);

  return {
    ...base,
    intent: "duration",
    noResults: list.length === 0,
    durationList: list, // Keep ALL duration entries
  };
}

// ---- Competitor ----
function searchCompetitor(
  calls: NormalizedCall[],
  parsed: ParsedQuery,
  base: SearchResultBase
): ResultData {
  const competitors = ["Gong", "Chorus", "Salesforce", "HubSpot", "Zoom", "Teams", "Outreach", "SalesLoft", "Clari", "Drift"];
  const compMap = new Map<string, Set<string>>();

  for (const call of calls) {
    const mentioned = safeArray(call.competitorsMentioned);
    for (const comp of mentioned) {
      if (!compMap.has(comp)) compMap.set(comp, new Set());
      compMap.get(comp)!.add(call.title);
    }
    // Also search text for competitors
    const text = getSearchableText(call).toLowerCase();
    for (const comp of competitors) {
      if (text.includes(comp.toLowerCase()) && !mentioned.includes(comp)) {
        if (!compMap.has(comp)) compMap.set(comp, new Set());
        compMap.get(comp)!.add(call.title);
      }
    }
  }

  const results = [...compMap.entries()]
    .map(([competitor, titles]) => ({ competitor, callCount: titles.size, callTitles: [...titles].slice(0, 5) }))
    .sort((a, b) => b.callCount - a.callCount);

  return {
    ...base,
    intent: "competitor",
    noResults: results.length === 0,
    competitorMentions: results,
  };
}

// ---- General Overview ----
function searchOverview(
  calls: NormalizedCall[],
  parsed: ParsedQuery,
  base: SearchResultBase
): ResultData {
  const totalDurSec = calls.reduce((s, c) => s + parseDurationToSeconds(c.duration), 0);
  const avgDurSec = calls.length ? Math.round(totalDurSec / calls.length) : 0;

  const topicIndex = buildTopicIndex(calls);
  const sortedTopics = [...topicIndex.entries()].sort((a, b) => b[1].count - a[1].count);
  const topTopicNames = sortedTopics.slice(0, 5).map(([t]) => t);

  const participants = new Set<string>();
  calls.forEach((c) => safeArray(c.participants).forEach((p) => { if (p && typeof p === "string") participants.add(p.trim().toLowerCase()); }));

  let pos = 0, neu = 0, neg = 0;
  calls.forEach((c) => { if (c.sentiment === "positive") pos++; else if (c.sentiment === "negative") neg++; else neu++; });

  const fmtDur = (s: number) => {
    if (s < 60) return `${s} sec`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  return {
    ...base,
    intent: "general_overview",
    noResults: calls.length === 0,
    overviewStats: {
      totalCalls: calls.length,
      totalDuration: fmtDur(totalDurSec),
      avgDuration: fmtDur(avgDurSec),
      topTopics: topTopicNames,
      uniqueParticipants: participants.size,
      sentimentBreakdown: { positive: pos, neutral: neu, negative: neg },
    },
  };
}

// ---- Text Search (default) ----
function searchText(
  calls: NormalizedCall[],
  parsed: ParsedQuery,
  base: SearchResultBase
): ResultData {
  const entityStr = parsed.entities.join(" ");

  if (parsed.entities.length === 0) {
    return searchOverview(calls, parsed, base);
  }

  const mentions: GroundedMention[] = [];

  for (const call of calls) {
    const fullText = getSearchableText(call);
    let totalCount = 0;
    const snippets: TranscriptSnippet[] = [];
    let source: GroundedMention["source"] = "summary";

    for (const entity of parsed.entities) {
      const count = countOccurrences(fullText, entity);
      if (count === 0) continue;
      totalCount += count;

      // Try sentence-level match first (has timestamps)
      const sentenceMatch = findSentenceWithTimestamp(call, entity);
      if (sentenceMatch) {
        snippets.push(sentenceMatch);
        source = "transcript";
        continue;
      }

      if (call.transcript) {
        const s = extractSnippet(call.transcript, entity);
        if (s) { snippets.push({ text: s, speakerName: "", matchHighlight: entity }); source = "transcript"; continue; }
      }
      if (call.aiSummary) {
        const s = extractSnippet(call.aiSummary, entity);
        if (s) { snippets.push({ text: s, speakerName: "", matchHighlight: entity }); source = "summary"; continue; }
      }
      const raw = call.raw?.summary;
      if (raw?.overview) {
        const s = extractSnippet(raw.overview, entity);
        if (s) { snippets.push({ text: s, speakerName: "", matchHighlight: entity }); source = "summary"; continue; }
      }
      for (const item of safeArray(call.actionItems)) {
        const s = extractSnippet(item, entity);
        if (s) { snippets.push({ text: s, speakerName: "", matchHighlight: entity }); source = "action_items"; break; }
      }
      // CRITICAL RULE: Do not create synthetic snippets from keyword/topic matches alone.
      // Only real transcript, summary, or action item evidence counts.
    }

    if (totalCount > 0 && snippets.length > 0) {
      mentions.push({
        callId: call.id, callTitle: call.title, aeName: call.aeName,
        date: call.date, dateTimestamp: call.dateTimestamp, mentionCount: totalCount,
        snippets, // Keep ALL snippets — do not truncate during processing
        source,
        recordingUrl: call.recordingUrl,
      });
    }
  }

  mentions.sort((a, b) => b.mentionCount - a.mentionCount);

  return {
    ...base,
    intent: "text_search",
    noResults: mentions.length === 0,
    totalMentions: mentions.reduce((s, m) => s + m.mentionCount, 0),
    totalMeetings: mentions.length,
    mentions, // Keep ALL mentions — do not truncate during processing
  };
}

// ---- Deep transcript enrichment (non-fatal) ----

export async function deepTranscriptSearch(
  matchedCallIds: string[],
  entities: string[],
  onProgress?: (msg: string) => void
): Promise<Map<string, TranscriptSnippet[]>> {
  const results = new Map<string, TranscriptSnippet[]>();
  const BATCH = 3;

  for (let i = 0; i < matchedCallIds.length; i += BATCH) {
    const batch = matchedCallIds.slice(i, i + BATCH);
    if (onProgress) onProgress(`Deep searching transcripts ${i + 1}/${matchedCallIds.length}...`);

    const fetched = await Promise.all(
      batch
        .map((id) =>
          fetch(`${SERVER_BASE}/calls/${id}`)
            .then((r) => r.json())
            .then((d) => d?.call ?? null)
            .catch(() => null)
        )
    );

    for (const t of fetched) {
      if (!t?.sentences) continue;
      const snippets: TranscriptSnippet[] = [];
      for (const entity of entities) {
        for (const sentence of t.sentences) {
          if (sentence.text.toLowerCase().includes(entity.toLowerCase())) {
            snippets.push({ text: sentence.text, speakerName: sentence.speaker_name, matchHighlight: entity, startTime: sentence.start_time });
          }
        }
      }
      if (snippets.length > 0) results.set(t.id, snippets);
    }
  }
  return results;
}

// =====================================================================
// Format responses per intent
// =====================================================================

export function formatResponse(result: ResultData, parsed: ParsedQuery): string {
  const tc = parsed.timeFilter ? ` ${parsed.timeFilter.label}` : "";
  const tcIn = tc ? ` in the${tc}` : "";
  const cat = result.analystCategory;

  if (result.noResults) {
    return `I couldn't find any transcript evidence for that query${tcIn}. I searched across ${result.searchedCallCount} calls but nothing matched. Try different keywords, a broader time range, or rephrasing your question — I'm happy to help narrow it down.`;
  }

  switch (result.intent) {
    case "topic_ranking": {
      const top = result.topTopics;
      if (top && top.length > 0) {
        const leader = top[0];
        const trendNote = leader.trend === "up" ? " and it's trending upward" : leader.trend === "down" ? ", though it seems to be declining recently" : "";
        if (cat === "counting") {
          return `Great question! The most discussed topic${tcIn} was **"${leader.topic}"**, which came up **${leader.count} times** across **${leader.callCount} calls**${trendNote}.\n\nHere's the full ranked breakdown across ${result.searchedCallCount} calls:`;
        }
        const runners = top.slice(1, 3).map((t) => `**${t.topic}** (${t.callCount} calls)`).join(" and ");
        return `Here's what I found across your calls${tcIn}:\n\n**"${leader.topic}"** is leading the pack with ${leader.count} mentions across ${leader.callCount} calls${trendNote}. Close behind are ${runners}.\n\nFull ranking with trend analysis below:`;
      }
      return `I pulled together all topics and keywords from your ${result.searchedCallCount} calls${tcIn}. Here's how they rank:`;
    }
    case "topic_search": {
      const entity = result.queryEntity;
      const mentions = result.totalMentions || 0;
      const meetings = result.totalMeetings || 0;
      if (cat === "counting") {
        return `**"${entity}"** came up quite a bit${tcIn}. I found **${mentions} mention${mentions !== 1 ? "s" : ""}** across **${meetings} meeting${meetings !== 1 ? "s" : ""}**, which suggests it's a significant discussion point.\n\nHere are the details with transcript evidence:`;
      }
      if (cat === "entity_extraction") {
        return `I found **${meetings} meeting${meetings !== 1 ? "s" : ""}** where **"${entity}"** was discussed${tcIn}, with **${mentions} total mention${mentions !== 1 ? "s" : ""}**. Each result below includes supporting transcript evidence so you can see exactly what was said:`;
      }
      return `**"${entity}"** showed up **${mentions} time${mentions !== 1 ? "s" : ""}** across **${meetings} call${meetings !== 1 ? "s" : ""}**${tcIn}. Here are the details with transcript evidence:`;
    }
    case "keyword_search":
      return `I ran a keyword analysis for **"${result.queryEntity}"**${tcIn} and found **${result.totalMentions || 0} occurrences** across **${result.totalMeetings || 0} meetings**. Here's what came up:`;
    case "participant_query": {
      const allRanks = result.participantRankings || [];
      const aeOnly = allRanks.filter((p) => p.isAE);
      const externalOnly = allRanks.filter((p) => !p.isAE);
      const isAEQuery = /\b(AEs?|account\s+executives?|sales\s+reps?|reps?|itilite|team\s+members?)\b/i.test(parsed.rawQuery);

      if (isAEQuery && aeOnly.length > 0) {
        const top3 = aeOnly.slice(0, 3);
        return `I identified **${aeOnly.length} active AEs** from the ${AE_DOMAIN} domain${tcIn}. Your most active reps are:\n\n${top3.map((p, i) => `${i + 1}. **${p.name}** — ${p.callCount} call${p.callCount !== 1 ? "s" : ""}, last active ${p.lastActiveDate}`).join("\n")}\n\n${aeOnly.length > 3 ? `Plus ${aeOnly.length - 3} more. ` : ""}Full breakdown below:`;
      }
      if (allRanks.length > 0) {
        return `Across **${result.searchedCallCount} calls**${tcIn}, I found **${aeOnly.length} AEs** (${AE_DOMAIN}) and **${externalOnly.length} external participants**. Here's everyone ranked by activity:`;
      }
      return `Here's the participant breakdown from your ${result.searchedCallCount} calls${tcIn}:`;
    }
    case "action_items": {
      const count = result.actionItems?.length || 0;
      const aboutStr = result.queryEntity ? ` related to **"${result.queryEntity}"**` : "";
      if (count > 10) {
        return `There's quite a bit of follow-up needed! I pulled **${count} action items**${aboutStr}${tcIn}. Each one is linked back to its source meeting so you can trace it:`;
      }
      return `I found **${count} action item${count !== 1 ? "s" : ""}**${aboutStr}${tcIn}. Here they are, each linked to the meeting they came from:`;
    }
    case "sentiment": {
      const s = result.sentiment;
      if (s) {
        const total = s.positive + s.neutral + s.negative;
        const posPct = total ? Math.round((s.positive / total) * 100) : 0;
        let tone = "";
        if (posPct >= 70) tone = "Overall, the mood has been quite positive — a great sign for the team.";
        else if (posPct >= 50) tone = "Things are generally trending positive, with a healthy mix.";
        else if (posPct >= 30) tone = "There's a fair amount of neutral or mixed sentiment — might be worth digging into the specifics.";
        else tone = "There's a noticeable amount of negative sentiment here — worth investigating further.";
        return `Here's the sentiment picture across **${total} calls**${tcIn}:\n\n**${posPct}%** had positive sentiment (**${s.positive}** positive, **${s.neutral}** neutral, **${s.negative}** negative). ${tone}\n\nIndividual call breakdowns below:`;
      }
      return `Here's the sentiment analysis across your calls${tcIn}:`;
    }
    case "duration": {
      const list = result.durationList;
      if (list && list.length > 0) {
        const direction = /shortest|least/i.test(parsed.rawQuery) ? "shortest" : "longest";
        return `Looking at call durations${tcIn}, the **${direction}** call was **"${list[0].title}"** at **${list[0].duration}**. Here's the full ranking:`;
      }
      return `Here's the call duration breakdown${tcIn}:`;
    }
    case "competitor": {
      const comps = result.competitorMentions;
      if (comps && comps.length > 0) {
        const leader = comps[0];
        return `Interesting — I found **${comps.length} competitor${comps.length !== 1 ? "s" : ""}** mentioned across your calls${tcIn}. **${leader.competitor}** came up the most, appearing in **${leader.callCount} call${leader.callCount !== 1 ? "s" : ""}**.\n\nHere's the full breakdown:`;
      }
      return `I didn't find any significant competitor mentions${tcIn}. This could mean competitors aren't top of mind for your prospects, or they're using different terminology.`;
    }
    case "general_overview": {
      const stats = result.overviewStats;
      if (stats) {
        return `Here's a snapshot of your call activity${tcIn}:\n\nYou've got **${stats.totalCalls} calls** totaling **${stats.totalDuration}** of recorded conversation, averaging **${stats.avgDuration}** per call, with **${stats.uniqueParticipants} unique participants**. Key metrics and top themes below:`;
      }
      return `Here's your call activity overview${tcIn}:`;
    }
    case "text_search": {
      if (result.totalMentions && result.totalMentions > 0) {
        const entity = result.queryEntity;
        const mentions = result.totalMentions;
        const meetings = result.totalMeetings || 0;
        if (cat === "counting") {
          return `**"${entity}"** came up **${mentions} time${mentions !== 1 ? "s" : ""}** across **${meetings} meeting${meetings !== 1 ? "s" : ""}**${tcIn}. That's a notable frequency — here are the details with transcript evidence:`;
        }
        return `I found **${mentions} mention${mentions !== 1 ? "s" : ""}** of **"${entity}"** across **${meetings} call${meetings !== 1 ? "s" : ""}**${tcIn}. Here's what was said:`;
      }
      return `Here are the search results${tcIn}:`;
    }
    default:
      return `Here's what I found${tcIn}:`;
  }
}

// =====================================================================
// Follow-up suggestions generator
// =====================================================================

export function generateFollowUpSuggestions(result: ResultData, parsed: ParsedQuery): string[] {
  const suggestions: string[] = [];
  const entity = result.queryEntity;

  switch (result.intent) {
    case "topic_ranking":
      if (result.topTopics && result.topTopics.length > 0) {
        suggestions.push(`Which clients asked about "${result.topTopics[0].topic}" most?`);
        suggestions.push(`Show me action items related to "${result.topTopics[0].topic}"`);
        suggestions.push("How does sentiment break down across these topics?");
      }
      break;
    case "topic_search":
    case "keyword_search":
    case "text_search":
      if (entity) {
        suggestions.push(`Which AEs handled "${entity}" discussions most?`);
        suggestions.push(`What action items came from "${entity}" conversations?`);
        if (result.totalMeetings && result.totalMeetings > 3) {
          suggestions.push(`What's the sentiment in calls that mentioned "${entity}"?`);
        }
      }
      break;
    case "participant_query":
      suggestions.push("What topics do these participants discuss most?");
      suggestions.push("Show me the sentiment breakdown for their calls");
      suggestions.push("What are the recent action items from these meetings?");
      break;
    case "action_items":
      suggestions.push("Which AEs have the most pending action items?");
      suggestions.push("What topics generate the most follow-ups?");
      break;
    case "sentiment":
      suggestions.push("Which calls had negative sentiment? Show me details");
      suggestions.push("What topics come up in negative calls?");
      suggestions.push("How does sentiment compare across AEs?");
      break;
    case "duration":
      suggestions.push("What topics were covered in the longest calls?");
      suggestions.push("Show me the sentiment for these calls");
      break;
    case "competitor":
      if (result.competitorMentions && result.competitorMentions.length > 0) {
        suggestions.push(`Show me what was said about ${result.competitorMentions[0].competitor}`);
        suggestions.push("Which AEs encountered competitor mentions most?");
      }
      break;
    case "general_overview":
      suggestions.push("What are the top topics discussed?");
      suggestions.push("Show me the sentiment breakdown");
      suggestions.push("Who are the most active AEs?");
      break;
  }

  return suggestions.slice(0, 3);
}

// =====================================================================
// Suggested queries — topic & keyword focused
// =====================================================================

export const suggestedQueries = [
  // Counting / Quantitative
  "How many times was pricing mentioned?",
  "How many meetings discussed integrations?",
  // Entity Extraction
  "Who asked about API capabilities?",
  "Which clients mentioned compliance?",
  // Trend / Pattern
  "What capabilities were discussed most in the last 10 calls?",
  "What objections came up most often?",
  // Exploratory / Insight
  "What were the main concerns in recent demos?",
  "What product feedback did customers give?",
  // AE / Specific
  "Give me the 15 active AEs",
  "Give me an overview of all my calls",
];

// =====================================================================
// Result renderers
// =====================================================================

function AnalystCategoryBadge({ category }: { category: AnalystCategory }) {
  const config: Record<AnalystCategory, { label: string; color: string }> = {
    counting: { label: "Quantitative", color: "text-blue-400 bg-blue-500/10 border-blue-500/20" },
    entity_extraction: { label: "Entity Extraction", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" },
    trend_pattern: { label: "Trend / Pattern", color: "text-[#ec5d25] bg-[#ec5d25]/10 border-[#ec5d25]/20" },
    exploratory: { label: "Exploratory Insight", color: "text-amber-400 bg-amber-500/10 border-amber-500/20" },
    specific_call: { label: "Call Detail", color: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20" },
  };
  const cfg = config[category] || config.exploratory;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ${cfg.color}`} style={{ fontSize: "0.62rem", fontWeight: 500 }}>
      {cfg.label}
    </span>
  );
}

function IntentBadge({ intent }: { intent: QueryIntent }) {
  const config: Record<QueryIntent, { icon: typeof Hash; label: string; color: string }> = {
    topic_ranking: { icon: TrendingUp, label: "Topic Ranking", color: "text-[#ec5d25] bg-[#ec5d25]/15 border-[#ec5d25]/25" },
    topic_search: { icon: Hash, label: "Topic Search", color: "text-cyan-400 bg-cyan-500/15 border-cyan-500/25" },
    keyword_search: { icon: Search, label: "Keyword Search", color: "text-blue-400 bg-blue-500/15 border-blue-500/25" },
    participant_query: { icon: Users, label: "Participants", color: "text-emerald-400 bg-emerald-500/15 border-emerald-500/25" },
    action_items: { icon: ListChecks, label: "Action Items", color: "text-amber-400 bg-amber-500/15 border-amber-500/25" },
    sentiment: { icon: ThumbsUp, label: "Sentiment", color: "text-rose-400 bg-rose-500/15 border-rose-500/25" },
    duration: { icon: Clock, label: "Duration", color: "text-orange-400 bg-orange-500/15 border-orange-500/25" },
    competitor: { icon: BarChart3, label: "Competitors", color: "text-red-400 bg-red-500/15 border-red-500/25" },
    general_overview: { icon: BarChart3, label: "Overview", color: "text-[#f07848] bg-[#ec5d25]/15 border-[#ec5d25]/25" },
    text_search: { icon: Search, label: "Text Search", color: "text-slate-400 bg-slate-500/15 border-slate-500/25" },
    summary: { icon: MessageSquare, label: "Summary", color: "text-slate-400 bg-slate-500/15 border-slate-500/25" },
  };
  const cfg = config[intent] || config.text_search;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border ${cfg.color}`} style={{ fontSize: "0.7rem", fontWeight: 600 }}>
      <Icon className="w-3 h-3" /> {cfg.label}
    </span>
  );
}

function TopicRankingResult({ data }: { data: ResultData }) {
  const [expanded, setExpanded] = useState(false);
  const rankings = data.topicRankings || [];
  const shown = expanded ? rankings : rankings.slice(0, 10);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <IntentBadge intent="topic_ranking" />
        <AnalystCategoryBadge category={data.analystCategory} />
      </div>
      {/* Top 5 highlight cards */}
      {data.topTopics && data.topTopics.length > 0 && (
        <div className="grid grid-cols-5 gap-2">
          {data.topTopics.map((t, i) => (
            <div key={t.topic} className="bg-[#12121c] border border-[#1e1e2e] rounded-lg p-3 text-center">
              <p className="text-[#ec5d25] mb-0.5" style={{ fontSize: "0.65rem", fontWeight: 600 }}>#{i + 1}</p>
              <p className="text-white truncate mb-1" style={{ fontSize: "0.8rem", fontWeight: 600 }} title={t.topic}>{t.topic}</p>
              <p className="text-[#8888a0]" style={{ fontSize: "0.65rem" }}>{t.count} mentions · {t.callCount} calls</p>
              <span className={`inline-block mt-1 ${t.trend === "up" ? "text-emerald-400" : t.trend === "down" ? "text-red-400" : "text-[#8888a0]"}`} style={{ fontSize: "0.65rem" }}>
                {t.trend === "up" ? "↑ Trending" : t.trend === "down" ? "↓ Declining" : "— Stable"}
              </span>
            </div>
          ))}
        </div>
      )}
      {/* Full table */}
      <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[#1e1e2e]">
              <th className="px-4 py-2.5 text-left text-[#8888a0] w-8" style={{ fontSize: "0.7rem", fontWeight: 500 }}>#</th>
              <th className="px-4 py-2.5 text-left text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Topic / Keyword</th>
              <th className="px-4 py-2.5 text-center text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Mentions</th>
              <th className="px-4 py-2.5 text-center text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Calls</th>
              <th className="px-4 py-2.5 text-center text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Trend</th>
              <th className="px-4 py-2.5 text-left text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Recent Calls</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t, i) => (
              <tr key={t.topic} className="border-b border-[#1e1e2e] last:border-b-0 hover:bg-[#1a1a28]">
                <td className="px-4 py-2.5 text-[#555568]" style={{ fontSize: "0.75rem" }}>{i + 1}</td>
                <td className="px-4 py-2.5" style={{ fontSize: "0.8rem" }}>
                  <span className="text-white px-2 py-0.5 rounded bg-[#ec5d25]/10 border border-[#ec5d25]/20" style={{ fontSize: "0.75rem" }}>{t.topic}</span>
                </td>
                <td className="px-4 py-2.5 text-center text-[#f5a07a]" style={{ fontSize: "0.8rem", fontWeight: 600 }}>{t.count}</td>
                <td className="px-4 py-2.5 text-center text-cyan-300" style={{ fontSize: "0.8rem" }}>{t.callCount}</td>
                <td className="px-4 py-2.5 text-center">
                  <span className={`${t.trend === "up" ? "text-emerald-400" : t.trend === "down" ? "text-red-400" : "text-[#8888a0]"}`} style={{ fontSize: "0.75rem" }}>
                    {t.trend === "up" ? "↑ Up" : t.trend === "down" ? "↓ Down" : "—"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-[#8888a0] max-w-[200px] truncate" style={{ fontSize: "0.7rem" }}>
                  {t.recentCallTitles.join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rankings.length > 10 && (
        <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-1 text-[#ec5d25] hover:text-[#f5a07a] transition-colors mx-auto" style={{ fontSize: "0.75rem" }}>
          {expanded ? <><ChevronUp className="w-3 h-3" /> Show less</> : <><ChevronDown className="w-3 h-3" /> Show all {rankings.length} topics</>}
        </button>
      )}
    </div>
  );
}

function RecordingLink({ url, compact = false }: { url?: string; compact?: boolean }) {
  if (!url || url === "#") return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 rounded-md transition-colors ${
        compact
          ? "px-1.5 py-0.5 bg-[#ec5d25]/10 text-[#f5a07a] hover:bg-[#ec5d25]/20 border border-[#ec5d25]/20"
          : "px-2 py-1 bg-[#ec5d25]/10 text-[#f5a07a] hover:bg-[#ec5d25]/25 border border-[#ec5d25]/20"
      }`}
      style={{ fontSize: compact ? "0.6rem" : "0.68rem", fontWeight: 500 }}
      title="Play recording"
    >
      <Headphones className={compact ? "w-2.5 h-2.5" : "w-3 h-3"} />
      {!compact && <span>Recording</span>}
      <ExternalLink className={compact ? "w-2 h-2" : "w-2.5 h-2.5"} />
    </a>
  );
}

function MentionsTable({ data }: { data: ResultData }) {
  const mentions = data.mentions || [];
  const [viewMode, setViewMode] = useState<"table" | "evidence">(
    data.analystCategory === "entity_extraction" || data.analystCategory === "specific_call" ? "evidence" : "table"
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <IntentBadge intent={data.intent} />
        <AnalystCategoryBadge category={data.analystCategory} />
        <div className="ml-auto flex items-center gap-1 bg-[#1e1e2e] rounded-lg p-0.5">
          <button
            onClick={() => setViewMode("table")}
            className={`px-2.5 py-1 rounded-md transition-colors ${viewMode === "table" ? "bg-[#d44a1a] text-white" : "text-[#8888a0] hover:text-white"}`}
            style={{ fontSize: "0.65rem" }}
          >Table</button>
          <button
            onClick={() => setViewMode("evidence")}
            className={`px-2.5 py-1 rounded-md transition-colors ${viewMode === "evidence" ? "bg-[#d44a1a] text-white" : "text-[#8888a0] hover:text-white"}`}
            style={{ fontSize: "0.65rem" }}
          >Evidence</button>
        </div>
      </div>

      {/* Quantitative summary cards */}
      <div className="flex gap-3">
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-lg px-4 py-2.5">
          <p className="text-[#ec5d25]" style={{ fontSize: "1.15rem", fontWeight: 700 }}>{data.totalMentions}</p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.65rem" }}>Total Mentions</p>
        </div>
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-lg px-4 py-2.5">
          <p className="text-emerald-400" style={{ fontSize: "1.15rem", fontWeight: 700 }}>{data.totalMeetings}</p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.65rem" }}>Meetings</p>
        </div>
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-lg px-4 py-2.5">
          <p className="text-blue-400" style={{ fontSize: "1.15rem", fontWeight: 700 }}>{data.searchedCallCount}</p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.65rem" }}>Analyzed</p>
        </div>
      </div>

      {viewMode === "evidence" ? (
        /* Evidence view — analyst-style entity list with transcript quotes */
        <div className="space-y-3">
          {mentions.map((m, i) => (
            <div key={`${m.callId}-${i}`} className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-4 hover:border-[#ec5d25]/20 transition-colors">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <p className="text-white" style={{ fontSize: "0.85rem", fontWeight: 600 }}>{m.callTitle}</p>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-[#8888a0]" style={{ fontSize: "0.72rem" }}>AE: <span className="text-[#c0c0d0]">{m.aeName}</span></span>
                    <span className="text-[#8888a0]" style={{ fontSize: "0.72rem" }}>Date: <span className="text-[#c0c0d0]">{m.date}</span></span>
                    <span className={`px-2 py-0.5 rounded ${
                      m.source === "transcript" ? "bg-emerald-500/15 text-emerald-300"
                      : m.source === "summary" ? "bg-blue-500/15 text-blue-300"
                      : "bg-amber-500/15 text-amber-300"
                    }`} style={{ fontSize: "0.62rem" }}>{m.source}</span>
                    <RecordingLink url={m.recordingUrl} />
                  </div>
                </div>
                <span className="px-2.5 py-1 rounded-lg bg-[#ec5d25]/15 text-[#f5a07a]" style={{ fontSize: "0.72rem", fontWeight: 600 }}>{m.mentionCount} hit{m.mentionCount !== 1 ? "s" : ""}</span>
              </div>
              {/* Transcript evidence snippets */}
              {m.snippets.length > 0 && (
                <div className="mt-3 space-y-2">
                  {m.snippets.map((snip, si) => (
                    <div key={si} className="pl-3 border-l-2 border-[#ec5d25]/30">
                      <div className="flex items-center gap-2 mb-0.5">
                        {snip.speakerName && (
                          <span className="text-[#f5a07a]" style={{ fontSize: "0.68rem", fontWeight: 600 }}>{snip.speakerName}:</span>
                        )}
                        {snip.startTime !== undefined && snip.startTime >= 0 && (() => {
                          const tsUrl = buildFirefliesTimestampUrl(m.callId, snip.startTime);
                          return tsUrl ? (
                            <a
                              href={tsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[#1a1a2e] border border-[#2a2a3e] text-cyan-400 hover:bg-cyan-500/15 hover:border-cyan-500/30 hover:text-cyan-300 transition-colors cursor-pointer"
                              style={{ fontSize: "0.6rem", fontWeight: 500 }}
                              title={`Jump to ${formatTimestamp(snip.startTime)} in Fireflies.ai`}
                            >
                              <Clock className="w-2.5 h-2.5" />
                              {formatTimestamp(snip.startTime)}
                              <ExternalLink className="w-2 h-2 opacity-60" />
                            </a>
                          ) : (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[#1a1a2e] border border-[#2a2a3e] text-cyan-400" style={{ fontSize: "0.6rem", fontWeight: 500 }}>
                              <Clock className="w-2.5 h-2.5" />
                              {formatTimestamp(snip.startTime)}
                            </span>
                          );
                        })()}
                      </div>
                      <p className="text-[#c0c0d0] italic" style={{ fontSize: "0.75rem" }}>
                        "{snip.text.slice(0, 250)}{snip.text.length > 250 ? "..." : ""}"
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        /* Table view — structured comparison */
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#1e1e2e]">
                <th className="px-4 py-2.5 text-left text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Call</th>
                <th className="px-4 py-2.5 text-left text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>AE</th>
                <th className="px-4 py-2.5 text-left text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Date</th>
                <th className="px-4 py-2.5 text-center text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Mentions</th>
                <th className="px-4 py-2.5 text-left text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Source</th>
                <th className="px-4 py-2.5 text-left text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Evidence</th>
                <th className="px-4 py-2.5 text-center text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Recording</th>
              </tr>
            </thead>
            <tbody>
              {mentions.map((m, i) => (
                <tr key={`${m.callId}-${i}`} className="border-b border-[#1e1e2e] last:border-b-0 hover:bg-[#1a1a28]">
                  <td className="px-4 py-2.5 text-white max-w-[160px] truncate" style={{ fontSize: "0.78rem" }}>{m.callTitle}</td>
                  <td className="px-4 py-2.5 text-[#c0c0d0]" style={{ fontSize: "0.78rem" }}>{m.aeName}</td>
                  <td className="px-4 py-2.5 text-[#c0c0d0]" style={{ fontSize: "0.78rem" }}>{m.date}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span className="px-2 py-0.5 rounded bg-[#ec5d25]/20 text-[#f5a07a]" style={{ fontSize: "0.7rem", fontWeight: 600 }}>{m.mentionCount}</span>
                  </td>
                  <td className="px-4 py-2.5" style={{ fontSize: "0.68rem" }}>
                    <span className={`px-2 py-0.5 rounded ${
                      m.source === "transcript" ? "bg-emerald-500/20 text-emerald-300"
                      : m.source === "summary" ? "bg-blue-500/20 text-blue-300"
                      : m.source === "keywords" ? "bg-amber-500/20 text-amber-300"
                      : "bg-purple-500/20 text-purple-300"
                    }`}>{m.source}</span>
                  </td>
                  <td className="px-4 py-2.5 text-[#8888a0] italic max-w-[220px]" style={{ fontSize: "0.72rem" }}>
                    {m.snippets[0]?.text ? (
                      <span>
                        {m.snippets[0].startTime !== undefined && m.snippets[0].startTime >= 0 && (() => {
                          const tsUrl = buildFirefliesTimestampUrl(m.callId, m.snippets[0].startTime);
                          return tsUrl ? (
                            <a
                              href={tsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-0.5 px-1 py-0 rounded bg-[#1a1a2e] border border-[#2a2a3e] text-cyan-400 hover:bg-cyan-500/15 hover:border-cyan-500/30 hover:text-cyan-300 transition-colors not-italic mr-1 cursor-pointer"
                              style={{ fontSize: "0.58rem", fontWeight: 500 }}
                              title={`Jump to ${formatTimestamp(m.snippets[0].startTime)} in Fireflies.ai`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Clock className="w-2 h-2" />
                              {formatTimestamp(m.snippets[0].startTime)}
                              <ExternalLink className="w-1.5 h-1.5 opacity-60" />
                            </a>
                          ) : (
                            <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded bg-[#1a1a2e] border border-[#2a2a3e] text-cyan-400 not-italic mr-1" style={{ fontSize: "0.58rem", fontWeight: 500 }}>
                              <Clock className="w-2 h-2" />
                              {formatTimestamp(m.snippets[0].startTime)}
                            </span>
                          );
                        })()}
                        {m.snippets[0].speakerName && <span className="text-[#f5a07a] not-italic" style={{ fontWeight: 500 }}>{m.snippets[0].speakerName}: </span>}
                        "{m.snippets[0].text.slice(0, 140)}{m.snippets[0].text.length > 140 ? "..." : ""}"
                      </span>
                    ) : <span className="text-[#555568]">No evidence</span>}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <RecordingLink url={m.recordingUrl} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ParticipantResult({ data }: { data: ResultData }) {
  const rankings = data.participantRankings || [];
  const aeCount = rankings.filter((r) => r.isAE).length;
  const externalCount = rankings.filter((r) => !r.isAE).length;
  const hasAEs = aeCount > 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <IntentBadge intent="participant_query" />
        <AnalystCategoryBadge category={data.analystCategory} />
      </div>

      {/* Summary cards */}
      <div className="flex gap-3">
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-lg px-4 py-2.5">
          <p className="text-[#ec5d25]" style={{ fontSize: "1.15rem", fontWeight: 700 }}>{rankings.length}</p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.65rem" }}>Total Found</p>
        </div>
        {hasAEs && (
          <div className="bg-[#12121c] border border-emerald-500/20 rounded-lg px-4 py-2.5">
            <p className="text-emerald-400" style={{ fontSize: "1.15rem", fontWeight: 700 }}>{aeCount}</p>
            <p className="text-[#8888a0]" style={{ fontSize: "0.65rem" }}>AEs ({AE_DOMAIN})</p>
          </div>
        )}
        {externalCount > 0 && (
          <div className="bg-[#12121c] border border-[#1e1e2e] rounded-lg px-4 py-2.5">
            <p className="text-blue-400" style={{ fontSize: "1.15rem", fontWeight: 700 }}>{externalCount}</p>
            <p className="text-[#8888a0]" style={{ fontSize: "0.65rem" }}>External</p>
          </div>
        )}
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-lg px-4 py-2.5">
          <p className="text-cyan-400" style={{ fontSize: "1.15rem", fontWeight: 700 }}>{data.searchedCallCount}</p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.65rem" }}>Calls Analyzed</p>
        </div>
      </div>

      <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[#1e1e2e]">
              <th className="px-4 py-2.5 text-left text-[#8888a0] w-8" style={{ fontSize: "0.7rem", fontWeight: 500 }}>#</th>
              <th className="px-4 py-2.5 text-left text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Name</th>
              <th className="px-4 py-2.5 text-center text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Role</th>
              <th className="px-4 py-2.5 text-center text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Calls</th>
              <th className="px-4 py-2.5 text-left text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Last Active</th>
              <th className="px-4 py-2.5 text-left text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Recent Meetings</th>
            </tr>
          </thead>
          <tbody>
            {rankings.map((p, i) => (
              <tr key={`${p.email}-${i}`} className="border-b border-[#1e1e2e] last:border-b-0 hover:bg-[#1a1a28]">
                <td className="px-4 py-2.5 text-[#555568]" style={{ fontSize: "0.75rem" }}>{i + 1}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                      p.isAE
                        ? "bg-gradient-to-br from-emerald-500 to-teal-600"
                        : "bg-gradient-to-br from-blue-500 to-[#c4400e]"
                    }`}>
                      <span className="text-white" style={{ fontSize: "0.6rem", fontWeight: 700 }}>{p.name.charAt(0).toUpperCase()}</span>
                    </div>
                    <div>
                      <span className="text-white block" style={{ fontSize: "0.8rem", fontWeight: 500 }}>{p.name}</span>
                      {p.email.includes("@") && (
                        <span className="text-[#666680] block" style={{ fontSize: "0.62rem" }}>{p.email}</span>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-center">
                  <span className={`px-2 py-0.5 rounded-full ${
                    p.isAE
                      ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/25"
                      : "bg-blue-500/15 text-blue-300 border border-blue-500/25"
                  }`} style={{ fontSize: "0.62rem", fontWeight: 600 }}>
                    {p.isAE ? "AE" : "External"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-center text-emerald-300" style={{ fontSize: "0.85rem", fontWeight: 600 }}>{p.callCount}</td>
                <td className="px-4 py-2.5 text-[#c0c0d0]" style={{ fontSize: "0.75rem" }}>{p.lastActiveDate}</td>
                <td className="px-4 py-2.5 text-[#8888a0] max-w-[220px] truncate" style={{ fontSize: "0.7rem" }}>{p.recentCalls.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasAEs && (
        <div className="flex items-center gap-2 text-[#8888a0] px-1" style={{ fontSize: "0.65rem" }}>
          <div className="w-2 h-2 rounded-full bg-emerald-500" />
          <span>AE = Account Executive ({AE_DOMAIN} domain)</span>
          <span className="mx-1">|</span>
          <div className="w-2 h-2 rounded-full bg-blue-500" />
          <span>External = Non-{AE_DOMAIN} participant</span>
        </div>
      )}
    </div>
  );
}

function ActionItemsResult({ data }: { data: ResultData }) {
  const items = data.actionItems || [];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <IntentBadge intent="action_items" />
        <AnalystCategoryBadge category={data.analystCategory} />
      </div>
      <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl divide-y divide-[#1e1e2e]">
        {items.map((item, i) => (
          <div key={`${item.callId}-${i}`} className="px-4 py-3 hover:bg-[#1a1a28]">
            <div className="flex items-start gap-3">
              <div className="w-5 h-5 rounded border border-amber-500/30 bg-amber-500/10 flex items-center justify-center shrink-0 mt-0.5">
                <ListChecks className="w-3 h-3 text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[#e0e0ee]" style={{ fontSize: "0.82rem" }}>{item.item}</p>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <p className="text-[#8888a0]" style={{ fontSize: "0.68rem" }}>
                    From: <span className="text-[#c0c0d0]">{item.callTitle}</span> · {item.date}
                  </p>
                  <RecordingLink url={item.recordingUrl} compact />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SentimentResult({ data }: { data: ResultData }) {
  const s = data.sentiment;
  if (!s) return null;
  const total = s.positive + s.neutral + s.negative || 1;
  const pPct = Math.round((s.positive / total) * 100);
  const nuPct = Math.round((s.neutral / total) * 100);
  const nPct = Math.round((s.negative / total) * 100);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <IntentBadge intent="sentiment" />
        <AnalystCategoryBadge category={data.analystCategory} />
      </div>
      <div className="flex gap-3">
        <div className="bg-[#12121c] border border-emerald-500/20 rounded-lg px-4 py-3 flex-1 text-center">
          <p className="text-emerald-400" style={{ fontSize: "1.25rem", fontWeight: 700 }}>{s.positive}</p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.65rem" }}>Positive ({pPct}%)</p>
        </div>
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-lg px-4 py-3 flex-1 text-center">
          <p className="text-slate-400" style={{ fontSize: "1.25rem", fontWeight: 700 }}>{s.neutral}</p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.65rem" }}>Neutral ({nuPct}%)</p>
        </div>
        <div className="bg-[#12121c] border border-red-500/20 rounded-lg px-4 py-3 flex-1 text-center">
          <p className="text-red-400" style={{ fontSize: "1.25rem", fontWeight: 700 }}>{s.negative}</p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.65rem" }}>Negative ({nPct}%)</p>
        </div>
      </div>
      {/* Sentiment bar */}
      <div className="flex h-2.5 rounded-full overflow-hidden">
        {pPct > 0 && <div className="bg-emerald-500" style={{ width: `${pPct}%` }} />}
        {nuPct > 0 && <div className="bg-slate-500" style={{ width: `${nuPct}%` }} />}
        {nPct > 0 && <div className="bg-red-500" style={{ width: `${nPct}%` }} />}
      </div>
      {s.calls.length > 0 && (
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#1e1e2e]">
                <th className="px-4 py-2.5 text-left text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Call</th>
                <th className="px-4 py-2.5 text-center text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Sentiment</th>
                <th className="px-4 py-2.5 text-left text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Date</th>
                <th className="px-4 py-2.5 text-center text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Recording</th>
              </tr>
            </thead>
            <tbody>
              {s.calls.map((c, i) => (
                <tr key={`${c.id}-${i}`} className="border-b border-[#1e1e2e] last:border-b-0 hover:bg-[#1a1a28]">
                  <td className="px-4 py-2.5 text-white max-w-[250px] truncate" style={{ fontSize: "0.78rem" }}>{c.title}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span className={`px-2 py-0.5 rounded ${
                      c.sentiment === "positive" ? "bg-emerald-500/20 text-emerald-300"
                      : c.sentiment === "negative" ? "bg-red-500/20 text-red-300"
                      : "bg-slate-500/20 text-slate-300"
                    }`} style={{ fontSize: "0.7rem" }}>{c.sentiment}</span>
                  </td>
                  <td className="px-4 py-2.5 text-[#c0c0d0]" style={{ fontSize: "0.78rem" }}>{c.date}</td>
                  <td className="px-4 py-2.5 text-center">
                    <RecordingLink url={c.recordingUrl} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DurationResult({ data }: { data: ResultData }) {
  const list = data.durationList || [];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <IntentBadge intent="duration" />
        <AnalystCategoryBadge category={data.analystCategory} />
      </div>
      <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[#1e1e2e]">
              <th className="px-4 py-2.5 text-left text-[#8888a0] w-8" style={{ fontSize: "0.7rem", fontWeight: 500 }}>#</th>
              <th className="px-4 py-2.5 text-left text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Call</th>
              <th className="px-4 py-2.5 text-center text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Duration</th>
              <th className="px-4 py-2.5 text-left text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Date</th>
              <th className="px-4 py-2.5 text-center text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Recording</th>
            </tr>
          </thead>
          <tbody>
            {list.map((d, i) => (
              <tr key={d.id} className="border-b border-[#1e1e2e] last:border-b-0 hover:bg-[#1a1a28]">
                <td className="px-4 py-2.5 text-[#555568]" style={{ fontSize: "0.75rem" }}>{i + 1}</td>
                <td className="px-4 py-2.5 text-white max-w-[250px] truncate" style={{ fontSize: "0.78rem" }}>{d.title}</td>
                <td className="px-4 py-2.5 text-center">
                  <span className="px-2 py-0.5 rounded bg-orange-500/20 text-orange-300" style={{ fontSize: "0.75rem", fontWeight: 600 }}>{d.duration}</span>
                </td>
                <td className="px-4 py-2.5 text-[#c0c0d0]" style={{ fontSize: "0.78rem" }}>{d.date}</td>
                <td className="px-4 py-2.5 text-center">
                  <RecordingLink url={d.recordingUrl} compact />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompetitorResult({ data }: { data: ResultData }) {
  const mentions = data.competitorMentions || [];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <IntentBadge intent="competitor" />
        <AnalystCategoryBadge category={data.analystCategory} />
      </div>
      <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl divide-y divide-[#1e1e2e]">
        {mentions.map((c) => (
          <div key={c.competitor} className="px-4 py-3 hover:bg-[#1a1a28]">
            <div className="flex items-center justify-between mb-1">
              <span className="text-white" style={{ fontSize: "0.85rem", fontWeight: 600 }}>{c.competitor}</span>
              <span className="text-red-300 px-2 py-0.5 rounded bg-red-500/15" style={{ fontSize: "0.7rem", fontWeight: 600 }}>{c.callCount} calls</span>
            </div>
            <p className="text-[#8888a0]" style={{ fontSize: "0.7rem" }}>Mentioned in: {c.callTitles.join(", ")}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function OverviewResult({ data }: { data: ResultData }) {
  const stats = data.overviewStats;
  if (!stats) return null;
  const sb = stats.sentimentBreakdown;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <IntentBadge intent="general_overview" />
        <AnalystCategoryBadge category={data.analystCategory} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-lg px-4 py-3 text-center">
          <MessageSquare className="w-4 h-4 text-[#ec5d25] mx-auto mb-1" />
          <p className="text-white" style={{ fontSize: "1.15rem", fontWeight: 700 }}>{stats.totalCalls}</p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.65rem" }}>Total Calls</p>
        </div>
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-lg px-4 py-3 text-center">
          <Clock className="w-4 h-4 text-cyan-400 mx-auto mb-1" />
          <p className="text-white" style={{ fontSize: "1.15rem", fontWeight: 700 }}>{stats.totalDuration}</p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.65rem" }}>Total Duration</p>
        </div>
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-lg px-4 py-3 text-center">
          <Clock className="w-4 h-4 text-emerald-400 mx-auto mb-1" />
          <p className="text-white" style={{ fontSize: "1.15rem", fontWeight: 700 }}>{stats.avgDuration}</p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.65rem" }}>Avg Duration</p>
        </div>
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-lg px-4 py-3 text-center">
          <Users className="w-4 h-4 text-amber-400 mx-auto mb-1" />
          <p className="text-white" style={{ fontSize: "1.15rem", fontWeight: 700 }}>{stats.uniqueParticipants}</p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.65rem" }}>Participants</p>
        </div>
      </div>
      {/* Sentiment mini bar */}
      <div className="bg-[#12121c] border border-[#1e1e2e] rounded-lg px-4 py-3">
        <p className="text-[#8888a0] mb-2" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Sentiment Breakdown</p>
        <div className="flex items-center gap-4 mb-2">
          <span className="text-emerald-400" style={{ fontSize: "0.75rem" }}>Positive: {sb.positive}</span>
          <span className="text-slate-400" style={{ fontSize: "0.75rem" }}>Neutral: {sb.neutral}</span>
          <span className="text-red-400" style={{ fontSize: "0.75rem" }}>Negative: {sb.negative}</span>
        </div>
        <div className="flex h-2 rounded-full overflow-hidden">
          {sb.positive > 0 && <div className="bg-emerald-500" style={{ width: `${(sb.positive / stats.totalCalls) * 100}%` }} />}
          {sb.neutral > 0 && <div className="bg-slate-500" style={{ width: `${(sb.neutral / stats.totalCalls) * 100}%` }} />}
          {sb.negative > 0 && <div className="bg-red-500" style={{ width: `${(sb.negative / stats.totalCalls) * 100}%` }} />}
        </div>
      </div>
      {/* Top topics */}
      {stats.topTopics.length > 0 && (
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-lg px-4 py-3">
          <p className="text-[#8888a0] mb-2" style={{ fontSize: "0.7rem", fontWeight: 500 }}>Top Topics</p>
          <div className="flex flex-wrap gap-2">
            {stats.topTopics.map((t) => (
              <span key={t} className="px-2.5 py-1 rounded-full bg-[#ec5d25]/15 border border-[#ec5d25]/25 text-[#f5a07a]" style={{ fontSize: "0.72rem" }}>{t}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// "AI Understanding" indicator — shows above each response
export function AIUnderstandingPanel({ plannerIntent, topic, scope, rewrittenQuery, wasRewritten }: { plannerIntent?: PlannerIntent; topic?: string; scope?: string; rewrittenQuery?: string; wasRewritten?: boolean }) {
  if (!plannerIntent) return null;

  const intentConfig: Record<PlannerIntent, { label: string; color: string; description: string }> = {
    SEARCH_QUERY: { label: "Search Query", color: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20", description: "Finding mentions of a topic" },
    COUNT_QUERY: { label: "Count Query", color: "text-blue-400 bg-blue-500/10 border-blue-500/20", description: "Counting occurrences or frequency" },
    TREND_QUERY: { label: "Trend Analysis", color: "text-[#ec5d25] bg-[#ec5d25]/10 border-[#ec5d25]/20", description: "Identifying patterns and rankings" },
    FOLLOW_UP: { label: "Follow-Up", color: "text-amber-400 bg-amber-500/10 border-amber-500/20", description: "Re-evaluating previous results" },
    DRILL_DOWN: { label: "Drill Down", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20", description: "Deeper detail on previous results" },
    CORRECTION: { label: "Correction", color: "text-rose-400 bg-rose-500/10 border-rose-500/20", description: "Re-running with fresh analysis" },
    COMPETITION: {
      label: "",
      color: "",
      description: ""
    }
  };

  const cfg = intentConfig[plannerIntent] || intentConfig.SEARCH_QUERY;

  return (
    <div className="space-y-1.5 mb-2">
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[#0d0d15] border border-[#1e1e2e]">
        <div className="flex items-center gap-1.5">
          <Sparkles className="w-3 h-3 text-[#555568]" />
          <span className="text-[#555568]" style={{ fontSize: "0.62rem", fontWeight: 500 }}>AI Understanding</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ${cfg.color}`} style={{ fontSize: "0.6rem", fontWeight: 600 }}>
            {cfg.label}
          </span>
          {topic && (
            <span className="text-[#8888a0]" style={{ fontSize: "0.62rem" }}>
              Topic: <span className="text-[#c0c0d0]">{topic}</span>
            </span>
          )}
          {scope && (
            <span className="text-[#8888a0]" style={{ fontSize: "0.62rem" }}>
              Scope: <span className="text-[#c0c0d0]">{scope}</span>
            </span>
          )}
        </div>
      </div>
      {wasRewritten && rewrittenQuery && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#0d0d15] border border-purple-500/15">
          <RefreshCw className="w-3 h-3 text-purple-400 shrink-0" />
          <span className="text-purple-400/70" style={{ fontSize: "0.6rem", fontWeight: 500 }}>Query Rewritten:</span>
          <span className="text-purple-300" style={{ fontSize: "0.62rem", fontStyle: "italic" }}>"{rewrittenQuery}"</span>
        </div>
      )}
    </div>
  );
}

export function FollowUpSuggestions({ suggestions, onSelect }: { suggestions: string[]; onSelect: (q: string) => void }) {
  if (suggestions.length === 0) return null;
  return (
    <div className="mt-4 pt-3 border-t border-[#1e1e2e]">
      <div className="flex items-center gap-1.5 mb-2">
        <Lightbulb className="w-3.5 h-3.5 text-amber-400" />
        <span className="text-[#8888a0]" style={{ fontSize: "0.7rem", fontWeight: 500 }}>You might also want to explore:</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onSelect(s)}
            className="px-3 py-1.5 rounded-lg bg-[#1a1a28] border border-[#2a2a3e] text-[#c0c0d0] hover:border-[#ec5d25]/40 hover:text-white hover:bg-[#ec5d25]/10 transition-all cursor-pointer"
            style={{ fontSize: "0.72rem" }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ResultRenderer({ data }: { data: ResultData }) {
  switch (data.intent) {
    case "topic_ranking": return <TopicRankingResult data={data} />;
    case "topic_search":
    case "keyword_search":
    case "text_search": return <MentionsTable data={data} />;
    case "participant_query": return <ParticipantResult data={data} />;
    case "action_items": return <ActionItemsResult data={data} />;
    case "sentiment": return <SentimentResult data={data} />;
    case "duration": return <DurationResult data={data} />;
    case "competitor": return <CompetitorResult data={data} />;
    case "general_overview": return <OverviewResult data={data} />;
    default: return <MentionsTable data={data} />;
  }
}
