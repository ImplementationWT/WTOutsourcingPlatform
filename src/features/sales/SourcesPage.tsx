import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { selectClass } from "@/features/admin/TeamAssignCard";
import { Empty, ErrorLine, Loading } from "@/features/activity/ActivityPanels";
import { dateText } from "@/features/activity/api";
import { cn } from "@/lib/utils";
import {
  createSource,
  LEAD_FIELD_LABELS,
  LEAD_FIELDS,
  receivesByEndpoint,
  rotateSourceKey,
  salesKeys,
  SOURCE_KIND_LABELS,
  SOURCE_KINDS,
  updateSource,
  useSources,
  type LeadField,
  type LeadSource,
  type SourceKind,
} from "./api";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const endpointOf = (source: LeadSource) => `${window.location.origin}${source.ingestPath}`;

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="xs"
      variant="outline"
      aria-label={label}
      onClick={async () => {
        await navigator.clipboard?.writeText(value).catch(() => undefined);
        setCopied(true);
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copiado" : "Copiar"}
    </Button>
  );
}

/** Clave recién creada o rotada: solo vive en este componente y no se vuelve a mostrar. */
function KeyOnce({ source, ingestKey, onClose }: { source: LeadSource; ingestKey: string; onClose: () => void }) {
  const example = `curl -X POST ${endpointOf(source)} \\\n  -H "X-Ingest-Key: ${ingestKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"name":"Ana Pérez","email":"ana@empresa.pe","company":"Empresa SAC"}'`;
  return (
    <div role="status" className="space-y-2 rounded-md border border-amber-400/30 bg-amber-500/10 p-3 text-sm">
      <p className="font-medium">Clave de ingesta de {source.name}</p>
      <p className="text-xs text-muted-foreground">Cópiala ahora: no se vuelve a mostrar. Si se pierde, rota la clave.</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded border border-foreground/15 bg-foreground/5 px-2 py-1 font-mono break-all">{ingestKey}</code>
        <CopyButton value={ingestKey} label="Copiar clave" />
      </div>
      <p className="text-xs text-muted-foreground">Envía cada lead con la clave en la cabecera X-Ingest-Key (o Authorization: Bearer). JSON o formulario; cualquier formato de campos.</p>
      <pre className="overflow-auto rounded border border-foreground/10 bg-foreground/[0.04] p-2 text-xs">{example}</pre>
      <Button size="xs" variant="ghost" onClick={onClose}>
        Ya la guardé
      </Button>
    </div>
  );
}

/** Mapeo: qué campo del envío llena cada campo del lead. Sin mapeo, se adivinan los habituales. */
function MappingEditor({ source, onSaved }: { source: LeadSource; onSaved: () => Promise<void> }) {
  const [rows, setRows] = useState(source.mapping);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = JSON.stringify(rows) !== JSON.stringify(source.mapping);
  const listId = `keys-${source.id}`;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await updateSource(source.id, { mapping: rows.filter((r) => r.from.trim()).map((r) => ({ from: r.from.trim(), to: r.to })) });
      await onSaved();
    } catch (err) {
      setError(message(err, "No se pudo guardar el mapeo."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Mapeo de campos</p>
      <p className="text-xs text-muted-foreground">
        Sin mapeo se reconocen solos los nombres habituales (email, correo, nombre, teléfono, empresa…). Los campos anidados se escriben con puntos, p. ej. <code>contact.email</code>.
      </p>
      <datalist id={listId}>
        {source.sampleKeys.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      {rows.map((row, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Campo del envío"
            list={listId}
            className="max-w-xs"
            value={row.from}
            onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))}
            placeholder="campo del envío"
          />
          <span className="text-muted-foreground">→</span>
          <select aria-label="Campo del lead" className={selectClass} value={row.to} onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? { ...x, to: e.target.value as LeadField } : x)))}>
            {LEAD_FIELDS.map((f) => (
              <option key={f} value={f}>
                {LEAD_FIELD_LABELS[f]}
              </option>
            ))}
          </select>
          <Button size="icon-xs" variant="ghost" aria-label="Quitar fila" onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" onClick={() => setRows((r) => [...r, { from: "", to: "email" }])}>
          <Plus />
          Agregar campo
        </Button>
        {changed && (
          <Button size="xs" disabled={busy} onClick={() => void save()}>
            {busy && <Loader2 className="animate-spin" />}
            Guardar mapeo
          </Button>
        )}
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

