import { createBrowserRouter, Navigate } from "react-router-dom";
import AppLayout from "@/components/layout/AppLayout";
import LoginPage from "@/features/auth/LoginPage";
import RequireAuth from "@/features/auth/RequireAuth";
import DashboardPage from "@/features/dashboard/DashboardPage";
import NewProjectPage from "@/features/projects/NewProjectPage";
import ProjectDetailPage from "@/features/projects/ProjectDetailPage";
import ProjectsPage from "@/features/projects/ProjectsPage";
import SettingsPage from "@/features/settings/SettingsPage";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: "/", element: <Navigate to="/dashboard" replace /> },
      {
        element: <AppLayout />,
        children: [
          { path: "/dashboard", element: <DashboardPage /> },
          { path: "/projects", element: <ProjectsPage /> },
          { path: "/projects/new", element: <NewProjectPage /> },
          { path: "/projects/:slug", element: <ProjectDetailPage /> },
          { path: "/settings", element: <SettingsPage /> },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/dashboard" replace /> },
]);
