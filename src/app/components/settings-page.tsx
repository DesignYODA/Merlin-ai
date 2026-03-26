import { useState } from "react";
import { Key, RefreshCw, Bell, Shield, Database, CheckCircle, XCircle, Loader2, CloudDownload, Trash2, HardDrive } from "lucide-react";
import { useData } from "./data-context";

export function SettingsPage() {
  const SERVER_BASE = import.meta.env.VITE_SQLITE_SERVER_BASE ?? "http://localhost:3001";
  const {
    calls, user, isLive, isLoading, error, refresh, fullSync, lastSynced,
    totalCallsFetched, fetchProgress, syncStatus, isSyncing, dbCallCount,
  } = useData();
  const [firefliesApiKey, setFirefliesApiKey] = useState("");
  const [groqApiKey, setGroqApiKey] = useState("");
  const [hubspotApiKey, setHubspotApiKey] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFullSyncing, setIsFullSyncing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [isSavingKeys, setIsSavingKeys] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    refresh();
    setTimeout(() => setIsRefreshing(false), 3000);
  };

  const handleFullSync = async () => {
    setIsFullSyncing(true);
    fullSync();
    setTimeout(() => setIsFullSyncing(false), 10000);
  };

  // const saveFirefliesKey = async () => {
  //   if (!firefliesApiKey.trim()) return;
  //   setIsSavingKeys(true);
  //   try {
  //     const r = await fetch(`${SERVER_BASE}/config/fireflies-api-key`, {
  //       method: "POST",
  //       headers: { "Content-Type": "application/json" },
  //       body: JSON.stringify({ apiKey: firefliesApiKey }),
  //     });
  //     if (!r.ok) throw new Error(`HTTP ${r.status}`);
  //     setSaveStatus("Saved Fireflies API key.");
  //     setFirefliesApiKey("");
  //   } catch (e: any) {
  //     setSaveStatus(`Failed to save Fireflies API key: ${e?.message || String(e)}`);
  //   } finally {
  //     setIsSavingKeys(false);
  //   }
  // };

  // const saveGroqKey = async () => {
  //   if (!groqApiKey.trim()) return;
  //   setIsSavingKeys(true);
  //   try {
  //     const r = await fetch(`${SERVER_BASE}/config/groq-api-key`, {
  //       method: "POST",
  //       headers: { "Content-Type": "application/json" },
  //       body: JSON.stringify({ apiKey: groqApiKey }),
  //     });
  //     if (!r.ok) throw new Error(`HTTP ${r.status}`);
  //     setSaveStatus("Saved Groq API key.");
  //     setGroqApiKey("");
  //   } catch (e: any) {
  //     setSaveStatus(`Failed to save Groq API key: ${e?.message || String(e)}`);
  //   } finally {
  //     setIsSavingKeys(false);
  //   }
  // };

  // const saveHubspotKey = async () => {
  //   if (!hubspotApiKey.trim()) return;
  //   setIsSavingKeys(true);
  //   try {
  //     const r = await fetch(`${SERVER_BASE}/config/hubspot-api-key`, {
  //       method: "POST",
  //       headers: { "Content-Type": "application/json" },
  //       body: JSON.stringify({ apiKey: hubspotApiKey }),
  //     });
  //     if (!r.ok) throw new Error(`HTTP ${r.status}`);
  //     setSaveStatus("Saved HubSpot API key.");
  //     setHubspotApiKey("");
  //   } catch (e: any) {
  //     setSaveStatus(`Failed to save HubSpot API key: ${e?.message || String(e)}`);
  //   } finally {
  //     setIsSavingKeys(false);
  //   }
  // };

  return (
    <div className="p-8 space-y-8 max-w-3xl">
      <div>
        <h1 className="text-white" style={{ fontSize: "1.75rem", fontWeight: 700 }}>Settings</h1>
        <p className="text-[#8888a0] mt-1" style={{ fontSize: "0.875rem" }}>Configure your Merlin AI workspace</p>
      </div>

      {/* Connection Status Banner */}
      <div className={`rounded-xl p-4 flex items-center gap-3 border ${isLive ? "bg-emerald-500/5 border-emerald-500/20" : "bg-rose-500/5 border-rose-500/20"}`}>
        {isLoading ? (
          <Loader2 className="w-5 h-5 text-amber-400 animate-spin shrink-0" />
        ) : isLive ? (
          <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />
        ) : (
          <XCircle className="w-5 h-5 text-rose-400 shrink-0" />
        )}
        <div>
          <p className={`${isLive ? "text-emerald-300" : "text-rose-300"}`} style={{ fontSize: "0.85rem", fontWeight: 600 }}>
            {isLoading ? "Connecting..." : isLive ? "Connected — Database Active" : "Connection Failed"}
          </p>
          <p className={`${isLive ? "text-emerald-400/60" : "text-rose-400/60"}`} style={{ fontSize: "0.75rem" }}>
            {isLive ? (
              <>
                {user?.name} ({user?.email}) · {dbCallCount} calls in database
                {lastSynced && ` · Last sync: ${lastSynced.toLocaleTimeString()}`}
              </>
            ) : error ? error : "Check your API key and try again"}
          </p>
        </div>
      </div>

      {/* Database Status */}
      <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-3">
          <HardDrive className="w-5 h-5 text-cyan-400" />
          <h3 className="text-white" style={{ fontSize: "1rem", fontWeight: 600 }}>Database Storage</h3>
          {isSyncing && <Loader2 className="w-4 h-4 text-[#ec5d25] animate-spin" />}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="p-3 rounded-lg bg-[#0f0f18]">
            <p className="text-[#8888a0]" style={{ fontSize: "0.7rem" }}>Calls Stored</p>
            <p className="text-white text-lg font-semibold">{dbCallCount}</p>
          </div>
          <div className="p-3 rounded-lg bg-[#0f0f18]">
            <p className="text-[#8888a0]" style={{ fontSize: "0.7rem" }}>Last Sync</p>
            <p className="text-white" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
              {syncStatus?.lastSyncAt
                ? new Date(syncStatus.lastSyncAt).toLocaleTimeString()
                : "Never"}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-[#0f0f18]">
            <p className="text-[#8888a0]" style={{ fontSize: "0.7rem" }}>New in Last Sync</p>
            <p className="text-white" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
              {syncStatus?.newCalls ?? "—"}
            </p>
          </div>
        </div>

        {fetchProgress && (
          <div className="flex items-center gap-2 text-[#8888a0]" style={{ fontSize: "0.8rem" }}>
            {isSyncing && <Loader2 className="w-3 h-3 animate-spin" />}
            <span className="text-[#ec5d25]">{fetchProgress}</span>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={handleRefresh}
            disabled={isRefreshing || isSyncing}
            className="px-4 py-2 rounded-lg bg-[#1e1e2e] text-[#8888a0] hover:text-white transition-colors flex items-center gap-2 disabled:opacity-50"
            style={{ fontSize: "0.85rem" }}
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing || isSyncing ? "animate-spin" : ""}`} />
            Check for New Calls
          </button>
          <button
            onClick={handleFullSync}
            disabled={isFullSyncing || isSyncing}
            className="px-4 py-2 rounded-lg bg-[#ec5d25] text-white hover:bg-[#f07848] transition-colors flex items-center gap-2 disabled:opacity-50"
            style={{ fontSize: "0.85rem" }}
          >
            <CloudDownload className={`w-4 h-4 ${isFullSyncing ? "animate-pulse" : ""}`} />
            Full Re-Sync
          </button>
        </div>

        <p className="text-[#555568]" style={{ fontSize: "0.7rem" }}>
          Calls are stored in the database for instant loading. New calls are automatically detected every 5 minutes.
          Full re-sync re-fetches all calls from Fireflies and updates the database.
        </p>
      </div>

      {saveStatus && (
        <div className="text-[#8888a0] text-center" style={{ fontSize: "0.75rem" }}>
          {saveStatus}
        </div>
      )}

      {/* Account Info */}
      {user && (
        <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <Shield className="w-5 h-5 text-emerald-400" />
            <h3 className="text-white" style={{ fontSize: "1rem", fontWeight: 600 }}>Account Info</h3>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="p-3 rounded-lg bg-[#0f0f18]">
              <p className="text-[#8888a0]" style={{ fontSize: "0.75rem" }}>Name</p>
              <p className="text-white" style={{ fontSize: "0.875rem" }}>{user.name}</p>
            </div>
            <div className="p-3 rounded-lg bg-[#0f0f18]">
              <p className="text-[#8888a0]" style={{ fontSize: "0.75rem" }}>Email</p>
              <p className="text-white" style={{ fontSize: "0.875rem" }}>{user.email}</p>
            </div>
            <div className="p-3 rounded-lg bg-[#0f0f18]">
              <p className="text-[#8888a0]" style={{ fontSize: "0.75rem" }}>Minutes Consumed</p>
              <p className="text-white" style={{ fontSize: "0.875rem" }}>{user.minutes_consumed?.toLocaleString() || "N/A"}</p>
            </div>
            <div className="p-3 rounded-lg bg-[#0f0f18]">
              <p className="text-[#8888a0]" style={{ fontSize: "0.75rem" }}>Role</p>
              <p className="text-white" style={{ fontSize: "0.875rem" }}>{user.is_admin ? "Admin" : "Member"}</p>
            </div>
          </div>
        </div>
      )}

      {/* Data Stats */}
      <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-3">
          <Database className="w-5 h-5 text-emerald-400" />
          <h3 className="text-white" style={{ fontSize: "1rem", fontWeight: 600 }}>Data Analytics</h3>
        </div>
        <div className="flex items-center gap-3 text-[#8888a0] flex-wrap" style={{ fontSize: "0.8rem" }}>
          <Shield className="w-4 h-4 shrink-0" />
          <span>{totalCallsFetched} calls indexed</span>
          <span>·</span>
          <span>{new Set(calls.flatMap((c) => c.topics)).size} keywords extracted</span>
          <span>·</span>
          <span>{calls.reduce((sum, c) => sum + c.actionItems.length, 0)} action items</span>
          <span>·</span>
          <span>Names redacted: 3 people</span>
        </div>
      </div>

      {/* Notifications */}
      <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-3">
          <Bell className="w-5 h-5 text-amber-400" />
          <h3 className="text-white" style={{ fontSize: "1rem", fontWeight: 600 }}>Notifications</h3>
        </div>
        <div className="space-y-3">
          <NotificationToggle label="New call analyzed" description="Get notified when a new call is processed" defaultChecked />
          <NotificationToggle label="Action item detected" description="Alert when action items are extracted" defaultChecked />
          <NotificationToggle label="Weekly insights digest" description="Receive a summary of insights every Monday" defaultChecked />
          <NotificationToggle label="Negative sentiment alert" description="Alert for calls with negative sentiment" defaultChecked={false} />
        </div>
      </div>
    </div>
  );
}

function NotificationToggle({ label, description, defaultChecked }: { label: string; description: string; defaultChecked: boolean }) {
  const [checked, setChecked] = useState(defaultChecked);
  return (
    <div className="flex items-center justify-between p-3 rounded-lg bg-[#0f0f18]">
      <div>
        <p className="text-white" style={{ fontSize: "0.85rem" }}>{label}</p>
        <p className="text-[#555568]" style={{ fontSize: "0.75rem" }}>{description}</p>
      </div>
      <button
        onClick={() => setChecked(!checked)}
        className={`w-10 h-6 rounded-full transition-colors flex items-center ${checked ? "bg-[#ec5d25] justify-end" : "bg-[#1e1e2e] justify-start"}`}
      >
        <div className="w-4 h-4 rounded-full bg-white mx-1" />
      </button>
    </div>
  );
}