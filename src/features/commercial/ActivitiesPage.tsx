import { ActivitiesTable } from "./ActivitiesTable";
import { PageHeader } from "@/components/layout/PageHeader";

/** Actividades comerciales ("Commercial Tasks"): las de todos los leads y deals. */
export default function ActivitiesPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Actividades" description="Llamadas, correos y follow-ups de cada lead o deal, con su responsable y su fecha. Se crean desde el lead o el deal." />
      <ActivitiesTable />
    </div>
  );
}
