import { useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { CommsTab } from "@/features/communications/CommsList";
import { useComms } from "@/features/communications/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, FileText, Plus, X } from "lucide-react";
import { useCrumbs } from "@/components/layout/crumbs";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { EditableText } from "@/components/ui/editable";
import { Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/dialog";
import { Flag } from "@/components/ui/flag";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { activityKeys, createUpdate, dateText, updatesQuery } from "@/features/activity/api";
import { coreKeys, createContact, useContactOptions } from "@/features/core/api";
import { apiFetch } from "@/lib/api-client";
import { COUNTRIES, countryByName, joinPhone, PHONE_PREFIXES, splitPhone } from "@/lib/countries";
import { formatDate } from "@/lib/format";
import { errorText, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  LEAD_FUNNEL_LABELS,
  LEAD_STATUS_LABELS,
  PIPELINE_LEAD_STATUSES,
  LEAD_TEMPERATURE_LABELS,
  LEAD_TEMPERATURES,
  leadBase,
  salesKeys,
  updateLead,
  useLead,
  useOwners,
  type LeadDetail,
  type LeadInput,
  type LeadStatus,
  type LeadTemperature,
} from "./api";
import { LeadStatusBadge } from "./SalesBadges";
import { LeadActivities } from "./LeadActivities";
import { MeetingsBoard } from "@/features/activity/MeetingsBoard";
import { useSession } from "@/features/auth/auth";
import { slugify, useSites, useSitesConfig } from "@/features/sites/api";
import { UploadSiteDialog } from "@/features/sites/SiteDialogs";
import { SitesList } from "@/features/sites/SitesList";


function useRefresh(id: string) {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: salesKeys.lead(id) }),
      queryClient.invalidateQueries({ queryKey: ["sales", "leads"] }),
      queryClient.invalidateQueries({ queryKey: activityKeys.updates(leadBase(id)) }),
    ]);
  };
}

/** Lo que había antes de un cambio, para «Deshacer». */
function previousOf(lead: LeadDetail, patch: Partial<LeadInput>): Partial<LeadInput> {
  const before: Partial<LeadInput> = {};
  const current: Record<keyof LeadInput, unknown> = {
    name: lead.name ?? "",
    company: lead.company,
    contactName: lead.contactName,
    email: lead.email,
    phone: lead.phone,
    country: lead.country,
    corporateEmail: lead.corporateEmail,
    website: lead.website,
    notes: lead.notes,
    status: lead.status,
    setterUserId: lead.setter?.id ?? null,
    closerUserId: lead.closer?.id ?? null,
    funnel: lead.funnel,
    temperature: lead.temperature,
    submittedAt: lead.submittedAt,
    meetingAt: lead.meetingAt,
    proposalUrl: lead.proposalUrl,
    contactId: lead.contactId,
    source: lead.source,
    lostReason: lead.lostReason,
  };
  for (const key of Object.keys(patch) as (keyof LeadInput)[]) (before as Record<string, unknown>)[key] = current[key];
  return before;
}

/** Guarda un cambio del lead con aviso «Guardado» y «Deshacer». */
function useSaveLead(lead: LeadDetail) {
  const refresh = useRefresh(lead.id);
  return async (patch: Partial<LeadInput>, what = "Cambio guardado") => {
    const before = previousOf(lead, patch);
    await updateLead(lead.id, patch);
    await refresh();
    toast.success(what, {
      undo: async () => {
        await updateLead(lead.id, before);
        await refresh();
      },
    });
  };
}

/** Campo con etiqueta en mayúsculas sobre el control (formularios del detalle). */
function Field({ label, htmlFor, children, className }: { label: string; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="text-caps-label block">
        {label}
      </label>
      {children}
    </div>
  );
}

/** Texto editable con aspecto de campo (borde y fondo), para los formularios del detalle. */
const boxed = "h-control border-input bg-card px-3 hover:border-foreground/20 dark:bg-white/[0.03]";

