import { XAxis, Tooltip, ResponsiveContainer, AreaChart, Area } from "recharts";
import {
  RefreshCw, Loader2, Building2, ArrowUpRight, ChevronUp,
  TrendingUp, Wifi, WifiOff,
} from "lucide-react";
import { useData } from "./data-context";

export function DashboardPage() {
  const {
    calls, analytics, isLoading, isLive, error,
    refresh, refreshHubspot, isHubspotRefreshing, totalCallsFetched,
  } = useData();
  const { summary, callsByDay, topTopics } = analytics;

  const dayData = callsByDay.map((d) => ({ name: d.day.slice(0, 3), v: d.count }));
  const topicsData = topTopics.slice(0, 8).map((t) => ({ name: t.topic, v: t.count }));

  const total = (summary?.positiveSentiment ?? 0) + (summary?.neutralSentiment ?? 0) + (summary?.negativeSentiment ?? 0);
  const positivePct = total > 0 ? Math.round((summary!.positiveSentiment / total) * 100) : 0;

  if (isLoading) {
    return (
      <div className="h-full flex flex-col bg-dash-dark">
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 style={{ width: 28, height: 28, color: "#ec5d25" }} className="animate-spin" />
            <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-label)' }}>Loading dashboard…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-dash-dark">

      {/* ══ TOP: hero chart ══════════════════════════════════════════════════ */}
      <div className="h-1/2 relative overflow-hidden" style={{ paddingTop: 64 }}>
        <div className="absolute top-0 right-1/3 w-96 h-96 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(236,93,37,0.07) 0%, transparent 70%)" }} />

        <div className="relative h-full flex items-stretch">

          {/* LEFT: tagline + status */}
          <div className="flex flex-col justify-center gap-2 px-5 shrink-0" style={{ width: 310 }}>
            {/* <h1 className="text-white" style={{ letterSpacing: "-0.025em" }}>
              Sales intelligence for itilite
            </h1> */}
            <div>
              <p style={{ fontSize: 'var(--fs-label)', color: 'var(--card-label)' }}>
                {isLive ? "Fireflies.ai sync active" : "Offline mode"}
              </p>
              <div className="flex items-center gap-1.5 mt-2">
                {isLive ? (
                  <>
                    <Wifi style={{ width: 11, height: 11, color: "#22c55e" }} />
                    <span style={{ fontSize: 'var(--fs-tiny)', color: "#22c55e" }}>Live · {totalCallsFetched} calls</span>
                  </>
                ) : (
                  <>
                    <WifiOff style={{ width: 11, height: 11, color: "#f87171" }} />
                    <span style={{ fontSize: 'var(--fs-tiny)', color: "#f87171" }}>{error || "Offline"}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* CENTER: area chart */}
          <div className="flex-1 flex items-end overflow-hidden">
            <ResponsiveContainer width="100%" height="72%">
              <AreaChart data={dayData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="heroGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor="#ec5d25" stopOpacity={0.14} />
                    <stop offset="100%" stopColor="#ec5d25" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  tick={({ x, y, payload }) => {
                    // Always show "Mon", even if the value is zero or missing
                    // If data missing, ensure "Mon" appears
                    // (Assumes dayData always includes all 7 days in order, starting with "Mon")
                    return (
                      <text
                        x={x}
                        y={y + 10}
                        textAnchor="middle"
                        fill="#fffddd"
                        fontSize="var(--fs-tiny)"
                        fontWeight={payload.value === "Mon" ? 700 : 400}
                        style={payload.value === "Mon"
                          ? { letterSpacing: "0.02em" }
                          : {}}
                      >
                        {payload.value}
                      </text>
                    )
                  }}
                />
                <Tooltip
                  cursor={{ stroke: "rgba(236,93,37,0.2)", strokeWidth: 1 }}
                  contentStyle={{ background: "#111", border: "1px solid #2a2a2a", borderRadius: 8, fontSize: 'var(--fs-tiny)', color: "#ccc" }}
                  labelStyle={{ color: "#666" }}
                />
                <Area
                  type="monotone"
                  dataKey="v"
                  name="Calls"
                  stroke="#ec5d25"
                  strokeWidth={1.5}
                  fill="url(#heroGrad)"
                  dot={{
                    r: 3,
                    stroke: "#ec5d25",
                    strokeWidth: 0,
                    fill: "#ec5d25",
                  }}
                  activeDot={{
                    r: 5,
                    fill: "#fff",
                    stroke: "#ec5d25",
                    strokeWidth: 2,
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* RIGHT: stat card + buttons */}
          <div className="flex flex-col justify-center gap-3 px-10 shrink-0" style={{ width: 300 }}>
            <div className="border" style={{
                borderColor: 'var(--dash-card-border)',
                borderRadius: 'var(--card-r)',
                padding: 'var(--card-inner)',
                position: "relative"
              }}
            >
              <div className="flex items-center justify-between mb-1">
                <span style={{ fontSize: 'var(--fs-tiny)', color: "var(--card-label)" }}>Total Calls</span>
                {/* <ChevronUp style={{ width: 12, height: 12, color: 'var(--card-muted)' }} /> */}
                {/* Top right button (absolute positioned) */}
                <button
                  onClick={refresh}
                  title="Refresh calls"
                  className="flex items-center justify-center border transition-all"
                  style={{
                    width: 24,
                    height: 24,
                    position: "absolute",
                    top: 8,
                    right: 8,
                    background: "rgba(26,26,26,0.8)",
                    borderColor: "#2a2a2a",
                    color: 'var(--card-label)',
                    borderRadius: 'var(--card-r)',
                    zIndex: 2
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = "#fff")}
                  onMouseLeave={e => (e.currentTarget.style.color = "var(--card-label)")}
                >
                  <RefreshCw style={{ width: 12, height: 12 }} />
                </button>
              </div>
              <p style={{ fontSize: "2.8rem", fontWeight: 700, lineHeight: 1, color: 'var(--card-label)' }}>
                {summary?.totalCalls ?? 0}
              </p>
              <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-label)', marginTop: 4 }}>
                {positivePct}% positive sentiment
              </p>
            </div>
       
       
            
            {/* <div className="flex justify-center gap-2"> */}
              {/* <button
                onClick={refresh}
                title="Refresh calls"
                className="flex items-center justify-center border transition-all"
                style={{ width: 30, height: 30, background: "rgba(26,26,26,0.8)", borderColor: "#2a2a2a", color: 'var(--card-label)', borderRadius: 'var(--card-r)' }}
                onMouseEnter={e => (e.currentTarget.style.color = "#fff")}
                onMouseLeave={e => (e.currentTarget.style.color = "var(--card-label)")}
              >
                <RefreshCw style={{ width: 12, height: 12 }} />
              </button> */}
              {/* <button
                onClick={refreshHubspot}
                disabled={isHubspotRefreshing}
                title="Sync HubSpot"
                className="flex items-center justify-center border transition-all disabled:opacity-30"
                style={{ width: 30, height: 30, background: "rgba(26,26,26,0.8)", borderColor: "#2a2a2a", color: 'var(--card-label)', borderRadius: 'var(--card-r)' }}
                onMouseEnter={e => { if (!isHubspotRefreshing) e.currentTarget.style.color = "#fff"; }}
                onMouseLeave={e => (e.currentTarget.style.color = "var(--card-label)")}
              >
                {isHubspotRefreshing
                  ? <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" />
                  : <Building2 style={{ width: 12, height: 12 }} />}
              </button> */}
            {/* </div> */}
          </div>

        </div>
      </div>

      <hr style={{ border: "none", borderTop: "1px solid var(--dash-divider)", margin: "40px 25%", width: "50%" }} />

      {/* ══ BOTTOM: 3-column card grid ═══════════════════════════════════════ */}
      <div className="h-1/2" style={{ padding: 'var(--outer-pad)' }}>
        <div className="grid grid-cols-3 h-full" style={{ gap: 'var(--card-gap)' }}>

          {/* LEFT: Topics Extracted */}
          <div className="border border-dash-card-border flex flex-col overflow-hidden"
               style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', padding: 'var(--card-inner)' }}>
            <div className="flex items-start justify-between mb-1 shrink-0">
              <span style={{ fontSize: 'var(--fs-label)', color: 'var(--card-label)' }}>Topics Extracted</span>
              <ArrowUpRight style={{ width: 13, height: 13, color: 'var(--card-label)' }} />
            </div>
            <p style={{ fontSize: 'var(--fs-stat-lg)', fontWeight: 700, color: 'var(--dash-card-text)', lineHeight: 1 }}>
              {summary?.uniqueTopics ?? 0}
            </p>
            <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)', marginTop: 2 }}>
              {topTopics[0] ? `Top: ${topTopics[0].topic}` : "No topics yet"}
            </p>
            <div className="mt-4 flex-1 overflow-y-auto" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {topicsData.map((t) => (
                <div key={t.name}>
                  <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
                    <span style={{ fontSize: 'var(--fs-small)', color: 'var(--card-muted)' }}>{t.name}</span>
                    <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)' }}>{t.v}</span>
                  </div>
                  <div style={{ height: 2, background: 'var(--dash-track)', borderRadius: 9999 }}>
                    <div style={{
                      height: "100%",
                      width: `${(t.v / (topicsData[0]?.v || 1)) * 100}%`,
                      background: "#ec5d25",
                      borderRadius: 9999,
                    }} />
                  </div>
                </div>
              ))}
              {topicsData.length === 0 && (
                <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)' }}>No topic data</p>
              )}
            </div>
          </div>

          {/* CENTER: Call Sentiment + Active AEs stacked */}
          <div className="flex flex-col" style={{ gap: 'var(--card-gap)' }}>

            {/* Call Sentiment */}
            <div className="border border-dash-card-border flex-1 flex flex-col"
                 style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', padding: 'var(--card-inner)' }}>
              <div className="flex items-start justify-between mb-1">
                <span style={{ fontSize: 'var(--fs-label)', color: 'var(--card-label)' }}>Call Sentiment</span>
                <ArrowUpRight style={{ width: 13, height: 13, color: 'var(--card-label)' }} />
              </div>
              <p style={{ fontSize: 'var(--fs-stat)', fontWeight: 700, color: 'var(--dash-card-text)', lineHeight: 1 }}>
                {positivePct}%
              </p>
              <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-muted)', marginTop: 2 }}>
                {positivePct >= 60 ? "Positive trend" : positivePct >= 40 ? "Mixed sentiment" : "Needs attention"}
              </p>
              <div className="mt-auto pt-4" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  { label: "Positive", value: summary?.positiveSentiment ?? 0, color: "#22c55e" },
                  { label: "Neutral",  value: summary?.neutralSentiment  ?? 0, color: "#f59e0b" },
                  { label: "Negative", value: summary?.negativeSentiment ?? 0, color: "#ef4444" },
                ].map(({ label, value, color }) => (
                  <div key={label}>
                    <div className="flex justify-between" style={{ marginBottom: 4 }}>
                      <span style={{ fontSize: 'var(--fs-small)', color: 'var(--card-muted)' }}>{label}</span>
                      <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)' }}>{value}</span>
                    </div>
                    <div style={{ height: 3, background: 'var(--dash-track)', borderRadius: 9999 }}>
                      <div style={{
                        height: "100%",
                        width: `${total > 0 ? (value / total) * 100 : 0}%`,
                        background: color,
                        borderRadius: 9999,
                        transition: "width 0.5s",
                      }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Active AEs */}
            <div className="border border-dash-card-border flex-1 flex flex-col"
                 style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', padding: 'var(--card-inner)' }}>
              <div className="flex items-start justify-between mb-1">
                <span style={{ fontSize: 'var(--fs-label)', color: 'var(--card-label)' }}>Active AEs</span>
                <ArrowUpRight style={{ width: 13, height: 13, color: 'var(--card-label)' }} />
              </div>
              <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)' }}>from HubSpot</p>
              <p style={{ fontSize: 'var(--fs-stat)', fontWeight: 700, color: 'var(--dash-card-text)', lineHeight: 1, marginTop: 4 }}>
                {summary?.activeAEs ?? 0}
              </p>
              <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-muted)', marginTop: 4 }}>
                {summary?.totalActionItems ?? 0} action items
              </p>
            </div>
          </div>

          {/* RIGHT: Recent Calls */}
          <div className="border border-dash-card-border flex flex-col overflow-hidden"
               style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)' }}>
            <div className="flex items-center justify-between border-b border-dash-card-border shrink-0"
                 style={{ padding: 'var(--card-inner)' }}>
              <span style={{ fontSize: 'var(--fs-label)', color: 'var(--card-label)' }}>Recent Calls</span>
              <TrendingUp style={{ width: 13, height: 13, color: 'var(--card-label)' }} />
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-dash-divider">
              {calls.length === 0 ? (
                <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)', padding: 'var(--card-inner)' }}>No calls yet</p>
              ) : calls.slice(0, 10).map((call) => (
                <div key={call.id} className="flex items-center gap-3 hover:bg-dash-card-hover transition-colors"
                     style={{ padding: '8px var(--card-inner)' }}>
                  <div className="flex-1 min-w-0">
                    <p className="truncate" style={{ fontSize: 'var(--fs-small)', color: 'var(--dash-card-text)' }}>{call.title}</p>
                    <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', marginTop: 1 }}>
                      {call.aeName} · {call.date}
                    </p>
                  </div>
                  <span style={{
                    fontSize: 'var(--fs-tiny)',
                    padding: "2px 7px",
                    borderRadius: 9999,
                    flexShrink: 0,
                    background: call.sentiment === "positive" ? "rgba(34,197,94,0.12)" : call.sentiment === "negative" ? "rgba(239,68,68,0.12)" : "rgba(245,158,11,0.12)",
                    color: call.sentiment === "positive" ? "#4ade80" : call.sentiment === "negative" ? "#f87171" : "#fbbf24",
                  }}>
                    {call.sentiment}
                  </span>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>

    </div>
  );
}
