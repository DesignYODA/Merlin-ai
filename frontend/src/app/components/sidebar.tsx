import { useState, useEffect } from "react";
import { NavLink } from "react-router";
import {
  LayoutDashboard, MessageSquare, Library, Hash, Settings, Flame,
  Package, LogOut, Sun, Moon, ChevronLeft, ChevronRight,
} from "lucide-react";
import { useData } from "./data-context";
import { useAuth } from "../auth";

interface SidebarProps {
  isDark: boolean;
  toggleTheme: () => void;
  collapsed: boolean;
  toggleCollapsed: () => void;
}

const navSections = [
  {
    items: [
      { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
      { to: "/ask-ai", icon: MessageSquare, label: "Ask Glisseo" },
    ],
  },
  {
    label: "Library",
    items: [
      { to: "/calls", icon: Library, label: "Calls Library" },
    ],
  },
  {
    label: "Insights",
    items: [
      { to: "/topics", icon: Hash, label: "Topics & Keywords" },
      { to: "/product-requests", icon: Package, label: "Product Insights" },
    ],
  },
  {
    label: "Settings",
    items: [
      { to: "/settings", icon: Settings, label: "Settings" },
    ],
  },
];

export function Sidebar({ isDark, toggleTheme, collapsed, toggleCollapsed }: SidebarProps) {
  const { isLive, isLoading, lastSynced } = useData();
  const { email, logout } = useAuth();

  // Delay showing labels when expanding so they appear after the width animation
  const [showLabels, setShowLabels] = useState(!collapsed);
  useEffect(() => {
    if (!collapsed) {
      const t = setTimeout(() => setShowLabels(true), 160);
      return () => clearTimeout(t);
    } else {
      setShowLabels(false);
    }
  }, [collapsed]);

  return (
    <aside
      style={{ width: collapsed ? 60 : 256, minWidth: collapsed ? 60 : 256 }}
      className="h-screen flex flex-col shrink-0 bg-white dark:bg-app-surface border-r border-gray-200 dark:border-app-border transition-[width,min-width] duration-200 ease-in-out"
    >
      {/* ── Header ───────────────────────────────────────── */}
      <div
        className={`flex items-center border-b border-gray-200 dark:border-app-border shrink-0 ${
          collapsed ? "justify-center px-2 py-4" : "justify-start gap-3 px-5 py-4"
        }`}
      >
        {/* Logo — hover swaps Flame → chevron to signal collapse/expand */}
        <button
          onClick={toggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="relative w-8 h-8 rounded-lg bg-gradient-to-br from-[#ec5d25] to-[#c4400e] flex items-center justify-center shrink-0 group"
        >
          <Flame className="w-4 h-4 text-white transition-opacity duration-150 group-hover:opacity-0 absolute" />
          {collapsed
            ? <ChevronRight className="w-4 h-4 text-white transition-opacity duration-150 opacity-0 group-hover:opacity-100" />
            : <ChevronLeft className="w-4 h-4 text-white transition-opacity duration-150 opacity-0 group-hover:opacity-100" />
          }
        </button>
        {showLabels && (
          <span
            className="text-gray-900 dark:text-white tracking-tight truncate"
            style={{ fontSize: "1.125rem", fontWeight: 600 }}
          >
            Glisseo AI
          </span>
        )}
      </div>

      {/* ── Nav ──────────────────────────────────────────── */}
      <nav className="flex-1 px-2 py-3 space-y-3 overflow-hidden">
        {navSections.map((section, si) => (
          <div key={si}>
            {showLabels && section.label && (
              <p
                className="px-3 mb-1 text-gray-400 dark:text-app-fg-subtle uppercase tracking-widest"
                style={{ fontSize: "0.6rem", fontWeight: 600 }}
              >
                {section.label}
              </p>
            )}
            {collapsed && si > 0 && (
              <div className="h-px bg-gray-200 dark:bg-app-overlay mx-2 mb-2" />
            )}
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <div key={item.to} className="relative group">
                  <NavLink
                    to={item.to}
                    end
                    className={({ isActive }) =>
                      `flex items-center rounded-lg transition-all ${
                        collapsed
                          ? "justify-center w-10 h-10 mx-auto"
                          : "gap-3 px-3 py-2.5 w-full"
                      } ${
                        isActive
                          ? "bg-gray-100 dark:bg-app-overlay text-gray-900 dark:text-white"
                          : "text-gray-500 dark:text-app-fg-muted hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-app-elevated"
                      }`
                    }
                  >
                    <item.icon className="w-[18px] h-[18px] shrink-0" />
                    {showLabels && (
                      <span style={{ fontSize: "0.875rem" }}>{item.label}</span>
                    )}
                  </NavLink>
                  {/* Hover tooltip — only in collapsed mode */}
                  {collapsed && (
                    <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2.5 z-[999] px-2 py-1 rounded-md text-xs whitespace-nowrap pointer-events-none shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150 bg-gray-900 text-white dark:bg-white dark:text-gray-900">
                      {item.label}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* ── Footer ───────────────────────────────────────── */}
      <div
        className={`border-t border-gray-200 dark:border-app-border ${
          collapsed ? "p-2 flex flex-col items-center gap-2" : "p-4"
        }`}
      >
        {/* Connection status — expanded only */}
        {showLabels && (
          <div className="mb-3 px-2">
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  isLoading
                    ? "bg-amber-400 animate-pulse"
                    : isLive
                    ? "bg-emerald-400"
                    : "bg-rose-400"
                }`}
              />
              <span
                className="text-gray-500 dark:text-app-fg-muted"
                style={{ fontSize: "0.7rem" }}
              >
                {isLoading ? "Syncing..." : isLive ? "Fireflies Connected" : "Offline Mode"}
              </span>
            </div>
            {lastSynced && (
              <p
                className="text-gray-400 dark:text-app-fg-subtle mt-1 pl-4"
                style={{ fontSize: "0.65rem" }}
              >
                Last sync: {lastSynced.toLocaleTimeString()}
              </p>
            )}
          </div>
        )}

        {/* Theme toggle */}
        {showLabels ? (
          <div className="flex items-center justify-between mb-3 px-1">
            <span className="text-gray-400 dark:text-app-fg-subtle" style={{ fontSize: "0.7rem" }}>
              {isDark ? "Dark mode" : "Light mode"}
            </span>
            <button
              onClick={toggleTheme}
              title={isDark ? "Switch to light mode" : "Switch to dark mode"}
              className="p-1.5 rounded-md text-gray-400 dark:text-app-fg-subtle hover:text-gray-700 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-app-elevated transition-colors"
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        ) : (
          <button
            onClick={toggleTheme}
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
            className="p-1.5 rounded-md text-gray-400 dark:text-app-fg-subtle hover:text-gray-700 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-app-elevated transition-colors"
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        )}

        {/* User row */}
        {showLabels ? (
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-full bg-gradient-to-br from-[#ec5d25] to-[#c4400e] flex items-center justify-center text-white shrink-0"
              style={{ fontSize: "0.75rem", fontWeight: 600 }}
            >
              {email ? email[0].toUpperCase() : "?"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-gray-500 dark:text-app-fg-muted truncate" style={{ fontSize: "0.72rem" }}>
                {email}
              </p>
            </div>
            <button
              onClick={logout}
              title="Sign out"
              className="text-gray-400 dark:text-app-fg-subtle hover:text-red-400 transition-colors shrink-0"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <>
            <div
              className="w-8 h-8 rounded-full bg-gradient-to-br from-[#ec5d25] to-[#c4400e] flex items-center justify-center text-white shrink-0"
              style={{ fontSize: "0.75rem", fontWeight: 600 }}
            >
              {email ? email[0].toUpperCase() : "?"}
            </div>
            <button
              onClick={logout}
              title="Sign out"
              className="p-1.5 rounded-md text-gray-400 dark:text-app-fg-subtle hover:text-red-400 transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