type LeadData = NonNullable<ReturnType<typeof useLead>["data"]>;

/** Con sangría si es JSON válido; si el servidor lo recortó por tamaño, tal cual. */
function prettyJson(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** «answers.0.problem» → «Problem»: la pregunta legible si el source solo manda la clave. */
const question = (key: string) => {
  const last = key.split(".").filter((k) => !/^\d+$/.test(k)).pop() ?? key;
  const text = last.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** Respuestas del formulario (prototipo): pregunta y respuesta tal cual llegaron del source. */
function FormAnswers({ lead }: { lead: LeadDetail }) {
  const [showRaw, setShowRaw] = useState(false);
  if (!lead.fields.length && !lead.rawJson) {
    return <p className="rounded-xl border border-dashed border-line-strong px-6 py-6 text-center text-sm text-muted-foreground">Este lead se creó manualmente: no hay un formulario asociado.</p>;
  }
  return (
    <div className="space-y-3">
      {lead.submittedAt && <p className="text-sm text-muted-foreground">Enviado el {formatDate(lead.submittedAt)}</p>}
      <dl className="overflow-hidden rounded-xl border border-border">
        {lead.fields.map((f) => (
          <div key={f.key} className="border-t border-border px-4 py-3 first:border-0">
            <dt className="text-[12.5px] text-muted-foreground" title={f.key}>
              {/[?¿\s]/.test(f.key) ? f.key : question(f.key)}
            </dt>
            <dd className="mt-1 font-semibold break-words">{f.value}</dd>
          </div>
        ))}
      </dl>
      {lead.rawJson && (
        <div>
          <Button size="xs" variant="ghost" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? "Ocultar" : "Ver"} el envío original
          </Button>
          {showRaw && <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-border bg-muted p-3 text-xs">{prettyJson(lead.rawJson)}</pre>}
        </div>
      )}
    </div>
  );
}

/** Updates del lead (columna derecha del prototipo): notas internas, la más reciente arriba. */
function UpdatesColumn({ base, canWrite, onPosted }: { base: string; canWrite: boolean; onPosted: () => Promise<unknown> }) {
  const queryClient = useQueryClient();
  // Solo las notas que escribe el equipo: los registros automáticos de acciones no se muestran.
  const { data: all, isLoading } = useQuery(updatesQuery(base));
  const updates = all?.filter((u) => u.kind === "manual");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const publish = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await createUpdate(base, body.trim());
      setBody("");
      await queryClient.invalidateQueries({ queryKey: activityKeys.updates(base) });
      await onPosted();
    } catch (err) {
      toast.error("No se pudo publicar el update.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Updates" className="flex flex-col rounded-[14px] border border-border bg-card lg:min-h-0">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-lg font-bold">Updates</h2>
        <p className="text-xs text-muted-foreground">Notas internas sobre este lead</p>
      </div>
      {canWrite && (
        <div className="border-b border-border p-4">
          <Textarea
            aria-label="Nuevo update"
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            // Enter publica; Shift+Enter hace un salto de línea.
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void publish();
              }
            }}
            placeholder="Escribe un update…"
            className="rounded-[10px] bg-muted dark:bg-muted"
          />
        </div>
      )}
      <div className="flex-1 p-4 lg:min-h-0 lg:overflow-y-auto">
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : !updates?.length ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <b>Aún no hay updates</b>
            <p className="text-sm text-muted-foreground">Publica el primero: llamadas, acuerdos o próximos pasos.</p>
          </div>
        ) : (
          <ol className="space-y-3">
            {updates.map((u) => (
              <li key={u.id} className="rounded-xl border border-border p-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{u.authorName}</span>
                  <span className="ml-auto">{dateText(u.createdAt)}</span>
                </div>
                <p className="mt-1 text-sm whitespace-pre-wrap">{u.body}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
      {canWrite && (
        <div className="flex justify-end border-t border-border p-4">
          <Button size="lg" disabled={!body.trim()} loading={busy} onClick={() => void publish()}>
            Publicar
          </Button>
        </div>
      )}
    </section>
  );
}

/** Sección de la pestaña Información: título y cuadrícula de 3 columnas (prototipo). */
function InfoSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-bold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
const grid3 = "grid gap-x-4 gap-y-4 sm:grid-cols-2 lg:grid-cols-3";

/** Encabezado de una pestaña con su acción principal («+ Nueva actividad»…). */
function TabHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-lg font-bold">{title}</h3>
      {action}
    </div>
  );
}

