import { Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDemoProjects } from "@/features/projects/api";
import { accountStatusMeta, projectStatusMeta, providerMeta } from "@/features/projects/meta";
import StatusLabel from "@/features/projects/StatusLabel";
import type { Project } from "@/types/project";

const number = new Intl.NumberFormat("es-PE");
const currency = new Intl.NumberFormat("es-PE", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default function DashboardPage() {
  const { data: projects, isLoading } = useDemoProjects();

  return (
    <section className="space-y-6">
      <div>
        <h1 className="flex items-center gap-3 text-3xl font-semibold tracking-tight">
          Dashboard
          <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-0.5 text-xs font-medium tracking-normal text-amber-200">
            Datos de ejemplo
          </span>
        </h1>
        <p className="mt-2 text-muted-foreground">
          Métricas principales de todos los proyectos alojados.
        </p>
      </div>

      {isLoading || !projects ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          <StatTiles projects={projects} />
          <div className="grid gap-4 xl:grid-cols-3">
            <ProjectsTable projects={projects} />
            <Alerts projects={projects} />
          </div>
        </>
      )}
    </section>
  );
}

function StatTiles({ projects }: { projects: Project[] }) {
  const online = projects.filter((p) => p.status === "online").length;
  const requests = projects.reduce((sum, p) => sum + p.metrics.requestsPerDay, 0);
  // Los proyectos recién creados aún no tienen historial de uptime.
  const measured = projects.filter((p) => p.status !== "provisioning");
  const avgUptime = measured.reduce((sum, p) => sum + p.metrics.uptime, 0) / (measured.length || 1);
  const cost = projects.reduce((sum, p) => sum + p.metrics.monthlyCost, 0);

  const tiles = [
    { label: "Proyectos activos", value: `${online} / ${projects.length}`, hint: "online ahora" },
    { label: "Requests por día", value: number.format(requests), hint: "suma de todos los proyectos" },
    { label: "Uptime promedio", value: `${avgUptime.toFixed(2)}%`, hint: "últimos 30 días" },
    { label: "Costo mensual", value: currency.format(cost), hint: "infraestructura y servicios" },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map((tile) => (
        <Card key={tile.label}>
          <CardHeader>
            <CardDescription>{tile.label}</CardDescription>
            <CardTitle className="text-3xl font-semibold tabular-nums">{tile.value}</CardTitle>
            <p className="text-xs text-muted-foreground">{tile.hint}</p>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

function ProjectsTable({ projects }: { projects: Project[] }) {
  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <CardTitle>Rendimiento por proyecto</CardTitle>
        <CardDescription>Estado y métricas clave de cada proyecto.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Proyecto</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Uptime</TableHead>
              <TableHead className="text-right">Requests/día</TableHead>
              <TableHead className="text-right">Latencia</TableHead>
              <TableHead className="text-right">Costo/mes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell>
                  <StatusLabel meta={projectStatusMeta[p.status]} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {p.status === "provisioning" ? "—" : `${p.metrics.uptime.toFixed(2)}%`}
                </TableCell>
                <TableCell className="text-right tabular-nums">{number.format(p.metrics.requestsPerDay)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {p.status === "offline" || p.status === "provisioning" ? "—" : `${p.metrics.avgResponseMs} ms`}
                </TableCell>
                <TableCell className="text-right tabular-nums">{currency.format(p.metrics.monthlyCost)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Alerts({ projects }: { projects: Project[] }) {
  const issues = projects.flatMap((project) =>
    project.accounts
      .filter((account) => account.status === "error" || account.status === "expiring")
      .map((account) => ({ project, account })),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cuentas que requieren atención</CardTitle>
        <CardDescription>Integraciones con error o por vencer.</CardDescription>
      </CardHeader>
      <CardContent>
        {issues.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todas las cuentas están conectadas.</p>
        ) : (
          <ul className="space-y-3">
            {issues.map(({ project, account }) => (
              <li
                key={`${project.id}-${account.provider}-${account.label}`}
                className="rounded-lg border p-3 text-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{project.name}</span>
                  <StatusLabel meta={accountStatusMeta[account.status]} />
                </div>
                <p className="mt-1 text-muted-foreground">
                  {providerMeta[account.provider].name} · {account.label}
                </p>
              </li>
            ))}
          </ul>
        )}
        <Link to="/projects" className="mt-4 inline-block text-sm font-medium hover:underline">
          Ver todos los proyectos →
        </Link>
      </CardContent>
    </Card>
  );
}
