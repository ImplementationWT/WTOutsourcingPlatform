import { createBrowserRouter, Navigate } from "react-router-dom";
import Home from "@/app/Home";
import AppLayout from "@/components/layout/AppLayout";
import UsersPage from "@/features/admin/UsersPage";
import LoginPage from "@/features/auth/LoginPage";
import RequireAuth from "@/features/auth/RequireAuth";
import ActivitiesPage from "@/features/commercial/ActivitiesPage";
import DemosPage from "@/features/commercial/DemosPage";
import ProposalDetailPage from "@/features/commercial/ProposalDetailPage";
import ProposalsPage from "@/features/commercial/ProposalsPage";
import ContactDetailPage from "@/features/core/ContactDetailPage";
import ContactsPage from "@/features/core/ContactsPage";
import DealDetailPage from "@/features/core/DealDetailPage";
import DealsPage from "@/features/core/DealsPage";
import DashboardPage from "@/features/dashboard/DashboardPage";
import MeetingsPage from "@/features/meetings/MeetingsPage";
import OpsProjectDetailPage from "@/features/ops/OpsProjectDetailPage";
import OpsProjectsPage from "@/features/ops/OpsProjectsPage";
import NewProjectPage from "@/features/projects/NewProjectPage";
import ProjectDetailPage from "@/features/projects/ProjectDetailPage";
import ProjectsPage from "@/features/projects/ProjectsPage";
import LeadDetailPage from "@/features/sales/LeadDetailPage";
import LeadsPage from "@/features/sales/LeadsPage";
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
          { path: "/comercial/actividades", element: <ActivitiesPage /> },
          { path: "/comercial/demos", element: <DemosPage /> },
          { path: "/comercial/propuestas", element: <ProposalsPage /> },
          { path: "/comercial/propuestas/:id", element: <ProposalDetailPage /> },
          { path: "/comercial/contactos", element: <ContactsPage /> },
          { path: "/comercial/contactos/:id", element: <ContactDetailPage /> },
          // Tablero general (fuera de Comercial y Operativa): Deals y Meetings.
          { path: "/deals", element: <DealsPage /> },
          { path: "/deals/:id", element: <DealDetailPage /> },
          { path: "/meetings", element: <MeetingsPage /> },
          // Rutas de pantallas que ya no existen: van a su reemplazo.
          ...["/comercial/deals", "/operativa/deals"].map((path) => ({ path, element: <Navigate to="/deals" replace /> })),
          { path: "/comercial/reuniones", element: <Navigate to="/meetings" replace /> },
          ...["/comercial/clientes", "/comercial/empresas/*", "/comercial/partners/*", "/comercial/catalogo", "/comercial/sources"].map((path) => ({ path, element: <Navigate to="/comercial" replace /> })),
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
