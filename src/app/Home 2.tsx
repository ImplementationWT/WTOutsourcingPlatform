import { Navigate } from "react-router-dom";
import { useSession } from "@/features/auth/auth";

/** Cada área entra por lo suyo: Comercial por sus leads, Financiera por Operativa (hasta tener su área). */
export default function Home() {
  const role = useSession().data?.role;
  return <Navigate to={role === "commercial" ? "/comercial" : role === "finance" ? "/operativa" : "/dashboard"} replace />;
}
