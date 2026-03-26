import { useState, useEffect } from "react";
import { Search, Filter, X, ChevronRight, Clock, Users, Tag, ExternalLink, Loader2 } from "lucide-react";
import { useData, type NormalizedCall } from "./data-context";

function CallDetail({ call, onClose }: { call: NormalizedCall; onClose: () => void }) {
  const { getCallDetail } = useData();
  const [detail, setDetail] = useState<NormalizedCall>(call);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoadingDetail(true);
    getCallDetail(call.id).then((result) => {
      if (mounted && result) {
        setDetail(result);
      }
      if (mounted) setLoadingDetail(false);
    });
    return () => { mounted = false; };
  }, [call.id, getCallDetail]);

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex justify-end" onClick={onClose}>
      <div className="w-full max-w-2xl bg-[#0f0f18] h-full overflow-y-auto border-l border-[#1e1e2e]" onClick={(e) => e.stopPropagation()}>
        <div className="p-6 border-b border-[#1e1e2e] flex items-center justify-between">
          <div>
            <h2 className="text-white" style={{ fontSize: "1.25rem", fontWeight: 700 }}>{detail.title}</h2>
            <p className="text-[#8888a0] mt-1" style={{ fontSize: "0.8rem" }}>
              {detail.aeName} · {detail.date}
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-[#1e1e2e] flex items-center justify-center text-[#8888a0] hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Meta */}
          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-2 text-[#8888a0]" style={{ fontSize: "0.8rem" }}>
              <Clock className="w-4 h-4" /> {detail.duration}
            </div>
            <div className="flex items-center gap-2 text-[#8888a0]" style={{ fontSize: "0.8rem" }}>
              <Users className="w-4 h-4" /> {detail.participants.length} participants
            </div>
            <span className={`px-2 py-1 rounded-md ${detail.sentiment === "positive" ? "bg-emerald-500/10 text-emerald-400" : detail.sentiment === "negative" ? "bg-rose-500/10 text-rose-400" : "bg-amber-500/10 text-amber-400"}`} style={{ fontSize: "0.7rem" }}>
              {detail.sentiment}
            </span>
          </div>

          {/* Links */}
          <div className="flex gap-3">
            {detail.transcriptUrl && detail.transcriptUrl !== "#" && (
              <a href={detail.transcriptUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#ec5d25]/10 text-[#f5a07a] border border-[#ec5d25]/20 hover:bg-[#ec5d25]/20 transition-colors" style={{ fontSize: "0.8rem" }}>
                <ExternalLink className="w-3 h-3" /> View on Fireflies
              </a>
            )}
            {detail.recordingUrl && detail.recordingUrl !== "#" && (
              <a href={detail.recordingUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#1e1e2e] text-[#8888a0] hover:text-white transition-colors" style={{ fontSize: "0.8rem" }}>
                <ExternalLink className="w-3 h-3" /> Audio
              </a>
            )}
          </div>

          {/* Participants */}
          {detail.participants.length > 0 && (
            <div>
              <h3 className="text-white mb-3" style={{ fontSize: "0.9rem", fontWeight: 600 }}>Participants</h3>
              <div className="flex flex-wrap gap-2">
                {detail.participants.map((p, idx) => (
                  <span key={`participant-${idx}`} className="px-3 py-1.5 rounded-lg bg-[#1e1e2e] text-[#c0c0d0]" style={{ fontSize: "0.75rem" }}>
                    {p}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* AI Summary */}
          <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-4">
            <h3 className="text-[#ec5d25] mb-2" style={{ fontSize: "0.85rem", fontWeight: 600 }}>AI Summary</h3>
            <p className="text-[#c0c0d0]" style={{ fontSize: "0.85rem", lineHeight: 1.6 }}>{detail.aiSummary}</p>
          </div>

          {/* Topics */}
          {detail.topics.length > 0 && (
            <div>
              <h3 className="text-white mb-3" style={{ fontSize: "0.9rem", fontWeight: 600 }}>Keywords / Topics</h3>
              <div className="flex flex-wrap gap-2">
                {detail.topics.map((topic, idx) => (
                  <span key={`topic-${idx}`} className="px-3 py-1.5 rounded-lg bg-[#ec5d25]/10 text-[#f5a07a] border border-[#ec5d25]/20" style={{ fontSize: "0.75rem" }}>
                    {topic}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Action Items */}
          {detail.actionItems.length > 0 && (
            <div>
              <h3 className="text-white mb-3" style={{ fontSize: "0.9rem", fontWeight: 600 }}>Action Items</h3>
              <div className="space-y-2">
                {detail.actionItems.map((item, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 rounded-lg bg-[#12121c]">
                    <Tag className="w-3 h-3 text-amber-400 mt-1 shrink-0" />
                    <span className="text-[#c0c0d0]" style={{ fontSize: "0.8rem" }}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Outline */}
          {detail.outline.length > 0 && (
            <div>
              <h3 className="text-white mb-3" style={{ fontSize: "0.9rem", fontWeight: 600 }}>Meeting Outline</h3>
              <div className="space-y-1">
                {detail.outline.map((item, i) => (
                  <p key={i} className="text-[#c0c0d0] py-1" style={{ fontSize: "0.8rem" }}>
                    {item}
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* Transcript */}
          {detail.transcript ? (
            <div>
              <h3 className="text-white mb-3" style={{ fontSize: "0.9rem", fontWeight: 600 }}>Transcript</h3>
              <div className="bg-[#0a0a12] border border-[#1e1e2e] rounded-xl p-4 max-h-96 overflow-y-auto">
                <pre className="text-[#c0c0d0] whitespace-pre-wrap" style={{ fontSize: "0.8rem", lineHeight: 1.7, fontFamily: "'Inter', sans-serif" }}>
                  {detail.transcript}
                </pre>
              </div>
            </div>
          ) : loadingDetail ? (
            <div className="flex items-center gap-2 text-[#8888a0] py-4" style={{ fontSize: "0.8rem" }}>
              <Loader2 className="w-4 h-4 animate-spin" /> Loading transcript...
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function CallsLibraryPage() {
  const { calls, isLoading, isLive } = useData();
  const [search, setSearch] = useState("");
  const [selectedCall, setSelectedCall] = useState<NormalizedCall | null>(null);
  const [sentimentFilter, setSentimentFilter] = useState<string>("all");

  const filteredCalls = calls.filter((call) => {
    const matchesSearch =
      call.title.toLowerCase().includes(search.toLowerCase()) ||
      call.clientName.toLowerCase().includes(search.toLowerCase()) ||
      call.aeName.toLowerCase().includes(search.toLowerCase()) ||
      call.participants.some((p) => p.toLowerCase().includes(search.toLowerCase()));
    const matchesSentiment = sentimentFilter === "all" || call.sentiment === sentimentFilter;
    return matchesSearch && matchesSentiment;
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-[#ec5d25] animate-spin" />
          <p className="text-[#8888a0]" style={{ fontSize: "0.875rem" }}>Loading calls from Fireflies...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-white" style={{ fontSize: "1.75rem", fontWeight: 700 }}>Calls Library</h1>
        <p className="text-[#8888a0] mt-1" style={{ fontSize: "0.875rem" }}>
          {isLive ? `${calls.length} calls synced from Fireflies.ai` : "Browse and analyze all meeting recordings"}
        </p>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-[200px] flex items-center gap-2 bg-[#12121c] border border-[#1e1e2e] rounded-xl px-4 py-2.5">
          <Search className="w-4 h-4 text-[#8888a0]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search calls, participants..."
            className="flex-1 bg-transparent border-none outline-none text-white placeholder-[#555568]"
            style={{ fontSize: "0.875rem" }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-[#8888a0]" />
          {["all", "positive", "neutral", "negative"].map((s) => (
            <button
              key={s}
              onClick={() => setSentimentFilter(s)}
              className={`px-3 py-1.5 rounded-lg capitalize transition-colors ${sentimentFilter === s ? "bg-[#ec5d25] text-white" : "bg-[#12121c] border border-[#1e1e2e] text-[#8888a0] hover:text-white"}`}
              style={{ fontSize: "0.75rem" }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#1e1e2e]">
                <th className="px-5 py-3.5 text-left text-[#8888a0]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>Call Title</th>
                <th className="px-5 py-3.5 text-left text-[#8888a0]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>Organizer</th>
                <th className="px-5 py-3.5 text-left text-[#8888a0]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>Date</th>
                <th className="px-5 py-3.5 text-left text-[#8888a0]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>Duration</th>
                <th className="px-5 py-3.5 text-left text-[#8888a0]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>Keywords</th>
                <th className="px-5 py-3.5 text-left text-[#8888a0]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>Sentiment</th>
                <th className="px-5 py-3.5" style={{ fontSize: "0.75rem" }}></th>
              </tr>
            </thead>
            <tbody>
              {filteredCalls.length > 0 ? (
                filteredCalls.map((call) => (
                  <tr
                    key={call.id}
                    onClick={() => setSelectedCall(call)}
                    className="border-b border-[#1e1e2e] last:border-b-0 hover:bg-[#1a1a28] cursor-pointer transition-colors"
                  >
                    <td className="px-5 py-4 text-white max-w-[250px] truncate" style={{ fontSize: "0.85rem" }}>{call.title}</td>
                    <td className="px-5 py-4 text-[#c0c0d0]" style={{ fontSize: "0.85rem" }}>{call.aeName}</td>
                    <td className="px-5 py-4 text-[#c0c0d0]" style={{ fontSize: "0.85rem" }}>{call.date}</td>
                    <td className="px-5 py-4 text-[#c0c0d0]" style={{ fontSize: "0.85rem" }}>{call.duration}</td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap gap-1">
                        {call.topics.slice(0, 2).map((t, idx) => (
                          <span key={`${call.id}-kw-${idx}`} className="px-2 py-0.5 rounded bg-[#ec5d25]/10 text-[#f5a07a]" style={{ fontSize: "0.65rem" }}>
                            {t}
                          </span>
                        ))}
                        {call.topics.length > 2 && (
                          <span className="px-2 py-0.5 rounded bg-[#1e1e2e] text-[#8888a0]" style={{ fontSize: "0.65rem" }}>
                            +{call.topics.length - 2}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <span className={`px-2 py-1 rounded-md ${call.sentiment === "positive" ? "bg-emerald-500/10 text-emerald-400" : call.sentiment === "negative" ? "bg-rose-500/10 text-rose-400" : "bg-amber-500/10 text-amber-400"}`} style={{ fontSize: "0.7rem" }}>
                        {call.sentiment}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <ChevronRight className="w-4 h-4 text-[#555568]" />
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-[#555568]" style={{ fontSize: "0.85rem" }}>
                    {calls.length === 0 ? "No calls found from Fireflies." : "No calls match your search."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedCall && <CallDetail call={selectedCall} onClose={() => setSelectedCall(null)} />}
    </div>
  );
}