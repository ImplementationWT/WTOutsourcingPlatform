import { ActivitiesTable } from "./ActivitiesTable";

/** Actividades comerciales ("Commercial Tasks"): las de todos los leads y deals. */
export default function ActivitiesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Actividades</h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">Llamadas, correos y follow-ups de cada lead o deal, con su responsable y su fecha. Se crean desde el lead o el deal.</p>
      </div>
      <ActivitiesTable />
    </div>
  );
}
