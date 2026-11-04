import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Code2, FileUp, Monitor, Smartphone, Tablet, Upload } from "lucide-react";
import { ColumnChart } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api-client";
import { errorText, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { SAMPLE_HTML, sitesApi, useSitesConfig, useSitesRefresh, useSiteStats, type Site } from "./api";

const label = "text-caps-label mb-2 block";
const field = "h-11 rounded-[10px] border-border bg-muted";

/** Nombre del enlace con el sufijo del dominio y la disponibilidad en vivo. */
function NameField({ value, onChange, exceptId, onValid }: { value: string; onChange: (v: string) => void; exceptId?: string; onValid: (ok: boolean) => void }) {
  const suffix = useSitesConfig().data?.sitesSuffix ?? ".sites.whatever.tech";
  const [status, setStatus] = useState<{ name: string; available: boolean; reason?: string } | null>(null);
  useEffect(() => {
    const name = value.trim().toLowerCase();
    if (!name) return;
    const t = setTimeout(() => {
      sitesApi
        .nameAvailability(name, exceptId)
        .then((r) => setStatus({ name, ...r }))
        .catch(() => setStatus({ name, available: false, reason: "No se pudo comprobar el nombre." }));
    }, 350);
    return () => clearTimeout(t);
  }, [value, exceptId]);
  const current = status?.name === value.trim().toLowerCase() ? status : null;
  useEffect(() => onValid(Boolean(value.trim() && current?.available)), [value, current, onValid]);
  return (
    <div>
      <label htmlFor="site-name" className={label}>
        Nombre del enlace
      </label>
      <div className="flex h-11 overflow-hidden rounded-[10px] border border-border bg-muted focus-within:border-foreground">
        <input id="site-name" className="min-w-0 flex-1 bg-transparent px-3 text-sm outline-none" value={value} placeholder="nombre-del-enlace" onChange={(e) => onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} />
        <span className="flex items-center bg-primary px-3.5 text-sm font-semibold whitespace-nowrap text-primary-foreground">{suffix}</span>
      </div>
      {value.trim() && current && (
        <p role="status" className={cn("mt-1.5 text-xs", current.available ? "text-[var(--chip-green-fg)]" : "text-destructive")}>
          {current.available ? "Disponible" : current.reason}
        </p>
      )}
    </div>
  );
}

/** «Subir archivo» o «Pegar código» (prototipo `.ptabs`) y la zona para soltar el archivo. */
function SourcePicker({ onChange }: { onChange: (source: { file: File } | { html: string } | null) => void }) {
  const [mode, setMode] = useState<"file" | "code">("file");
  const [file, setFile] = useState<File | null>(null);
  const [html, setHtml] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pick = (f: File | null | undefined) => {
    if (!f) return;
    setFile(f);
    onChange({ file: f });
  };
  const tab = (m: "file" | "code", text: string, Icon: typeof Upload) => (
    <button type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); onChange(m === "file" ? (file ? { file } : null) : html.trim() ? { html } : null); }} className={cn("inline-flex h-11 flex-1 items-center justify-center gap-2 font-semibold transition-colors", mode === m ? "bg-accent-soft text-accent-text" : "text-muted-foreground hover:text-foreground")}>
      <Icon className="size-4" aria-hidden /> {text}
    </button>
  );
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Origen de la propuesta" className="flex overflow-hidden rounded-xl border border-border [&>*+*]:border-l [&>*+*]:border-border">
        {tab("file", "Subir archivo", Upload)}
        {tab("code", "Pegar código", Code2)}
      </div>
      {mode === "file" ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            pick(e.dataTransfer.files[0]);
          }}
          className={cn("flex flex-col items-center gap-3.5 rounded-[14px] border-2 border-dashed px-5 py-8 text-center text-muted-foreground transition-colors", over ? "border-primary bg-accent-soft" : "border-line-strong")}
        >
          <FileUp className="size-6" aria-hidden />
          <p>{file ? <b className="text-foreground">{file.name}</b> : "Arrastra y suelta un archivo .html o .zip aquí"}</p>
          <input ref={input} type="file" accept=".html,.htm,.zip,text/html,application/zip" className="hidden" aria-label="Archivo de la propuesta" onChange={(e) => pick(e.target.files?.[0])} />
          <Button size="lg" onClick={() => input.current?.click()}>
            {file ? "Cambiar archivo" : "Subir archivo"}
          </Button>
          <p className="text-sm">
            o usa un{" "}
            <button
              type="button"
              className="font-semibold text-foreground underline underline-offset-2"
              onClick={() => {
                setMode("code");
                setHtml(SAMPLE_HTML);
                onChange({ html: SAMPLE_HTML });
              }}
            >
              ejemplo
            </button>
          </p>
        </div>
      ) : (
        <Textarea
          aria-label="Código HTML"
          rows={10}
          value={html}
          placeholder="<!doctype html>…"
          className="rounded-[10px] bg-muted font-mono text-xs dark:bg-muted"
          onChange={(e) => {
            setHtml(e.target.value);
            onChange(e.target.value.trim() ? { html: e.target.value } : null);
          }}
        />
      )}
    </div>
  );
}

