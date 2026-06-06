import React, { useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import { TrendingUp, Globe, Package, AlertTriangle, Zap, Loader2, ExternalLink } from "lucide-react";
import { useData } from "./data-context";

function renderBoldText(text: string): React.JSX.Element {
  let cleaned = text.replace(/^[\s]*[-•*]\s+/, "").trim();
  const parts = cleaned.split(/(\*\*[^*]+\*\*)/g);
  return (
    <span>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={i} className="text-white font-semibold">{part.slice(2, -2)}</strong>;
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}

export function InsightsPage() {
  const { analytics, isLoading, isLive } = useData();
  const { summary, topTopics, topAEs, callActionItems } = analytics;

  const keywordChartData = useMemo(() => {
    const seen = new Set<string>();
    return topTopics.slice(0, 10).map((t, i) => {
      let name = (t.topic || `kw-${i}`).slice(0, 20);
      while (seen.has(name)) name = `${name} (${i})`;
      seen.add(name);
      return { name, count: t.count };
    });
  }, [topTopics]);

  const totalCalls = summary?.totalCalls ?? 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-[#ec5d25] animate-spin" />
          <p className="text-[#8888a0]" style={{ fontSize: "0.875rem" }}>Generating insights…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-white" style={{ fontSize: "1.75rem", fontWeight: 700 }}>Insights</h1>
        <p className="text-[#8888a0] mt-1" style={{ fontSize: "0.875rem" }}>
          {isLive ? `Auto-generated from ${totalCalls} Fireflies calls` : "Intelligence from your call data"}
        </p>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          { label: "Top Keyword",   value: topTopics[0]?.topic ?? "N/A",       sub: topTopics[0] ? `${topTopics[0].count} mentions` : "",                      icon: TrendingUp,   color: "text-[#ec5d25]" },
          { label: "Most Active AE", value: topAEs[0]?.aeName ?? "N/A",        sub: topAEs[0] ? `${topAEs[0].callCount} calls` : "",                           icon: Globe,        color: "text-emerald-400" },
          { label: "Action Items",  value: String(summary?.totalActionItems ?? 0), sub: `From ${totalCalls} calls`,                                            icon: Package,      color: "text-amber-400" },
          { label: "Sentiment",     value: `${summary?.positiveSentiment ?? 0} pos / ${summary?.negativeSentiment ?? 0} neg`, sub: `${totalCalls} total calls`, icon: AlertTriangle, color: "text-rose-400" },
        ].map((stat) => (
          <div key={stat.label} className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <stat.icon className={`w-4 h-4 ${stat.color}`} />
              <span className="text-[#8888a0]" style={{ fontSize: "0.8rem" }}>{stat.label}</span>
            </div>
            <p className="text-white truncate" style={{ fontSize: "1.1rem", fontWeight: 700 }}>{stat.value}</p>
            <p className="text-[#555568] mt-1" style={{ fontSize: "0.75rem" }}>{stat.sub}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Keywords Chart */}
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-6">
          <h3 className="text-white mb-4" style={{ fontSize: "1rem", fontWeight: 600 }}>Top Keywords</h3>
          {keywordChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={keywordChartData}>
                <XAxis dataKey="name" stroke="#8888a0" style={{ fontSize: "0.65rem" }} angle={-30} textAnchor="end" height={80} />
                <YAxis type="number" stroke="#8888a0" style={{ fontSize: "0.75rem" }} allowDecimals={false} />
                <Tooltip contentStyle={{ backgroundColor: "#1e1e2e", border: "1px solid #2e2e4e", borderRadius: "8px", fontSize: "0.8rem" }} />
                <Bar dataKey="count" fill="#ec5d25" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[280px] text-[#555568]" style={{ fontSize: "0.85rem" }}>No keyword data available</div>
          )}
        </div>

        {/* Top AEs */}
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-6">
          <h3 className="text-white mb-4" style={{ fontSize: "1rem", fontWeight: 600 }}>Most Active Organizers</h3>
          <div className="space-y-3">
            {topAEs.slice(0, 5).map((ae, i) => (
              <div key={ae.aeName} className="flex items-center gap-4 p-3 rounded-lg bg-[#0f0f18]">
                <span className="w-6 h-6 rounded-md bg-[#ec5d25]/10 text-[#ec5d25] flex items-center justify-center shrink-0" style={{ fontSize: "0.7rem", fontWeight: 700 }}>
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-white truncate" style={{ fontSize: "0.85rem" }}>{ae.aeName}</p>
                </div>
                <div className="flex items-center gap-1 text-[#ec5d25] shrink-0">
                  <Zap className="w-3 h-3" />
                  <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>{ae.callCount} calls</span>
                </div>
              </div>
            ))}
            {topAEs.length === 0 && (
              <div className="py-8 text-center text-[#555568]" style={{ fontSize: "0.85rem" }}>No data available</div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Action Items — from analytical store */}
      <div className="space-y-4">
        <h3 className="text-white" style={{ fontSize: "1rem", fontWeight: 600 }}>Recent Action Items</h3>
        {callActionItems.slice(0, 6).length > 0 ? (
          <div className="space-y-4">
            {callActionItems.slice(0, 6).map((item) => (
              <div key={item.callId} className="bg-[#12121c] border border-[#1e1e2e] rounded-xl overflow-hidden hover:border-[#2a2a3a] transition-colors">
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#1e1e2e] bg-[#0e0e18]">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ec5d25]/20 to-[#c4400e]/20 border border-[#ec5d25]/15 flex items-center justify-center shrink-0">
                      <Package className="w-4 h-4 text-[#ec5d25]" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-white truncate" style={{ fontSize: "0.88rem", fontWeight: 600 }}>{item.callTitle}</p>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-[#8888a0]" style={{ fontSize: "0.72rem" }}>
                          Organizer: <span className="text-[#c0c0d0]">{item.aeName}</span>
                        </span>
                        {item.dateTs && (
                          <span className="text-[#555568]" style={{ fontSize: "0.72rem" }}>
                            {new Date(item.dateTs).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400" style={{ fontSize: "0.7rem", fontWeight: 600 }}>
                      {item.actionItems.length} item{item.actionItems.length !== 1 ? "s" : ""}
                    </span>
                    {item.transcriptUrl && item.transcriptUrl !== "#" && (
                      <a href={item.transcriptUrl} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#ec5d25]/10 border border-[#ec5d25]/20 text-[#ec5d25] hover:bg-[#ec5d25]/20 transition-colors"
                        style={{ fontSize: "0.72rem", fontWeight: 500 }}>
                        <ExternalLink className="w-3 h-3" /> View Call
                      </a>
                    )}
                  </div>
                </div>
                <div className="px-5 py-4">
                  <ul className="space-y-2.5">
                    {item.actionItems.slice(0, 5).map((ai, i) => (
                      <li key={i} className="flex items-start gap-3">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400/80 mt-2 shrink-0" />
                        <span className="text-[#d0d0e0] leading-relaxed" style={{ fontSize: "0.84rem" }}>{renderBoldText(ai)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-12 text-center">
            <Package className="w-8 h-8 text-[#555568] mx-auto mb-3" />
            <p className="text-[#555568]" style={{ fontSize: "0.85rem" }}>No action items found</p>
          </div>
        )}
      </div>

      {/* AI Auto Insights */}
      {totalCalls > 0 && summary && (
        <div className="bg-gradient-to-br from-[#ec5d25]/5 to-[#c4400e]/5 border border-[#ec5d25]/20 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <Zap className="w-5 h-5 text-[#ec5d25]" />
            <h3 className="text-white" style={{ fontSize: "1rem", fontWeight: 600 }}>AI Auto-Generated Insights</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { insight: `You have ${totalCalls} calls synced. The most discussed keyword is "${topTopics[0]?.topic ?? "N/A"}" with ${topTopics[0]?.count ?? 0} mentions.`, priority: "medium" as const },
              { insight: `${topAEs[0]?.aeName ?? "Unknown"} is your most active organizer with ${topAEs[0]?.callCount ?? 0} calls recorded.`, priority: "medium" as const },
              { insight: `${summary.positiveSentiment} calls had positive sentiment, ${summary.negativeSentiment} had negative sentiment out of ${totalCalls} total.`, priority: summary.negativeSentiment > summary.positiveSentiment ? "high" as const : "medium" as const },
              { insight: `${summary.totalActionItems} action items were extracted across all meetings. Consider reviewing outstanding items.`, priority: summary.totalActionItems > 10 ? "high" as const : "medium" as const },
            ].map((item, i) => (
              <div key={i} className="p-4 rounded-lg bg-[#12121c]/60 border border-[#1e1e2e]">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`w-2 h-2 rounded-full ${item.priority === "high" ? "bg-rose-400" : "bg-amber-400"}`} />
                  <span className={`${item.priority === "high" ? "text-rose-400" : "text-amber-400"}`} style={{ fontSize: "0.65rem", fontWeight: 600 }}>
                    {item.priority.toUpperCase()} PRIORITY
                  </span>
                </div>
                <p className="text-[#c0c0d0]" style={{ fontSize: "0.85rem", lineHeight: 1.5 }}>{item.insight}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
