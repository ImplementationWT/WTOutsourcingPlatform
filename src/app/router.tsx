import { createBrowserRouter, Navigate } from "react-router-dom";
import Home from "@/app/Home";
import AppLayout from "@/components/layout/AppLayout";
import UsersPage from "@/features/admin/UsersPage";
import LoginPage from "@/features/auth/LoginPage";
import RequireAuth from "@/features/auth/RequireAuth";
import ActivitiesPage from "@/features/commercial/ActivitiesPage";
import CatalogPage from "@/features/commercial/CatalogPage";
import DemosPage from "@/features/commercial/DemosPage";
import MeetingsInboxPage from "@/features/commercial/MeetingsInboxPage";
import PartnerDetailPage from "@/features/commercial/PartnerDetailPage";
import PartnersPage from "@/features/commercial/PartnersPage";
import ProposalDetailPage from "@/features/commercial/ProposalDetailPage";
import ProposalsPage from "@/features/commercial/ProposalsPage";
import CompaniesPage from "@/features/core/CompaniesPage";
import CompanyDetailPage from "@/features/core/CompanyDetailPage";
import ContactDetailPage from "@/features/core/ContactDetailPage";
import ContactsPage from "@/features/core/ContactsPage";
import DealDetailPage from "@/features/core/DealDetailPage";
import DealsPage from "@/features/core/DealsPage";
import DashboardPage from "@/features/dashboard/DashboardPage";
import OpsProjectDetailPage from "@/features/ops/OpsProjectDetailPage";
import OpsProjectsPage from "@/features/ops/OpsProjectsPage";
import NewProjectPage from "@/features/projects/NewProjectPage";
import ProjectDetailPage from "@/features/projects/ProjectDetailPage";
import ProjectsPage from "@/features/projects/ProjectsPage";
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
          { path: "/comercial/actividades", element: <ActivitiesPage /> },
          { path: "/comercial/demos", element: <DemosPage /> },
          { path: "/comercial/propuestas", element: <ProposalsPage /> },
          { path: "/comercial/propuestas/:id", element: <ProposalDetailPage /> },
          { path: "/comercial/partners", element: <PartnersPage /> },
          { path: "/comercial/partners/:id", element: <PartnerDetailPage /> },
          { path: "/comercial/catalogo", element: <CatalogPage /> },
          { path: "/comercial/reuniones", element: <MeetingsInboxPage /> },
          // Clientes pasó a Empresas (núcleo compartido).
          { path: "/comercial/clientes", element: <Navigate to="/comercial/empresas" replace /> },
          { path: "/comercial/empresas", element: <CompaniesPage /> },
          { path: "/comercial/empresas/:id", element: <CompanyDetailPage /> },
          { path: "/comercial/contactos", element: <ContactsPage /> },
          { path: "/comercial/contactos/:id", element: <ContactDetailPage /> },
          // Deals es una sola tabla; aparece en Comercial y en Operativa.
          { path: "/comercial/deals", element: <DealsPage /> },
          { path: "/operativa/deals", element: <DealsPage /> },
          { path: "/deals/:id", element: <DealDetailPage /> },
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