const formOf = (source: { file: File } | { html: string }, extra: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  if ("file" in source) form.append("file", source.file, source.file.name);
  else form.append("html", source.html);
  return form;
};

/** Subir propuesta: nombre del enlace, archivo o código, y el lead (fijo si se abre desde el lead). */
export function UploadSiteDialog({ open, onClose, lead, projectId, suggestedName = "" }: { open: boolean; onClose: () => void; lead?: { id: string; name: string } | null; projectId?: string; suggestedName?: string }) {
  const [name, setName] = useState(suggestedName);
  const [valid, setValid] = useState(false);
  const [source, setSource] = useState<{ file: File } | { html: string } | null>(null);
  const [leadId, setLeadId] = useState<string | null>(lead?.id ?? null);
  const [busy, setBusy] = useState(false);
  const refresh = useSitesRefresh();
  const leads = useQuery({
    queryKey: ["sites", "lead-options"],
    enabled: open && !lead,
    queryFn: () => apiFetch<{ rows: { id: string; title: string }[] }>("/api/sales/leads?page=1&pageSize=100&sort=company&dir=asc"),
  });
  const publish = async () => {
    if (!source || !valid) return;
    setBusy(true);
    try {
      const { site } = await sitesApi.create(formOf(source, { name: name.trim() }), { ...(leadId ? { leadId } : {}), ...(projectId ? { projectId } : {}) });
      await refresh();
      toast.success(`Publicada en ${site.url.replace(/^https?:\/\//, "")}`);
      onClose();
    } catch (err) {
      toast.error("No se pudo publicar la propuesta.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Subir propuesta"
      className="max-w-[620px] rounded-2xl"
      dirty={Boolean(source)}
      footer={
        <>
          <Button variant="outline" size="lg" onClick={onClose}>
            Cancelar
          </Button>
          <Button size="lg" disabled={!source || !valid} loading={busy} onClick={() => void publish()}>
            Publicar
          </Button>
        </>
      }
    >
      <div className="space-y-5 py-1">
        <NameField value={name} onChange={setName} onValid={setValid} />
        <SourcePicker onChange={setSource} />
        <div>
          <p className={label}>Lead relacionado (opcional)</p>
          {lead ? (
            <p className="flex h-11 items-center rounded-[10px] bg-muted px-3 text-sm font-semibold">{lead.name}</p>
          ) : (
            <Select label="Lead relacionado" value={leadId} emptyLabel="Sin lead" searchable options={(leads.data?.rows ?? []).map((l) => ({ value: l.id, label: l.title }))} onValueChange={setLeadId} />
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Actualizar: reemplaza los archivos del sitio (el enlace no cambia). */
export function UpdateSiteDialog({ site, onClose }: { site: Site | null; onClose: () => void }) {
  const [source, setSource] = useState<{ file: File } | { html: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useSitesRefresh();
  const save = async () => {
    if (!site || !source) return;
    setBusy(true);
    try {
      await sitesApi.replaceFiles(site.id, formOf(source, { mode: "replace" }));
      await refresh();
      toast.success("Propuesta actualizada", { description: "El enlace es el mismo; los cambios ya se ven." });
      onClose();
    } catch (err) {
      toast.error("No se pudo actualizar.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={Boolean(site)}
      onOpenChange={(o) => !o && onClose()}
      title="Actualizar propuesta"
      description={site?.url.replace(/^https?:\/\//, "")}
      className="max-w-[620px] rounded-2xl"
      dirty={Boolean(source)}
      footer={
        <>
          <Button variant="outline" size="lg" onClick={onClose}>
            Cancelar
          </Button>
          <Button size="lg" disabled={!source} loading={busy} onClick={() => void save()}>
            Actualizar
          </Button>
        </>
      }
    >
      <div className="py-1">{site && <SourcePicker key={site.id} onChange={setSource} />}</div>
    </Modal>
  );
}

/** Personalizar: subdominio, contraseña y página de inicio. */
export function CustomizeSiteDialog({ site, onClose }: { site: Site | null; onClose: () => void }) {
  const [name, setName] = useState(site?.name ?? "");
  const [nameOk, setNameOk] = useState(true);
  const [mode, setMode] = useState<"public" | "password">(site?.access.mode ?? "public");
  const [password, setPassword] = useState("");
  const [homepage, setHomepage] = useState(site?.homepage ?? "");
  const [busy, setBusy] = useState(false);
  const refresh = useSitesRefresh();
  if (!site) return null;
  const html = site.files.filter((f) => /\.html?$/i.test(f.path));
  const renamed = name.trim() !== site.name;
  const needsPassword = mode === "password" && site.access.mode !== "password" && password.length < 4;
  const save = async () => {
    setBusy(true);
    try {
      await sitesApi.update(site.id, {
        ...(renamed ? { name: name.trim() } : {}),
        ...(homepage !== site.homepage ? { homepage } : {}),
        ...(mode !== site.access.mode || password ? { access: mode === "public" ? { mode } : { mode, ...(password ? { password } : {}) } } : {}),
      });
      await refresh();
      toast.success("Cambios guardados", { description: renamed ? "El enlace nuevo tarda unos segundos en publicarse." : undefined });
      onClose();
    } catch (err) {
      toast.error("No se pudo guardar.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Personalizar"
      description={site.url.replace(/^https?:\/\//, "")}
      className="max-w-[620px] rounded-2xl"
      footer={
        <>
          <Button variant="outline" size="lg" onClick={onClose}>
            Cancelar
          </Button>
          <Button size="lg" disabled={(renamed && !nameOk) || needsPassword} loading={busy} onClick={() => void save()}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-5 py-1">
        <NameField value={name} onChange={setName} exceptId={site.id} onValid={(ok) => setNameOk(ok || !renamed)} />
        <div>
          <p className={label}>Acceso</p>
          <div role="radiogroup" aria-label="Acceso" className="inline-flex rounded-[10px] bg-muted p-[3px]">
            {(["public", "password"] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cn("h-9 rounded-lg px-3.5 text-sm", mode === m ? "bg-card font-semibold shadow-sm" : "font-medium text-muted-foreground")}>
                {m === "public" ? "Público" : "Con contraseña"}
              </button>
            ))}
          </div>
          {mode === "password" && (
            <Input aria-label="Contraseña del sitio" type="password" className={cn(field, "mt-3")} value={password} placeholder={site.access.mode === "password" ? "Deja vacío para mantener la actual" : "Mínimo 4 caracteres"} onChange={(e) => setPassword(e.target.value)} />
          )}
        </div>
        {html.length > 1 && (
          <div>
            <p className={label}>Página de inicio</p>
            <Select label="Página de inicio" value={homepage} options={html.map((f) => ({ value: f.path, label: f.path }))} onValueChange={(v) => v && setHomepage(v)} />
          </div>
        )}
      </div>
    </Modal>
  );
}

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 60) return m <= 1 ? "hace un momento" : `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} ${h === 1 ? "hora" : "horas"}`;
  const d = Math.round(h / 24);
  return `hace ${d} ${d === 1 ? "día" : "días"}`;
};
const DEVICE = { mobile: Smartphone, tablet: Tablet, desktop: Monitor };
const AV = ["#5b5bd6", "#8b5cf6", "#0e9ab5", "#16a34a", "#e2445c", "#e0a50f"];

/** Estadísticas: personas, visitas y páginas vistas del periodo, por día, y el registro de visitas. */
export function SiteStatsDialog({ site, onClose }: { site: Site | null; onClose: () => void }) {
  const [days, setDays] = useState(30);
  const { data, isLoading, error } = useSiteStats(site?.id ?? null, days);
  const short = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString("es-PE", { day: "numeric", month: "short" }).replace(".", "");
  // Número de cada visitante en orden de llegada (el más antiguo es 1), y cuántas veces volvió.
  const order = new Map<string, number>();
  const seen = new Map<string, number>();
  const visits = data?.log ?? [];
  [...visits].reverse().forEach((v) => !order.has(v.visitor) && order.set(v.visitor, order.size + 1));
  const nth = [...visits].reverse().map((v) => {
    const n = (seen.get(v.visitor) ?? 0) + 1;
    seen.set(v.visitor, n);
    return n;
  }).reverse();
  return (
    <Modal open={Boolean(site)} onOpenChange={(o) => !o && onClose()} title="Estadísticas" description={site && `${site.url.replace(/^https?:\/\//, "")} · visitas de personas reales`} className="max-w-[880px] rounded-2xl">
      <div className="space-y-5 py-1">
        <div className="flex justify-end">
          <div role="tablist" aria-label="Periodo" className="inline-flex rounded-full border border-border p-1">
            {[7, 30, 90].map((d) => (
              <button key={d} role="tab" type="button" aria-selected={days === d} onClick={() => setDays(d)} className={cn("h-9 rounded-full px-4 text-sm", days === d ? "bg-accent-soft font-semibold text-accent-text" : "font-medium")}>
                {d}d
              </button>
            ))}
          </div>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(error, "No se pudieron cargar las estadísticas.")}
          </p>
        ) : isLoading || !data ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                ["Personas únicas", data.period.people, `Histórico: ${data.allTime.people} · dispositivos distintos que lo abrieron`],
                ["Visitas", data.period.visits, "Veces que lo abrieron (recargas seguidas cuentan una)"],
                ["Páginas vistas", data.period.views, `Histórico: ${data.allTime.views} · cada página cargada, incluidas las recargas`],
              ].map(([t, v, s], i) => (
                <div key={t as string} className={cn("flex flex-col gap-3.5 rounded-[14px] border p-[18px]", i === 1 ? "border-primary bg-accent-soft" : "border-border bg-card")}>
                  <p className="text-sm">{t}</p>
                  <p className="text-[28px] leading-tight font-bold tabular-nums">{v}</p>
                  <p className="text-xs text-muted-foreground">{s}</p>
                </div>
              ))}
            </div>
            <ColumnChart columns={data.series.map((d) => ({ label: short(d.day), values: { visits: d.visits } }))} series={[{ key: "visits", label: "Visitas", color: "var(--viz-5)" }]} format={(v) => String(Math.round(v))} height={200} labelEvery={days === 7 ? 1 : days === 30 ? 4 : 12} totals={days === 7} />
            <div>
              <h3 className="mb-3 text-lg font-bold">Registro de visitas</h3>
              {!visits.length ? (
                <p className="rounded-[14px] border border-border p-8 text-center text-sm text-muted-foreground">Aún no hay visitas en este periodo.</p>
              ) : (
                <ol className="overflow-hidden rounded-[14px] border border-border">
                  {visits.map((v, i) => {
                    const n = order.get(v.visitor)!;
                    const Icon = DEVICE[v.device];
                    const minutes = Math.round((Date.parse(v.end) - Date.parse(v.start)) / 60_000);
                    return (
                      <li key={`${v.visitor}-${v.start}`} className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-0">
                        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white" style={{ background: AV[n % AV.length] }}>
                          {n}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm">
                            <b>Visitante {n}</b> <span className="text-muted-foreground">{nth[i]}.ª visita{nth[i] > 1 ? " · volvió" : ""}</span>
                          </p>
                          <p className="flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                            <Icon className="size-3.5 shrink-0" aria-hidden /> {v.os} · {v.browser} · desde {v.referrer ?? "Directo"}
                          </p>
                        </div>
                        <div className="shrink-0 text-right text-sm">
                          <p className="font-semibold">{ago(v.start)}</p>
                          <p className="text-muted-foreground">
                            {v.pages} {v.pages === 1 ? "página" : "páginas"}
                            {minutes > 0 ? ` · ${minutes} min` : ""}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
