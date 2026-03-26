import { Search, ExternalLink, Loader2, Package, Filter, ChevronDown, X } from "lucide-react";
import { useState, useMemo, useRef, useEffect } from "react";
import { useData } from "./data-context";
import React from "react";

// Render action item text: convert **bold** to <strong>, strip leading bullets/dashes
function renderActionItemText(text: string): JSX.Element {
  // Strip leading bullet markers like "- ", "• ", "* "
  let cleaned = text.replace(/^[\s]*[-•*]\s+/, "").trim();

  // Split on **bold** markers and render
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

const SERVER_BASE = import.meta.env.VITE_SQLITE_SERVER_BASE ?? "http://localhost:3001";

export function ProductRequestsPage() {
  const { calls, isLoading, isLive } = useData();
  const [search, setSearch] = useState("");
  const [selectedOrganizer, setSelectedOrganizer] = useState<string>("all");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [productRequests, setProductRequests] = useState<Array<{
    id: string;
    feature: string;
    clientName: string;
    aeName: string;
    callTitle: string;
    callId: string;
    date: string;
    transcriptUrl: string;
  }>>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

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

  // Run Groq-based product extraction when calls load
  useEffect(() => {
    if (!calls.length || isLoading) return;

    let cancelled = false;
    setIsAnalyzing(true);
    setAnalyzeError(null);

    fetch(`${SERVER_BASE}/product-requests/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callIds: calls.map((c) => c.id) }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 400 ? "Groq API key not configured. Add it in Settings." : `HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        const flat = (data.results || []).flatMap((r: { callId: string; callTitle: string; aeName: string; clientName: string; date: string; transcriptUrl: string; items: string[] }) =>
          (r.items || []).map((item, i) => ({
            id: `${r.callId}-${i}`,
            feature: item,
            clientName: r.clientName,
            aeName: r.aeName,
            callTitle: r.callTitle,
            callId: r.callId,
            date: r.date,
            transcriptUrl: r.transcriptUrl || "#",
          }))
        );
        setProductRequests(flat);
      })
      .catch((err) => {
        if (!cancelled) setAnalyzeError(err?.message || "Analysis failed");
        setProductRequests([]);
      })
      .finally(() => {
        if (!cancelled) setIsAnalyzing(false);
      });

    return () => { cancelled = true; };
  }, [calls.length, isLoading]);

  // Unique organizers for filter
  const organizers = useMemo(() => {
    const names = [...new Set(productRequests.map((r) => r.aeName))].filter(Boolean).sort();
    return names;
  }, [productRequests]);

  // Organizer counts for filter badges
  const organizerCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of productRequests) {
      map.set(r.aeName, (map.get(r.aeName) || 0) + 1);
    }
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

  // Group filtered items by call for bullet-list rendering
  const groupedByCall = useMemo(() => {
    const map = new Map<
      string,
      {
        callId: string;
        callTitle: string;
        aeName: string;
        date: string;
        transcriptUrl: string;
        items: { id: string; feature: string }[];
      }
    >();
    for (const r of filtered) {
      if (!map.has(r.callId)) {
        map.set(r.callId, {
          callId: r.callId,
          callTitle: r.callTitle,
          aeName: r.aeName,
          date: r.date,
          transcriptUrl: r.transcriptUrl,
          items: [],
        });
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

  const showAnalyzingOverlay = isAnalyzing && productRequests.length === 0 && !analyzeError;

  return (
    <div className="p-8 space-y-6">
      {showAnalyzingOverlay && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#0a0a12]/80 backdrop-blur-sm">
          <Loader2 className="w-10 h-10 text-[#ec5d25] animate-spin mb-4" />
          <p className="text-[#c0c0d0]" style={{ fontSize: "0.9rem" }}>Analyzing calls with AI for product mentions...</p>
          <p className="text-[#555568] mt-1" style={{ fontSize: "0.75rem" }}>This may take a minute for many calls</p>
        </div>
      )}
      <div>
        <h1 className="text-white" style={{ fontSize: "1.75rem", fontWeight: 700 }}>Product Feedback Intelligence</h1>
        <p className="text-[#8888a0] mt-1" style={{ fontSize: "0.875rem" }}>
          {isLive
            ? `${productRequests.length} product mentions extracted from ${calls.length} calls via AI`
            : "AI-extracted product mentions and requests from call transcripts"}
        </p>
        {analyzeError && (
          <p className="text-amber-400 mt-2" style={{ fontSize: "0.8rem" }}>{analyzeError}</p>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-5">
          <p className="text-amber-400" style={{ fontSize: "1.5rem", fontWeight: 700 }}>{productRequests.length}</p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.8rem" }}>Total Product Mentions</p>
        </div>
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-5">
          <p className="text-[#ec5d25]" style={{ fontSize: "1.5rem", fontWeight: 700 }}>
            {new Set(productRequests.map((r) => r.callTitle)).size}
          </p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.8rem" }}>Calls with Product Mentions</p>
        </div>
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-5">
          <p className="text-emerald-400" style={{ fontSize: "1.5rem", fontWeight: 700 }}>
            {new Set(productRequests.map((r) => r.aeName)).size}
          </p>
          <p className="text-[#8888a0]" style={{ fontSize: "0.8rem" }}>Unique Organizers</p>
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

        {/* Organizer Filter Dropdown */}
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
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedOrganizer("all");
                }}
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

      {/* Active filter indicator */}
      {selectedOrganizer !== "all" && (
        <div className="flex items-center gap-2">
          <span className="text-[#8888a0]" style={{ fontSize: "0.75rem" }}>Filtering by:</span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#ec5d25]/10 border border-[#ec5d25]/20 text-[#ec5d25]" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
            {selectedOrganizer}
            <X
              className="w-3 h-3 cursor-pointer hover:text-white transition-colors"
              onClick={() => setSelectedOrganizer("all")}
            />
          </span>
          <span className="text-[#555568]" style={{ fontSize: "0.72rem" }}>
            {filtered.length} item{filtered.length !== 1 ? "s" : ""} across {groupedByCall.length} call{groupedByCall.length !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      {/* Grouped Action Items — Bullet List Style */}
      {groupedByCall.length > 0 ? (
        <div className="space-y-4">
          {groupedByCall.map((group) => (
            <div
              key={group.callId}
              className="bg-[#12121c] border border-[#1e1e2e] rounded-xl overflow-hidden hover:border-[#2a2a3a] transition-colors"
            >
              {/* Call header */}
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

              {/* Action items as bullet list */}
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
              ? (analyzeError ? "Analysis failed. Check Settings for Groq API key." : "No product mentions found in your calls.")
              : "No results match your search."}
          </p>
        </div>
      )}
    </div>
  );
}
