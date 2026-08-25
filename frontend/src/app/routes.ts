import { createBrowserRouter, redirect } from "react-router";
import { Layout, AskAiRoute, SplitLayout } from "./components/layout";
import { LandingPage } from "./components/landing-page";
import { LoginPage } from "./components/login-page";
import { DashboardPage } from "./components/dashboard-page";
import { InsightsPage } from "./components/insights-page";
import { CallsLibraryPage } from "./components/calls-library-page";
import { TopicsPage } from "./components/topics-page";
import { ProductRequestsPage } from "./components/product-requests-page";
import { SettingsPage } from "./components/settings-page";

export const router = createBrowserRouter([
  // ── Public ──────────────────────────────────────────────────────────────
  { path: "/", Component: LandingPage },
  { path: "/login", Component: LoginPage },
  { path: "/ask-ai", Component: AskAiRoute },

  // ── Split layout (no sidebar): Overview + Library + Insights ────────────
  {
    path: "/dashboard",
    Component: SplitLayout,
    children: [{ index: true, Component: DashboardPage }],
  },
  {
    path: "/library",
    Component: SplitLayout,
    children: [{ index: true, Component: CallsLibraryPage }],
  },
  {
    path: "/insights",
    Component: SplitLayout,
    children: [{ index: true, Component: InsightsPage }],
  },

  // ── Sidebar layout: utility pages ────────────────────────────────────────
  {
    path: "/topics",
    Component: Layout,
    children: [{ index: true, Component: TopicsPage }],
  },
  {
    path: "/product-requests",
    Component: Layout,
    children: [{ index: true, Component: ProductRequestsPage }],
  },
  {
    path: "/settings",
    Component: Layout,
    children: [{ index: true, Component: SettingsPage }],
  },
  { path: "/calls", loader: () => redirect("/library") },
]);
