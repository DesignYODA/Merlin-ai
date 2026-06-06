import { Outlet, Navigate } from "react-router";
import { Sidebar } from "./sidebar";
import { DataProvider } from "./data-context";
import { useAuth } from "../auth";

export function Layout() {
  const { email } = useAuth();

  if (!email) return <Navigate to="/login" replace />;

  return (
    <DataProvider>
      <div className="dark flex h-screen w-screen bg-[#0a0a12] overflow-hidden" style={{ fontFamily: "'Inter', sans-serif" }}>
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </DataProvider>
  );
}
