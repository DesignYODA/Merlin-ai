import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useNavigate, useLocation } from "react-router";
import parse from "html-react-parser";
import { Search, Filter, X, ChevronRight, Clock, Users, ExternalLink, Loader2, Play, Check, Building2, Handshake, RefreshCw, Send, Sparkles, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useData, type NormalizedCall } from "./data-context";
import { getHubspotFlatData, getHubspotCompanyDetails, backfillHubspotLabels, askCall, askHubspotRow } from "../api";
import type { AskAiSeedItem } from "./ask-ai-page";
import type { HubspotDealLinkState } from "./library-nav-state";

export interface HubspotFlatRow {
  company_id: string; company_name: string; company_domain: string; company_phone: string;
  company_city: string; company_state: string; company_country: string; company_industry: string;
  company_createdate: string; company_lifecyclestage: string; company_hubspot_owner_id: string;
  company_hs_lastmodifieddate: string; company_synced_at: number;
  deal_ids: string[]; note_ids: string[]; email_ids: string[];
  deal_id: string; deal_name: string; deal_amount: string; deal_stage: string;
  deal_closedate: string; deal_pipeline: string; deal_hubspot_owner_id: string;
  deal_createdate: string; deal_hs_lastmodifieddate: string;
  note_id: string; note_hs_note_body: string; note_hs_createdate: string;
  note_hs_lastmodifieddate: string; note_hubspot_owner_id: string; note_hs_timestamp: string; note_url: string;
  email_id: string; email_hs_email_subject: string; email_hs_email_text: string;
  email_hs_createdate: string; email_hubspot_owner_id: string; email_url: string;
  all_deals: Array<{ deal_id: string; deal_name: string; deal_amount: string; deal_stage: string; deal_closedate: string; deal_pipeline: string; deal_hubspot_owner_id: string; }>;
}

// Full note/email bodies for one company — fetched on demand (see getHubspotCompanyDetails)
// when its modal opens, rather than embedded in every HubspotFlatRow (too much text to ship
// for every company on every list load).
interface HubspotCompanyDetail {
  all_notes: Array<{ note_id: string; note_hs_note_body: string; note_hs_createdate: string; note_hubspot_owner_id: string; note_url: string; }>;
  all_emails: Array<{ email_id: string; email_hs_email_subject: string; email_hs_email_text: string; email_hs_createdate: string; email_hubspot_owner_id: string; email_url: string; }>;
}

type DetailTab = "summary" | "keypoints" | "transcript" | "askai";

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function parseRawLine(line: string): { label: string; seconds: number; rest: string; prefixLen: number } | null {
  const m = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\] ?(.*)/s);
  if (!m) return null;
  const [, h, min, s, rest] = m;
  return {
    label: `[${h}:${min}:${s}]`,
    seconds: parseInt(h, 10) * 3600 + parseInt(min, 10) * 60 + parseInt(s, 10),
    rest,
    prefixLen: line.length - rest.length,
  };
}

function fuzzyMatch(text: string, query: string): { matched: boolean; indices: number[] } {
  const tl = text.toLowerCase();
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { matched: true, indices: [] };
  const indices: number[] = [];
  for (const word of words) {
    const idx = tl.indexOf(word);
    if (idx === -1) return { matched: false, indices: [] };
    for (let i = 0; i < word.length; i++) indices.push(idx + i);
  }
  return { matched: true, indices };
}

function HighlightedText({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <span>{text}</span>;
  const set = new Set(indices);
  const parts: { t: string; hi: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hi = set.has(i);
    if (parts.length && parts[parts.length - 1].hi === hi) parts[parts.length - 1].t += text[i];
    else parts.push({ t: text[i], hi });
  }
  return (
    <>
      {parts.map((p, i) =>
        p.hi
          ? <mark key={i} style={{ background: "rgba(236,93,37,0.25)", color: "#f5a07a", borderRadius: 2, padding: "0 1px" }}>{p.t}</mark>
          : <span key={i}>{p.t}</span>
      )}
    </>
  );
}

const mdComponents = {
  ul: ({ children }: { children: React.ReactNode }) => (
    <ul style={{ paddingLeft: 18, display: 'flex', flexDirection: 'column' as const, gap: 6, margin: 0 }}>{children}</ul>
  ),
  ol: ({ children }: { children: React.ReactNode }) => (
    <ol style={{ paddingLeft: 18, display: 'flex', flexDirection: 'column' as const, gap: 6, margin: 0 }}>{children}</ol>
  ),
  li: ({ children }: { children: React.ReactNode }) => (
    <li style={{ fontSize: 'var(--fs-small)', color: 'var(--card-muted)', lineHeight: 1.6, listStyleType: 'disc' }}>{children}</li>
  ),
  p: ({ children }: { children: React.ReactNode }) => (
    <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-muted)', lineHeight: 1.6, margin: 0 }}>{children}</p>
  ),
  strong: ({ children }: { children: React.ReactNode }) => (
    <strong style={{ color: 'var(--dash-card-text)', fontWeight: 600 }}>{children}</strong>
  ),
};