/** Valor de solo lectura con aspecto de campo (Funnel, Submission). */
const ReadField = ({ children }: { children: ReactNode }) => <p className="flex h-11 items-center rounded-[10px] border border-border bg-muted px-3 text-sm">{children}</p>;

/** Correo o teléfono como campo con el botón de copiar dentro (prototipo). */
function CopyField({ kind, value, canWrite, onSave, label = kind === "email" ? "Correo" : "Teléfono" }: { kind: "email" | "phone"; value: string | null; canWrite: boolean; onSave: (v: string | null) => Promise<unknown>; label?: string }) {
  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copiado`);
    } catch {
      toast.error(`No se pudo copiar el ${label.toLowerCase()}.`);
    }
  };
  return (
    <div className="flex h-11 items-center rounded-[10px] border border-border bg-muted pr-1.5">
      <EditableText label={label} type={kind === "email" ? "email" : "tel"} className="h-11 min-w-0 flex-1 border-0 bg-transparent px-3" value={value} placeholder={kind === "email" ? "Agregar correo" : "Agregar teléfono"} disabled={!canWrite} onSave={onSave} />
      {value && (
        <button type="button" aria-label={`Copiar ${label}`} title={`Copiar ${label}`} onClick={() => void copy()} className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card hover:text-foreground">
          <Copy className="size-4" />
        </button>
      )}
    </div>
  );
}

const NEW = "__new";
const dialogField = "h-11 rounded-[10px] border-border bg-muted dark:bg-muted";

/** «+ Agregar empresa nueva»: la empresa es un texto del lead (como en el resto de la plataforma). */
function NewCompanyDialog({ onClose, onSave }: { onClose: () => void; onSave: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    await onSave(name.trim());
    setBusy(false);
    onClose();
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Agregar empresa nueva" className="max-w-md rounded-2xl" footer={<><Button variant="outline" size="lg" onClick={onClose}>Cancelar</Button><Button size="lg" disabled={!name.trim()} loading={busy} onClick={() => void save()}>Agregar empresa</Button></>}>
      <form onSubmit={(e) => void save(e)} className="space-y-2 py-1">
        <label htmlFor="new-company" className="text-caps-label block">
          Nombre de la empresa
        </label>
        <Input id="new-company" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Manpersa SAC" className={dialogField} />
      </form>
    </Modal>
  );
}

/** «+ Agregar contacto nuevo»: crea el contacto (queda en Contactos) y lo enlaza al lead. */
function NewContactDialog({ company, onClose, onSave }: { company: string; onClose: () => void; onSave: (c: { id: string; name: string }) => Promise<unknown> }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (form.name.trim().length < 2) return;
    setBusy(true);
    try {
      const { contact } = await createContact({ name: form.name.trim(), emails: form.email.trim() ? [form.email.trim()] : [], phone: form.phone.trim() || null, company: company || null });
      await queryClient.invalidateQueries({ queryKey: coreKeys.contacts });
      await onSave(contact);
      onClose();
    } catch (err) {
      toast.error("No se pudo crear el contacto.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  };
  const field = (k: keyof typeof form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="space-y-2">
      <label htmlFor={`new-contact-${k}`} className="text-caps-label block">
        {label}
      </label>
      <Input id={`new-contact-${k}`} value={form[k]} onChange={set(k)} className={dialogField} {...props} />
    </div>
  );
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Agregar contacto nuevo" description={company ? `De ${company}` : undefined} className="max-w-md rounded-2xl" footer={<><Button variant="outline" size="lg" onClick={onClose}>Cancelar</Button><Button size="lg" disabled={form.name.trim().length < 2} loading={busy} onClick={() => void save()}>Agregar contacto</Button></>}>
      <form onSubmit={(e) => void save(e)} className="space-y-4 py-1">
        {field("name", "Nombre", { autoFocus: true, placeholder: "Francisco Wong" })}
        {field("email", "Correo", { type: "email", placeholder: "nombre@empresa.com" })}
        {field("phone", "Teléfono", { type: "tel" })}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

/** Prefijos con la bandera de su país. */
const PHONE_OPTIONS = PHONE_PREFIXES.map((p) => ({ ...p, icon: <Flag code={p.value.split(":")[0]} /> }));

/**
 * Teléfono en dos casillas: prefijo (lista de países) y número. Se guarda junto («+51 987 654 321»);
 * sin prefijo guardado, se propone el del país del lead.
 */
function PhoneField({ value, country, canWrite, onSave }: { value: string | null; country: string | null; canWrite: boolean; onSave: (v: string | null) => Promise<unknown> }) {
  const saved = splitPhone(value);
  const fallback = countryByName(country)?.dial ?? null;
  const [dial, setDial] = useState<string | null>(saved.dial ?? fallback);
  const current = saved.dial ?? dial;
  // El país del lead decide entre los que comparten prefijo (+1: EE. UU., Canadá…).
  const own = countryByName(country);
  const option = PHONE_PREFIXES.find((p) => p.dial === current && own && p.value.startsWith(`${own.code}:`)) ?? PHONE_PREFIXES.find((p) => p.dial === current);
  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Teléfono copiado");
    } catch {
      toast.error("No se pudo copiar el teléfono.");
    }
  };
  return (
    <div className="flex max-w-[23rem] gap-2">
      <div className="w-28 shrink-0">
        <Select
          label="Prefijo del teléfono"
          value={option?.value ?? null}
          placeholder="+"
          searchable
          options={PHONE_OPTIONS}
          renderValue={(o) =>
            o ? (
              <span className="flex items-center gap-2 tabular-nums">
                <Flag code={o.value.split(":")[0]} />+{o.value.split(":")[1]}
              </span>
            ) : (
              "+"
            )
          }
          disabled={!canWrite}
          onValueChange={(v) => {
            const next = v?.split(":")[1] ?? null;
            setDial(next);
            if (saved.number && next !== saved.dial) void onSave(joinPhone(next, saved.number));
          }}
        />
      </div>
      <div className="flex h-11 min-w-0 flex-1 items-center rounded-[10px] border border-border bg-muted pr-1.5">
        <EditableText label="Número de teléfono" type="tel" className="h-11 min-w-0 flex-1 border-0 bg-transparent px-3" value={saved.number || null} placeholder="987 654 321" disabled={!canWrite} onSave={(v) => onSave(joinPhone(current, v ?? ""))} />
        {value && (
          <button type="button" aria-label="Copiar Teléfono" title="Copiar Teléfono" onClick={() => void copy()} className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card hover:text-foreground">
            <Copy className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Página web: se guarda con https:// si se escribe sin él, y se abre en otra pestaña. */
function WebsiteField({ value, canWrite, onSave }: { value: string | null; canWrite: boolean; onSave: (v: string | null) => Promise<unknown> }) {
  return (
    <div className="flex h-11 items-center rounded-[10px] border border-border bg-muted pr-1.5">
      <EditableText id="lead-website" label="Página web" type="url" className="h-11 min-w-0 flex-1 border-0 bg-transparent px-3" value={value} placeholder="empresa.com" disabled={!canWrite} onSave={(v) => onSave(v ? (/^https?:\/\//i.test(v) ? v : `https://${v}`) : null)} />
      {value && (
        <a href={value} target="_blank" rel="noreferrer" aria-label="Abrir la página web" title="Abrir la página web" className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card hover:text-foreground">
          <ExternalLink className="size-4" />
        </a>
      )}
    </div>
  );
}

