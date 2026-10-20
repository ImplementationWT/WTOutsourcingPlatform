import { useState } from "react";
import { AlertTriangle, Plus, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import NewServerForm from "./NewServerForm";
import ServerCard from "./ServerCard";
import { useServers } from "./api";

type Tab = "servers";
const TABS: [Tab, string, typeof Server][] = [["servers", "Servidores", Server]];

/** Integraciones de la plataforma. Servidores: donde se despliegan los proyectos (se elige al crearlos). */
export default function IntegrationsPage() {
  const [tab, setTab] = useState<Tab>("servers");
  const [adding, setAdding] = useState(false);
  const { data, isLoading, error } = useServers();

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Integraciones</h1>
        <p className="mt-2 text-muted-foreground">Conexiones de la plataforma que luego se eligen en cada proyecto.</p>
      </div>

      <div className="flex items-center gap-1 border-b border-foreground/10" role="tablist">
        {TABS.map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors",
              tab === id ? "border-violet-400 font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === "servers" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="max-w-2xl text-sm text-muted-foreground">
              Cada servidor tiene su propio dominio de apps. El servidor de un proyecto se elige al crearlo y no cambia nunca. Launchpad entra
              con un usuario sin privilegios (<code className="font-mono">provisioner</code>) que solo puede ejecutar los scripts de la
              plataforma.
            </p>
            {data?.available && !adding && (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus />
                Añadir servidor
              </Button>
            )}
          </div>

          {data && !data.available && (
            <Card>
              <CardContent className="flex items-start gap-3 text-sm">
                <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-400" />
                <p>
                  Para añadir servidores falta la clave que cifra sus claves SSH en la plataforma (
                  <code className="font-mono">SERVER_KEYS_ENCRYPTION_KEY_SECRET_REF</code>). Se crea sola en el próximo despliegue de
                  Launchpad.
                </p>
              </CardContent>
            </Card>
          )}

          {adding && <NewServerForm onCreated={() => setAdding(false)} onCancel={() => setAdding(false)} />}

          {isLoading ? (
            <Skeleton className="h-40 rounded-xl" />
          ) : error ? (
            <p role="alert" className="text-sm text-red-300">
              {error instanceof Error ? error.message : "No se pudieron cargar los servidores."}
            </p>
          ) : data?.servers.length ? (
            data.servers.map((server) => <ServerCard key={server.id} server={server} ghcrOrg={data.ghcrOrg} />)
          ) : (
            <p className="text-sm text-muted-foreground">Aún no hay servidores.</p>
          )}
        </div>
      )}
    </section>
  );
}
