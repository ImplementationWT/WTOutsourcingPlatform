import { Link } from "react-router-dom";
import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDashboard } from "@/features/projects/api";
import { liveStatusMeta } from "@/features/projects/meta";
import { Code } from "@/features/projects/new-project/parts";
import StatusLabel from "@/features/projects/StatusLabel";
import { cn } from "@/lib/utils";
import type { DashboardData, DashboardProject } from "@/types/project";

const relative = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

/** "hace 5 minutos", "ayer"… */
function ago(iso: string | null) {
  if (!iso) return "—";
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  return "ahora";
}

const ACTIONS: Record<string, string> = {
  "client.created": "creó el proyecto",
  "job.retried": "reintentó el aprovisionamiento",
  "client.redeploy_requested": "lanzó un redespliegue",
  "client.deletion_requested": "pidió borrar el proyecto",
  "client.deleted": "borró el proyecto",
  initial_password_revealed: "mostró la contraseña inicial",
  "github.repository.created": "creó el repositorio",
  "github.workflow.dispatched": "lanzó el despliegue",
  "server.client_installed": "preparó el servidor",
  "atlas.database_user.created": "creó el usuario de la base",
  "atlas.database_user.password_rotated": "rotó la credencial de la base",
  "mongodb.database.created": "inicializó la base",
  "github.environment.created": "creó el entorno production",
  "github.environment_secrets.written": "escribió secrets",
};

/** Estado mostrado: la salud en vivo si está desplegado; si no, el del aprovisionamiento. */
function displayStatus(p: DashboardProject) {
  if (p.status === "provisioning") return liveStatusMeta.provisioning;
  if (p.status === "failed") return liveStatusMeta.failed;
  return liveStatusMeta[p.live];
}

export default function DashboardPage() {
  const { data, isLoading, isError, error, refetch, isFetching } = useDashboard();

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-2 text-muted-foreground">
            Estado real de los proyectos: aprovisionamiento, salud de cada app y actividad reciente.
          </p>
        </div>
        <Button variant="ghost" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn(isFetching && "animate-spin")} />
          Actualizar
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : isError || !data ? (
        <Card>
          <CardContent className="flex items-center gap-3 text-sm">
            <AlertTriangle className="size-5 text-amber-400" />
            {error?.message ?? "No se pudo cargar el dashboard."}
          </CardContent>
        </Card>
      ) : (
        <>
          <StatTiles data={data} />
          <div className="grid gap-4 xl:grid-cols-3">
            <ProjectsTable data={data} />
            <div className="space-y-4">
              <Attention data={data} />
              <Activity data={data} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Salud comprobada en vivo con <Code>/health/ready</Code> por HTTPS · actualizado {ago(data.generatedAt)}.
          </p>
        </>
      )}
    </section>
  );
}

function StatTiles({ data }: { data: DashboardData }) {
  const { totals } = data;
  const tiles = [
    { label: "Proyectos", value: String(totals.projects), hint: `${totals.ready} listos · ${totals.provisioning} aprovisionando` },
    {
      label: "Apps en línea",
      value: data.deployEnabled ? `${totals.online} / ${totals.deployed}` : "—",
      hint: data.deployEnabled ? "responden /health/ready ahora" : "el despliegue no está habilitado",
    },
    {
      label: "Requieren atención",
      value: String(data.attention.length),
      hint: totals.failed ? `${totals.failed} con el aprovisionamiento fallido` : "nada pendiente",
      warn: data.attention.length > 0,
    },
    { label: "Último despliegue", value: ago(data.lastDeployAt), hint: "imagen confirmada por el servidor", text: true },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map((tile) => (
        <Card key={tile.label}>
          <CardHeader>
            <CardDescription>{tile.label}</CardDescription>
            <CardTitle className={cn("font-semibold tabular-nums", tile.text ? "text-2xl leading-9" : "text-3xl", tile.warn && "text-amber-400")}>
              {tile.value}
            </CardTitle>
            <p className="text-xs text-muted-foreground">{tile.hint}</p>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

function ProjectsTable({ data }: { data: DashboardData }) {
  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <CardTitle>Proyectos</CardTitle>
        <CardDescription>Salud en vivo, versión del template, HTTPS y último despliegue.</CardDescription>
      </CardHeader>
      <CardContent>
        {data.projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aún no hay proyectos. <Link to="/projects/new" className="font-medium underline-offset-4 hover:underline">Crea el primero</Link>.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Proyecto</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Respuesta</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>HTTPS</TableHead>
                <TableHead>Último despliegue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.projects.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    <Link to={`/projects/${p.id}`} className="underline-offset-4 hover:underline">
                      {p.name}
                    </Link>
                    {p.live !== "not_deployed" && (
                      <a href={p.appUrl} target="_blank" rel="noreferrer" title={`Abrir ${p.appUrl}`} className="ml-1.5 inline-flex text-muted-foreground hover:text-foreground">
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusLabel meta={displayStatus(p)} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{p.responseMs !== null ? `${p.responseMs} ms` : "—"}</TableCell>
                  <TableCell className="tabular-nums">{p.templateVersion ?? "—"}</TableCell>
                  <TableCell className="text-sm">{p.httpsVerifiedAt ? "Verificado" : "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{p.image ? ago(p.image.deployedAt) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function Attention({ data }: { data: DashboardData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Requieren atención</CardTitle>
        <CardDescription>Aprovisionamientos fallidos, apps que no responden y contraseñas por mostrar.</CardDescription>
      </CardHeader>
      <CardContent>
        {data.attention.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todo en orden.</p>
        ) : (
          <ul className="space-y-3">
            {data.attention.map((item) => (
              <li key={`${item.clientId}-${item.kind}`} className="rounded-lg border p-3 text-sm">
                <Link to={`/projects/${item.clientId}`} className="font-medium underline-offset-4 hover:underline">
                  {item.name}
                </Link>
                <p className="mt-1 text-muted-foreground">{item.message}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Activity({ data }: { data: DashboardData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Actividad reciente</CardTitle>
        <CardDescription>Últimas acciones registradas en la auditoría.</CardDescription>
      </CardHeader>
      <CardContent>
        {data.activity.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin actividad todavía.</p>
        ) : (
          <ul className="space-y-2.5">
            {data.activity.map((entry, i) => (
              <li key={`${entry.at}-${i}`} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{entry.actor === "admin" ? "Admin" : entry.actor}</span>{" "}
                  <span className="text-muted-foreground">{ACTIONS[entry.action] ?? entry.action}</span>{" "}
                  <span className="font-medium">{entry.clientId}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{ago(entry.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
