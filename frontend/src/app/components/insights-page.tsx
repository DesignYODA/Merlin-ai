import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router";
import { TrendingUp, TrendingDown, Globe, Package, AlertTriangle, Loader2, Megaphone, Users, Handshake, ChevronRight, ExternalLink, X, Search } from "lucide-react";
import { Line, LineChart, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { useData } from "./data-context";
import { getHubspotFlatData } from "../api";
import type { HubspotFlatRow } from "./calls-library-page";
import type { HubspotDealLinkState } from "./library-nav-state";

// Sales stage stat cards — each maps to an exact HubSpot dealstage_label.
// "Meetings Lost" intentionally maps to the Opportunities pipeline's "Lost"
// stage (not the Leads pipeline's "Meeting Not Done") per product decision.
const SALES_STAGE_CARDS: { key: string; label: string; stage: string; color: string }[] = [
  { key: "churned",         label: "Companies Churned", stage: "Churned",         color: "#f87171" },
  { key: "contract_signed", label: "Contract Signed",   stage: "Contract Signed", color: "#4ade80" },
  { key: "meetings_lost",   label: "Meetings Lost",     stage: "Lost",            color: "#fbbf24" },
  { key: "nurture",         label: "Nurture",           stage: "Nurture",         color: "#60a5fa" },
];

type DealWithCompany = {
  deal_id: string; deal_name: string; deal_amount: string; deal_stage: string;
  deal_closedate: string; deal_pipeline: string; company_id: string; company_name: string;
};

// Fixed-order categorical palette (identity, never cycled) — reused from the
// stat-card colors already established elsewhere in this component.
const SERIES_COLORS = ["#ec5d25", "#60a5fa", "#fbbf24", "#4ade80", "#f87171"];

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1).toLocaleString("en-US", { month: "short" });
}

// Topics dropped from the Product graph/keyword list entirely — matched by substring,
// so e.g. "itilite demo", "finance teams", "sales team sync" are all excluded.
const EXCLUDED_TOPIC_SUBSTRINGS = ["discovery call", "itilite", "healthcare staffing", "locum staffing", "finance team", "sales team"];

// Any topic containing one of these substrings is merged under the given label —
// e.g. "corporate card" and "credit card" both roll up into "Card". Everything else stays separate.
const GROUPED_TOPIC_RULES: { match: string; label: string }[] = [
  { match: "card", label: "Card" },
  { match: "expense", label: "Expense" },
  { match: "travel", label: "Travel" },
];

type TopicCount = { topic: string; count: number; callIds: string[] };

// Maps each topic's callIds against Glisseo's call list, keeping only external calls
// (externalParticipants.length > 0) — internal-only calls never count toward the graph.
function groupTopics(topics: TopicCount[], externalCallIds: Set<string>): TopicCount[] {
  const groups = new Map<string, { topic: string; callIds: Set<string> }>();
  for (const t of topics) {
    const lower = t.topic.trim().toLowerCase();
    if (EXCLUDED_TOPIC_SUBSTRINGS.some((s) => lower.includes(s))) continue;

    const externalIds = t.callIds.filter((id) => externalCallIds.has(id));
    if (externalIds.length === 0) continue;

    const rule = GROUPED_TOPIC_RULES.find((r) => lower.includes(r.match));
    const key = rule ? rule.label : t.topic;

    const existing = groups.get(key);
    if (existing) {
      externalIds.forEach((id) => existing.callIds.add(id));
    } else {
      groups.set(key, { topic: key, callIds: new Set(externalIds) });
    }
  }
  return [...groups.values()].map((g) => ({ topic: g.topic, count: g.callIds.size, callIds: [...g.callIds] }));
}

type InsightsTab = "product" | "marketing" | "founders" | "sales";

const TABS: { id: InsightsTab; label: string; icon: typeof Package }[] = [
  { id: "product",   label: "Product",   icon: Package },
  { id: "marketing", label: "Marketing", icon: Megaphone },
  { id: "founders",  label: "Founders",  icon: Users },
  { id: "sales",     label: "Sales",     icon: Handshake },
];

