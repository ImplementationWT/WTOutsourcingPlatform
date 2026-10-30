import { createBrowserRouter, Navigate } from "react-router-dom";
import Home from "@/app/Home";
import AppLayout from "@/components/layout/AppLayout";
import UsersPage from "@/features/admin/UsersPage";
import LoginPage from "@/features/auth/LoginPage";
import RequireAuth from "@/features/auth/RequireAuth";
import DashboardPage from "@/features/dashboard/DashboardPage";
import OpsProjectDetailPage from "@/features/ops/OpsProjectDetailPage";
import OpsProjectsPage from "@/features/ops/OpsProjectsPage";
import NewProjectPage from "@/features/projects/NewProjectPage";
import ProjectDetailPage from "@/features/projects/ProjectDetailPage";
import ProjectsPage from "@/features/projects/ProjectsPage";
import CustomersPage from "@/features/sales/CustomersPage";
import LeadDetailPage from "@/features/sales/LeadDetailPage";
import LeadsPage from "@/features/sales/LeadsPage";
import SourcesPage from "@/features/sales/SourcesPage";
import IntegrationsPage from "@/features/servers/IntegrationsPage";
import SettingsPage from "@/features/settings/SettingsPage";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: "/", element: <Home /> },
      // AI Developer: consola a pantalla completa (sin la barra lateral del panel).
      // Se carga al abrirla: el markdown del chat no pesa en el resto del panel.
      { path: "/projects/:slug/ai", lazy: async () => ({ Component: (await import("@/features/ai/AiDeveloperPage")).default }) },
      {
        element: <AppLayout />,
        children: [
          { path: "/comercial", element: <LeadsPage /> },
          { path: "/comercial/leads/:id", element: <LeadDetailPage /> },
          { path: "/comercial/clientes", element: <CustomersPage /> },
          { path: "/comercial/sources", element: <SourcesPage /> },
          { path: "/operativa", element: <OpsProjectsPage /> },
          { path: "/operativa/:id", element: <OpsProjectDetailPage /> },
          { path: "/dashboard", element: <DashboardPage /> },
          { path: "/projects", element: <ProjectsPage /> },
          { path: "/projects/new", element: <NewProjectPage /> },
          { path: "/projects/:slug", element: <ProjectDetailPage /> },
          { path: "/integrations", element: <IntegrationsPage /> },
          // Costos vive ahora dentro del Dashboard.
          { path: "/costs", element: <Navigate to="/dashboard#costos" replace /> },
          { path: "/users", element: <UsersPage /> },
          { path: "/settings", element: <SettingsPage /> },
        ],
      },
    ],
  },
  { path: "*", element: <Home /> },
]);
