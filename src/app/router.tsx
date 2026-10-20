import { createBrowserRouter, Navigate } from "react-router-dom";
import AppLayout from "@/components/layout/AppLayout";
import LoginPage from "@/features/auth/LoginPage";
import RequireAuth from "@/features/auth/RequireAuth";
import DashboardPage from "@/features/dashboard/DashboardPage";
import NewProjectPage from "@/features/projects/NewProjectPage";
import ProjectDetailPage from "@/features/projects/ProjectDetailPage";
import ProjectsPage from "@/features/projects/ProjectsPage";
import IntegrationsPage from "@/features/servers/IntegrationsPage";
import SettingsPage from "@/features/settings/SettingsPage";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: "/", element: <Navigate to="/dashboard" replace /> },
      // AI Developer: consola a pantalla completa (sin la barra lateral del panel).
      // Se carga al abrirla: el markdown del chat no pesa en el resto del panel.
      { path: "/projects/:slug/ai", lazy: async () => ({ Component: (await import("@/features/ai/AiDeveloperPage")).default }) },
      {
        element: <AppLayout />,
        children: [
          { path: "/dashboard", element: <DashboardPage /> },
          { path: "/projects", element: <ProjectsPage /> },
          { path: "/projects/new", element: <NewProjectPage /> },
          { path: "/projects/:slug", element: <ProjectDetailPage /> },
          { path: "/integrations", element: <IntegrationsPage /> },
          { path: "/settings", element: <SettingsPage /> },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/dashboard" replace /> },
]);
