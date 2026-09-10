import { useState, useCallback, useEffect } from "react";
import { Outlet, Navigate, NavLink, Link } from "react-router";
import { Settings, Calendar } from "lucide-react";
import { Sidebar } from "./sidebar";
import { GlisseoLogo } from "./glisseo-mark";
import { GlisseoGlobe } from "./glisseo-globe";
import { DataProvider, useData } from "./data-context";
import { useAuth } from "../auth";
import { AskAiPage } from "./ask-ai-page";

// ─── Sync date chip (reads from DataProvider context) ────────────────────────

function SyncDateBadge() {
  const { syncStatus, lastSynced } = useData();

  const raw = syncStatus?.lastSyncAt ? new Date(syncStatus.lastSyncAt) : lastSynced;
  if (!raw) return null;

  const now = new Date();
  const isToday =
    raw.getDate() === now.getDate() &&
    raw.getMonth() === now.getMonth() &&
    raw.getFullYear() === now.getFullYear();

  const dateStr = raw.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
  const timeStr = raw.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#2e2e2e] bg-[#1a1a1a]/80 backdrop-blur-sm"
      style={{ fontSize: "0.7rem" }}
    >
      <Calendar className="w-3 h-3 text-[#555]" />
      <span className="text-[#555]">{isToday ? "Today" : dateStr}</span>
      <span className="text-[#2e2e2e]">·</span>
      <span className="text-[#777]">{isToday ? dateStr : ""}{isToday ? " " : ""}{timeStr}</span>
    </div>
  );
}

function readBool(key: string, def: boolean) {
  const v = localStorage.getItem(key);
  return v === null ? def : v === "true";
}

// ─── Sidebar layout (Calls, Topics, Settings, etc.) ─────────────────────────

export function Layout() {
  const { email } = useAuth();

  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem("glisseo-theme");
    return saved !== "light";
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readBool("glisseo-sidebar-collapsed", false)
  );

  const toggleTheme = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      localStorage.setItem("glisseo-theme", next ? "dark" : "light");
      return next;
    });
  }, []);

  const toggleCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("glisseo-sidebar-collapsed", String(next));
      return next;
    });
  }, []);

  if (!email) return <Navigate to="/login" replace />;

  return (
    <DataProvider>
      <div
        className={`${isDark ? "dark" : ""} flex h-screen w-screen overflow-hidden bg-app-base`}
      >
        <Sidebar
          isDark={isDark}
          toggleTheme={toggleTheme}
          collapsed={sidebarCollapsed}
          toggleCollapsed={toggleCollapsed}
        />
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </DataProvider>
  );
}

// ─── Split layout (Overview / Insights) ──────────────────────────────────────

export function SplitLayout() {
  const { email } = useAuth();
  if (!email) return <Navigate to="/login" replace />;

  return (
    <DataProvider>
      <div
        className="h-screen w-screen overflow-hidden relative"
      >
        {/* ── Floating top navbar ── */}
        <header className="absolute top-0 left-0 right-0 z-30 px-8 py-3.5 flex items-center justify-between">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2">
            <GlisseoLogo size={22} />
            <span className="text-white font-bold tracking-tight" style={{ fontSize: "0.88rem" }}>
              Glisseo<span className="text-[#ec5d25]">.</span>AI
            </span>
          </Link>

          {/* Centered pill nav */}
          <div className="flex items-center gap-0.5 p-1 rounded-full bg-[#1a1a1a]/90 backdrop-blur-md border border-[#2e2e2e]">
            <NavLink
                to="/dashboard"
                className={({ isActive }) =>
                  `px-5 py-1.5 rounded-full transition-all duration-150 ${
                    isActive
                      ? "bg-[#2e2e2e] text-white"
                      : "text-[#888] opacity-50 hover:opacity-100 hover:text-white"
                  }`
                }
                style={{ fontSize: "0.8rem" }}
              >
                Overview
            </NavLink>

            <Link
              to="/ask-ai"
              className="px-5 py-1.5 rounded-full text-[#888] opacity-50 hover:opacity-100 hover:text-white transition-all duration-150"
              style={{ fontSize: "0.8rem" }}
            >
              Ask Glisseo
            </Link>

            <NavLink
              to="/library"
              className={({ isActive }) =>
                `px-5 py-1.5 rounded-full transition-all duration-150 ${
                  isActive
                    ? "bg-[#2e2e2e] text-white"
                    : "text-[#888] opacity-50 hover:opacity-100 hover:text-white"
                }`
              }
              style={{ fontSize: "0.8rem" }}
            >
              Library
            </NavLink>
            
            <NavLink
              to="/insights"
              className={({ isActive }) =>
                `px-5 py-1.5 rounded-full transition-all duration-150 ${
                  isActive
                    ? "bg-[#2e2e2e] text-white"
                    : "text-[#888] opacity-50 hover:opacity-100 hover:text-white"
                }`
              }
              style={{ fontSize: "0.8rem" }}
            >
              Insights
            </NavLink>
          </div>

          {/* Right icons */}
          <div className="flex items-center gap-2">
            <SyncDateBadge />
            <Link
              to="/settings"
              className="w-8 h-8 rounded-lg bg-[#1a1a1a]/80 border border-[#2e2e2e] flex items-center justify-center text-[#666] hover:text-white hover:bg-[#2a2a2a] transition-all"
              title="Settings"
            >
              <Settings className="w-3.5 h-3.5" />
            </Link>
          </div>
        </header>

        {/* Page fills full height; pages manage their own top/bottom split */}
        <main className="h-full">
          <Outlet />
        </main>
      </div>
    </DataProvider>
  );
}

