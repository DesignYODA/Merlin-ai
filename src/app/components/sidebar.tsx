import { NavLink } from "react-router";
import {
  LayoutDashboard,
  MessageSquare,
  Library,
  Lightbulb,
  Hash,
  Settings,
  Flame,
  Package,
} from "lucide-react";
import { useData } from "./data-context";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/ask-ai", icon: MessageSquare, label: "Ask Merlin" },
  { to: "/calls", icon: Library, label: "Calls Library" },
  { to: "/insights", icon: Lightbulb, label: "Insights" },
  { to: "/topics", icon: Hash, label: "Topics & Keywords" },
  { to: "/product-requests", icon: Package, label: "Product Requests" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export function Sidebar() {
  const { isLive, isLoading, user, lastSynced } = useData();

  return (
    <aside className="w-64 h-screen bg-[#0f0f13] border-r border-[#1e1e2e] flex flex-col shrink-0">
      <div className="p-5 flex items-center gap-3 border-b border-[#1e1e2e]">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ec5d25] to-[#c4400e] flex items-center justify-center">
          <Flame className="w-4 h-4 text-white" />
        </div>
        <span className="text-white tracking-tight" style={{ fontSize: "1.125rem", fontWeight: 600 }}>Merlin AI</span>
      </div>

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all ${
                isActive
                  ? "bg-[#1e1e2e] text-white"
                  : "text-[#8888a0] hover:text-white hover:bg-[#1a1a28]"
              }`
            }
          >
            <item.icon className="w-[18px] h-[18px]" />
            <span style={{ fontSize: "0.875rem" }}>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="p-4 border-t border-[#1e1e2e]">
        {/* Connection status */}
        <div className="mb-3 px-2">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isLoading ? "bg-amber-400 animate-pulse" : isLive ? "bg-emerald-400" : "bg-rose-400"}`} />
            <span className="text-[#8888a0]" style={{ fontSize: "0.7rem" }}>
              {isLoading ? "Syncing..." : isLive ? "Fireflies Connected" : "Offline Mode"}
            </span>
          </div>
          {lastSynced && (
            <p className="text-[#555568] mt-1 pl-4" style={{ fontSize: "0.65rem" }}>
              Last sync: {lastSynced.toLocaleTimeString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#ec5d25] to-[#c4400e] flex items-center justify-center text-white" style={{ fontSize: "0.75rem", fontWeight: 600 }}>
            {user ? user.name.split(" ").map(n => n[0]).join("").slice(0,2) : "JD"}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white truncate" style={{ fontSize: "0.875rem" }}>{user?.name || "John Doe"}</p>
            <p className="text-[#8888a0] truncate" style={{ fontSize: "0.75rem" }}>{user?.email || "Admin"}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}