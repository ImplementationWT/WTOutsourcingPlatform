import { Navigate } from "react-router-dom";
import { useSession } from "@/features/auth/auth";

/** Comercial y Financiera no usan Infraestructura: entran por Operativa. */
export default function Home() {
  const role = useSession().data?.role;
  return <Navigate to={role === "commercial" || role === "finance" ? "/operativa" : "/dashboard"} replace />;
}
