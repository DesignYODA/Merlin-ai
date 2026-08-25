import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  Key, RefreshCw, Bell, Shield, Database,
  CheckCircle, XCircle, Loader2, CloudDownload, HardDrive, X,
  Play, Handshake,
} from "lucide-react";
import { useData } from "./data-context";
import {
  setFirefliesApiKey as apiSetFirefliesKey,
  setGroqApiKey as apiSetGroqKey,
  setHubSpotApiKey as apiSetHubSpotKey,
  resetHubspot,
} from "../api";

type Tab = "keys" | "sync" | "account" | "notifications";

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "keys",          label: "API Keys",      icon: <Key className="w-4 h-4" /> },
  { id: "sync",          label: "Sync & Data",   icon: <HardDrive className="w-4 h-4" /> },
  { id: "account",       label: "Account",       icon: <Shield className="w-4 h-4" /> },
  { id: "notifications", label: "Notifications", icon: <Bell className="w-4 h-4" /> },
];

export function SettingsPage() {
  const navigate = useNavigate();
  const {
    calls, user, isLive, isLoading, error, refresh, fullSync,
    lastSynced, totalCallsFetched, fetchProgress, syncStatus, isSyncing, dbCallCount,
    runHubspotSync, runHubspotIncrementalSync, isHubspotSyncing, hubspotSyncStatus,
  } = useData();

  const [tab, setTab] = useState<Tab>("keys");

  // Key inputs
  const [firefliesKey, setFirefliesKey] = useState("");
  const [groqKey, setGroqKey] = useState("");
  const [hubspotKey, setHubspotKey] = useState("");
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [isSavingKeys, setIsSavingKeys] = useState(false);

  // Sync
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFullSyncing, setIsFullSyncing] = useState(false);
  const [isResettingHubspot, setIsResettingHubspot] = useState(false);
  const [syncTarget, setSyncTarget] = useState<"fireflies" | "hubspot" | "both">("fireflies");

  const close = () => navigate(-1);

  const saveKey = async (label: string, value: string, apiFn: (v: string) => Promise<unknown>, reset: () => void) => {
    if (!value.trim()) return;
    setIsSavingKeys(true);
    setSaveStatus(null);
    try {
      await apiFn(value);
      setSaveStatus(`✓ ${label} saved.`);
      reset();
    } catch (e: unknown) {
      setSaveStatus(`✗ Failed: ${(e as Error)?.message || String(e)}`);
    } finally {
      setIsSavingKeys(false);
    }
  };

  const handleCheckNew = async () => {
    setIsRefreshing(true);
    try {
      if (syncTarget === "fireflies" || syncTarget === "both") refresh();
      // "Check for New" should only fetch what changed, not re-pull every company —
      // that's what the incremental sync is for; full re-sync is its own button below.
      if (syncTarget === "hubspot"   || syncTarget === "both") await runHubspotIncrementalSync();
    } finally {
      setTimeout(() => setIsRefreshing(false), 3000);
    }
  };

  const handleResetHubspot = async () => {
    if (!window.confirm("This will delete all cached HubSpot data and re-fetch from scratch. Continue?")) return;
    setIsResettingHubspot(true);
    try {
      // /hubspot/reset clears the table; runHubspotSync fetches fresh + updates context state
      await resetHubspot();
      await runHubspotSync();
    } catch (e: unknown) {
      console.warn("HubSpot reset failed:", (e as Error).message);
    } finally {
      setIsResettingHubspot(false);
    }
  };

  const handleFullResync = async () => {
    setIsFullSyncing(true);
    try {
      if (syncTarget === "fireflies" || syncTarget === "both") fullSync();
      if (syncTarget === "hubspot"   || syncTarget === "both") await runHubspotSync();
    } finally {
      setTimeout(() => setIsFullSyncing(false), 10000);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="w-[780px] max-h-[88vh] rounded-2xl border border-[#222228] shadow-2xl flex overflow-hidden"
           style={{ background: "#111114" }}>

        {/* ── Left nav ── */}
        <div className="w-44 flex-shrink-0 flex flex-col border-r border-[#1e1e28]" style={{ background: "#0d0d10" }}>
          <div className="px-5 pt-5 pb-4 flex items-center justify-between border-b border-[#1e1e28]">
            <span className="text-white font-semibold" style={{ fontSize: "0.9rem" }}>Settings</span>
            <button onClick={close} className="text-[#555] hover:text-white transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          <nav className="flex-1 p-3 space-y-0.5">
            {TABS.map(({ id, label, icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                  tab === id
                    ? "bg-[#1e1e28] text-white"
                    : "text-[#666] hover:text-[#aaa] hover:bg-[#18181e]"
                }`}
                style={{ fontSize: "0.8rem" }}
              >
                {icon}
                {label}
              </button>
            ))}
          </nav>

          {/* Status dot */}
          <div className="px-4 py-4 border-t border-[#1e1e28]">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${isLive ? "bg-emerald-400" : "bg-rose-500"}`} />
              <span className="text-[#555]" style={{ fontSize: "0.72rem" }}>
                {isLoading ? "Connecting…" : isLive ? "Live" : "Offline"}
              </span>
            </div>
          </div>
        </div>

        {/* ── Right content ── */}
        <div className="flex-1 overflow-y-auto">

          {/* ── API Keys ── */}
          {tab === "keys" && (
            <div className="p-7 space-y-6">
              <SectionHeader icon={<Key className="w-4 h-4 text-[#ec5d25]" />} title="API Keys" />

              {saveStatus && (
                <div className={`text-xs px-3 py-2 rounded-lg ${saveStatus.startsWith("✓") ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"}`}>
                  {saveStatus}
                </div>
              )}

              <KeyField
                label="Fireflies API Key"
                placeholder="ff_…"
                value={firefliesKey}
                onChange={setFirefliesKey}
                onSave={() => saveKey("Fireflies key", firefliesKey, apiSetFirefliesKey, () => setFirefliesKey(""))}
                saving={isSavingKeys}
              />
              <KeyField
                label="Groq API Key"
                placeholder="gsk_…"
                value={groqKey}
                onChange={setGroqKey}
                onSave={() => saveKey("Groq key", groqKey, apiSetGroqKey, () => setGroqKey(""))}
                saving={isSavingKeys}
              />
              <KeyField
                label="HubSpot API Key"
                placeholder="pat-…"
                value={hubspotKey}
                onChange={setHubspotKey}
                onSave={() => saveKey("HubSpot key", hubspotKey, apiSetHubSpotKey, () => setHubspotKey(""))}
                saving={isSavingKeys}
              />
            </div>
          )}

          {/* ── Sync & Data ── */}
          {tab === "sync" && (
            <div className="p-7 space-y-5">
              <SectionHeader icon={<HardDrive className="w-4 h-4 text-cyan-400" />} title="Sync & Data" />

              {/* ── Service rows ── */}
              <div className="space-y-2">
                {/* Fireflies */}
                <div className="rounded-xl border border-[#1e1e28] px-4 py-3.5" style={{ background: "#0d0d10" }}>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 w-32 shrink-0">
                      <Play className="w-3 h-3 text-[#ec5d25]" />
                      <span className="text-white font-medium" style={{ fontSize: "0.82rem" }}>Fireflies</span>
                      {isLoading
                        ? <Loader2 className="w-2.5 h-2.5 text-amber-400 animate-spin" />
                        : isLive
                          ? <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          : <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />}
                    </div>
                    <div className="flex items-center gap-5 flex-1 flex-wrap">
                      <InlineStat label="Calls" value={String(dbCallCount)} />
                      <InlineStat label="Last Sync" value={syncStatus?.lastSyncAt ? new Date(syncStatus.lastSyncAt).toLocaleTimeString() : "Never"} />
                      <InlineStat label="New" value={String(syncStatus?.newCalls ?? "—")} />
                      {(!isLive || error) && !isLoading && (
                        <span className="text-rose-400" style={{ fontSize: "0.72rem" }}>{error || "Offline"}</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* HubSpot */}
                <div className="rounded-xl border border-[#1e1e28] px-4 py-3.5" style={{ background: "#0d0d10" }}>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 w-32 shrink-0">
                      <Handshake className="w-3 h-3 text-[#ff7a59]" />
                      <span className="text-white font-medium" style={{ fontSize: "0.82rem" }}>HubSpot</span>
                      {isHubspotSyncing
                        ? <Loader2 className="w-2.5 h-2.5 text-[#ff7a59] animate-spin" />
                        : hubspotSyncStatus?.lastSyncAt
                          ? <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          : <span className="w-1.5 h-1.5 rounded-full bg-[#333]" />}
                    </div>
                    <div className="flex items-center gap-5 flex-1 flex-wrap">
                      <InlineStat label="Deals"     value={String(hubspotSyncStatus?.dealCount    ?? "—")} />
                      <InlineStat label="Companies" value={String(hubspotSyncStatus?.companyCount ?? "—")} />
                      <InlineStat label="Notes"     value={String(hubspotSyncStatus?.noteCount    ?? "—")} />
                      <InlineStat label="Emails"    value={String(hubspotSyncStatus?.emailCount   ?? "—")} />
                      <InlineStat label="Contacts"  value={String(hubspotSyncStatus?.contactCount ?? "—")} />
                      <InlineStat label="Last Sync" value={hubspotSyncStatus?.lastSyncAt ? new Date(hubspotSyncStatus.lastSyncAt).toLocaleTimeString() : "Never"} />
                    </div>
                    <button
                      onClick={handleResetHubspot}
                      disabled={isResettingHubspot || isHubspotSyncing}
                      title="Clear cached data and re-fetch from HubSpot"
                      className="flex items-center gap-1 border border-[#2a2a34] rounded-lg px-2.5 py-1 transition-colors hover:border-rose-500/40 hover:text-rose-400 disabled:opacity-40 shrink-0"
                      style={{ fontSize: "0.7rem", color: "#555" }}
                    >
                      {isResettingHubspot
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <RefreshCw className="w-3 h-3" />}
                      Reset
                    </button>
                  </div>
                </div>
              </div>

              {/* Progress bar */}
              {fetchProgress && (
                <div
                  className="flex items-center gap-2"
                  style={{
                    fontSize: "0.78rem",
                    color: fetchProgress.includes("failed") || fetchProgress.includes("Failed")
                      ? "#f87171"
                      : "#ec5d25",
                  }}
                >
                  {isSyncing && <Loader2 className="w-3 h-3 animate-spin" />}
                  <span>{fetchProgress}</span>
                  {(fetchProgress.includes("failed") || fetchProgress.includes("Failed")) && (
                    <button
                      onClick={() => setTab("keys")}
                      className="underline underline-offset-2 hover:opacity-70 transition-opacity"
                      style={{ color: "#60a5fa", background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: "inherit" }}
                    >
                      Check API Keys
                    </button>
                  )}
                </div>
              )}

              {/* ── Sync actions ── */}
              <div className="space-y-3 pt-1">
                <div className="flex items-center gap-2">
                  <span className="text-[#444]" style={{ fontSize: "0.73rem" }}>Sync source</span>
                  <div className="flex gap-1">
                    {(["fireflies", "hubspot", "both"] as const).map((src) => (
                      <button
                        key={src}
                        onClick={() => setSyncTarget(src)}
                        className="border transition-colors"
                        style={{
                          padding: "3px 11px",
                          borderRadius: 9999,
                          fontSize: "0.73rem",
                          background: syncTarget === src ? "#1e1e28" : "transparent",
                          borderColor: syncTarget === src ? "rgba(236,93,37,0.45)" : "#2a2a34",
                          color: syncTarget === src ? "#fff" : "#555",
                        }}
                      >
                        {src === "both" ? "Both" : src === "fireflies" ? "Fireflies" : "HubSpot"}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleCheckNew}
                    disabled={isRefreshing || isSyncing || isHubspotSyncing}
                    className="px-4 py-2 rounded-lg bg-[#1a1a22] text-[#888] hover:text-white border border-[#2a2a34] transition-colors flex items-center gap-2 disabled:opacity-40"
                    style={{ fontSize: "0.82rem" }}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
                    Check for New
                  </button>
                  <button
                    onClick={handleFullResync}
                    disabled={isFullSyncing || isSyncing || isHubspotSyncing}
                    className="px-4 py-2 rounded-lg bg-[#ec5d25] text-white hover:bg-[#f07848] transition-colors flex items-center gap-2 disabled:opacity-40"
                    style={{ fontSize: "0.82rem" }}
                  >
                    <CloudDownload className={`w-3.5 h-3.5 ${isFullSyncing ? "animate-pulse" : ""}`} />
                    Full Re-Sync
                  </button>
                </div>
              </div>

              {/* ── Data Stats ── */}
              <div className="border-t border-[#1e1e28] pt-5 space-y-3">
                <SectionHeader icon={<Database className="w-4 h-4 text-emerald-400" />} title="Data Stats" />
                <div className="flex items-center gap-4 text-[#666] flex-wrap" style={{ fontSize: "0.78rem" }}>
                  <span>{totalCallsFetched} calls indexed</span>
                  <span className="text-[#333]">·</span>
                  <span>{new Set(calls.flatMap((c) => c.topics)).size} keywords</span>
                  <span className="text-[#333]">·</span>
                  <span>{calls.reduce((s, c) => s + c.actionItems.length, 0)} action items</span>
                </div>
              </div>
            </div>
          )}

          {/* ── Account ── */}
          {tab === "account" && (
            <div className="p-7 space-y-6">
              <SectionHeader icon={<Shield className="w-4 h-4 text-emerald-400" />} title="Account" />
              {user ? (
                <div className="grid grid-cols-2 gap-3">
                  <StatTile label="Name" value={user.name} />
                  <StatTile label="Email" value={user.email} />
                  <StatTile label="Minutes Consumed" value={user.minutes_consumed?.toLocaleString() ?? "N/A"} />
                  <StatTile label="Role" value={user.is_admin ? "Admin" : "Member"} />
                </div>
              ) : (
                <p className="text-[#555]" style={{ fontSize: "0.82rem" }}>No account info available.</p>
              )}
            </div>
          )}

          {/* ── Notifications ── */}
          {tab === "notifications" && (
            <div className="p-7 space-y-6">
              <SectionHeader icon={<Bell className="w-4 h-4 text-amber-400" />} title="Notifications" />
              <div className="space-y-2">
                <NotificationToggle label="New call analyzed"        description="When a new call is processed"              defaultChecked />
                <NotificationToggle label="Action item detected"     description="When action items are extracted"           defaultChecked />
                <NotificationToggle label="Weekly insights digest"   description="Summary every Monday"                     defaultChecked />
                <NotificationToggle label="Negative sentiment alert" description="Calls with negative sentiment"            defaultChecked={false} />
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function SectionHeader({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2.5 mb-1">
      {icon}
      <h3 className="text-white font-semibold" style={{ fontSize: "0.92rem" }}>{title}</h3>
    </div>
  );
}

function InlineStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-white font-medium" style={{ fontSize: "0.82rem" }}>{value}</span>
      <span className="text-[#444]" style={{ fontSize: "0.68rem" }}>{label}</span>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3.5 rounded-xl border border-[#1e1e28]" style={{ background: "#0d0d10" }}>
      <p className="text-[#555]" style={{ fontSize: "0.68rem", marginBottom: 4 }}>{label}</p>
      <p className="text-white font-medium" style={{ fontSize: "0.875rem" }}>{value}</p>
    </div>
  );
}

function KeyField({
  label, placeholder, value, onChange, onSave, saving,
}: {
  label: string; placeholder: string; value: string;
  onChange: (v: string) => void; onSave: () => void; saving: boolean;
}) {
  return (
    <div className="space-y-2">
      <label className="text-[#888]" style={{ fontSize: "0.78rem" }}>{label}</label>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => e.key === "Enter" && onSave()}
          className="flex-1 px-3 py-2 rounded-lg border border-[#2a2a34] bg-[#0d0d10] text-white placeholder-[#444] outline-none focus:border-[#ec5d25]/60 transition-colors"
          style={{ fontSize: "0.82rem" }}
        />
        <button
          onClick={onSave}
          disabled={!value.trim() || saving}
          className="px-4 py-2 rounded-lg bg-[#ec5d25] text-white hover:bg-[#f07848] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 shrink-0"
          style={{ fontSize: "0.82rem" }}
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Save
        </button>
      </div>
    </div>
  );
}

function NotificationToggle({ label, description, defaultChecked }: { label: string; description: string; defaultChecked: boolean }) {
  const [checked, setChecked] = useState(defaultChecked);
  return (
    <div className="flex items-center justify-between px-4 py-3 rounded-xl border border-[#1e1e28]" style={{ background: "#0d0d10" }}>
      <div>
        <p className="text-white" style={{ fontSize: "0.84rem" }}>{label}</p>
        <p className="text-[#555]" style={{ fontSize: "0.72rem" }}>{description}</p>
      </div>
      <button
        onClick={() => setChecked(!checked)}
        className={`w-10 h-5.5 rounded-full transition-colors relative flex-shrink-0 ${checked ? "bg-[#ec5d25]" : "bg-[#2a2a34]"}`}
        style={{ width: 38, height: 22 }}
      >
        <span
          className="absolute top-[3px] w-4 h-4 rounded-full bg-white transition-all"
          style={{ left: checked ? "calc(100% - 19px)" : 3 }}
        />
      </button>
    </div>
  );
}