export function InsightsPage() {
  const navigate = useNavigate();
  const { calls, analytics, isLoading, isLive } = useData();
  const { summary, topTopics, topAEs } = analytics;
  const externalCallIds = useMemo(
    () => new Set(calls.filter((c) => c.externalParticipants.length > 0).map((c) => c.id)),
    [calls]
  );
  const groupedTopics = useMemo(() => groupTopics(topTopics, externalCallIds), [topTopics, externalCallIds]);
  const [activeTab, setActiveTab] = useState<InsightsTab>("product");
  const [excludedKeywords, setExcludedKeywords] = useState<Set<string>>(new Set());
  const [openKeywordTopic, setOpenKeywordTopic] = useState<string | null>(null);
  const [keywordSearch, setKeywordSearch] = useState("");

  // HubSpot deals — fetched lazily on first visit to the Sales tab, mirroring
  // calls-library-page.tsx's own fetch-on-first-use pattern for the same data.
  const [hsRows, setHsRows] = useState<HubspotFlatRow[]>([]);
  const [hsFetched, setHsFetched] = useState(false);
  const [hsLoading, setHsLoading] = useState(false);
  const [hsError, setHsError] = useState<string | null>(null);
  const [openSalesStage, setOpenSalesStage] = useState<string | null>(null);

  useEffect(() => {
    if (activeTab !== "sales" || hsFetched) return;
    setHsLoading(true);
    setHsError(null);
    getHubspotFlatData()
      .then((res) => {
        setHsRows((res.rows || []) as HubspotFlatRow[]);
        setHsFetched(true);
      })
      .catch((err) => setHsError(err instanceof Error ? err.message : "Failed to load HubSpot data"))
      .finally(() => setHsLoading(false));
  }, [activeTab, hsFetched]);

  // Every deal across every company, flattened with its parent company attached —
  // a company can have several deals, each with its own stage, so the stage counts
  // must be computed over deals (not one stage per company).
  const allDeals = useMemo<DealWithCompany[]>(
    () => hsRows.flatMap((r) =>
      (r.all_deals || []).map((d) => ({ ...d, company_id: r.company_id, company_name: r.company_name }))
    ),
    [hsRows]
  );

  // Grouped once so the 4 sales stat cards (and the modal) don't each re-filter
  // the full deal list on every render — was O(allDeals) × 4 per render before.
  const dealsByStage = useMemo(() => {
    const map = new Map<string, DealWithCompany[]>();
    for (const d of allDeals) {
      const list = map.get(d.deal_stage);
      if (list) list.push(d);
      else map.set(d.deal_stage, [d]);
    }
    return map;
  }, [allDeals]);

  const toggleKeyword = (topic: string) => {
    setExcludedKeywords((prev) => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });
  };

  const totalCalls = summary?.totalCalls ?? 0;

  const statCards = useMemo(() => [
    { label: "Top Keyword",    value: topTopics[0]?.topic ?? "N/A",                                                                    sub: topTopics[0] ? `${topTopics[0].count} mentions` : "",     icon: TrendingUp,    color: "#ec5d25" },
    { label: "Most Active AE", value: topAEs[0]?.aeName ?? "N/A",                                                                      sub: topAEs[0] ? `${topAEs[0].callCount} calls` : "",          icon: Globe,         color: "#4ade80" },
    { label: "Action Items",   value: String(summary?.totalActionItems ?? 0),                                                           sub: `from ${totalCalls} calls`,                               icon: Package,       color: "#fbbf24" },
    { label: "Sentiment",      value: `${summary?.positiveSentiment ?? 0} / ${summary?.negativeSentiment ?? 0}`,                        sub: "positive / negative",                                    icon: AlertTriangle, color: "#f87171" },
  ], [topTopics, topAEs, summary, totalCalls]);

  // The Product tab's whole trend pipeline (filter → month-bucket every call
  // date → build chart series) — previously recomputed on every render while
  // that tab was visible instead of only when the underlying data changed.
  const productTrend = useMemo(() => {
    const trending = groupedTopics.filter((t) => t.count > 5).sort((a, b) => b.count - a.count);
    if (trending.length === 0) {
      return { trending, maxCount: 1, months: [] as string[], chartData: [] as Record<string, string | number>[], lastTotal: 0, delta: 0, trendingUp: true };
    }

    const maxCount = Math.max(...trending.map((t) => t.count), 1);

    const callDateMap = new Map(calls.map((c) => [c.id, c.dateTimestamp]));
    const monthSet = new Set<string>();
    trending.forEach((t) => t.callIds.forEach((id) => {
      const ts = callDateMap.get(id);
      if (ts) monthSet.add(monthKey(ts));
    }));
    const months = [...monthSet].sort();

    const countInMonth = (callIds: string[], mk: string) =>
      callIds.filter((id) => {
        const ts = callDateMap.get(id);
        return ts !== undefined && monthKey(ts) === mk;
      }).length;

    const chartData = months.map((mk) => {
      const row: Record<string, string | number> = { month: monthLabel(mk) };
      trending.forEach((t) => { row[t.topic] = countInMonth(t.callIds, mk); });
      return row;
    });

    const monthTotals = months.map((mk) =>
      trending.reduce((sum, t) => sum + countInMonth(t.callIds, mk), 0)
    );
    const lastTotal = monthTotals[monthTotals.length - 1] ?? 0;
    const prevTotal = monthTotals[monthTotals.length - 2] ?? 0;
    const delta = prevTotal > 0 ? Math.round(((lastTotal - prevTotal) / prevTotal) * 100) : (lastTotal > 0 ? 100 : 0);
    const trendingUp = delta >= 0;

    return { trending, maxCount, months, chartData, lastTotal, delta, trendingUp };
  }, [groupedTopics, calls]);

  // Calls matching the currently-open keyword modal — was calls.find() per
  // callId (O(callIds × calls)) recomputed on every render while the modal
  // was open; a Map lookup plus computing it only when the topic changes fixes both.
  const matchedKeywordCalls = useMemo(() => {
    const topic = groupedTopics.find((t) => t.topic === openKeywordTopic);
    if (!topic) return [];
    const callsById = new Map(calls.map((c) => [c.id, c]));
    return topic.callIds
      .map((id) => callsById.get(id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .sort((a, b) => (b.dateTimestamp || 0) - (a.dateTimestamp || 0));
  }, [groupedTopics, openKeywordTopic, calls]);

  // Deals for the currently-open sales stage modal, sorted — reuses the
  // dealsByStage grouping above instead of re-filtering allDeals.
  const sortedStageDeals = useMemo(() => {
    const card = SALES_STAGE_CARDS.find((c) => c.key === openSalesStage);
    const list = card ? (dealsByStage.get(card.stage) || []) : [];
    return [...list].sort((a, b) => (b.deal_closedate || "").localeCompare(a.deal_closedate || ""));
  }, [dealsByStage, openSalesStage]);

  if (isLoading) {
    return (
      <div className="h-full bg-dash-dark flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 style={{ width: 28, height: 28, color: "#ec5d25" }} className="animate-spin" />
          <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-label)' }}>Generating insights…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full bg-dash-dark overflow-y-auto" style={{ paddingTop: 64 }}>
      <div style={{ padding: 'var(--card-inner)', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Header */}
        <div style={{ padding: '8px 0' }}>
          <h1 className="text-white">Insights</h1>
          <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-label)', marginTop: 4 }}>
            {isLive ? `Auto-generated from ${totalCalls} Fireflies calls` : "Intelligence from your call data"}
          </p>
        </div>

        {/* ── Component 1: Overview ── */}
        {/* <div className="grid grid-cols-4 gap-[var(--card-gap)]">
          {statCards.map((stat) => (
            <div key={stat.label} className="border flex flex-col"
                 style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', padding: 'var(--card-inner)', borderColor: 'var(--dash-card-border)' }}>
              <div className="flex items-center gap-2 mb-2">
                <stat.icon style={{ width: 13, height: 13, color: stat.color, flexShrink: 0 }} />
                <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-label)' }}>{stat.label}</span>
              </div>
              <p className="truncate" style={{ fontSize: 'var(--fs-stat)', fontWeight: 700, color: 'var(--dash-card-text)', lineHeight: 1 }}>
                {stat.value}
              </p>
              <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', marginTop: 4 }}>{stat.sub}</p>
            </div>
          ))}
        </div> */}

        {/* ── Component 2: Product / Marketing / Founders / Sales toggle ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="inline-flex" style={{
            padding: 4, borderRadius: 9999, background: 'var(--card-bg)',
            border: '1px solid var(--dash-card-border)', width: 'fit-content', gap: 4,
          }}>
            {TABS.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className="flex items-center gap-2 transition-colors"
                  style={{
                    padding: '8px 16px', borderRadius: 9999, border: 'none', cursor: 'pointer',
                    fontSize: 'var(--fs-small)', fontWeight: 600,
                    background: active ? 'var(--brand-orange)' : 'transparent',
                    color: active ? '#fff' : 'var(--card-label)',
                  }}
                >
                  <tab.icon style={{ width: 14, height: 14 }} />
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Tab content */}
          {activeTab === "product" && (() => {
            const { trending, maxCount, months, chartData, lastTotal, delta, trendingUp } = productTrend;

            if (trending.length === 0) {
              return (
                <div className="flex flex-col items-center justify-center" style={{ padding: 48, minHeight: 260 }}>
                  <Package style={{ width: 28, height: 28, color: 'var(--card-subtle)', marginBottom: 8 }} />
                  <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)' }}>No trending topics with more than 5 mentions yet</p>
                </div>
              );
            }

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--card-gap)' }}>
                <div className="grid grid-cols-2 gap-[var(--card-gap)]">
                  {/* Stat card 1 — horizontal keyword counts */}
                  <div className="border" style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', borderColor: 'var(--dash-card-border)', padding: 'var(--card-inner)' }}>
                    <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-label)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 14 }}>
                      Top Keywords
                    </p>
                    <div className="flex items-center gap-2" style={{
                      padding: '6px 10px', borderRadius: 'var(--card-r)', marginBottom: 12,
                      background: 'var(--dash-track)', border: '1px solid var(--dash-card-border)',
                    }}>
                      <Search style={{ width: 13, height: 13, color: 'var(--card-subtle)', flexShrink: 0 }} />
                      <input
                        value={keywordSearch}
                        onChange={(e) => setKeywordSearch(e.target.value)}
                        placeholder="Search keywords…"
                        className="flex-1 bg-transparent border-none outline-none"
                        style={{ fontSize: 'var(--fs-tiny)', color: 'var(--dash-card-text)' }}
                      />
                      {keywordSearch && (
                        <button
                          onClick={() => setKeywordSearch("")}
                          className="flex items-center justify-center transition-opacity hover:opacity-70"
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}
                        >
                          <X style={{ width: 12, height: 12, color: 'var(--card-subtle)' }} />
                        </button>
                      )}
                    </div>
                    {(() => {
                      const visibleKeywords = trending.filter((topic) =>
                        topic.topic.toLowerCase().includes(keywordSearch.trim().toLowerCase())
                      );
                      if (visibleKeywords.length === 0) {
                        return (
                          <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', padding: '8px 0' }}>
                            No keywords match "{keywordSearch}"
                          </p>
                        );
                      }
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 260, overflowY: 'auto' }}>
                          {visibleKeywords.map((topic) => {
                            const i = trending.indexOf(topic);
                            return (
                              <button
                                key={topic.topic}
                                onClick={() => setOpenKeywordTopic(topic.topic)}
                                className="flex items-center gap-2 transition-opacity hover:opacity-80"
                                style={{ width: '100%', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                              >
                                <span className="truncate" style={{ width: 96, flexShrink: 0, fontSize: 'var(--fs-tiny)', color: 'var(--card-muted)' }}>
                                  {topic.topic}
                                </span>
                                <div style={{ flex: 1, height: 8, background: 'var(--dash-track)', borderRadius: 9999, overflow: 'hidden' }}>
                                  <div style={{ width: `${Math.round((topic.count / maxCount) * 100)}%`, height: '100%', background: SERIES_COLORS[i % SERIES_COLORS.length], borderRadius: 9999 }} />
                                </div>
                                <span style={{ width: 20, textAlign: 'right', flexShrink: 0, fontSize: 'var(--fs-small)', fontWeight: 700, color: 'var(--dash-card-text)' }}>
                                  {topic.count}
                                </span>
                                <ChevronRight style={{ width: 13, height: 13, color: 'var(--card-subtle)', flexShrink: 0 }} />
                              </button>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Stat card 2 — keyword trend headline */}
                  <div className="border flex flex-col" style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', borderColor: 'var(--dash-card-border)', padding: 'var(--card-inner)' }}>
                    <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
                      <TrendingUp style={{ width: 13, height: 13, color: '#ec5d25', flexShrink: 0 }} />
                      <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-label)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
                        Keyword Trend
                      </span>
                    </div>
                    <p style={{ fontSize: 'var(--fs-stat)', fontWeight: 700, color: 'var(--dash-card-text)', lineHeight: 1 }}>
                      {lastTotal}
                    </p>
                    <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', marginTop: 4 }}>
                      mentions this month across top {trending.length} keyword{trending.length !== 1 ? "s" : ""}
                    </p>
                    {months.length > 1 && (
                      <div className="flex items-center gap-1" style={{ marginTop: 10 }}>
                        {trendingUp
                          ? <TrendingUp style={{ width: 12, height: 12, color: '#4ade80' }} />
                          : <TrendingDown style={{ width: 12, height: 12, color: '#f87171' }} />}
                        <span style={{ fontSize: 'var(--fs-tiny)', fontWeight: 600, color: trendingUp ? '#4ade80' : '#f87171' }}>
                          {trendingUp ? "+" : ""}{delta}%
                        </span>
                        <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)' }}>vs last month</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Bottom card — monthly trend graph */}
                <div className="border" style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', borderColor: 'var(--dash-card-border)', padding: 'var(--card-inner)' }}>
                  <div className="flex items-center justify-between flex-wrap" style={{ gap: 10, marginBottom: 12 }}>
                    <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-label)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
                      Keyword Mentions by Month
                    </p>
                    {/* Filter — click a keyword to toggle it on the graph; all shown by default */}
                    <div className="flex items-center flex-wrap" style={{ gap: 6 }}>
                      {trending.map((topic, i) => {
                        const on = !excludedKeywords.has(topic.topic);
                        const color = SERIES_COLORS[i % SERIES_COLORS.length];
                        return (
                          <button
                            key={topic.topic}
                            onClick={() => toggleKeyword(topic.topic)}
                            className="flex items-center gap-1.5 transition-opacity"
                            style={{
                              padding: '3px 9px', borderRadius: 9999, cursor: 'pointer',
                              fontSize: 'var(--fs-tiny)', fontWeight: 600,
                              border: `1px solid ${on ? color : 'var(--dash-card-border)'}`,
                              background: on ? `${color}1a` : 'transparent',
                              color: on ? color : 'var(--card-subtle)',
                              opacity: on ? 1 : 0.6,
                            }}
                          >
                            <span style={{ width: 6, height: 6, borderRadius: 9999, background: on ? color : 'var(--card-subtle)', flexShrink: 0 }} />
                            {topic.topic}
                          </button>
                        );
                      })}
                      {excludedKeywords.size < trending.length && (
                        <button
                          onClick={() => setExcludedKeywords(new Set(trending.map((t) => t.topic)))}
                          className="transition-opacity hover:opacity-70"
                          style={{
                            padding: '3px 9px', borderRadius: 9999, cursor: 'pointer',
                            fontSize: 'var(--fs-tiny)', fontWeight: 600,
                            border: '1px solid var(--dash-card-border)', background: 'transparent',
                            color: '#f87171',
                          }}
                        >
                          Clear all
                        </button>
                      )}
                    </div>
                  </div>
                  {months.length < 2 ? (
                    <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)', padding: '24px 0' }}>
                      Not enough monthly history yet to plot a trend.
                    </p>
                  ) : excludedKeywords.size === trending.length ? (
                    <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)', padding: '24px 0' }}>
                      No keywords selected — click a keyword above to show it.
                    </p>
                  ) : (
                    <ResponsiveContainer width="100%" height={260}>
                      <LineChart data={chartData} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                        <CartesianGrid vertical={false} stroke="var(--dash-divider)" />
                        <XAxis
                          dataKey="month"
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: 'var(--card-subtle)', fontSize: 13 }}
                        />
                        <YAxis
                          allowDecimals={false}
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: 'var(--card-subtle)', fontSize: 13 }}
                        />
                        <Tooltip
                          cursor={{ stroke: "rgba(236,93,37,0.2)", strokeWidth: 1 }}
                          contentStyle={{ background: "#111", border: "1px solid #2a2a2a", borderRadius: 8, fontSize: 'var(--fs-tiny)', color: "#ccc" }}
                          labelStyle={{ color: "#666" }}
                        />
                        {trending.filter((topic) => !excludedKeywords.has(topic.topic)).map((topic) => {
                          const i = trending.indexOf(topic);
                          const color = SERIES_COLORS[i % SERIES_COLORS.length];
                          return (
                            <Line
                              key={topic.topic}
                              type="monotone"
                              dataKey={topic.topic}
                              name={topic.topic}
                              stroke={color}
                              strokeWidth={2}
                              dot={{ r: 3, strokeWidth: 0, fill: color }}
                              activeDot={{ r: 5, fill: "#fff", stroke: color, strokeWidth: 2 }}
                            />
                          );
                        })}
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>
            );
          })()}

          {activeTab === "sales" && (() => {
            if (hsLoading && !hsFetched) {
              return (
                <div className="flex items-center justify-center gap-2" style={{ padding: 48, minHeight: 260 }}>
                  <Loader2 className="animate-spin" style={{ width: 20, height: 20, color: '#ec5d25' }} />
                  <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-label)' }}>Loading HubSpot deals…</p>
                </div>
              );
            }
            if (hsError) {
              return (
                <div className="flex flex-col items-center justify-center" style={{ padding: 48, minHeight: 260 }}>
                  <AlertTriangle style={{ width: 28, height: 28, color: '#f87171', marginBottom: 8 }} />
                  <p style={{ fontSize: 'var(--fs-small)', color: '#f87171' }}>{hsError}</p>
                </div>
              );
            }
            return (
              <div className="grid grid-cols-4 gap-[var(--card-gap)]">
                {SALES_STAGE_CARDS.map((card) => {
                  const matches = dealsByStage.get(card.stage) || [];
                  return (
                    <button
                      key={card.key}
                      onClick={() => setOpenSalesStage(card.key)}
                      className="border flex flex-col transition-opacity hover:opacity-90"
                      style={{
                        background: 'var(--card-bg)', borderRadius: 'var(--card-r)', padding: 'var(--card-inner)',
                        borderColor: 'var(--dash-card-border)', textAlign: 'left', cursor: 'pointer',
                      }}
                    >
                      <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                        <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-label)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
                          {card.label}
                        </span>
                        <ChevronRight style={{ width: 14, height: 14, color: 'var(--card-subtle)', flexShrink: 0 }} />
                      </div>
                      <p style={{ fontSize: 'var(--fs-stat)', fontWeight: 700, color: card.color, lineHeight: 1 }}>
                        {matches.length}
                      </p>
                      <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', marginTop: 4 }}>
                        deal{matches.length !== 1 ? "s" : ""}
                      </p>
                    </button>
                  );
                })}
              </div>
            );
          })()}

          {activeTab !== "product" && activeTab !== "sales" && TABS.filter((t) => t.id === activeTab).map((tab) => (
            <div key={tab.id} className="flex flex-col items-center justify-center"
                 style={{ padding: 48, minHeight: 260 }}>
              <tab.icon style={{ width: 28, height: 28, color: 'var(--card-subtle)', marginBottom: 8 }} />
              <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)' }}>{tab.label} insights coming soon</p>
            </div>
          ))}
        </div>

      </div>

      {/* ── Keyword calls modal ── */}
      {openKeywordTopic && (() => {
        const matchedCalls = matchedKeywordCalls;

        return (
          <div
            className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center"
            style={{ animation: "fadeInOverlay 0.2s ease-out", padding: 24 }}
            onClick={() => setOpenKeywordTopic(null)}
          >
            <div
              className="border w-full"
              style={{
                maxWidth: 480, maxHeight: '70vh', display: 'flex', flexDirection: 'column',
                background: 'var(--card-bg)', borderColor: 'var(--dash-card-border)', borderRadius: 'var(--card-r)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between border-b shrink-0" style={{ padding: 'var(--card-inner)', borderColor: 'var(--dash-card-border)' }}>
                <div>
                  <p style={{ fontSize: 'var(--fs-small)', fontWeight: 700, color: 'var(--dash-card-text)' }}>{openKeywordTopic}</p>
                  <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', marginTop: 2 }}>
                    {matchedCalls.length} call{matchedCalls.length !== 1 ? "s" : ""} mentioned this keyword
                  </p>
                </div>
                <button
                  onClick={() => setOpenKeywordTopic(null)}
                  className="flex items-center justify-center border transition-all hover:text-white shrink-0"
                  style={{ width: 28, height: 28, borderRadius: 'var(--card-r)', background: 'var(--card-bg)', borderColor: 'var(--dash-card-border)', color: 'var(--card-label)' }}
                >
                  <X style={{ width: 13, height: 13 }} />
                </button>
              </div>

              <div style={{ overflowY: 'auto', padding: 8 }}>
                {matchedCalls.length === 0 ? (
                  <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)', padding: 16 }}>No calls found for this keyword.</p>
                ) : (
                  matchedCalls.map((call) => {
                    const hasLink = call.transcriptUrl && call.transcriptUrl !== "#";
                    const Row = hasLink ? "a" : "div";
                    return (
                      <Row
                        key={call.id}
                        {...(hasLink ? { href: call.transcriptUrl, target: "_blank", rel: "noopener noreferrer" } : {})}
                        className="flex items-center gap-3 transition-colors hover:bg-dash-card-hover"
                        style={{ padding: '10px 12px', borderRadius: 'var(--card-r)', textDecoration: 'none' }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p className="truncate" style={{ fontSize: 'var(--fs-small)', fontWeight: 600, color: 'var(--dash-card-text)' }}>{call.title}</p>
                          <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', marginTop: 2 }}>
                            {call.aeName} · {call.date}
                          </p>
                        </div>
                        {hasLink && <ExternalLink style={{ width: 13, height: 13, color: 'var(--card-subtle)', flexShrink: 0 }} />}
                      </Row>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Sales stage deals modal ── */}
      {openSalesStage && (() => {
        const card = SALES_STAGE_CARDS.find((c) => c.key === openSalesStage);
        const matchedDeals = sortedStageDeals;

        return (
          <div
            className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center"
            style={{ animation: "fadeInOverlay 0.2s ease-out", padding: 24 }}
            onClick={() => setOpenSalesStage(null)}
          >
            <div
              className="border w-full"
              style={{
                maxWidth: 520, maxHeight: '70vh', display: 'flex', flexDirection: 'column',
                background: 'var(--card-bg)', borderColor: 'var(--dash-card-border)', borderRadius: 'var(--card-r)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between border-b shrink-0" style={{ padding: 'var(--card-inner)', borderColor: 'var(--dash-card-border)' }}>
                <div>
                  <p style={{ fontSize: 'var(--fs-small)', fontWeight: 700, color: 'var(--dash-card-text)' }}>{card?.label}</p>
                  <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', marginTop: 2 }}>
                    {matchedDeals.length} deal{matchedDeals.length !== 1 ? "s" : ""} in stage "{card?.stage}"
                  </p>
                </div>
                <button
                  onClick={() => setOpenSalesStage(null)}
                  className="flex items-center justify-center border transition-all hover:text-white shrink-0"
                  style={{ width: 28, height: 28, borderRadius: 'var(--card-r)', background: 'var(--card-bg)', borderColor: 'var(--dash-card-border)', color: 'var(--card-label)' }}
                >
                  <X style={{ width: 13, height: 13 }} />
                </button>
              </div>

              <div style={{ overflowY: 'auto', padding: 8 }}>
                {matchedDeals.length === 0 ? (
                  <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)', padding: 16 }}>No deals found in this stage.</p>
                ) : (
                  matchedDeals.map((deal) => (
                    <button
                      key={deal.deal_id}
                      onClick={() => navigate("/library", {
                        state: { hubspotCompanyId: deal.company_id, hubspotDealId: deal.deal_id } satisfies HubspotDealLinkState,
                      })}
                      className="w-full flex items-center gap-3 transition-colors hover:bg-dash-card-hover"
                      style={{ padding: '10px 12px', borderRadius: 'var(--card-r)', textAlign: 'left', cursor: 'pointer' }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p className="truncate" style={{ fontSize: 'var(--fs-small)', fontWeight: 600, color: 'var(--dash-card-text)' }}>
                          {deal.deal_name || deal.company_name || "Unnamed deal"}
                        </p>
                        <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', marginTop: 2 }}>
                          {deal.company_name}{deal.deal_amount ? ` · $${deal.deal_amount}` : ""}{deal.deal_closedate ? ` · ${deal.deal_closedate.slice(0, 10)}` : ""}
                        </p>
                      </div>
                      {deal.deal_pipeline && (
                        <span style={{
                          fontSize: 'var(--fs-tiny)', fontWeight: 600, padding: '3px 9px', borderRadius: 9999,
                          background: `${card?.color}1a`, color: card?.color, flexShrink: 0,
                        }}>
                          {deal.deal_pipeline}
                        </span>
                      )}
                      <ChevronRight style={{ width: 13, height: 13, color: 'var(--card-subtle)', flexShrink: 0 }} />
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