function SourceCard({ source }: { source: LeadSource }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: salesKeys.sources });
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endpoint = receivesByEndpoint(source.kind);

  async function run(kind: string, fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err, "No se pudo completar la acción."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{source.name}</CardTitle>
          <Badge variant="outline">{SOURCE_KIND_LABELS[source.kind]}</Badge>
          {!source.active && <Badge variant="secondary">Desactivado</Badge>}
        </div>
        <CardDescription>
          {source.received} lead{source.received === 1 ? "" : "s"} recibido{source.received === 1 ? "" : "s"}
          {source.lastReceivedAt ? ` · el último ${dateText(source.lastReceivedAt)}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {endpoint && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Endpoint</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded border border-foreground/15 bg-foreground/5 px-2 py-1 font-mono text-xs break-all">{endpointOf(source)}</code>
              <CopyButton value={endpointOf(source)} label={`Copiar endpoint de ${source.name}`} />
            </div>
            <p className="text-xs text-muted-foreground">Clave {source.keyHint ? `terminada en …${source.keyHint}` : "sin generar"}.</p>
          </div>
        )}
        {key && <KeyOnce source={source} ingestKey={key} onClose={() => setKey(null)} />}
        <div className="flex flex-wrap gap-2">
          {endpoint && (
            <Button
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                if (!window.confirm(`¿Rotar la clave de ${source.name}? La actual deja de funcionar en el acto.`)) return;
                void run("rotate", async () => {
                  setKey((await rotateSourceKey(source.id)).ingestKey);
                  await refresh();
                });
              }}
            >
              {busy === "rotate" ? <Loader2 className="animate-spin" /> : <KeyRound />}
              Rotar clave
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            disabled={busy !== null}
            onClick={() =>
              run("active", async () => {
                await updateSource(source.id, { active: !source.active });
                await refresh();
              })
            }
          >
            {source.active ? "Desactivar" : "Activar"}
          </Button>
        </div>
        <ErrorLine error={error} />
        {endpoint && <MappingEditor key={JSON.stringify(source.mapping)} source={source} onSaved={async () => void (await refresh())} />}
      </CardContent>
    </Card>
  );
}

function NewSourceForm() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SourceKind>("webhook");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ source: LeadSource; ingestKey: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createSource({ name: name.trim(), kind });
      if (result.ingestKey) setCreated({ source: result.source, ingestKey: result.ingestKey });
      setName("");
      await queryClient.invalidateQueries({ queryKey: salesKeys.sources });
    } catch (err) {
      setError(message(err, "No se pudo crear el source."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nuevo source</CardTitle>
        <CardDescription>Cada source (web, ads, formularios, Zapier…) tiene su endpoint y su clave. Manda los datos como los tenga: no hace falta un formato fijo.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="src-name">Nombre</Label>
            <Input id="src-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Meta Ads" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="src-kind">Tipo</Label>
            <select id="src-kind" className={cn(selectClass, "w-full")} value={kind} onChange={(e) => setKind(e.target.value as SourceKind)}>
              {SOURCE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {SOURCE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={name.trim().length < 2 || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            Crear source
          </Button>
        </form>
        <ErrorLine error={error} />
        {created && <KeyOnce source={created.source} ingestKey={created.ingestKey} onClose={() => setCreated(null)} />}
      </CardContent>
    </Card>
  );
}

export default function SourcesPage() {
  const { data: sources, isLoading, error } = useSources();
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Sources de leads</h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">De dónde llegan los leads y cómo se leen sus datos.</p>
      </div>
      <NewSourceForm />
      <ErrorLine error={error ? message(error, "No se pudieron cargar los sources.") : null} />
      {isLoading ? <Loading /> : !sources?.length ? <Empty>Aún no hay sources.</Empty> : sources.map((s) => <SourceCard key={s.id} source={s} />)}
    </div>
  );
}