// ─── Ask Glisseo full-page layout (globe intro → chat) ───────────────────────

type IntroPhase = "video" | "fading" | "chat";

export function AskAiRoute() {
  const { email } = useAuth();
  const [isDark] = useState(() => localStorage.getItem("glisseo-theme") !== "light");
  const [phase, setPhase] = useState<IntroPhase>("video");

  const advance = useCallback(() => {
    if (phase !== "video") return;
    setPhase("fading");
    setTimeout(() => setPhase("chat"), 700);
  }, [phase]);

  // Auto-advance with a smooth fade-out after the intro has had time to show
  useEffect(() => {
    const timer = setTimeout(advance, 3200);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!email) return <Navigate to="/login" replace />;

  return (
    <DataProvider>
      <div className={`${isDark ? "dark" : ""} h-screen w-screen overflow-hidden bg-app-base relative`}>

        {/* ── Globe intro layer ── */}
        {phase !== "chat" && (
          <div
            onClick={advance}
            style={{
              position: "fixed", inset: 0, zIndex: 50,
              background: "radial-gradient(ellipse at 50% 42%, #7D2400 0%, #3E0C00 42%, #0B0200 78%)",
              cursor: "pointer",
              opacity: phase === "fading" ? 0 : 1,
              transition: "opacity 700ms cubic-bezier(0.4, 0, 0.2, 1)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <style>{`
              @keyframes floatY { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-14px)} }
            `}</style>
            <div style={{
              width: 480, height: 480,
              animation: "floatY 5s ease-in-out infinite",
              display: "flex", alignItems: "center", justifyContent: "center",
              position: "relative",
            }}>
              <div style={{
                position: "absolute", width: 380, height: 380, borderRadius: "50%",
                background: "radial-gradient(circle, rgba(240,120,68,0.35) 0%, rgba(184,48,0,0.14) 45%, transparent 72%)",
                filter: "blur(20px)",
              }} />
              <div style={{ filter: "drop-shadow(0 30px 50px rgba(0,0,0,0.55))" }}>
                <GlisseoGlobe size={420} />
              </div>
            </div>

            {/* Skip hint */}
            <div
              style={{
                position: "absolute", bottom: 32, left: "50%",
                transform: "translateX(-50%)",
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 18px", borderRadius: 9999,
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.14)",
                color: "rgba(255,255,255,0.45)",
                fontSize: "0.72rem", pointerEvents: "none",
                backdropFilter: "blur(8px)",
              }}
            >
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#ec5d25", animation: "pulse 2s ease-in-out infinite" }} />
              Click anywhere to skip
            </div>
          </div>
        )}

        {/* ── Chat layer — always mounted so DataProvider is ready ── */}
        <div
          style={{
            position: "absolute", inset: 0,
            opacity: phase === "chat" ? 1 : 0,
            transition: phase === "fading" ? "opacity 700ms 300ms cubic-bezier(0.4, 0, 0.2, 1)" : "none",
            pointerEvents: phase === "chat" ? "auto" : "none",
          }}
        >
          <AskAiPage />
        </div>

      </div>
    </DataProvider>
  );
}

// ─── Catch-all (unknown paths, e.g. a direct/typed navigation to a backend-only
// path like /data) — send authenticated users to the dashboard and everyone
// else to login, instead of react-router's default "no routes matched" page. ──

export function NotFoundRedirect() {
  const { email } = useAuth();
  return <Navigate to={email ? "/dashboard" : "/login"} replace />;
}