/** Empresas conocidas (de los leads y de los clientes de los proyectos) para el selector. */
function useCompanies(enabled: boolean) {
  return useQuery({
    queryKey: ["sales", "company-options"],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const [leads, projects] = await Promise.all([
        apiFetch<{ rows: { company: string }[] }>("/api/sales/leads?page=1&pageSize=100&sort=company&dir=asc"),
        apiFetch<{ rows: { client: { company: string | null } | null }[] }>("/api/ops/projects?page=1&pageSize=100").catch(() => ({ rows: [] })),
      ]);
      return [...new Set([...leads.rows.map((l) => l.company), ...projects.rows.map((p) => p.client?.company ?? "")].map((c) => c.trim()).filter(Boolean))].sort((x, y) => x.localeCompare(y, "es"));
    },
  });
}

function InfoTab({ data, canWrite, persist }: { data: LeadData; canWrite: boolean; persist: (patch: Partial<LeadInput>, what?: string) => Promise<unknown> }) {
  const { lead } = data;
  const owners = useOwners(canWrite).data ?? [];
  const contacts = useContactOptions(canWrite).data ?? [];
  const companies = useCompanies(canWrite).data ?? [];
  const people = owners.map((o) => ({ value: o.id, label: o.name }));
  const companyOptions = [...new Set([lead.company, ...companies].filter(Boolean))].map((c) => ({ value: c, label: c }));
  // El contacto enlazado manda; si no hay, el nombre escrito en el lead.
  const [adding, setAdding] = useState<"company" | "contact" | null>(null);
  const contactOptions = [...contacts.map((c) => ({ value: c.id, label: c.name, description: c.company ?? undefined })), ...(!lead.contactRef && lead.contactName ? [{ value: "__typed", label: lead.contactName }] : [])];
  return (
    <div className="space-y-8">
      <InfoSection title="Datos comerciales">
        <div className={grid3}>
          <Field label="Estado">
            <Select label="Estado del lead" value={lead.status} options={PIPELINE_LEAD_STATUSES.map((st) => ({ value: st, label: LEAD_STATUS_LABELS[st] }))} disabled={!canWrite} onValueChange={(v) => v && v !== lead.status && void persist({ status: v as LeadStatus }, `Estado: ${LEAD_STATUS_LABELS[v as LeadStatus]}`)} />
          </Field>
          <Field label="Temperatura">
            <Select label="Temperatura" value={lead.temperature} emptyLabel="Sin definir" options={LEAD_TEMPERATURES.map((t) => ({ value: t, label: LEAD_TEMPERATURE_LABELS[t] }))} disabled={!canWrite} onValueChange={(v) => void persist({ temperature: v as LeadTemperature | null }, v ? `Temperatura cambiada a ${LEAD_TEMPERATURE_LABELS[v as LeadTemperature]}` : "Temperatura borrada")} />
          </Field>
          <Field label="Funnel">
            <ReadField>{lead.funnel ? LEAD_FUNNEL_LABELS[lead.funnel] : "—"}</ReadField>
          </Field>
          <Field label="Setter">
            <Select label="Setter" value={lead.setter?.id ?? null} emptyLabel="Sin asignar" options={people} disabled={!canWrite} placeholder={lead.setter?.name ?? "Sin asignar"} onValueChange={(v) => void persist({ setterUserId: v }, "Setter actualizado")} />
          </Field>
          <Field label="Closer">
            <Select label="Closer" value={lead.closer?.id ?? null} emptyLabel="Sin asignar" options={people} disabled={!canWrite} placeholder={lead.closer?.name ?? "Sin asignar"} onValueChange={(v) => void persist({ closerUserId: v }, "Closer actualizado")} />
          </Field>
          <Field label="Submission">
            <ReadField>{lead.submittedAt ? formatDate(lead.submittedAt) : "—"}</ReadField>
          </Field>
          <Field label="Reunión" htmlFor="lead-reunion">
            <DatePicker id="lead-reunion" label="Fecha de reunión" placeholder="dd/mm/aaaa" disabled={!canWrite} value={lead.meetingAt} onValueChange={(v) => void persist({ meetingAt: v }, v ? `Reunión: ${formatDate(v)}` : "Reunión borrada")} />
          </Field>
          {lead.status === "lost" && (
            <Field label="Motivo de pérdida" htmlFor="lead-lost" className="sm:col-span-2">
              <EditableText id="lead-lost" label="Motivo de la pérdida" className={boxed} value={lead.lostReason} placeholder="Sin presupuesto, eligió otra opción…" disabled={!canWrite} onSave={(v) => persist({ lostReason: v }, "Motivo guardado")} />
            </Field>
          )}
        </div>
      </InfoSection>

      <InfoSection title="Contacto">
        <div className={grid3}>
          <Field label="Correo">
            <CopyField kind="email" value={lead.email} canWrite={canWrite} onSave={(v) => persist({ email: v }, "Correo guardado")} />
          </Field>
          <Field label="Teléfono" className="lg:col-span-2">
            <PhoneField value={lead.phone} country={lead.country} canWrite={canWrite} onSave={(v) => persist({ phone: v }, "Teléfono guardado")} />
          </Field>
          <Field label="Empresa">
            <Select
              label="Empresa"
              value={lead.company || null}
              placeholder="Elige una empresa"
              searchable
              options={[...companyOptions, ...(canWrite ? [{ value: NEW, label: "+ Agregar empresa nueva" }] : [])]}
              disabled={!canWrite}
              onValueChange={(v) => (v === NEW ? setAdding("company") : v && v !== lead.company && void persist({ company: v }, "Empresa guardada"))}
            />
          </Field>
          <Field label="Contacto">
            <Select
              label="Contacto"
              value={lead.contactRef?.id ?? (lead.contactName ? "__typed" : null)}
              placeholder="Elige un contacto"
              searchable
              options={[...contactOptions, ...(canWrite ? [{ value: NEW, label: "+ Agregar contacto nuevo" }] : [])]}
              disabled={!canWrite}
              onValueChange={(v) => {
                if (v === NEW) return setAdding("contact");
                if (v === "__typed") return;
                const c = contacts.find((x) => x.id === v);
                if (v) void persist({ contactId: v, ...(c ? { contactName: c.name } : {}) }, "Contacto enlazado");
              }}
            />
          </Field>
          <Field label="País">
            <Select label="País" value={countryByName(lead.country)?.name ?? lead.country} placeholder="Elige un país" searchable options={[...COUNTRIES.map((c) => ({ value: c.name, label: c.name, icon: <Flag code={c.code} /> })), ...(lead.country && !countryByName(lead.country) ? [{ value: lead.country, label: lead.country }] : [])]} disabled={!canWrite} onValueChange={(v) => v && v !== lead.country && void persist({ country: v }, `País: ${v}`)} />
          </Field>
          <Field label="Correo corporativo">
            <CopyField kind="email" label="Correo corporativo" value={lead.corporateEmail} canWrite={canWrite} onSave={(v) => persist({ corporateEmail: v }, "Correo corporativo guardado")} />
          </Field>
          <Field label="Página web" htmlFor="lead-website">
            <WebsiteField value={lead.website} canWrite={canWrite} onSave={(v) => persist({ website: v }, "Página web guardada")} />
          </Field>
        </div>
      </InfoSection>

      {lead.notes && (
        <InfoSection title="Notas">
          <EditableText label="Notas del lead" multiline className="-mx-2 w-[calc(100%+1rem)]" value={lead.notes || null} placeholder="Qué necesita, contexto, próximos pasos…" disabled={!canWrite} onSave={(v) => persist({ notes: v ?? "" }, "Notas guardadas")} />
        </InfoSection>
      )}

      {adding === "company" && <NewCompanyDialog onClose={() => setAdding(null)} onSave={(name) => persist({ company: name }, `Empresa: ${name}`)} />}
      {adding === "contact" && <NewContactDialog company={lead.company} onClose={() => setAdding(null)} onSave={(c) => persist({ contactId: c.id, contactName: c.name }, `Contacto creado y enlazado: ${c.name}`)} />}

      <InfoSection title="Respuestas del formulario" action={lead.fields.length > 0 || lead.rawJson ? <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-muted px-3 text-xs font-semibold text-muted-foreground"><FileText className="size-3.5" aria-hidden />{lead.source}</span> : undefined}>
        <FormAnswers lead={lead} />
      </InfoSection>
    </div>
  );
}

/**
 * Propuestas del lead (prototipo): el mismo tablero de Propuestas filtrado por este lead. Lo que
 * se sube aquí aparece allí y al revés; «Subir propuesta» viene con el lead ya elegido.
 */
function LeadSites({ data, canWrite }: { data: LeadData; canWrite: boolean }) {
  const { lead } = data;
  const sites = useSites("live", { leadId: lead.id });
  const configured = useSitesConfig().data?.configured;
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-4">
      <TabHead
        title="Propuestas"
        action={
          canWrite &&
          configured && (
            <Button onClick={() => setOpen(true)}>
              <Plus /> Subir propuesta
            </Button>
          )
        }
      />
      {configured === false ? (
        <p className="rounded-xl border border-dashed border-line-strong px-6 py-8 text-center text-sm text-muted-foreground">Propuestas aún no está conectada a WTProposalPlatform.</p>
      ) : (
        <SitesList sites={sites.data?.items} isLoading={sites.isLoading} canWrite={canWrite && (sites.data?.canWrite ?? false)} showLinks={false} empty="Aún no hay propuestas para este lead. Súbela aquí o desde Propuestas." />
      )}
      {open && <UploadSiteDialog open onClose={() => setOpen(false)} lead={{ id: lead.id, name: lead.title }} suggestedName={slugify(`demo-prospecto-${lead.company || lead.title}`)} />}
    </div>
  );
}

