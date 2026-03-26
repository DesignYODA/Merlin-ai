import { useState, useMemo } from "react";
import { Search, TrendingUp, Hash, Loader2 } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useData } from "./data-context";

export function TopicsPage() {
  const { calls, isLoading, isLive } = useData();
  const [search, setSearch] = useState("");
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);

  const topicData = useMemo(() => {
    const topicMap: Record<string, { count: number; callIds: string[] }> = {};
    calls.forEach((c) => {
      c.topics.forEach((t) => {
        if (!t || !t.trim()) return;
        const key = t.trim().toLowerCase();
        if (!topicMap[key]) topicMap[key] = { count: 0, callIds: [] };
        topicMap[key].count++;
        if (!topicMap[key].callIds.includes(c.id)) {
          topicMap[key].callIds.push(c.id);
        }
      });
    });
    return Object.entries(topicMap)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([topic, data]) => ({ topic, ...data }));
  }, [calls]);

  const filteredTopics = topicData.filter((t) =>
    t.topic.toLowerCase().includes(search.toLowerCase())
  );

  const topicChartData = topicData.slice(0, 12).map((t, i) => {
    return {
      name: t.topic || `topic-${i}`,
      count: t.count,
    };
  });

  const selectedTopicCalls = selectedTopic
    ? calls.filter((c) => c.topics.some((t) => t.toLowerCase() === selectedTopic.toLowerCase()))
    : [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-[#ec5d25] animate-spin" />
          <p className="text-[#8888a0]" style={{ fontSize: "0.875rem" }}>Extracting topics...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-white" style={{ fontSize: "1.75rem", fontWeight: 700 }}>Topics & Keywords</h1>
        <p className="text-[#8888a0] mt-1" style={{ fontSize: "0.875rem" }}>
          {isLive ? `${topicData.length} unique keywords from ${calls.length} Fireflies calls` : "Track trending topics across meetings"}
        </p>
      </div>

      {/* Topic Distribution Chart */}
      {topicChartData.length > 0 && (
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-6">
          <h3 className="text-white mb-4" style={{ fontSize: "1rem", fontWeight: 600 }}>Keyword Distribution</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={topicChartData}>
              <XAxis key="xaxis-topics" dataKey="name" stroke="#8888a0" style={{ fontSize: "0.65rem" }} angle={-25} textAnchor="end" height={60} />
              <YAxis key="yaxis-topics" stroke="#8888a0" style={{ fontSize: "0.75rem" }} allowDecimals={false} />
              <Tooltip key="tooltip-topics" contentStyle={{ backgroundColor: "#1e1e2e", border: "1px solid #2e2e4e", borderRadius: "8px", fontSize: "0.8rem" }} />
              <Bar key="bar-topics" dataKey="count" fill="#ec5d25" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Search */}
      <div className="flex items-center gap-2 bg-[#12121c] border border-[#1e1e2e] rounded-xl px-4 py-2.5">
        <Search className="w-4 h-4 text-[#8888a0]" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search keywords..."
          className="flex-1 bg-transparent border-none outline-none text-white placeholder-[#555568]"
          style={{ fontSize: "0.875rem" }}
        />
      </div>

      {/* Topics Grid */}
      {filteredTopics.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredTopics.map((topic) => (
            <button
              key={topic.topic}
              onClick={() => setSelectedTopic(selectedTopic === topic.topic ? null : topic.topic)}
              className={`text-left p-5 rounded-xl border transition-all ${
                selectedTopic === topic.topic
                  ? "bg-[#ec5d25]/10 border-[#ec5d25]/30"
                  : "bg-[#12121c] border-[#1e1e2e] hover:border-[#2e2e4e]"
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Hash className="w-4 h-4 text-[#ec5d25]" />
                  <span className="text-white truncate" style={{ fontSize: "0.95rem", fontWeight: 600 }}>{topic.topic}</span>
                </div>
                <TrendingUp className="w-4 h-4 text-emerald-400" />
              </div>
              <p className="text-[#8888a0]" style={{ fontSize: "0.8rem" }}>
                {topic.count} mention{topic.count !== 1 ? "s" : ""} · {topic.callIds.length} call{topic.callIds.length !== 1 ? "s" : ""}
              </p>
            </button>
          ))}
        </div>
      ) : (
        <div className="py-12 text-center text-[#555568]" style={{ fontSize: "0.85rem" }}>
          {topicData.length === 0 ? "No keywords found in your calls." : "No keywords match your search."}
        </div>
      )}

      {/* Selected Topic Detail */}
      {selectedTopic && selectedTopicCalls.length > 0 && (
        <div className="bg-[#12121c] border border-[#ec5d25]/20 rounded-xl p-6">
          <h3 className="text-white mb-4" style={{ fontSize: "1rem", fontWeight: 600 }}>
            Calls mentioning "{selectedTopic}"
          </h3>
          <div className="space-y-3">
            {selectedTopicCalls.map((call) => (
              <div key={call.id} className="flex items-center justify-between p-3 rounded-lg bg-[#0f0f18] hover:bg-[#1a1a28] transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-white truncate" style={{ fontSize: "0.85rem" }}>{call.title}</p>
                  <p className="text-[#8888a0]" style={{ fontSize: "0.75rem" }}>{call.aeName} · {call.date} · {call.duration}</p>
                </div>
                <span className={`px-2 py-1 rounded-md shrink-0 ${call.sentiment === "positive" ? "bg-emerald-500/10 text-emerald-400" : call.sentiment === "negative" ? "bg-rose-500/10 text-rose-400" : "bg-amber-500/10 text-amber-400"}`} style={{ fontSize: "0.7rem" }}>
                  {call.sentiment}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}