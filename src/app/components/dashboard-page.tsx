import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import {
  Phone,
  TrendingUp,
  Users,
  MessageSquare,
  RefreshCw,
  Wifi,
  WifiOff,
  Loader2,
} from "lucide-react";
import { useData } from "./data-context";

export function DashboardPage() {
  const { calls, isLoading, isLive, error, refresh } = useData();

  const stats = useMemo(() => {
    const totalCalls = calls.length;
    const allTopics = calls.flatMap((c) => c.topics);
    const uniqueTopics = new Set(allTopics).size;
    const uniqueAEs = new Set(calls.map((c) => c.aeName)).size;
    const totalRequests = calls.reduce((sum, c) => sum + c.actionItems.length, 0);
    return { totalCalls, uniqueTopics, uniqueAEs, totalRequests };
  }, [calls]);

  const sentimentData = useMemo(() => {
    const pos = calls.filter((c) => c.sentiment === "positive").length;
    const neu = calls.filter((c) => c.sentiment === "neutral").length;
    const neg = calls.filter((c) => c.sentiment === "negative").length;
    return [
      { name: "Positive", value: pos, fill: "#22c55e" },
      { name: "Neutral", value: neu, fill: "#f59e0b" },
      { name: "Negative", value: neg, fill: "#ef4444" },
    ].filter((d) => d.value > 0);
  }, [calls]);

  const topTopics = useMemo(() => {
    const topicMap: Record<string, number> = {};
    calls.forEach((c) => c.topics.forEach((t) => {
      if (!t || !t.trim()) return;
      const key = t.trim().toLowerCase();
      topicMap[key] = (topicMap[key] || 0) + 1;
    }));
    const seen = new Set<string>();
    return Object.entries(topicMap)
      .filter(([topic]) => topic && topic.length > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([topic, count], i) => {
        let name = topic;
        if (seen.has(name)) name = `${topic} (${i})`;
        seen.add(name);
        return { name, count };
      });
  }, [calls]);

  const callsByDay = useMemo(() => {
    const dayMap: Record<string, number> = {};
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    days.forEach((d) => (dayMap[d] = 0));
    calls.forEach((c) => {
      if (c.dateTimestamp) {
        const day = days[new Date(c.dateTimestamp).getDay()];
        dayMap[day]++;
      }
    });
    return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => ({ name: d, calls: dayMap[d] || 0 }));
  }, [calls]);

  const statCards = [
    { label: "Total Calls", value: stats.totalCalls.toString(), icon: Phone, color: "from-[#ec5d25] to-[#c4400e]" },
    { label: "Topics Extracted", value: stats.uniqueTopics.toString(), icon: TrendingUp, color: "from-emerald-500 to-teal-600" },
    { label: "Active AEs", value: stats.uniqueAEs.toString(), icon: Users, color: "from-amber-500 to-orange-600" },
    { label: "Action Items", value: stats.totalRequests.toString(), icon: MessageSquare, color: "from-rose-500 to-pink-600" },
  ];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-[#ec5d25] animate-spin" />
          <p className="text-[#8888a0]" style={{ fontSize: "0.875rem" }}>Fetching calls from Fireflies...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-white" style={{ fontSize: "1.75rem", fontWeight: 700 }}>Dashboard</h1>
          <p className="text-[#8888a0] mt-1 flex items-center gap-2" style={{ fontSize: "0.875rem" }}>
            {isLive ? (
              <>
                <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                Live data from Fireflies.ai
              </>
            ) : (
              <>
                <WifiOff className="w-3.5 h-3.5 text-rose-400" />
                {error || "Using offline data"}
              </>
            )}
          </p>
        </div>
        <button
          onClick={refresh}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#12121c] border border-[#1e1e2e] text-[#8888a0] hover:text-white hover:border-[#ec5d25]/50 transition-all"
          style={{ fontSize: "0.8rem" }}
        >
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-4 flex items-center gap-3">
          <WifiOff className="w-5 h-5 text-rose-400 shrink-0" />
          <div>
            <p className="text-rose-300" style={{ fontSize: "0.85rem" }}>Failed to connect to Fireflies API</p>
            <p className="text-rose-400/60" style={{ fontSize: "0.75rem" }}>{error}</p>
          </div>
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) => (
          <div key={card.label} className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-5 hover:border-[#2e2e4e] transition-colors">
            <div className="flex items-center justify-between mb-4">
              <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${card.color} flex items-center justify-center`}>
                <card.icon className="w-5 h-5 text-white" />
              </div>
              {isLive && (
                <div className="flex items-center gap-1 text-emerald-400" style={{ fontSize: "0.7rem" }}>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> LIVE
                </div>
              )}
            </div>
            <p className="text-white" style={{ fontSize: "1.5rem", fontWeight: 700 }}>{card.value}</p>
            <p className="text-[#8888a0] mt-1" style={{ fontSize: "0.8rem" }}>{card.label}</p>
          </div>
        ))}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-6">
          <h3 className="text-white mb-4" style={{ fontSize: "1rem", fontWeight: 600 }}>Calls by Day of Week</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={callsByDay}>
              <XAxis key="xaxis-day" dataKey="name" stroke="#8888a0" style={{ fontSize: "0.75rem" }} />
              <YAxis key="yaxis-day" stroke="#8888a0" style={{ fontSize: "0.75rem" }} />
              <Tooltip key="tooltip-day" contentStyle={{ backgroundColor: "#1e1e2e", border: "1px solid #2e2e4e", borderRadius: "8px", fontSize: "0.8rem" }} labelStyle={{ color: "#fff" }} />
              <Bar key="bar-day" dataKey="calls" fill="#ec5d25" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-6">
          <h3 className="text-white mb-4" style={{ fontSize: "1rem", fontWeight: 600 }}>Call Sentiment</h3>
          {calls.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie key="pie-sentiment" data={sentimentData} cx="50%" cy="50%" innerRadius={60} outerRadius={90} dataKey="value" nameKey="name" paddingAngle={4}>
                  {sentimentData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Pie>
                <Tooltip key="tooltip-sentiment" contentStyle={{ backgroundColor: "#1e1e2e", border: "1px solid #2e2e4e", borderRadius: "8px", fontSize: "0.8rem" }} />
                <Legend key="legend-sentiment" wrapperStyle={{ fontSize: "0.8rem" }} formatter={(value) => <span style={{ color: "#c0c0d0" }}>{value}</span>} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[240px] text-[#555568]" style={{ fontSize: "0.85rem" }}>No call data available</div>
          )}
        </div>
      </div>

      {/* Top Topics */}
      {topTopics.length > 0 && (
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-6">
          <h3 className="text-white mb-4" style={{ fontSize: "1rem", fontWeight: 600 }}>Top Topics (from Keywords)</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={topTopics}>
              <XAxis key="xaxis-topics" dataKey="name" stroke="#8888a0" style={{ fontSize: "0.7rem" }} angle={-20} textAnchor="end" height={60} />
              <YAxis key="yaxis-topics" stroke="#8888a0" style={{ fontSize: "0.75rem" }} allowDecimals={false} />
              <Tooltip key="tooltip-topics" contentStyle={{ backgroundColor: "#1e1e2e", border: "1px solid #2e2e4e", borderRadius: "8px", fontSize: "0.8rem" }} />
              <Bar key="bar-topics" dataKey="count" fill="#ec5d25" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Recent Calls */}
      <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-6">
        <h3 className="text-white mb-4" style={{ fontSize: "1rem", fontWeight: 600 }}>Recent Calls</h3>
        {calls.length > 0 ? (
          <div className="space-y-3">
            {calls.slice(0, 8).map((call) => (
              <div key={call.id} className="flex items-center justify-between p-3 rounded-lg bg-[#0f0f18] hover:bg-[#1a1a28] transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-white truncate" style={{ fontSize: "0.875rem" }}>{call.title}</p>
                  <p className="text-[#8888a0]" style={{ fontSize: "0.75rem" }}>
                    {call.aeName} · {call.date} · {call.duration}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {call.topics.length > 0 && (
                    <div className="hidden md:flex gap-1">
                      {call.topics.slice(0, 2).map((t, idx) => (
                        <span key={`${call.id}-topic-${idx}`} className="px-2 py-0.5 rounded bg-[#ec5d25]/10 text-[#f5a07a]" style={{ fontSize: "0.65rem" }}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  <span
                    className={`px-2 py-1 rounded-md ${call.sentiment === "positive" ? "bg-emerald-500/10 text-emerald-400" : call.sentiment === "negative" ? "bg-rose-500/10 text-rose-400" : "bg-amber-500/10 text-amber-400"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {call.sentiment}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-8 text-center text-[#555568]" style={{ fontSize: "0.85rem" }}>No calls found. Connect to Fireflies to see your meetings.</div>
        )}
      </div>
    </div>
  );
}