type ModalTab = "info" | "activities" | "meetings" | "proposals" | "comms";

/**
 * Detalle del lead en una ventana grande (prototipo): encabezado con el estado, pestañas
 * (Información, Actividades, Reuniones, Propuestas y Comunicaciones) y los Updates a la derecha.
 * Los deals se crean y gestionan en la pestaña Deals del proyecto (D2). Todo se edita en el lugar con guardado automático y «Deshacer». Financiera solo lee.
 */
export function LeadDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, error } = useLead(id);
  const refresh = useRefresh(id);
  const [tab, setTab] = useState<ModalTab>("info");
  const canWrite = data?.canWrite ?? false;
  const save = useSaveLead(data?.lead ?? ({} as LeadDetail));
  useCrumbs([data && { label: data.lead.title }]);
  const persist = (patch: Partial<LeadInput>, what?: string) => save(patch, what).catch((err: unknown) => toast.error("No se pudo guardar el cambio.", { description: errorText(err, "Inténtalo de nuevo.") }));
  const me = useSession().data?.id;
  // Contadores de los tableros conectados: Meetings y Propuestas, filtrados por este lead.
  const meetings = useQuery({ queryKey: ["meetings", "for-lead"], queryFn: () => apiFetch<{ rows: { lead: { id: string } | null }[] }>("/api/meetings?page=1&pageSize=100") });
  const leadSites = useSites("live", { leadId: id });
  const comms = useComms({ leadId: id });


  const tabs: { id: ModalTab; label: string; count?: number }[] = data
    ? [
        { id: "info", label: "Información" },
        { id: "activities", label: "Actividades", count: data.pendingActivities },
        { id: "meetings", label: "Reuniones", count: meetings.data?.rows?.filter((m) => m.lead?.id === id).length },
        { id: "proposals", label: "Propuestas", count: leadSites.data?.items?.length },
        { id: "comms", label: "Comunicaciones", count: comms.data?.communications?.length },
      ]
    : [];

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed inset-2 z-50 mx-auto flex max-w-[1320px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-overlay outline-none sm:inset-x-6 sm:top-[46px] sm:bottom-[46px] lg:inset-x-[60px]">
          {isLoading || !data ? (
            <div className="space-y-4 p-8">
              <Dialog.Title className="sr-only">Lead</Dialog.Title>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error instanceof Error ? error.message : "Lead no encontrado."}
                </p>
              ) : (
                <>
                  <Skeleton className="h-9 w-64" />
                  <Skeleton className="h-80 w-full rounded-2xl" />
                </>
              )}
              <Button variant="outline" onClick={onClose}>
                Cerrar
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-3 px-4 pt-5 pb-4 sm:px-8 sm:pt-8 sm:pb-5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-3">
                    <Dialog.Title className="truncate text-2xl font-bold tracking-tight sm:text-[2rem]">{data.lead.title}</Dialog.Title>
                    <LeadStatusBadge value={data.lead.status} />
                  </div>
                  <Dialog.Description className="mt-1.5 text-sm text-muted-foreground">{[data.lead.contactName, `creado ${formatDate(data.lead.createdAt)}`].filter(Boolean).join(" · ")}</Dialog.Description>
                </div>
                <Dialog.Close aria-label="Cerrar" className="inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] border border-border bg-card transition-colors hover:border-line-strong hover:bg-muted">
                  <X className="size-5" />
                </Dialog.Close>
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-5 overflow-y-auto px-4 pb-6 sm:px-8 sm:pb-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:content-stretch lg:overflow-hidden">
                <section className="flex flex-col rounded-[14px] border border-border bg-card lg:min-h-0">
                  <div role="tablist" aria-label="Secciones del lead" className="flex shrink-0 overflow-x-auto border-b border-border px-5">
                    {tabs.map((t) => (
                      <button
                        key={t.id}
                        role="tab"
                        type="button"
                        aria-selected={tab === t.id}
                        onClick={() => setTab(t.id)}
                        className={cn("-mb-px mr-4 inline-flex h-[52px] shrink-0 items-center gap-1.5 border-b-2 px-1 text-sm whitespace-nowrap transition-colors", tab === t.id ? "border-primary font-semibold text-foreground" : "border-transparent font-medium text-muted-foreground hover:text-foreground")}
                      >
                        {t.label}
                        {t.count !== undefined && <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11.5px] tabular-nums", tab === t.id ? "bg-accent-soft text-accent-text" : "bg-muted text-muted-foreground")}>{t.count}</span>}
                      </button>
                    ))}
                  </div>
                  <div role="tabpanel" className="proto-form min-h-64 flex-1 p-4 sm:p-6 lg:min-h-0 lg:overflow-y-auto">
                    {tab === "info" && <InfoTab data={data} canWrite={canWrite} persist={persist} />}
                    {tab === "activities" && <LeadActivities leadId={data.lead.id} canWrite={canWrite} me={me} />}
                    {tab === "meetings" && <MeetingsBoard target={{ kind: "lead", id: data.lead.id, name: data.lead.title }} canWrite={canWrite} />}
                    {tab === "proposals" && <LeadSites data={data} canWrite={canWrite} />}
                    {/* El tablero de Comunicaciones filtrado por este lead (mismos datos y seguimientos). */}
                    {tab === "comms" && <CommsTab scope={{ leadId: data.lead.id }} defaultContact={data.lead.contactName ?? ""} />}
                  </div>
                </section>
                <UpdatesColumn base={leadBase(data.lead.id)} canWrite={canWrite} onPosted={refresh} />
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