function CallDetail({ call, onClose }: { call: NormalizedCall; onClose: () => void }) {
  const { getCallDetail } = useData();
  const [detail, setDetail] = useState<NormalizedCall>(call);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("summary");

  const [transcriptSearch, setTranscriptSearch] = useState("");
  const [speakerFilter, setSpeakerFilter] = useState("all");

  // Ask AI state
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiAnswer, setAiAnswer] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let mounted = true;
    setLoadingDetail(true);
    getCallDetail(call.id).then((result) => {
      if (mounted && result) setDetail(result);
      if (mounted) setLoadingDetail(false);
    });
    return () => { mounted = false; };
  }, [call.id, getCallDetail]);

  const handleAskAI = async () => {
    const q = aiQuestion.trim();
    if (!q || aiLoading) return;
    setAiLoading(true);
    setAiAnswer("");
    setAiError(null);
    try {
      const result = await askCall(call.id, q);
      setAiAnswer(result.answer);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "Failed to get answer");
    } finally {
      setAiLoading(false);
    }
  };

  const tabs: { id: DetailTab; label: string }[] = [
    { id: "summary",    label: "AI Summary" },
    { id: "keypoints",  label: "Key Points" },
    { id: "transcript", label: "Transcript" },
    { id: "askai",      label: "Ask AI" },
  ];

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex justify-end" style={{ animation: "fadeInOverlay 0.2s ease-out" }} onClick={onClose}>
      <div
        className="w-full max-w-2xl h-full border-l flex flex-col"
        style={{ background: "#181818", borderColor: 'var(--dash-card-border)', animation: "slideInFromRight 0.25s cubic-bezier(0.22,1,0.36,1)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b shrink-0"
             style={{ padding: 'var(--card-inner)', borderColor: 'var(--dash-card-border)' }}>
          <div style={{ flex: 1, minWidth: 0, paddingRight: 12 }}>
            <h2 className="text-white" style={{ fontSize: "1.1rem", fontWeight: 700, lineHeight: 1.3 }}>{detail.title}</h2>
            <div className="flex items-center gap-3" style={{ marginTop: 4 }}>
              <span style={{ fontSize: 'var(--fs-small)', color: 'var(--card-label)' }}>{detail.aeName}</span>
              <span style={{ color: 'var(--dash-divider)' }}>·</span>
              <span style={{ fontSize: 'var(--fs-small)', color: 'var(--card-label)' }}>{detail.date}</span>
              <span style={{ color: 'var(--dash-divider)' }}>·</span>
              <span className="flex items-center gap-1" style={{ fontSize: 'var(--fs-small)', color: 'var(--card-label)' }}>
                <Clock style={{ width: 11, height: 11 }} /> {detail.duration}
              </span>
              <span className="flex items-center gap-1" style={{ fontSize: 'var(--fs-small)', color: 'var(--card-label)' }}>
                <Users style={{ width: 11, height: 11 }} /> {detail.participants.length}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center border transition-all hover:text-white shrink-0"
            style={{ width: 32, height: 32, borderRadius: 'var(--card-r)', background: 'var(--card-bg)', borderColor: 'var(--dash-card-border)', color: 'var(--card-label)' }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Tab pills */}
        <div className="flex items-center gap-1.5 border-b shrink-0" style={{ padding: '10px 20px', borderColor: 'var(--dash-card-border)' }}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="flex items-center gap-1.5 transition-all"
              style={{
                padding: "5px 14px",
                borderRadius: 9999,
                fontSize: 'var(--fs-small)',
                fontWeight: activeTab === tab.id ? 600 : 400,
                background: activeTab === tab.id ? '#ec5d25' : 'transparent',
                color: activeTab === tab.id ? '#fff' : 'var(--card-label)',
                border: activeTab === tab.id ? '1px solid #ec5d25' : '1px solid var(--dash-card-border)',
              }}
            >
              {tab.id === "askai" && <Sparkles style={{ width: 10, height: 10 }} />}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Scrollable content — transcript tab uses its own internal scroll */}
        <div
          className="flex-1"
          style={{
            minHeight: 0,
            padding: 'var(--card-inner)',
            display: 'flex',
            flexDirection: 'column',
            gap: activeTab === "transcript" ? 8 : 18,
            overflow: activeTab === "transcript" ? "hidden" : "auto",
          }}
        >

          {/* ── AI Summary tab ── */}
          {activeTab === "summary" && (
            <>
              <div className="border" style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', padding: 'var(--card-inner)', borderColor: 'var(--dash-card-border)' }}>
                <p style={{ fontSize: 'var(--fs-label)', color: "#ec5d25", marginBottom: 8 }}>Summary</p>
                <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-muted)', lineHeight: 1.7 }}>
                  {detail.aiSummary || "No summary available for this call."}
                </p>
              </div>

              {detail.participants.length > 0 && (
                <div>
                  <p style={{ fontSize: 'var(--fs-label)', color: 'var(--card-label)', marginBottom: 8 }}>Participants</p>
                  <div className="flex flex-wrap gap-2">
                    {[...new Set(
                      detail.participants.flatMap((p) => p.split(",").map((s) => s.trim())).filter(Boolean)
                    )].map((p) => (
                      <span key={p} className="border"
                            style={{ fontSize: 'var(--fs-small)', padding: "4px 10px", borderRadius: 'var(--card-r)', background: 'var(--card-bg)', borderColor: 'var(--dash-card-border)', color: 'var(--card-muted)' }}>
                        {p}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Key Points tab ── */}
          {activeTab === "keypoints" && (
            <>
              {detail.topics.length > 0 && (
                <div>
                  <p style={{ fontSize: 'var(--fs-label)', color: 'var(--card-label)', marginBottom: 8 }}>Keywords</p>
                  <div className="flex flex-wrap gap-2">
                    {detail.topics.map((topic, idx) => (
                      <span key={`topic-${idx}`} className="border"
                            style={{ fontSize: 'var(--fs-tiny)', padding: "3px 8px", borderRadius: 9999, background: "rgba(236,93,37,0.1)", color: "#f5a07a", borderColor: "rgba(236,93,37,0.2)" }}>
                        {topic}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {detail.actionItems.length > 0 && (
                <div>
                  <p style={{ fontSize: 'var(--fs-label)', color: 'var(--card-label)', marginBottom: 8 }}>Action Items</p>
                  <div className="border" style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', padding: '10px 14px', borderColor: 'var(--dash-card-border)' }}>
                    <ReactMarkdown components={mdComponents}>
                      {detail.actionItems.map((item) => `- ${item}`).join("\n")}
                    </ReactMarkdown>
                  </div>
                </div>
              )}

              {detail.outline.length > 0 && (
                <div>
                  <p style={{ fontSize: 'var(--fs-label)', color: 'var(--card-label)', marginBottom: 8 }}>Meeting Outline</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {detail.outline.map((item, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span style={{ fontSize: 'var(--fs-tiny)', color: '#ec5d25', fontWeight: 700, marginTop: 2, flexShrink: 0 }}>{i + 1}.</span>
                        <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-muted)', lineHeight: 1.5, margin: 0 }}>{item}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {detail.topics.length === 0 && detail.actionItems.length === 0 && detail.outline.length === 0 && (
                <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)' }}>No key points available for this call.</p>
              )}
            </>
          )}

          {/* ── Transcript tab ── */}
          {activeTab === "transcript" && (() => {
            const sentences = detail.raw?.sentences ?? [];
            const hasTimestamps = sentences.length > 0;
            const hasTranscriptUrl = detail.transcriptUrl && detail.transcriptUrl !== "#";

            // Unique speakers for filter pill
            const speakers = hasTimestamps
              ? [...new Set(sentences.map((s) => s.speaker_name).filter(Boolean))].sort()
              : [];

            // Apply speaker filter then search filter
            const speakerFiltered = hasTimestamps
              ? (speakerFilter === "all" ? sentences : sentences.filter((s) => s.speaker_name === speakerFilter))
              : [];
            const matchedSentences = speakerFiltered
              .map((s) => ({ s, ...fuzzyMatch(s.text, transcriptSearch) }))
              .filter((r) => r.matched);
            const rawLines = !hasTimestamps
              ? detail.transcript.split("\n").filter((l) => l.trim())
                  .map((line) => ({ line, ...fuzzyMatch(line, transcriptSearch) }))
                  .filter((r) => r.matched)
              : [];

            return (
              <>
                {/* Search bar */}
                {(hasTimestamps || detail.transcript) && (
                  <div className="flex items-center gap-2 border"
                       style={{ flexShrink: 0, borderRadius: 'var(--card-r)', borderColor: 'var(--dash-divider)', padding: '7px 12px', background: '#181818' }}>
                    <Search style={{ width: 13, height: 13, color: 'var(--card-label)', flexShrink: 0 }} />
                    <input
                      value={transcriptSearch}
                      onChange={(e) => setTranscriptSearch(e.target.value)}
                      placeholder="Search in transcript…"
                      className="flex-1 bg-transparent border-none outline-none"
                      style={{ fontSize: 'var(--fs-small)', color: 'var(--dash-card-text)' }}
                    />
                    {transcriptSearch && (
                      <button onClick={() => setTranscriptSearch("")} style={{ color: 'var(--card-label)', lineHeight: 0 }}>
                        <X style={{ width: 12, height: 12 }} />
                      </button>
                    )}
                  </div>
                )}

                {/* Speaker filter pills */}
                {speakers.length > 1 && (
                  <div className="flex items-center gap-1.5 flex-wrap" style={{ flexShrink: 0 }}>
                    {["all", ...speakers].map((sp) => (
                      <button
                        key={sp}
                        onClick={() => setSpeakerFilter(sp)}
                        style={{
                          padding: "3px 10px", borderRadius: 9999, fontSize: 'var(--fs-tiny)',
                          fontWeight: speakerFilter === sp ? 600 : 400,
                          background: speakerFilter === sp ? '#ec5d25' : 'var(--card-bg)',
                          color: speakerFilter === sp ? '#fff' : 'var(--card-label)',
                          border: `1px solid ${speakerFilter === sp ? '#ec5d25' : 'var(--dash-card-border)'}`,
                          cursor: 'pointer',
                        }}
                      >
                        {sp === "all" ? "All speakers" : sp}
                      </button>
                    ))}
                  </div>
                )}

                {loadingDetail ? (
                  <div className="flex items-center gap-2" style={{ fontSize: 'var(--fs-small)', color: 'var(--card-label)' }}>
                    <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#ec5d25' }} /> Loading transcript…
                  </div>
                ) : hasTimestamps ? (
                  /* ── Sentence-by-sentence with timestamp links ── */
                  (() => {
                    const display = transcriptSearch.trim() ? matchedSentences : speakerFiltered.map((s) => ({ s, matched: true, indices: [] as number[] }));
                    return display.length === 0 ? (
                      <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)' }}>No lines match "{transcriptSearch}".</p>
                    ) : (
                      <div className="border" style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', borderColor: 'var(--dash-card-border)', overflowY: 'auto', flex: 1, minHeight: 0 }}>
                        {transcriptSearch.trim() && (
                          <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', padding: '8px 14px', borderBottom: '1px solid var(--dash-divider)' }}>
                            {display.length} line{display.length !== 1 ? "s" : ""} matched
                          </p>
                        )}
                        {display.map(({ s, indices }, i) => (
                          <div key={s.index ?? i} className="border-b last:border-b-0 flex gap-3 items-start"
                               style={{ padding: '9px 14px', borderColor: 'var(--dash-divider)' }}>
                            {/* Timestamp — links to Fireflies at that exact second */}
                            {hasTranscriptUrl ? (
                              <a
                                href={`${detail.transcriptUrl}?t=${Math.floor(s.start_time)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`Jump to ${formatTime(s.start_time)}`}
                                style={{
                                  fontSize: 'var(--fs-tiny)', color: '#60a5fa', flexShrink: 0,
                                  minWidth: 60, fontVariantNumeric: 'tabular-nums',
                                  lineHeight: '1.6', textDecoration: 'none',
                                }}
                                className="hover:opacity-70 transition-opacity"
                              >
                                {formatTime(s.start_time)}
                              </a>
                            ) : (
                              <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', flexShrink: 0, minWidth: 60, fontVariantNumeric: 'tabular-nums', lineHeight: '1.6' }}>
                                {formatTime(s.start_time)}
                              </span>
                            )}
                            {/* Speaker + text */}
                            <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-muted)', lineHeight: 1.6, margin: 0, flex: 1 }}>
                              {s.speaker_name && (
                                <span style={{ color: '#ec5d25', fontWeight: 600, marginRight: 4 }}>{s.speaker_name}:</span>
                              )}
                              {transcriptSearch.trim()
                                ? <HighlightedText text={s.text} indices={indices} />
                                : s.text}
                            </p>
                          </div>
                        ))}
                      </div>
                    );
                  })()
                ) : detail.transcript ? (
                  /* ── Fallback: raw transcript string ── */
                  transcriptSearch.trim() ? (
                    rawLines.length === 0 ? (
                      <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)' }}>No lines match "{transcriptSearch}".</p>
                    ) : (
                      <div className="border" style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', borderColor: 'var(--dash-card-border)', overflowY: 'auto', flex: 1, minHeight: 0 }}>
                        <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', padding: '8px 14px', borderBottom: '1px solid var(--dash-divider)' }}>
                          {rawLines.length} line{rawLines.length !== 1 ? "s" : ""} matched
                        </p>
                        {rawLines.map((r, i) => {
                          const parsed = parseRawLine(r.line);
                          const adjIdx = parsed ? r.indices.map(j => j - parsed.prefixLen).filter(j => j >= 0) : r.indices;
                          return (
                            <div key={i} className="border-b last:border-b-0 flex gap-3 items-start" style={{ padding: '9px 14px', borderColor: 'var(--dash-divider)' }}>
                              {parsed && hasTranscriptUrl ? (
                                <a href={`${detail.transcriptUrl}?t=${parsed.seconds}`} target="_blank" rel="noopener noreferrer"
                                   title={`Jump to ${parsed.label}`}
                                   style={{ fontSize: 'var(--fs-tiny)', color: '#60a5fa', flexShrink: 0, minWidth: 60, fontVariantNumeric: 'tabular-nums', lineHeight: '1.6', textDecoration: 'none' }}
                                   className="hover:opacity-70 transition-opacity">
                                  {parsed.label}
                                </a>
                              ) : parsed ? (
                                <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', flexShrink: 0, minWidth: 60, fontVariantNumeric: 'tabular-nums', lineHeight: '1.6' }}>
                                  {parsed.label}
                                </span>
                              ) : null}
                              <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-muted)', lineHeight: 1.6, margin: 0, flex: 1 }}>
                                <HighlightedText text={parsed ? parsed.rest : r.line} indices={adjIdx} />
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )
                  ) : (
                    <div className="border" style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', borderColor: 'var(--dash-card-border)', overflowY: 'auto', flex: 1, minHeight: 0 }}>
                      {detail.transcript.split("\n").filter((l) => l.trim()).map((line, i) => {
                        const parsed = parseRawLine(line);
                        return (
                          <div key={i} className="border-b last:border-b-0 flex gap-3 items-start" style={{ padding: '9px 14px', borderColor: 'var(--dash-divider)' }}>
                            {parsed && hasTranscriptUrl ? (
                              <a href={`${detail.transcriptUrl}?t=${parsed.seconds}`} target="_blank" rel="noopener noreferrer"
                                 title={`Jump to ${parsed.label}`}
                                 style={{ fontSize: 'var(--fs-tiny)', color: '#60a5fa', flexShrink: 0, minWidth: 60, fontVariantNumeric: 'tabular-nums', lineHeight: '1.6', textDecoration: 'none' }}
                                 className="hover:opacity-70 transition-opacity">
                                {parsed.label}
                              </a>
                            ) : parsed ? (
                              <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', flexShrink: 0, minWidth: 60, fontVariantNumeric: 'tabular-nums', lineHeight: '1.6' }}>
                                {parsed.label}
                              </span>
                            ) : null}
                            <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-muted)', lineHeight: 1.6, margin: 0, flex: 1 }}>
                              {parsed ? parsed.rest : line}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )
                ) : (
                  <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)' }}>
                    Transcript not available. Click a call row to load it from Fireflies.
                  </p>
                )}
              </>
            );
          })()}

          {/* ── Ask AI tab ── */}
          {activeTab === "askai" && (
            <>
              {/* Input area */}
              <div className="border" style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', borderColor: 'var(--dash-card-border)', overflow: 'hidden' }}>
                <textarea
                  ref={inputRef}
                  value={aiQuestion}
                  onChange={(e) => setAiQuestion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAskAI(); } }}
                  placeholder="Ask anything about this call… (e.g. What were the main objections? What were the next steps?)"
                  rows={3}
                  className="w-full bg-transparent border-none outline-none resize-none"
                  style={{ padding: '12px 14px', fontSize: 'var(--fs-small)', color: 'var(--dash-card-text)', lineHeight: 1.6 }}
                />
                <div className="flex items-center justify-between border-t" style={{ padding: '8px 12px', borderColor: 'var(--dash-card-border)' }}>
                  <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)' }}>
                    Powered by Groq · based on transcript &amp; Summary
                  </p>
                  <button
                    onClick={handleAskAI}
                    disabled={aiLoading || !aiQuestion.trim()}
                    className="flex items-center gap-1.5 transition-opacity"
                    style={{
                      padding: "5px 14px",
                      borderRadius: 9999,
                      fontSize: 'var(--fs-small)',
                      fontWeight: 600,
                      background: aiLoading || !aiQuestion.trim() ? 'var(--dash-divider)' : '#ec5d25',
                      color: aiLoading || !aiQuestion.trim() ? 'var(--card-subtle)' : '#fff',
                      cursor: aiLoading || !aiQuestion.trim() ? 'not-allowed' : 'pointer',
                      border: 'none',
                    }}
                  >
                    {aiLoading ? <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> : <Send style={{ width: 12, height: 12 }} />}
                    {aiLoading ? "Thinking…" : "Ask"}
                  </button>
                </div>
              </div>

              {/* Answer */}
              {(aiAnswer || aiError) && (
                <div className="border" style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', padding: 'var(--card-inner)', borderColor: aiError ? 'rgba(248,113,113,0.3)' : 'var(--dash-card-border)' }}>
                  {aiError ? (
                    <p style={{ fontSize: 'var(--fs-small)', color: '#f87171' }}>{aiError}</p>
                  ) : (
                    <ReactMarkdown components={mdComponents}>{aiAnswer}</ReactMarkdown>
                  )}
                </div>
              )}

              {!aiAnswer && !aiError && !aiLoading && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Try asking</p>
                  {[
                    "What were the main objections from the customer?",
                    "What are the agreed next steps?",
                    "What pain points did the customer mention?",
                    "What's the overall sentiment of this call?",
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => { setAiQuestion(suggestion); inputRef.current?.focus(); }}
                      className="text-left border transition-colors hover:border-orange-500/40"
                      style={{ padding: "8px 12px", borderRadius: 'var(--card-r)', background: 'var(--card-bg)', borderColor: 'var(--dash-card-border)', fontSize: 'var(--fs-small)', color: 'var(--card-muted)' }}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const HS_PORTAL = import.meta.env.VITE_PORTAL_ID ?? "";
const hsUrl = (type: string, id: string) =>
  `https://app-na2.hubspot.com/contacts/${HS_PORTAL}/record/${type}/${id}`;

// Outlook/HubSpot logged emails append the entire prior thread below the reply —
// either an underscore divider (e.g. "________________________________") or a
// Gmail-style "On <day>, <time> ... wrote:" header. Cut the body at whichever
// comes first so only the message actually sent at this email's own timestamp
// is shown, not every earlier reply already shown as its own row.
const QUOTE_MARKERS = [/_{8,}/, /\bOn\b[\s\S]{0,160}?\bwrote:/i];

const stripQuotedReplyTail = (html: string): string => {
  let cutIndex = html.length;
  for (const marker of QUOTE_MARKERS) {
    const match = html.match(marker);
    if (match?.index !== undefined && match.index < cutIndex) {
      cutIndex = match.index;
    }
  }
  return html.slice(0, cutIndex);
};

// Strip inline color/background styles from HubSpot HTML so the dark theme takes over
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parseNote = (html: string) => parse(html, {
  replace(node: any) {
    if (node.attribs?.style) {
      node.attribs.style = node.attribs.style
        .replace(/\bcolor\s*:[^;]+;?/gi, "")
        .replace(/\bbackground(-color)?\s*:[^;]+;?/gi, "")
        .replace(/\bfont-size\s*:[^;]+;?/gi, "");
    }
  },
});

const PAGE_SIZE = 20;

// Searchable, scrollable multi-select checklist — used by the HubSpot filter
// dropdown for Country and Stage, which can have far too many distinct
// values to browse as a single row of horizontal pills.
function ChecklistFilter({
  options, selected, onChange,
}: {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = query
    ? options.filter((o) => o.toLowerCase().includes(query.toLowerCase()))
    : options;

  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  return (
    <div>
      <div className="flex items-center gap-1.5 border" style={{
        margin: '0 14px 6px', padding: '5px 8px', borderRadius: 'var(--card-r)',
        borderColor: 'var(--dash-card-border)', background: 'var(--dash-dark)',
      }}>
        <Search style={{ width: 11, height: 11, color: 'var(--card-subtle)', flexShrink: 0 }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          className="flex-1 bg-transparent border-none outline-none"
          style={{ fontSize: 'var(--fs-tiny)', color: 'var(--dash-card-text)', minWidth: 0 }}
        />
        {selected.length > 0 && (
          <button onClick={() => onChange([])} style={{ fontSize: 'var(--fs-tiny)', color: '#ec5d25', flexShrink: 0 }}>
            Clear
          </button>
        )}
      </div>
      <div style={{ maxHeight: 160, overflowY: 'auto' }}>
        {filtered.length === 0 && (
          <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', padding: '6px 14px' }}>No matches</p>
        )}
        {filtered.map((opt) => {
          const checked = selected.includes(opt);
          return (
            <button
              key={opt}
              onClick={() => toggle(opt)}
              className="w-full flex items-center gap-2 transition-colors hover:bg-dash-card-hover"
              style={{ padding: '6px 14px', fontSize: 'var(--fs-small)', color: 'var(--dash-card-text)', textAlign: 'left' }}
            >
              <span className="flex items-center justify-center border" style={{
                width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                background: checked ? '#ec5d25' : 'transparent',
                borderColor: checked ? '#ec5d25' : 'var(--dash-card-border)',
              }}>
                {checked && <Check style={{ width: 10, height: 10, color: '#fff' }} />}
              </span>
              <span style={{ flex: 1 }}>{opt}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CallsLibraryPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { calls, isLoading, isLive, refresh, getCallDetail } = useData();
  const [search, setSearch] = useState("");
  const [selectedCall, setSelectedCall] = useState<NormalizedCall | null>(null);
  const [sentimentFilter, setSentimentFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "external" | "internal">("all");
  const [ffYearFilter, setFfYearFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const filterRef = useRef<HTMLDivElement>(null);
  const activeFilterCount = (sentimentFilter !== "all" ? 1 : 0) + (typeFilter !== "all" ? 1 : 0) + (ffYearFilter !== "all" ? 1 : 0);

  // ─── Row selection (hover checkboxes) → "Ask Glisseo" bridge to the chat page ──
  const [selectedCallIds, setSelectedCallIds] = useState<Set<string>>(new Set());
  const [selectedHsIds, setSelectedHsIds] = useState<Set<string>>(new Set());
  const [askBarQuestion, setAskBarQuestion] = useState("");
  const [askPopoverOpen, setAskPopoverOpen] = useState(false);
  const [askInfoOpen, setAskInfoOpen] = useState(false);
  const askRef = useRef<HTMLDivElement>(null);
  const toggleCallSelect = (id: string) => setSelectedCallIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleHsSelect = (id: string) => setSelectedHsIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // ─── Source toggle: Fireflies vs HubSpot ────────────────────────────────────
  const [source, setSource] = useState<"fireflies" | "hubspot">("fireflies");
  const [hsData, setHsData] = useState<HubspotFlatRow[]>([]);
  const [hsLoading, setHsLoading] = useState(false);
  const [hsError, setHsError] = useState<string | null>(null);
  const [hsFetched, setHsFetched] = useState(false);
  const [selectedHsRow, setSelectedHsRow] = useState<HubspotFlatRow | null>(null);
  // Deep-link target when arriving via a "view deal" navigation (e.g. from
  // Insights' Sales stage modal) — highlights the specific deal within the
  // opened company's Deals section.
  const [highlightDealId, setHighlightDealId] = useState<string | null>(null);
  const highlightDealRef = useRef<HTMLDivElement>(null);
  const [hsVisibleCount, setHsVisibleCount] = useState(50);
  const [hsSortDir, setHsSortDir] = useState<"asc" | "desc">("desc");
  const [hsCountryFilters, setHsCountryFilters] = useState<string[]>([]);
  const [hsStageFilters, setHsStageFilters] = useState<string[]>([]);
  const [hsPipelineFilter, setHsPipelineFilter] = useState("all");
  const [hsYearFilter, setHsYearFilter] = useState("all");
  const [hsFilterOpen, setHsFilterOpen] = useState(false);
  const hsFilterRef = useRef<HTMLDivElement>(null);

  // HubSpot row modal — Ask AI
  const [hsModalTab, setHsModalTab] = useState<"details" | "askai">("details");
  const [hsDetailsSubTab, setHsDetailsSubTab] = useState<"notes" | "emails">("notes");
  const [hsAiQuestion, setHsAiQuestion] = useState("");
  const [hsAiAnswer, setHsAiAnswer] = useState("");
  const [hsAiLoading, setHsAiLoading] = useState(false);
  const [hsAiError, setHsAiError] = useState<string | null>(null);
  const hsAiInputRef = useRef<HTMLTextAreaElement>(null);

  // Full note/email bodies for the selected company — fetched lazily on modal open.
  const [hsDetail, setHsDetail] = useState<HubspotCompanyDetail | null>(null);
  const [hsDetailLoading, setHsDetailLoading] = useState(false);
  const [hsDetailError, setHsDetailError] = useState<string | null>(null);

  useEffect(() => {
    if (source !== "hubspot" || hsFetched) return;
    setHsLoading(true);
    setHsError(null);
    getHubspotFlatData()
      .then((res) => {
        setHsData((res.rows || []) as HubspotFlatRow[]);
        setHsFetched(true);
      })
      .catch((err) => setHsError(err instanceof Error ? err.message : "Failed to load HubSpot data"))
      .finally(() => setHsLoading(false));
  }, [source, hsFetched]);

  // Deep-link handling: a caller (e.g. Insights' Sales stage modal) navigated
  // here with { hubspotCompanyId, hubspotDealId? } in location.state. Switch
  // to the HubSpot tab immediately so the fetch effect above kicks off, then
  // once hsData has actually loaded, open that company's modal and highlight
  // the deal. The state is cleared via a replace navigation once handled (or
  // once we've established the company can't be found) so it doesn't re-fire.
  useEffect(() => {
    const navState = location.state as HubspotDealLinkState | null;
    if (!navState?.hubspotCompanyId) return;
    setSource("hubspot");
    if (!hsFetched) return;
    const row = hsData.find((r) => r.company_id === navState.hubspotCompanyId);
    if (row) {
      setSelectedHsRow(row);
      setHighlightDealId(navState.hubspotDealId ?? null);
    }
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, hsFetched, hsData, navigate]);

  // Scroll the highlighted deal into view once, when the modal opens with a target.
  useEffect(() => {
    if (highlightDealId && selectedHsRow) {
      highlightDealRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightDealId, selectedHsRow]);

  const [hsBackfilling, setHsBackfilling] = useState(false);
  const refreshHubspot = () => { setHsFetched(false); };
  const backfillLabels = async () => {
    setHsBackfilling(true);
    try {
      await backfillHubspotLabels();
      setHsFetched(false); // reload table with updated labels
    } finally {
      setHsBackfilling(false);
    }
  };

  // Clear selection + question when switching between Fireflies and HubSpot
  useEffect(() => {
    setSelectedCallIds(new Set());
    setSelectedHsIds(new Set());
    setAskBarQuestion("");
    setAskPopoverOpen(false);
    setAskInfoOpen(false);
  }, [source]);

  const selectedCount = source === "fireflies" ? selectedCallIds.size : selectedHsIds.size;

  // Close the ask popover / info bubble on outside click
  useEffect(() => {
    if (!askPopoverOpen && !askInfoOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (askRef.current && !askRef.current.contains(e.target as Node)) {
        setAskPopoverOpen(false);
        setAskInfoOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [askPopoverOpen, askInfoOpen]);

  const handleAskGlisseoClick = () => {
    if (selectedCount < 2) {
      setAskInfoOpen(true);
      return;
    }
    setAskInfoOpen(false);
    setAskPopoverOpen((o) => !o);
  };

  const handleAskGlisseo = () => {
    const question = askBarQuestion.trim();
    if (!question) return;
    const seedItems: AskAiSeedItem[] = source === "fireflies"
      ? calls.filter((c) => selectedCallIds.has(c.id)).map((c) => ({ type: "call" as const, id: c.id, title: c.title }))
      : hsData.filter((r) => selectedHsIds.has(r.company_id)).map((r) => ({
          type: "hubspot" as const,
          id: r.company_id,
          label: r.company_name || "Unnamed Company",
          context: r as unknown as Record<string, unknown>,
        }));
    if (seedItems.length === 0) return;
    setAskPopoverOpen(false);
    navigate("/ask-ai", { state: { seedQuestion: question, seedItems } });
  };

  // Auto-refresh when Fireflies returns no calls
  const [noCallsCountdown, setNoCallsCountdown] = useState<number | null>(null);
  useEffect(() => {
    const empty = !isLoading && source === "fireflies" && calls.length === 0;
    if (!empty) { setNoCallsCountdown(null); return; }
    setNoCallsCountdown(5);
    const interval = setInterval(() => {
      setNoCallsCountdown((n) => {
        if (n === null || n <= 1) { clearInterval(interval); refresh(); return null; }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [isLoading, source, calls.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [search, sentimentFilter, typeFilter, ffYearFilter]);
  useEffect(() => { setHsVisibleCount(50); }, [search, hsCountryFilters, hsStageFilters, hsPipelineFilter, hsYearFilter]);

  // ─── Background transcript backfill — every 15 min, try to fill any calls missing a transcript ──
  const callsRef = useRef(calls);
  useEffect(() => { callsRef.current = calls; }, [calls]);
  const getCallDetailRef = useRef(getCallDetail);
  useEffect(() => { getCallDetailRef.current = getCallDetail; }, [getCallDetail]);
  const isBackfillingTranscriptsRef = useRef(false);

  const backfillMissingTranscripts = useCallback(async () => {
    if (isBackfillingTranscriptsRef.current) return;
    const missing = callsRef.current.filter((c) => !c.transcript);
    if (missing.length === 0) return;

    isBackfillingTranscriptsRef.current = true;
    const batch = missing.slice(0, 25); // cap per run so we don't hammer Fireflies
    console.log(`[transcript backfill] ${missing.length} call(s) missing transcript — fetching ${batch.length} this run...`);
    try {
      for (const call of batch) {
        try {
          await getCallDetailRef.current(call.id);
        } catch (err) {
          console.warn(`[transcript backfill] failed for call ${call.id}:`, err);
        }
        await new Promise((r) => setTimeout(r, 400)); // small delay between requests
      }
    } finally {
      isBackfillingTranscriptsRef.current = false;
    }
  }, []);

  useEffect(() => {
    backfillMissingTranscripts();
    const id = setInterval(backfillMissingTranscripts, 15 * 60 * 1000);
    return () => clearInterval(id);
  }, [backfillMissingTranscripts]);

  useEffect(() => {
    if (!filterOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [filterOpen]);

  useEffect(() => {
    if (!hsFilterOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (hsFilterRef.current && !hsFilterRef.current.contains(e.target as Node)) {
        setHsFilterOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [hsFilterOpen]);

  useEffect(() => {
    setHsModalTab("details");
    setHsDetailsSubTab("notes");
    setHsAiQuestion("");
    setHsAiAnswer("");
    setHsAiError(null);

    setHsDetail(null);
    setHsDetailError(null);
    if (!selectedHsRow?.company_id) return;
    setHsDetailLoading(true);
    getHubspotCompanyDetails(selectedHsRow.company_id)
      .then((res) => setHsDetail(res))
      .catch((err) => setHsDetailError(err instanceof Error ? err.message : "Failed to load notes/emails"))
      .finally(() => setHsDetailLoading(false));
  }, [selectedHsRow?.company_id]);

  const handleHsAskAI = async () => {
    const q = hsAiQuestion.trim();
    if (!q || hsAiLoading || !selectedHsRow) return;
    setHsAiLoading(true);
    setHsAiAnswer("");
    setHsAiError(null);
    try {
      const result = await askHubspotRow(selectedHsRow as unknown as Record<string, unknown>, q);
      setHsAiAnswer(result.answer);
    } catch (err) {
      setHsAiError(err instanceof Error ? err.message : "Failed to get answer");
    } finally {
      setHsAiLoading(false);
    }
  };

  const filteredCalls = useMemo(() => calls.filter((call) => {
    const matchesSearch =
      fuzzyMatch(call.title, search).matched ||
      call.clientName.toLowerCase().includes(search.toLowerCase()) ||
      call.aeName.toLowerCase().includes(search.toLowerCase()) ||
      call.participants.some((p) => p.toLowerCase().includes(search.toLowerCase()));
    const matchesSentiment = sentimentFilter === "all" || call.sentiment === sentimentFilter;
    const isExternal = call.externalParticipants.length > 0;
    const matchesType =
      typeFilter === "all" ||
      (typeFilter === "external" && isExternal) ||
      (typeFilter === "internal" && !isExternal);
    const matchesYear = ffYearFilter === "all" || (call.date.match(/\d{4}/)?.[0] === ffYearFilter);
    return matchesSearch && matchesSentiment && matchesType && matchesYear;
  }), [calls, search, sentimentFilter, typeFilter, ffYearFilter]);

  const visibleCalls = filteredCalls.slice(0, visibleCount);
  const hasMore = visibleCount < filteredCalls.length;

  // Client-side search + filters for HubSpot unified table
  const hsSearch = source === "hubspot" ? search.toLowerCase() : "";
  const hsCountries = useMemo(() => [...new Set(hsData.map((r) => r.company_country).filter(Boolean))].sort(), [hsData]);
  const hsStages = useMemo(() => [...new Set(hsData.map((r) => r.deal_stage).filter(Boolean))].sort(), [hsData]);
  const hsPipelines = useMemo(() => [...new Set(hsData.map((r) => r.deal_pipeline).filter(Boolean))].sort(), [hsData]);
  const hsYears = useMemo(() => {
    const yrs = new Set<string>();
    hsData.forEach((r) => {
      if (r.deal_createdate) {
        const y = new Date(r.deal_createdate).getFullYear();
        if (!isNaN(y)) yrs.add(String(y));
      }
    });
    return [...yrs].sort((a, b) => b.localeCompare(a));
  }, [hsData]);
  const ffYears = useMemo(() => {
    const yrs = new Set<string>();
    calls.forEach((c) => { const m = c.date.match(/\d{4}/); if (m) yrs.add(m[0]); });
    return [...yrs].sort((a, b) => b.localeCompare(a));
  }, [calls]);
  const activeHsFilterCount = (hsCountryFilters.length > 0 ? 1 : 0) + (hsStageFilters.length > 0 ? 1 : 0) + (hsPipelineFilter !== "all" ? 1 : 0) + (hsYearFilter !== "all" ? 1 : 0);
  const filteredHsData = useMemo(() => hsData.filter((r) => {
    const matchesSearch = !hsSearch || (
      r.company_name.toLowerCase().includes(hsSearch) ||
      r.company_domain.toLowerCase().includes(hsSearch) ||
      r.company_industry.toLowerCase().includes(hsSearch) ||
      r.company_country.toLowerCase().includes(hsSearch) ||
      fuzzyMatch(r.deal_name, hsSearch).matched ||
      r.deal_stage.toLowerCase().includes(hsSearch) ||
      r.deal_pipeline.toLowerCase().includes(hsSearch)
    );
    const matchesCountry = hsCountryFilters.length === 0 || hsCountryFilters.includes(r.company_country);
    const matchesStage = hsStageFilters.length === 0 || hsStageFilters.includes(r.deal_stage);
    const matchesPipeline = hsPipelineFilter === "all" || r.deal_pipeline === hsPipelineFilter;
    const matchesYear = hsYearFilter === "all" || (
      r.deal_createdate && String(new Date(r.deal_createdate).getFullYear()) === hsYearFilter
    );
    return matchesSearch && matchesCountry && matchesStage && matchesPipeline && matchesYear;
  }), [hsData, hsSearch, hsCountryFilters, hsStageFilters, hsPipelineFilter, hsYearFilter]);
  const sortedHsData = useMemo(() => [...filteredHsData].sort((a, b) => {
    const av = a.deal_createdate || "";
    const bv = b.deal_createdate || "";
    return hsSortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
  }), [filteredHsData, hsSortDir]);
  const visibleHsData = sortedHsData.slice(0, hsVisibleCount);
  const hsHasMore = hsVisibleCount < sortedHsData.length;

  // Only block the whole page on Fireflies load; HubSpot is independent
  if (isLoading && source === "fireflies") {
    return (
      <div className="h-full bg-dash-dark flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 style={{ width: 28, height: 28, color: "#ec5d25" }} className="animate-spin" />
          <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-label)' }}>Loading calls from Fireflies & Hubspot…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full bg-dash-dark overflow-y-auto" style={{ paddingTop: 64 }}>
      <div style={{ padding: '28px 36px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Header */}
        <div style={{ padding: '12px 0' }}>
          <h1 className="text-white" style={{ fontSize: '2.6rem' }}>Calls Library</h1>
        </div>

        {/* Single unified block: search + filters + table.
            NOT overflow-hidden here — the Filter dropdown is an absolutely-positioned
            popover anchored inside the toolbar below, and overflow:hidden on this
            outer box would permanently clip it (with no way to scroll it back into
            view) whenever the table is short enough that the block's total height
            is less than the dropdown's own height — i.e. exactly when there are few
            rows. Rounding is instead clipped per-table-wrapper below, scoped to just
            the table content, so it doesn't also clip the toolbar's popovers. */}
        <div className="border" style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', borderColor: 'var(--dash-card-border)' }}>

          {/* Toolbar */}
          <div className="flex items-center gap-3 flex-wrap border-b" style={{ padding: '12px 16px', borderColor: 'var(--dash-card-border)' }}>

            {/* Source toggle */}
            <div className="flex items-center gap-0.5" style={{ padding: 3, borderColor: 'var(--dash-card-border)', flexShrink: 0 }}>
              {([
                { id: "fireflies" as const, icon: <img src="https://img.logo.dev/fireflies.ai?token=pk_L8_LjP3dRAaHRmdddLSwUg" alt="Fireflies Logo" style={{ width: 30, height: 30, marginRight: 3, borderRadius: 3, background: "#fff" }} /> },
           
                { id: "hubspot" as const, icon: <img src="https://img.logo.dev/hubspot.com?token=pk_L8_LjP3dRAaHRmdddLSwUg" alt="Hubspot Logo" style={{ width: 30, height: 30, marginRight: 3, borderRadius: 3, background: "#fff" }} /> },
           
           
              ]).map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSource(s.id)}
                  className="flex items-center gap-1.5 rounded transition-all"
                  style={{
                    padding: "5px 12px",
                    fontSize: 'var(--fs-small)',
                    background: source === s.id ? '#ec5d25' : 'transparent',
                    color: source === s.id ? '#fff' : 'var(--card-label)',
                    fontWeight: source === s.id ? 600 : 400,
                  }}
                >
                  {s.icon} {s.label}
                </button>
              ))}
            </div>

            {/* HubSpot refresh + backfill */}
            {source === "hubspot" && (
              <>
                <button onClick={refreshHubspot} title="Refresh HubSpot data" className="flex items-center gap-1.5 transition-opacity hover:opacity-70" style={{ color: 'var(--card-label)', fontSize: 'var(--fs-tiny)' }}>
                  <RefreshCw style={{ width: 11, height: 11 }} /> Refresh
                </button>
                <button
                  onClick={backfillLabels}
                  disabled={hsBackfilling}
                  title="Resolve stage/pipeline IDs to labels for all existing deals"
                  className="flex items-center gap-1.5 transition-opacity hover:opacity-70 disabled:opacity-40"
                  style={{ color: 'var(--card-label)', fontSize: 'var(--fs-tiny)' }}
                >
                  {hsBackfilling
                    ? <Loader2 style={{ width: 11, height: 11 }} className="animate-spin" />
                    : <RefreshCw style={{ width: 11, height: 11 }} />}
                  Fix labels
                </button>
              </>
            )}

            <div className="flex-1 min-w-52 flex items-center gap-2 border"
                 style={{ borderRadius: 'var(--card-r)', borderColor: 'var(--dash-divider)', padding: '7px 12px', background: 'transparent' }}>
              <Search style={{ width: 13, height: 13, color: 'var(--card-label)', flexShrink: 0 }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={source === "hubspot" ? "Search companies, deals, notes…" : "Search calls, participants…"}
                className="flex-1 bg-transparent border-none outline-none"
                style={{ fontSize: 'var(--fs-small)', color: 'var(--dash-card-text)' }}
              />
            </div>
            {/* Row count — HubSpot only */}
            {source === "hubspot" && !hsLoading && !hsError && (
              <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {(hsSearch || activeHsFilterCount > 0)
                  ? `${filteredHsData.length} of ${hsData.length}`
                  : `${hsData.length}`}{" "}
                {hsData.length === 1 ? "company" : "companies"}
                {hsHasMore && ` · showing ${hsVisibleCount}`}
              </span>
            )}

            {/* Filter dropdown — HubSpot */}
            {source === "hubspot" && <div ref={hsFilterRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setHsFilterOpen((o) => !o)}
                className="flex items-center gap-1.5 border transition-colors"
                style={{
                  fontSize: 'var(--fs-tiny)',
                  padding: "6px 10px",
                  borderRadius: 'var(--card-r)',
                  background: hsFilterOpen || activeHsFilterCount > 0 ? 'var(--dash-card-hover)/200' : 'transparent',
                  borderColor: hsFilterOpen || activeHsFilterCount > 0 ? '#ec5d25' : 'var(--dash-divider)',
                  color: activeHsFilterCount > 0 ? '#ec5d25' : 'var(--card-label)',
                }}
              >
                <Filter style={{ width: 11, height: 11 }} />
                Filter
                {activeHsFilterCount > 0 && (
                  <span style={{
                    width: 16, height: 16, borderRadius: '50%',
                    background: '#1a1a2e', color: '#fff',
                    fontSize: '0.55rem', fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {activeHsFilterCount}
                  </span>
                )}
              </button>

              {hsFilterOpen && (
                <div
                  className="border"
                  style={{
                    position: 'absolute', top: 'calc(100% + 6px)', right: 0,
                    zIndex: 40, minWidth: 260, maxWidth: 300,
                    background: 'var(--card-bg)', borderColor: 'var(--dash-card-border)',
                    borderRadius: 'var(--card-r)',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                    padding: '10px 0',
                    maxHeight: 360, overflowY: 'auto',
                  }}
                >
                  {/* Country */}
                  <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '2px 14px 6px' }}>
                    Country{hsCountryFilters.length > 0 && ` (${hsCountryFilters.length})`}
                  </p>
                  <ChecklistFilter options={hsCountries} selected={hsCountryFilters} onChange={setHsCountryFilters} />

                  <div style={{ height: 1, background: 'var(--dash-divider)', margin: '8px 0' }} />

                  {/* Stage */}
                  <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '2px 14px 6px' }}>
                    Stage{hsStageFilters.length > 0 && ` (${hsStageFilters.length})`}
                  </p>
                  <ChecklistFilter options={hsStages} selected={hsStageFilters} onChange={setHsStageFilters} />

                  <div style={{ height: 1, background: 'var(--dash-divider)', margin: '8px 0' }} />

                  {/* Pipeline */}
                  <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '2px 14px 6px' }}>Pipeline</p>
                  {[{ value: "all", label: "All" }, ...hsPipelines.map((p) => ({ value: p, label: p }))].map((opt) => (
                    <button key={opt.value} onClick={() => setHsPipelineFilter(opt.value)}
                      className="w-full flex items-center gap-2 transition-colors hover:bg-dash-card-hover"
                      style={{ padding: '7px 14px', fontSize: 'var(--fs-small)', color: 'var(--dash-card-text)', textAlign: 'left' }}>
                      <span style={{ flex: 1 }}>{opt.label}</span>
                      {hsPipelineFilter === opt.value && <Check style={{ width: 11, height: 11, color: '#ec5d25', flexShrink: 0 }} />}
                    </button>
                  ))}

                  {hsYears.length > 0 && <div style={{ height: 1, background: 'var(--dash-divider)', margin: '8px 0' }} />}

                  {/* Year */}
                  {hsYears.length > 0 && <>
                    <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '2px 14px 6px' }}>Year</p>
                    <div className="flex items-center gap-1.5" style={{ padding: '0 14px 8px', overflowX: 'auto' }}>
                      {[{ value: "all", label: "All" }, ...hsYears.map((y) => ({ value: y, label: y }))].map((opt) => (
                        <button key={opt.value} onClick={() => setHsYearFilter(opt.value)}
                          className="transition-colors"
                          style={{
                            padding: '5px 12px', borderRadius: 9999, fontSize: 'var(--fs-tiny)', whiteSpace: 'nowrap', flexShrink: 0,
                            fontWeight: hsYearFilter === opt.value ? 600 : 400,
                            background: hsYearFilter === opt.value ? '#ec5d25' : 'var(--card-bg)',
                            color: hsYearFilter === opt.value ? '#fff' : 'var(--card-label)',
                            border: `1px solid ${hsYearFilter === opt.value ? '#ec5d25' : 'var(--dash-card-border)'}`,
                          }}>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </>}

                  {/* Clear */}
                  {activeHsFilterCount > 0 && (
                    <>
                      <div style={{ height: 1, background: 'var(--dash-divider)', margin: '8px 0' }} />
                      <button
                        onClick={() => { setHsCountryFilters([]); setHsStageFilters([]); setHsPipelineFilter("all"); setHsYearFilter("all"); }}
                        className="w-full transition-colors hover:bg-dash-card-hover"
                        style={{ padding: '7px 14px', fontSize: 'var(--fs-tiny)', color: '#f87171', textAlign: 'left' }}
                      >
                        Clear all filters
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>}

            {/* Row count — Fireflies only */}
            {source === "fireflies" && (
              <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {(search || activeFilterCount > 0)
                  ? `${filteredCalls.length} of ${calls.length}`
                  : `${calls.length}`}{" "}
                {calls.length === 1 ? "call" : "calls"}
                {hasMore && ` · showing ${visibleCalls.length}`}
              </span>
            )}

            {/* Filter dropdown — Fireflies only */}
            {source === "fireflies" && <div ref={filterRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setFilterOpen((o) => !o)}
                className="flex items-center gap-1.5 border transition-colors"
                style={{
                  fontSize: 'var(--fs-tiny)',
                  padding: "6px 10px",
                  borderRadius: 'var(--card-r)',
                  background: filterOpen || activeFilterCount > 0 ? 'var(--dash-card-hover)' : 'transparent',
                  borderColor: filterOpen || activeFilterCount > 0 ? '#ec5d25' : 'var(--dash-divider)',
                  color: activeFilterCount > 0 ? '#ec5d25' : 'var(--card-label)',
                }}
              >
                <Filter style={{ width: 11, height: 11 }} />
                Filter
                {activeFilterCount > 0 && (
                  <span style={{
                    width: 16, height: 16, borderRadius: '50%',
                    background: '#ec5d25', color: '#fff',
                    fontSize: '0.55rem', fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {activeFilterCount}
                  </span>
                )}
              </button>

              {filterOpen && (
                <div
                  className="border"
                  style={{
                    position: 'absolute', top: 'calc(100% + 6px)', right: 0,
                    zIndex: 40, minWidth: 200,
                    background: 'var(--card-bg)', borderColor: 'var(--dash-card-border)',
                    borderRadius: 'var(--card-r)',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                    padding: '10px 0',
                  }}
                >
                  {/* Type section */}
                  <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '2px 14px 6px' }}>
                    Type
                  </p>
                  {([
                    { value: "all",      label: "All",      dot: "#64748b" },
                    { value: "external", label: "External", dot: "#60a5fa" },
                    { value: "internal", label: "Internal", dot: "#a78bfa" },
                  ] as const).map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => { setTypeFilter(opt.value); }}
                      className="w-full flex items-center gap-2 transition-colors hover:bg-dash-card-hover"
                      style={{ padding: '7px 14px', fontSize: 'var(--fs-small)', color: 'var(--dash-card-text)', textAlign: 'left' }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: opt.dot, flexShrink: 0 }} />
                      <span style={{ flex: 1 }}>{opt.label}</span>
                      {typeFilter === opt.value && <Check style={{ width: 11, height: 11, color: '#ec5d25', flexShrink: 0 }} />}
                    </button>
                  ))}

                  {/* Divider */}
                  <div style={{ height: 1, background: 'var(--dash-divider)', margin: '8px 0' }} />

                  {/* Sentiment section */}
                  <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '2px 14px 6px' }}>
                    Sentiment
                  </p>
                  {([
                    { value: "all",      label: "All",      dot: "#64748b" },
                    { value: "positive", label: "Positive", dot: "#4ade80" },
                    { value: "neutral",  label: "Neutral",  dot: "#fbbf24" },
                    { value: "negative", label: "Negative", dot: "#f87171" },
                  ] as const).map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => { setSentimentFilter(opt.value); }}
                      className="w-full flex items-center gap-2 transition-colors hover:bg-dash-card-hover"
                      style={{ padding: '7px 14px', fontSize: 'var(--fs-small)', color: 'var(--dash-card-text)', textAlign: 'left' }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: opt.dot, flexShrink: 0 }} />
                      <span style={{ flex: 1 }}>{opt.label}</span>
                      {sentimentFilter === opt.value && <Check style={{ width: 11, height: 11, color: '#ec5d25', flexShrink: 0 }} />}
                    </button>
                  ))}

                  {ffYears.length > 0 && <div style={{ height: 1, background: 'var(--dash-divider)', margin: '8px 0' }} />}

                  {/* Year */}
                  {ffYears.length > 0 && <>
                    <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '2px 14px 6px' }}>
                      Year
                    </p>
                    {[{ value: "all", label: "All" }, ...ffYears.map((y) => ({ value: y, label: y }))].map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setFfYearFilter(opt.value)}
                        className="w-full flex items-center gap-2 transition-colors hover:bg-dash-card-hover"
                        style={{ padding: '7px 14px', fontSize: 'var(--fs-small)', color: 'var(--dash-card-text)', textAlign: 'left' }}
                      >
                        <span style={{ flex: 1 }}>{opt.label}</span>
                        {ffYearFilter === opt.value && <Check style={{ width: 11, height: 11, color: '#ec5d25', flexShrink: 0 }} />}
                      </button>
                    ))}
                  </>}

                  {/* Clear */}
                  {activeFilterCount > 0 && (
                    <>
                      <div style={{ height: 1, background: 'var(--dash-divider)', margin: '8px 0' }} />
                      <button
                        onClick={() => { setSentimentFilter("all"); setTypeFilter("all"); setFfYearFilter("all"); }}
                        className="w-full transition-colors hover:bg-dash-card-hover"
                        style={{ padding: '7px 14px', fontSize: 'var(--fs-tiny)', color: '#f87171', textAlign: 'left' }}
                      >
                        Clear all filters
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>}

            {/* Ask Glisseo — always visible; disabled-styled until 2+ rows are
                checked. Clicking below that threshold shows an info bubble
                instead of doing nothing, so the affordance stays discoverable. */}
            <div ref={askRef} style={{ position: 'relative' }}>
              <button
                onClick={handleAskGlisseoClick}
                className="flex items-center gap-1.5 transition-opacity"
                style={{
                  fontSize: 'var(--fs-tiny)',
                  padding: "6px 12px",
                  borderRadius: 'var(--card-r)',
                  border: `1px solid ${selectedCount >= 2 ? '#ec5d25' : 'var(--dash-divider)'}`,
                  background: selectedCount >= 2 ? 'rgba(236,93,37,0.1)' : 'transparent',
                  color: selectedCount >= 2 ? '#ec5d25' : 'var(--card-subtle)',
                  opacity: selectedCount >= 2 ? 1 : 0.6,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <Sparkles style={{ width: 11, height: 11 }} />
                Ask Glisseo
                {selectedCount > 0 && (
                  <span style={{
                    width: 16, height: 16, borderRadius: '50%',
                    background: selectedCount >= 2 ? '#ec5d25' : 'var(--dash-divider)',
                    color: selectedCount >= 2 ? '#fff' : 'var(--card-subtle)',
                    fontSize: '0.55rem', fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {selectedCount}
                  </span>
                )}
              </button>

              {/* Info bubble — shown when clicked with fewer than 2 selected */}
              {askInfoOpen && (
                <div
                  className="border"
                  style={{
                    position: 'absolute', top: 'calc(100% + 6px)', right: 0,
                    zIndex: 40, width: 220,
                    background: 'var(--card-bg)', borderColor: '#ec5d25',
                    borderRadius: 'var(--card-r)',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                    padding: '10px 12px',
                    fontSize: 'var(--fs-tiny)', color: 'var(--dash-card-text)', lineHeight: 1.5,
                  }}
                >
                  Select two or more to ask combined
                </div>
              )}

              {/* Question popover — shown once 2+ rows are selected and the button is clicked */}
              {askPopoverOpen && selectedCount >= 2 && (
                <div
                  className="border"
                  style={{
                    position: 'absolute', top: 'calc(100% + 6px)', right: 0,
                    zIndex: 40, width: 280,
                    background: 'var(--card-bg)', borderColor: 'var(--dash-card-border)',
                    borderRadius: 'var(--card-r)',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                    padding: 12,
                    display: 'flex', flexDirection: 'column', gap: 8,
                  }}
                >
                  <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)' }}>
                    Ask a combined question about the {selectedCount} selected {source === "fireflies" ? "calls" : "companies"}
                  </p>
                  <textarea
                    autoFocus
                    value={askBarQuestion}
                    onChange={(e) => setAskBarQuestion(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && askBarQuestion.trim()) { e.preventDefault(); handleAskGlisseo(); } }}
                    placeholder={source === "fireflies" ? "Ask about these calls…" : "Ask about these companies…"}
                    rows={2}
                    className="w-full bg-transparent border-none outline-none resize-none"
                    style={{ fontSize: 'var(--fs-small)', color: 'var(--dash-card-text)', border: '1px solid var(--dash-divider)', borderRadius: 'var(--card-r)', padding: '8px 10px' }}
                  />
                  <button
                    onClick={handleAskGlisseo}
                    disabled={!askBarQuestion.trim()}
                    className="flex items-center justify-center gap-1.5 transition-opacity"
                    style={{
                      padding: "6px 12px", borderRadius: 9999, fontSize: 'var(--fs-small)', fontWeight: 600,
                      background: askBarQuestion.trim() ? '#ec5d25' : 'var(--dash-divider)',
                      color: askBarQuestion.trim() ? '#fff' : 'var(--card-subtle)',
                      cursor: askBarQuestion.trim() ? 'pointer' : 'not-allowed',
                      border: 'none',
                    }}
                  >
                    <Sparkles style={{ width: 12, height: 12 }} />
                    Ask Glisseo
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* ── HubSpot unified table ── */}
          {source === "hubspot" && (
            <div className="overflow-x-auto" style={{ overflowY: 'hidden', borderBottomLeftRadius: 'var(--card-r)', borderBottomRightRadius: 'var(--card-r)' }}>
              {hsLoading && (
                <div className="flex items-center justify-center gap-2" style={{ padding: 48, color: 'var(--card-label)', fontSize: 'var(--fs-small)' }}>
                  <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#ec5d25' }} /> Loading HubSpot data…
                </div>
              )}
              {hsError && (
                <p className="text-center" style={{ padding: 32, fontSize: 'var(--fs-small)', color: '#f87171' }}>
                  {hsError}
                </p>
              )}

              {!hsLoading && !hsError && (
                <table className="w-full">
                  <thead>
                    <tr className="border-b" style={{ borderColor: 'var(--dash-divider)' }}>
                      <th style={{ padding: '10px 8px 10px 16px', width: 32 }} />
                      {["Company", "Domain", "Industry", "Country", "Deal Name", "Stage", "Pipeline"].map((h) => (
                        <th key={h} className="text-left" style={{ padding: '10px 16px', fontSize: 'var(--fs-big)', fontWeight: 600, color: 'var(--card-label)' }}>{h}</th>
                      ))}
                      <th className="text-left" style={{ padding: '10px 16px', fontSize: 'var(--fs-big)', fontWeight: 600, color: 'var(--card-label)', whiteSpace: 'nowrap' }}>
                        <button
                          onClick={() => setHsSortDir((d) => d === "asc" ? "desc" : "asc")}
                          className="flex items-center gap-1 transition-opacity hover:opacity-70"
                          style={{ color: 'var(--card-label)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 'inherit' }}
                        >
                          Deal Created
                          {hsSortDir === "asc"
                            ? <ArrowUp style={{ width: 11, height: 11, color: '#ec5d25' }} />
                            : hsSortDir === "desc"
                              ? <ArrowDown style={{ width: 11, height: 11, color: '#ec5d25' }} />
                              : <ArrowUpDown style={{ width: 11, height: 11 }} />}
                        </button>
                      </th>
                      <th className="text-left" style={{ padding: '10px 16px', fontSize: 'var(--fs-big)', fontWeight: 600, color: 'var(--card-label)' }}>Links</th>
                      <th style={{ padding: '10px 16px' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredHsData.length === 0 ? (
                      <tr><td colSpan={11} className="text-center" style={{ padding: '48px 16px', fontSize: 'var(--fs-small)', color: 'var(--card-subtle)' }}>
                        {hsData.length === 0 ? "No HubSpot data. Run a sync to import companies." : "No rows match your search."}
                      </td></tr>
                    ) : visibleHsData.map((row) => (
                      <tr key={row.company_id} className="group border-b last:border-b-0 cursor-pointer transition-colors hover:bg-dash-card-hover" style={{ borderColor: 'var(--dash-divider)' }}
                          onClick={() => { setSelectedHsRow(row); setHighlightDealId(null); }}>
                        <td style={{ padding: '11px 8px 11px 16px', width: 32 }} onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedHsIds.has(row.company_id)}
                            onChange={() => toggleHsSelect(row.company_id)}
                            className={`transition-opacity ${selectedHsIds.has(row.company_id) ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                            style={{ width: 14, height: 14, cursor: 'pointer', accentColor: '#ec5d25' }}
                          />
                        </td>
                        <td style={{ padding: '11px 16px', fontSize: 'var(--fs-medium)', color: 'var(--dash-card-text)', fontWeight: 500, maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <div className="flex items-center gap-2">
                            <Building2 style={{ width: 13, height: 13, color: '#ec5d25', flexShrink: 0 }} />
                            {row.company_name || "—"}
                          </div>
                        </td>
                        <td style={{ padding: '11px 16px', fontSize: 'var(--fs-medium)', color: '#60a5fa' }}>
                          {row.company_domain ? (
                            <span onClick={(e) => e.stopPropagation()}>
                              <a href={`https://${row.company_domain}`} target="_blank" rel="noopener noreferrer"
                                 className="flex items-center gap-1 hover:opacity-70 transition-opacity">
                                <ExternalLink style={{ width: 10, height: 10 }} />{row.company_domain}
                              </a>
                            </span>
                          ) : "—"}
                        </td>
                        <td style={{ padding: '11px 16px', fontSize: 'var(--fs-tiny)' }}>
                          {row.company_industry ? (
                            <span style={{ padding: "2px 8px", borderRadius: 9999, background: "rgba(236,93,37,0.1)", color: "#f5a07a" }}>
                              {row.company_industry}
                            </span>
                          ) : "—"}
                        </td>
                        <td style={{ padding: '11px 16px', fontSize: 'var(--fs-medium)', color: 'var(--card-muted)' }}>{row.company_country || "—"}</td>
                        <td style={{ padding: '11px 16px', fontSize: 'var(--fs-medium)', color: 'var(--dash-card-text)', fontWeight: 500, maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {row.deal_name || "—"}
                        </td>
                        <td style={{ padding: '11px 16px', fontSize: 'var(--fs-tiny)' }}>
                          {row.deal_stage ? (
                            <span style={{ padding: "2px 8px", borderRadius: 9999, background: "rgba(139,92,246,0.12)", color: "#a78bfa" }}>
                              {row.deal_stage}
                            </span>
                          ) : "—"}
                        </td>
                        <td style={{ padding: '11px 16px', fontSize: 'var(--fs-medium)', color: 'var(--card-muted)' }}>{row.deal_pipeline || "—"}</td>
                        <td style={{ padding: '11px 16px', fontSize: 'var(--fs-medium)', color: 'var(--card-muted)', whiteSpace: 'nowrap' }}>
                          {row.deal_createdate
                            ? new Date(row.deal_createdate).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
                            : "—"}
                        </td>
                        <td style={{ padding: '11px 16px' }} onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-1.5">
                            {row.deal_id && (
                              <a
                                href={hsUrl("0-3", row.deal_id)}
                                target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 border hover:opacity-70 transition-opacity"
                                style={{ fontSize: 'var(--fs-tiny)', padding: '2px 7px', borderRadius: 9999, background: 'rgba(236,93,37,0.1)', borderColor: 'rgba(236,93,37,0.2)', color: '#f5a07a', textDecoration: 'none', whiteSpace: 'nowrap' }}
                              >
                                <ExternalLink style={{ width: 8, height: 8 }} /> Deal
                              </a>
                            )}
                            {row.note_ids.length > 0 && (
                              <a
                                href={row.note_url || hsUrl("0-46", row.note_id)}
                                target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 border hover:opacity-70 transition-opacity"
                                style={{ fontSize: 'var(--fs-tiny)', padding: '2px 7px', borderRadius: 9999, background: 'rgba(96,165,250,0.1)', borderColor: 'rgba(96,165,250,0.2)', color: '#60a5fa', textDecoration: 'none', whiteSpace: 'nowrap' }}
                              >
                                <ExternalLink style={{ width: 8, height: 8 }} /> Notes{row.note_ids.length > 1 ? ` (${row.note_ids.length})` : ""}
                              </a>
                            )}
                            {(row.email_ids || []).length > 0 && (
                              <a
                                href={row.email_url || hsUrl("0-49", row.email_id)}
                                target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 border hover:opacity-70 transition-opacity"
                                style={{ fontSize: 'var(--fs-tiny)', padding: '2px 7px', borderRadius: 9999, background: 'rgba(74,222,128,0.1)', borderColor: 'rgba(74,222,128,0.2)', color: '#4ade80', textDecoration: 'none', whiteSpace: 'nowrap' }}
                              >
                                <ExternalLink style={{ width: 8, height: 8 }} /> Email{row.email_ids.length > 1 ? ` (${row.email_ids.length})` : ""}
                              </a>
                            )}
                          </div>
                        </td>
                        <td style={{ padding: '11px 16px' }}>
                          <ChevronRight style={{ width: 14, height: 14, color: 'var(--card-subtle)' }} />
                        </td>
                      </tr>
                    ))}
                    {hsHasMore && (
                      <tr>
                        <td colSpan={11} className="text-center border-t" style={{ borderColor: 'var(--dash-divider)', padding: '13px 16px' }}>
                          <button
                            onClick={() => setHsVisibleCount((n) => n + 50)}
                            className="inline-flex items-center gap-2 border transition-opacity hover:opacity-70"
                            style={{ fontSize: 'var(--fs-small)', padding: "6px 18px", borderRadius: 9999, background: 'transparent', borderColor: 'var(--dash-divider)', color: 'var(--card-label)' }}
                          >
                            View more
                            <span style={{ fontSize: 'var(--fs-medium)', color: 'var(--card-subtle)' }}>
                              ({filteredHsData.length - hsVisibleCount} remaining)
                            </span>
                          </button>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* ── Fireflies table ── */}
          {source === "fireflies" && <div className="overflow-x-auto" style={{ overflowY: 'hidden', borderBottomLeftRadius: 'var(--card-r)', borderBottomRightRadius: 'var(--card-r)' }}>
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th style={{ padding: '10px 8px 10px 16px', width: 32 }} />
                  {["Call Title", "Organizer", "Date", "Duration", "Keywords", "Sentiment", "Links", ""].map((h) => (
                    <th key={h} className="text-left" style={{ padding: '10px 16px', fontSize: 'var(--fs-big)', fontWeight: 600, color: 'var(--card-label)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredCalls.length > 0 ? visibleCalls.map((call) => (
                  <tr
                    key={call.id}
                    onClick={() => setSelectedCall(call)}
                    className="group border-b last:border-b-0 cursor-pointer transition-colors hover:bg-dash-card-hover"
                    style={{ borderColor: 'var(--dash-divider)' }}
                  >
                    <td style={{ padding: '11px 8px 11px 16px', width: 32 }} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedCallIds.has(call.id)}
                        onChange={() => toggleCallSelect(call.id)}
                        className={`transition-opacity ${selectedCallIds.has(call.id) ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                        style={{ width: 14, height: 14, cursor: 'pointer', accentColor: '#ec5d25' }}
                      />
                    </td>
                    <td className="max-w-[200px] truncate" style={{ padding: '11px 16px', fontSize: 'var(--fs-medium)', color: 'var(--dash-card-text)', fontWeight: 500 }}>
                      {call.title}
                    </td>
                    <td style={{ padding: '11px 16px', fontSize: 'var(--fs-medium)', color: 'var(--card-muted)' }}>{call.aeName}</td>
                    <td style={{ padding: '11px 16px', fontSize: 'var(--fs-medium)', color: 'var(--card-muted)', whiteSpace: 'nowrap' }}>{call.date}</td>
                    <td style={{ padding: '11px 16px', fontSize: 'var(--fs-medium)', color: 'var(--card-muted)', whiteSpace: 'nowrap' }}>{call.duration}</td>
                    <td style={{ padding: '11px 16px' }}>
                      <div className="flex flex-wrap gap-1">
                        {call.topics.slice(0, 2).map((t, idx) => (
                          <span key={`${call.id}-kw-${idx}`}
                                style={{ fontSize: 'var(--fs-tiny)', padding: "2px 6px", borderRadius: 9999, background: "rgba(236,93,37,0.1)", color: "#f5a07a" }}>
                            {t}
                          </span>
                        ))}
                        {call.topics.length > 2 && (
                          <span style={{ fontSize: 'var(--fs-tiny)', padding: "2px 6px", borderRadius: 9999, background: 'var(--dash-divider)', color: 'var(--card-subtle)' }}>
                            +{call.topics.length - 2}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '11px 16px' }}>
                      <span style={{
                        fontSize: 'var(--fs-tiny)', padding: "2px 8px", borderRadius: 9999,
                        background: call.sentiment === "positive" ? "rgba(34,197,94,0.12)" : call.sentiment === "negative" ? "rgba(239,68,68,0.12)" : "rgba(245,158,11,0.12)",
                        color: call.sentiment === "positive" ? "#4ade80" : call.sentiment === "negative" ? "#f87171" : "#fbbf24",
                      }}>
                        {call.sentiment}
                      </span>
                    </td>
                    <td style={{ padding: '11px 16px' }}>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        {call.transcriptUrl && call.transcriptUrl !== "#" && (
                          <a
                            href={call.transcriptUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 border transition-opacity hover:opacity-70"
                            style={{ fontSize: 'var(--fs-tiny)', padding: "3px 8px", borderRadius: 9999, background: "rgba(96,165,250,0.1)", borderColor: "rgba(96,165,250,0.2)", color: "#60a5fa", whiteSpace: 'nowrap' }}
                          >
                            <ExternalLink style={{ width: 9, height: 9 }} /> Fireflies
                          </a>
                        )}
                        {call.recordingUrl && call.recordingUrl !== "#" && (
                          <a
                            href={call.recordingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Play audio"
                            className="flex items-center justify-center border transition-opacity hover:opacity-70"
                            style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--dash-divider)', borderColor: 'var(--dash-divider)', color: 'var(--card-label)', flexShrink: 0 }}
                          >
                            <Play style={{ width: 10, height: 10 }} />
                          </a>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '11px 16px' }}>
                      <ChevronRight style={{ width: 13, height: 13, color: 'var(--card-subtle)' }} />
                    </td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={9} className="text-center" style={{ padding: '48px 16px', fontSize: 'var(--fs-small)', color: 'var(--card-subtle)' }}>
                      {calls.length === 0 ? (
                        <span>
                          No calls found from Fireflies.
                          {noCallsCountdown !== null && (
                            <span style={{ marginLeft: 8, color: 'var(--card-label)' }}>
                              Retrying in {noCallsCountdown}s…
                            </span>
                          )}
                        </span>
                      ) : "No calls match your search."}
                    </td>
                  </tr>
                )}
                {hasMore && (
                  <tr>
                    <td colSpan={9} className="text-center border-t" style={{ borderColor: 'var(--dash-divider)', padding: '13px 16px' }}>
                      <button
                        onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                        className="inline-flex items-center gap-2 border transition-opacity hover:opacity-70"
                        style={{ fontSize: 'var(--fs-small)', padding: "6px 18px", borderRadius: 9999, background: 'transparent', borderColor: 'var(--dash-divider)', color: 'var(--card-label)' }}
                      >
                        View more
                        <span style={{ fontSize: 'var(--fs-medium)', color: 'var(--card-subtle)' }}>
                          ({filteredCalls.length - visibleCount} remaining)
                        </span>
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>}

        </div>

      </div>

      {selectedCall && <CallDetail call={selectedCall} onClose={() => setSelectedCall(null)} />}

      {/* ── HubSpot row detail panel ── */}
      {selectedHsRow && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex justify-end"
          style={{ animation: "fadeInOverlay 0.2s ease-out" }}
          onClick={() => { setSelectedHsRow(null); setHighlightDealId(null); }}
        >
          <div
            className="w-full max-w-2xl h-full border-l flex flex-col"
            style={{ background: "#181818", borderColor: 'var(--dash-card-border)', animation: "slideInFromRight 0.25s cubic-bezier(0.22,1,0.36,1)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-start justify-between border-b shrink-0"
                 style={{ padding: 'var(--card-inner)', borderColor: 'var(--dash-card-border)' }}>
              <div style={{ flex: 1, minWidth: 0, paddingRight: 12 }}>
                <div className="flex items-center gap-2">
                  <Building2 style={{ width: 16, height: 16, color: '#ec5d25', flexShrink: 0 }} />
                  <h2 className="text-white" style={{ fontSize: "1.1rem", fontWeight: 700, lineHeight: 1.3 }}>
                    {selectedHsRow.company_name || "Unnamed Company"}
                  </h2>
                </div>
                {selectedHsRow.company_domain && (
                  <a href={`https://${selectedHsRow.company_domain}`} target="_blank" rel="noopener noreferrer"
                     className="flex items-center gap-1 hover:opacity-70 transition-opacity mt-1"
                     style={{ fontSize: 'var(--fs-small)', color: '#60a5fa' }}>
                    <ExternalLink style={{ width: 10, height: 10 }} />{selectedHsRow.company_domain}
                  </a>
                )}
              </div>
              <button
                onClick={() => { setSelectedHsRow(null); setHighlightDealId(null); }}
                className="flex items-center justify-center border transition-all hover:text-white shrink-0"
                style={{ width: 32, height: 32, borderRadius: 'var(--card-r)', background: 'var(--card-bg)', borderColor: 'var(--dash-card-border)', color: 'var(--card-label)' }}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Tab pills */}
            <div className="flex items-center gap-1.5 border-b shrink-0" style={{ padding: '10px 20px', borderColor: 'var(--dash-card-border)' }}>
              {([
                { id: "details" as const, label: "Details" },
                { id: "askai"   as const, label: "Ask AI", icon: <Sparkles style={{ width: 10, height: 10 }} /> },
              ]).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setHsModalTab(tab.id)}
                  className="flex items-center gap-1.5 transition-all"
                  style={{
                    padding: "5px 14px", borderRadius: 9999, fontSize: 'var(--fs-small)',
                    fontWeight: hsModalTab === tab.id ? 600 : 400,
                    background: hsModalTab === tab.id ? '#ec5d25' : 'transparent',
                    color: hsModalTab === tab.id ? '#fff' : 'var(--card-label)',
                    border: hsModalTab === tab.id ? '1px solid #ec5d25' : '1px solid var(--dash-card-border)',
                  }}
                >
                  {tab.icon} {tab.label}
                </button>
              ))}
            </div>

            <div className="overflow-y-auto flex-1" style={{ padding: 'var(--card-inner)', display: 'flex', flexDirection: 'column', gap: 24 }}>

              {/* ── Details tab ── */}
              {hsModalTab === "details" && <>

              {/* Company details */}
              <section>
                <p style={{ fontSize: 'var(--fs-tiny)', fontWeight: 600, color: 'var(--card-subtle)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 10 }}>Company</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px' }}>
                  {[
                    ["Industry",   selectedHsRow.company_industry],
                    ["Country",    selectedHsRow.company_country],
                    ["City",       selectedHsRow.company_city],
                    ["State",      selectedHsRow.company_state],
                    ["Phone",      selectedHsRow.company_phone],
                    ["Lifecycle",  selectedHsRow.company_lifecyclestage],
                  ].filter(([, v]) => v).map(([label, value]) => (
                    <div key={label}>
                      <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)' }}>{label} </span>
                      <span style={{ fontSize: 'var(--fs-small)', color: 'var(--dash-card-text)' }}>{value}</span>
                    </div>
                  ))}
                </div>
              </section>

              {/* All deals */}
              {(selectedHsRow.all_deals || []).length > 0 && (
                <section>
                  <p style={{ fontSize: 'var(--fs-tiny)', fontWeight: 600, color: 'var(--card-subtle)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 10 }}>
                    Deals ({(selectedHsRow.all_deals || []).length})
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {(selectedHsRow.all_deals || []).map((d) => {
                      const isHighlighted = highlightDealId !== null && d.deal_id === highlightDealId;
                      return (
                      <div
                        key={d.deal_id}
                        ref={isHighlighted ? highlightDealRef : undefined}
                        className="border"
                        style={{
                          borderRadius: 'var(--card-r)', padding: '10px 14px', display: 'flex', flexWrap: 'wrap', gap: '6px 20px', alignItems: 'center',
                          borderColor: isHighlighted ? '#ec5d25' : 'var(--dash-divider)',
                          background: isHighlighted ? 'rgba(236,93,37,0.08)' : 'transparent',
                          boxShadow: isHighlighted ? '0 0 0 1px #ec5d25' : 'none',
                        }}
                      >
                        <span style={{ fontSize: 'var(--fs-medium)', fontWeight: 600, color: 'var(--dash-card-text)', flexGrow: 1 }}>{d.deal_name || "Unnamed Deal"}</span>
                        {d.deal_amount && <span style={{ fontSize: 'var(--fs-small)', color: '#4ade80', fontWeight: 600 }}>${Number(d.deal_amount).toLocaleString()}</span>}
                        {d.deal_stage && <span style={{ fontSize: 'var(--fs-tiny)', padding: '2px 8px', borderRadius: 9999, background: 'rgba(139,92,246,0.12)', color: '#a78bfa' }}>{d.deal_stage}</span>}
                        {d.deal_pipeline && <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-muted)' }}>{d.deal_pipeline}</span>}
                        {d.deal_closedate && <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)' }}>Close: {new Date(d.deal_closedate).toLocaleDateString()}</span>}
                        {d.deal_id && (
                          <a
                            href={hsUrl("0-3", d.deal_id)}
                            target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 border hover:opacity-70 transition-opacity"
                            style={{ fontSize: 'var(--fs-tiny)', padding: '2px 8px', borderRadius: 9999, background: 'rgba(236,93,37,0.1)', borderColor: 'rgba(236,93,37,0.2)', color: '#f5a07a', textDecoration: 'none' }}
                          >
                            <ExternalLink style={{ width: 9, height: 9 }} /> Deal
                          </a>
                        )}
                      </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Notes / Emails — pill-switched. Full bodies are fetched lazily
                  (hsDetail) when the modal opens; note_ids/email_ids counts are
                  already known from the bulk row so the pills can render instantly. */}
              {(selectedHsRow.note_ids.length > 0 || selectedHsRow.email_ids.length > 0) && (
                <section>
                  <div className="flex items-center gap-1.5" style={{ marginBottom: 10 }}>
                    {([
                      { id: "notes" as const,  label: `Notes (${selectedHsRow.note_ids.length})` },
                      { id: "emails" as const, label: `Emails (${selectedHsRow.email_ids.length})` },
                    ]).map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => setHsDetailsSubTab(tab.id)}
                        className="transition-all"
                        style={{
                          padding: "4px 12px", borderRadius: 9999, fontSize: 'var(--fs-small)',
                          fontWeight: hsDetailsSubTab === tab.id ? 600 : 400,
                          background: hsDetailsSubTab === tab.id ? '#ec5d25' : 'transparent',
                          color: hsDetailsSubTab === tab.id ? '#fff' : 'var(--card-label)',
                          border: hsDetailsSubTab === tab.id ? '1px solid #ec5d25' : '1px solid var(--dash-card-border)',
                          cursor: 'pointer',
                        }}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  {hsDetailLoading && (
                    <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)', padding: '12px 0' }}>Loading…</p>
                  )}
                  {!hsDetailLoading && hsDetailError && (
                    <p style={{ fontSize: 'var(--fs-small)', color: '#f87171', padding: '12px 0' }}>{hsDetailError}</p>
                  )}

                  {!hsDetailLoading && !hsDetailError && hsDetailsSubTab === "notes" && (
                    (hsDetail?.all_notes || []).length === 0 ? (
                      <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)', padding: '12px 0' }}>No notes for this company.</p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {(hsDetail?.all_notes || []).map((n) => (
                          <div key={n.note_id} className="border" style={{ borderRadius: 'var(--card-r)', borderColor: 'var(--dash-divider)', padding: '10px 14px' }}>
                            <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
                              {n.note_hs_createdate && (
                                <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', margin: 0 }}>{new Date(n.note_hs_createdate).toLocaleDateString()}</p>
                              )}
                              {n.note_id && (
                                <a
                                  href={n.note_url || hsUrl("0-46", n.note_id)}
                                  target="_blank" rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 border hover:opacity-70 transition-opacity"
                                  style={{ fontSize: 'var(--fs-tiny)', padding: '2px 8px', borderRadius: 9999, background: 'rgba(96,165,250,0.1)', borderColor: 'rgba(96,165,250,0.2)', color: '#60a5fa', textDecoration: 'none' }}
                                >
                                  <ExternalLink style={{ width: 9, height: 9 }} /> Note
                                </a>
                              )}
                            </div>
                            <div className="hs-note-body" style={{ fontSize: 'var(--fs-small)', color: 'var(--card-muted)', lineHeight: 1.6 }}>
                              {n.note_hs_note_body ? parseNote(n.note_hs_note_body) : "—"}
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  )}

                  {!hsDetailLoading && !hsDetailError && hsDetailsSubTab === "emails" && (
                    (hsDetail?.all_emails || []).length === 0 ? (
                      <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)', padding: '12px 0' }}>No emails for this company.</p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {(hsDetail?.all_emails || []).map((e) => (
                          <div key={e.email_id} className="border" style={{ borderRadius: 'var(--card-r)', borderColor: 'var(--dash-divider)', padding: '10px 14px' }}>
                            <div className="flex items-center justify-between" style={{ marginBottom: 6, gap: 12 }}>
                              <p style={{ fontSize: 'var(--fs-small)', fontWeight: 600, color: 'var(--dash-card-text)', margin: 0, flex: 1 }}>
                                {e.email_hs_email_subject || "(No subject)"}
                              </p>
                              {e.email_id && (
                                <a
                                  href={e.email_url || hsUrl("0-49", e.email_id)}
                                  target="_blank" rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 border hover:opacity-70 transition-opacity"
                                  style={{ fontSize: 'var(--fs-tiny)', padding: '2px 8px', borderRadius: 9999, background: 'rgba(96,165,250,0.1)', borderColor: 'rgba(96,165,250,0.2)', color: '#60a5fa', textDecoration: 'none', flexShrink: 0, whiteSpace: 'nowrap' }}
                                >
                                  <ExternalLink style={{ width: 9, height: 9 }} /> Email
                                </a>
                              )}
                            </div>
                            {e.email_hs_createdate && (
                              <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', margin: '0 0 6px' }}>
                                {new Date(e.email_hs_createdate).toLocaleDateString()}
                              </p>
                            )}
                            <div className="hs-note-body" style={{ fontSize: 'var(--fs-small)', color: 'var(--card-muted)', lineHeight: 1.6 }}>
                              {e.email_hs_email_text ? parseNote(stripQuotedReplyTail(e.email_hs_email_text)) : "—"}
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  )}
                </section>
              )}

              {(selectedHsRow.all_deals || []).length === 0 && selectedHsRow.note_ids.length === 0 && selectedHsRow.email_ids.length === 0 && (
                <p style={{ fontSize: 'var(--fs-small)', color: 'var(--card-subtle)', textAlign: 'center', padding: '24px 0' }}>No deals, notes, or emails associated with this company.</p>
              )}

              </>}

              {/* ── Ask AI tab ── */}
              {hsModalTab === "askai" && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {/* Input */}
                  <div className="border" style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', borderColor: 'var(--dash-card-border)', overflow: 'hidden' }}>
                    <textarea
                      ref={hsAiInputRef}
                      value={hsAiQuestion}
                      onChange={(e) => setHsAiQuestion(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleHsAskAI(); } }}
                      placeholder="Ask anything about this company, deals, notes, or emails…"
                      rows={3}
                      className="w-full bg-transparent border-none outline-none resize-none"
                      style={{ padding: '12px 14px', fontSize: 'var(--fs-small)', color: 'var(--dash-card-text)', lineHeight: 1.6 }}
                    />
                    <div className="flex items-center justify-between border-t" style={{ padding: '8px 12px', borderColor: 'var(--dash-card-border)' }}>
                      <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)' }}>
                        Powered by Groq · based on company, deals, notes &amp; emails
                      </p>
                      <button
                        onClick={handleHsAskAI}
                        disabled={hsAiLoading || !hsAiQuestion.trim()}
                        className="flex items-center gap-1.5 transition-opacity"
                        style={{
                          padding: "5px 14px", borderRadius: 9999, fontSize: 'var(--fs-small)', fontWeight: 600,
                          background: hsAiLoading || !hsAiQuestion.trim() ? 'var(--dash-divider)' : '#ec5d25',
                          color: hsAiLoading || !hsAiQuestion.trim() ? 'var(--card-subtle)' : '#fff',
                          cursor: hsAiLoading || !hsAiQuestion.trim() ? 'not-allowed' : 'pointer',
                          border: 'none',
                        }}
                      >
                        {hsAiLoading ? <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> : <Send style={{ width: 12, height: 12 }} />}
                        {hsAiLoading ? "Thinking…" : "Ask"}
                      </button>
                    </div>
                  </div>

                  {/* Answer */}
                  {(hsAiAnswer || hsAiError) && (
                    <div className="border" style={{ background: 'var(--card-bg)', borderRadius: 'var(--card-r)', padding: 'var(--card-inner)', borderColor: hsAiError ? 'rgba(248,113,113,0.3)' : 'var(--dash-card-border)' }}>
                      {hsAiError
                        ? <p style={{ fontSize: 'var(--fs-small)', color: '#f87171' }}>{hsAiError}</p>
                        : <ReactMarkdown components={mdComponents}>{hsAiAnswer}</ReactMarkdown>
                      }

                      {/* Citations — notes/emails used as context for this answer */}
                      {!hsAiError && ((hsDetail?.all_notes || []).length > 0 || (hsDetail?.all_emails || []).length > 0) && (
                        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--dash-divider)' }}>
                          <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
                            Sources
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {(hsDetail?.all_notes || []).map((n, i) => (
                              <a
                                key={n.note_id}
                                href={n.note_url || hsUrl("0-46", n.note_id)}
                                target="_blank" rel="noopener noreferrer"
                                title={n.note_hs_createdate ? new Date(n.note_hs_createdate).toLocaleDateString() : undefined}
                                className="inline-flex items-center gap-1 border hover:opacity-70 transition-opacity"
                                style={{ fontSize: 'var(--fs-tiny)', padding: '3px 9px', borderRadius: 9999, background: 'rgba(96,165,250,0.1)', borderColor: 'rgba(96,165,250,0.2)', color: '#60a5fa', textDecoration: 'none' }}
                              >
                                <ExternalLink style={{ width: 9, height: 9 }} /> Note {i + 1}
                              </a>
                            ))}
                            {(hsDetail?.all_emails || []).map((e, i) => (
                              <a
                                key={e.email_id}
                                href={e.email_url || hsUrl("0-49", e.email_id)}
                                target="_blank" rel="noopener noreferrer"
                                title={e.email_hs_createdate ? new Date(e.email_hs_createdate).toLocaleDateString() : undefined}
                                className="inline-flex items-center gap-1 border hover:opacity-70 transition-opacity"
                                style={{ fontSize: 'var(--fs-tiny)', padding: '3px 9px', borderRadius: 9999, background: 'rgba(74,222,128,0.1)', borderColor: 'rgba(74,222,128,0.2)', color: '#4ade80', textDecoration: 'none' }}
                              >
                                <ExternalLink style={{ width: 9, height: 9 }} /> Email {i + 1}
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Suggestions */}
                  {!hsAiAnswer && !hsAiError && !hsAiLoading && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <p style={{ fontSize: 'var(--fs-tiny)', color: 'var(--card-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Try asking</p>
                      {[
                        "What is the current deal status and next steps?",
                        "Summarize all the notes for this company.",
                        "What is the total deal value?",
                        "What stage are the deals at and what's the expected close date?",
                      ].map((suggestion) => (
                        <button
                          key={suggestion}
                          onClick={() => { setHsAiQuestion(suggestion); hsAiInputRef.current?.focus(); }}
                          className="text-left border transition-colors hover:border-orange-500/40"
                          style={{ padding: "8px 12px", borderRadius: 'var(--card-r)', background: 'var(--card-bg)', borderColor: 'var(--dash-card-border)', fontSize: 'var(--fs-small)', color: 'var(--card-muted)' }}
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

