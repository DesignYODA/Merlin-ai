import { createBrowserRouter, redirect } from "react-router";
import { Layout } from "./components/layout";
import { LoginPage } from "./components/login-page";
import { DashboardPage } from "./components/dashboard-page";
import { AskAiPage } from "./components/ask-ai-page";
import { CallsLibraryPage } from "./components/calls-library-page";
import { InsightsPage } from "./components/insights-page";
import { TopicsPage } from "./components/topics-page";
import { ProductRequestsPage } from "./components/product-requests-page";
import { SettingsPage } from "./components/settings-page";

export const router = createBrowserRouter([
  { path: "/login", Component: LoginPage },
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, loader: () => redirect("/dashboard") },
      { path: "dashboard", Component: DashboardPage },
      { path: "ask-ai", Component: AskAiPage },
      { path: "calls", Component: CallsLibraryPage },
      { path: "insights", Component: InsightsPage },
      { path: "topics", Component: TopicsPage },
      { path: "product-requests", Component: ProductRequestsPage },
      { path: "settings", Component: SettingsPage },
    ],
  },
]);
