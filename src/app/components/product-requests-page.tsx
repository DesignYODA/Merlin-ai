import { Search, ExternalLink, Loader2, Package, Filter, ChevronDown, X, RefreshCw } from "lucide-react";
import { useState, useMemo, useRef, useEffect } from "react";
import { useData } from "./data-context";
import type { ProductInsightResult } from "./data-context";
import React from "react";

function renderActionItemText(text: string): React.JSX.Element {
  let cleaned = text.replace(/^[\s]*[-•*]\s+/, "").trim();
  const parts = cleaned.split(/(\*\*[^*]+\*\*)/g);
  return (
    <span>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className="text-white font-semibold">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}

function timeAgo(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const SERVER_BASE = import.meta.env.VITE_SQLITE_SERVER_BASE ?? "http://localhost:3001";

export function ProductRequestsPage() {
  const { calls, isLoading, isLive, productInsights, setProductInsights } = useData();
  const [search, setSearch] = useState("");
  const [selectedOrganizer, setSelectedOrganizer] = useState<string>("all");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyticalCount, setAnalyticalCount] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load count from analytical store on mount
  useEffect(() => {
    fetch(`${SERVER_BASE}/analytics/product-analysis`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.results) setAnalyticalCount(d.results.length); })
      .catch(() => {});
  }, [isAnalyzing]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function runAnalysis() {
    if (!calls.length) return;
    setIsAnalyzing(true);
    setAnalyzeError(null);

    // Send no callIds — server will pick only uncached calls automatically
    fetch(`${SERVER_BASE}/product-requests/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 400 ? "LLM API key not configured. Add it in Settings." : `HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (data.newCount === 0) return; // nothing new analyzed, UI already up to date
        // Reload ALL cached insights from DB (new + previously analyzed)
        return fetch(`${SERVER_BASE}/product-insights`)
          .then((r) => r.json())
          .then((fresh) => {
            const results: ProductInsightResult[] = (fresh.results || []).map((r: ProductInsightResult) => ({
              ...r,
              analyzedAt: r.analyzedAt ?? Date.now(),
            }));
            setProductInsights(results);
          });
      })
      .catch((err) => setAnalyzeError(err?.message || "Analysis failed"))
      .finally(() => setIsAnalyzing(false));
  }

  // Flatten cached insights into the same shape used for rendering
  const productRequests = useMemo(() =>
    productInsights.flatMap((r) =>
      (r.items || []).map((item, i) => ({
        id: `${r.callId}-${i}`,
        feature: item,
        clientName: r.clientName,
        aeName: r.aeName,
        callTitle: r.callTitle,
        callId: r.callId,
        date: r.date,
        transcriptUrl: r.transcriptUrl,
        analyzedAt: r.analyzedAt,
      }))
    ),
    [productInsights]
  );

  // Newest analyzedAt across all results
  const lastAnalyzedAt = useMemo(() =>
    productInsights.reduce((max, r) => Math.max(max, r.analyzedAt ?? 0), 0),
    [productInsights]
  );

  const organizers = useMemo(() => {
    const names = [...new Set(productRequests.map((r) => r.aeName))].filter(Boolean).sort();
    return names;
  }, [productRequests]);

  const organizerCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of productRequests) map.set(r.aeName, (map.get(r.aeName) || 0) + 1);
    return map;
  }, [productRequests]);

  const filtered = productRequests.filter((r) => {
    const matchesSearch =
      r.feature.toLowerCase().includes(search.toLowerCase()) ||
      r.clientName.toLowerCase().includes(search.toLowerCase()) ||
      r.aeName.toLowerCase().includes(search.toLowerCase()) ||
      r.callTitle.toLowerCase().includes(search.toLowerCase());
    const matchesOrganizer = selectedOrganizer === "all" || r.aeName === selectedOrganizer;
    return matchesSearch && matchesOrganizer;
  });

  const groupedByCall = useMemo(() => {
    const map = new Map<string, { callId: string; callTitle: string; aeName: string; date: string; transcriptUrl: string; items: { id: string; feature: string }[] }>();
    for (const r of filtered) {
      if (!map.has(r.callId)) {
        map.set(r.callId, { callId: r.callId, callTitle: r.callTitle, aeName: r.aeName, date: r.date, transcriptUrl: r.transcriptUrl, items: [] });
      }
      map.get(r.callId)!.items.push({ id: r.id, feature: r.feature });
    }
    return [...map.values()];
  }, [filtered]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-[#ec5d25] animate-spin" />
          <p className="text-[#8888a0]" style={{ fontSize: "0.875rem" }}>Loading calls...</p>
        </div>
      </div>
    );
  }

  const showAnalyzingOverlay = isAnalyzing && productInsights.length === 0 && !analyzeError;

  return (
    <div className="p-8 space-y-6">
      {showAnalyzingOverlay && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#0a0a12]/80 backdrop-blur-sm">
          <Loader2 className="w-10 h-10 text-[#ec5d25] animate-spin mb-4" />
          <p className="text-[#c0c0d0]" style={{ fontSize: "0.9rem" }}>Analyzing new calls with AI for product mentions...</p>
          <p className="text-[#555568] mt-1" style={{ fontSize: "0.75rem" }}>Already-analyzed calls are skipped automatically</p>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-white" style={{ fontSize: "1.75rem", fontWeight: 700 }}>Product Feedback Intelligence</h1>
          <p className="text-[#8888a0] mt-1" style={{ fontSize: "0.875rem" }}>
            {isLive
              ? `${productRequests.length} product mentions extracted from ${productInsights.length} calls via AI`
              : "AI-extracted product mentions and requests from call transcripts"}
          </p>
          {lastAnalyzedAt > 0 && (
            <p className="text-[#555568] mt-0.5" style={{ fontSize: "0.75rem" }}>
              Last analyzed {timeAgo(lastAnalyzedAt)}
            </p>
          )}
          {analyzeError && (
            <p className="text-amber-400 mt-2" style={{ fontSize: "0.8rem" }}>{analyzeError}</p>
          )}
        </div>
        <button
          onClick={runAnalysis}
          disabled={isAnalyzing || !calls.length}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#ec5d25]/10 border border-[#ec5d25]/30 text-[#ec5d25] hover:bg-[#ec5d25]/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          style={{ fontSize: "0.82rem", fontWeight: 500 }}
        >
          {isAnalyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {isAnalyzing ? "Analyzing…" : "Analyze New"}
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-5">
          <p className="text-amber-400" style={{ fontSize: "1.5rem", fontWeight: 700 }}>{productRequests.length}</p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.8rem" }}>Total Product Mentions</p>
        </div>
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-5">
          <p className="text-[#ec5d25]" style={{ fontSize: "1.5rem", fontWeight: 700 }}>
            {productInsights.length}
          </p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.8rem" }}>Calls with Product Mentions</p>
        </div>
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-5">
          <p className="text-emerald-400" style={{ fontSize: "1.5rem", fontWeight: 700 }}>
            {new Set(productRequests.map((r) => r.aeName)).size}
          </p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.8rem" }}>Unique Organizers</p>
        </div>
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-5">
          <p className="text-indigo-400" style={{ fontSize: "1.5rem", fontWeight: 700 }}>
            {analyticalCount ?? "—"}
          </p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.8rem" }}>Synced to Analytical DB</p>
        </div>
      </div>

      {/* Search + Organizer Filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 bg-[#12121c] border border-[#1e1e2e] rounded-xl px-4 py-2.5 flex-1 min-w-[240px]">
          <Search className="w-4 h-4 text-[#8888a0]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product mentions..."
            className="flex-1 bg-transparent border-none outline-none text-white placeholder-[#555568]"
            style={{ fontSize: "0.875rem" }}
          />
        </div>

        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-colors cursor-pointer ${
              selectedOrganizer !== "all"
                ? "bg-[#ec5d25]/10 border-[#ec5d25]/30 text-[#ec5d25]"
                : "bg-[#12121c] border-[#1e1e2e] text-[#8888a0] hover:border-[#2e2e3e]"
            }`}
            style={{ fontSize: "0.85rem" }}
          >
            <Filter className="w-3.5 h-3.5" />
            <span>{selectedOrganizer === "all" ? "All Organizers" : selectedOrganizer}</span>
            {selectedOrganizer !== "all" ? (
              <X
                className="w-3.5 h-3.5 hover:text-white transition-colors"
                onClick={(e) => { e.stopPropagation(); setSelectedOrganizer("all"); }}
              />
            ) : (
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${dropdownOpen ? "rotate-180" : ""}`} />
            )}
          </button>

          {dropdownOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-72 bg-[#12121c] border border-[#1e1e2e] rounded-xl shadow-xl shadow-black/40 z-50 overflow-hidden">
              <div className="max-h-72 overflow-y-auto">
                <button
                  onClick={() => { setSelectedOrganizer("all"); setDropdownOpen(false); }}
                  className={`w-full flex items-center justify-between px-4 py-2.5 text-left transition-colors cursor-pointer ${
                    selectedOrganizer === "all" ? "bg-[#ec5d25]/10 text-[#ec5d25]" : "text-[#c0c0d0] hover:bg-[#1a1a28]"
                  }`}
                  style={{ fontSize: "0.82rem" }}
                >
                  <span>All Organizers</span>
                  <span className="text-[#555568]" style={{ fontSize: "0.72rem" }}>{productRequests.length}</span>
                </button>
                <div className="border-t border-[#1e1e2e]" />
                {organizers.map((org) => (
                  <button
                    key={org}
                    onClick={() => { setSelectedOrganizer(org); setDropdownOpen(false); }}
                    className={`w-full flex items-center justify-between px-4 py-2.5 text-left transition-colors cursor-pointer ${
                      selectedOrganizer === org ? "bg-[#ec5d25]/10 text-[#ec5d25]" : "text-[#c0c0d0] hover:bg-[#1a1a28]"
                    }`}
                    style={{ fontSize: "0.82rem" }}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-6 h-6 rounded-full bg-gradient-to-br from-[#ec5d25]/30 to-[#c4400e]/30 flex items-center justify-center shrink-0">
                        <span className="text-[#ec5d25]" style={{ fontSize: "0.58rem", fontWeight: 700 }}>
                          {org.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <span className="truncate">{org}</span>
                    </div>
                    <span className="text-[#555568] shrink-0 ml-2" style={{ fontSize: "0.72rem" }}>
                      {organizerCounts.get(org) || 0}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {selectedOrganizer !== "all" && (
        <div className="flex items-center gap-2">
          <span className="text-[#8888a0]" style={{ fontSize: "0.75rem" }}>Filtering by:</span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#ec5d25]/10 border border-[#ec5d25]/20 text-[#ec5d25]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
            {selectedOrganizer}
            <X className="w-3 h-3 cursor-pointer hover:text-white transition-colors" onClick={() => setSelectedOrganizer("all")} />
          </span>
          <span className="text-[#555568]" style={{ fontSize: "0.72rem" }}>
            {filtered.length} item{filtered.length !== 1 ? "s" : ""} across {groupedByCall.length} call{groupedByCall.length !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      {/* Results */}
      {groupedByCall.length > 0 ? (
        <div className="space-y-4">
          {groupedByCall.map((group) => (
            <div
              key={group.callId}
              className="bg-[#12121c] border border-[#1e1e2e] rounded-xl overflow-hidden hover:border-[#2a2a3a] transition-colors"
            >
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#1e1e2e] bg-[#0e0e18]">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ec5d25]/20 to-[#c4400e]/20 border border-[#ec5d25]/15 flex items-center justify-center shrink-0">
                    <Package className="w-4 h-4 text-[#ec5d25]" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-white truncate" style={{ fontSize: "0.88rem", fontWeight: 600 }}>
                      {group.callTitle}
                    </p>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-[#8888a0]" style={{ fontSize: "0.72rem" }}>
                        Organizer: <span className="text-[#c0c0d0]">{group.aeName}</span>
                      </span>
                      <span className="text-[#555568]" style={{ fontSize: "0.72rem" }}>{group.date}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span
                    className="px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400"
                    style={{ fontSize: "0.7rem", fontWeight: 600 }}
                  >
                    {group.items.length} item{group.items.length !== 1 ? "s" : ""}
                  </span>
                  {group.transcriptUrl && group.transcriptUrl !== "#" && (
                    <a
                      href={group.transcriptUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#ec5d25]/10 border border-[#ec5d25]/20 text-[#ec5d25] hover:bg-[#ec5d25]/20 transition-colors"
                      style={{ fontSize: "0.72rem", fontWeight: 500 }}
                    >
                      <ExternalLink className="w-3 h-3" /> View Call
                    </a>
                  )}
                </div>
              </div>
              <div className="px-5 py-4">
                <ul className="space-y-2.5">
                  {group.items.map((item) => (
                    <li key={item.id} className="flex items-start gap-3">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400/80 mt-2 shrink-0" />
                      <span className="text-[#d0d0e0] leading-relaxed" style={{ fontSize: "0.84rem" }}>
                        {renderActionItemText(item.feature)}
                      </span>
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
          <p className="text-[#555568]" style={{ fontSize: "0.85rem" }}>
            {productRequests.length === 0 && !isAnalyzing
              ? (analyzeError ? "Analysis failed. Check Settings for API key." : "No product mentions found. Click Re-analyze to run analysis.")
              : "No results match your search."}
          </p>
        </div>
      )}
    </div>
  );
}
