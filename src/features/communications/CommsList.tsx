import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Mail, Plus, Reply } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Modal } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { useSession } from "@/features/auth/auth";
import { formatDate, formatShortDateTime } from "@/lib/format";
import { errorText, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { commsApi, commsKey, DIRECTION_LABELS, followUp, KIND_LABELS, KIND_TONE, KINDS, mailReady, useComms, useMyMail, useThread, type CommInput, type Communication, type CommsScope, type Direction, type Kind } from "./api";
import { ComposeDialog, GmailCard } from "./Mail";

/** Relación de una comunicación nueva: fija (desde un proyecto o lead) o a elegir en la pantalla general. */
export interface RelationOption {
  value: string; // "p:<id>" | "l:<id>"
  label: string;
  contact?: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Formulario para registrar un email, mensaje o llamada. */
export function CommDialog({
  open,
  onOpenChange,
  fixed,
  relations = [],
  people,
  defaultContact = "",
  initialRelation = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Relación fija (pestaña del proyecto o del lead). */
  fixed?: CommsScope;
  relations?: RelationOption[];
  people: { id: string; name: string }[];
  defaultContact?: string;
  initialRelation?: string;
}) {
  const queryClient = useQueryClient();
  const me = useSession().data?.id ?? null;
  const [rel, setRel] = useState(initialRelation);
  const [kind, setKind] = useState<Kind>("email");
  const [direction, setDirection] = useState<Direction>("sent");
  const [owner, setOwner] = useState<string | null>(me);
  const [contact, setContact] = useState(defaultContact || relations.find((r) => r.value === initialRelation)?.contact || "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [follow, setFollow] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const relation = fixed ?? (rel ? (rel.startsWith("p:") ? { projectId: rel.slice(2) } : { leadId: rel.slice(2) }) : null);
  const valid = Boolean(relation) && Boolean(subject.trim() || body.trim());

  async function save() {
    if (!relation || !valid) return;
    setBusy(true);
    try {
      const input: CommInput = { kind, direction, ownerUserId: owner, contactName: contact.trim(), subject: subject.trim(), body: body.trim(), date: today(), followUpDate: follow, ...relation };
      await commsApi.create(input);
      await queryClient.invalidateQueries({ queryKey: commsKey });
      toast.success("Comunicación registrada");
      onOpenChange(false);
    } catch (err) {
      toast.error("No se pudo registrar.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Registrar comunicación"
      dirty={Boolean(subject || body)}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!valid} loading={busy} onClick={() => void save()}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {!fixed && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-caps-label" htmlFor="cm-rel">Relacionado con</Label>
            <Select
              id="cm-rel"
              label="Relacionado con"
              value={rel || null}
              placeholder="Elige proyecto o lead"
              searchable
              options={relations}
              onValueChange={(v) => {
                setRel(v ?? "");
                const found = relations.find((r) => r.value === v);
                if (found?.contact && !contact) setContact(found.contact);
              }}
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label className="text-caps-label" htmlFor="cm-kind">Tipo</Label>
          <Select id="cm-kind" label="Tipo" value={kind} options={KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))} onValueChange={(v) => v && setKind(v as Kind)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-caps-label" htmlFor="cm-dir">Dirección</Label>
          <Select id="cm-dir" label="Dirección" value={direction} options={(["sent", "received"] as const).map((d) => ({ value: d, label: DIRECTION_LABELS[d] }))} onValueChange={(v) => v && setDirection(v as Direction)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-caps-label" htmlFor="cm-owner">Responsable</Label>
          <Select id="cm-owner" label="Responsable" value={owner} emptyLabel="Sin responsable" options={people.map((p) => ({ value: p.id, label: p.name }))} onValueChange={setOwner} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-caps-label" htmlFor="cm-contact">Contacto</Label>
          <Input id="cm-contact" value={contact} maxLength={120} placeholder="Persona del cliente" onChange={(e) => setContact(e.target.value)} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-caps-label" htmlFor="cm-subject">Asunto</Label>
          <Input id="cm-subject" value={subject} maxLength={200} placeholder="Ej. Propuesta enviada, aprobación de alcance" onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-caps-label" htmlFor="cm-body">Resumen del mensaje</Label>
          <Textarea id="cm-body" rows={4} value={body} placeholder="Qué se dijo, qué se acordó" onChange={(e) => setBody(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-caps-label" htmlFor="cm-follow">Próximo seguimiento (opcional)</Label>
          <DatePicker id="cm-follow" label="Próximo seguimiento" value={follow} min={today()} onValueChange={setFollow} />
        </div>
      </div>
    </Modal>
  );
}

/** Mensajes guardados del hilo de un correo, del más viejo al más nuevo. */
function Thread({ id }: { id: string }) {
  const { data, isLoading } = useThread(id);
  if (isLoading) return <p className="text-xs text-muted-foreground">Cargando hilo…</p>;
  const list = data?.communications ?? [];
  if (list.length < 2) return null;
  return (
    <ol aria-label="Hilo" className="space-y-2 border-l-2 border-border pl-3">
      {list.map((m) => (
        <li key={m.id} className="text-sm">
          <p className="text-xs text-muted-foreground">
            <b className="text-foreground">{m.direction === "sent" ? (m.owner?.name ?? m.email?.from) : m.email?.from}</b> · {m.email?.sentAt ? formatShortDateTime(m.email.sentAt) : formatDate(m.date)}
          </p>
          <p className="line-clamp-4 whitespace-pre-line">{m.body || "Sin contenido."}</p>
        </li>
      ))}
    </ol>
  );
}

const MATCHED: Record<string, string> = { contact: "por el contacto", lead: "por el correo del lead", thread: "por el hilo", domain: "por el dominio", manual: "elegido al enviar" };

/** Una comunicación: se despliega para leer el resumen, marcar el seguimiento o eliminarla. */
export function CommCard({ c, showRelation, canEdit }: { c: Communication; showRelation: boolean; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const me = useSession().data?.id;
  const mail = useMyMail().data;
  const [open, setOpen] = useState(false);
  const [replying, setReplying] = useState(false);
  // Solo se responde desde el buzón propio (el hilo de Gmail es de quien lo recibió).
  const canReply = c.source === "gmail" && c.owner?.id === me && mailReady(mail);
  const f = followUp(c);
  const refresh = () => queryClient.invalidateQueries({ queryKey: commsKey });
  const act = async (action: () => Promise<unknown>, done?: string, undo?: () => Promise<unknown>) => {
    try {
      await action();
      await refresh();
      if (done) toast.success(done, undo ? { undo: async () => { await undo(); await refresh(); } } : undefined);
    } catch (err) {
      toast.error("No se pudo guardar el cambio.", { description: errorText(err, "Inténtalo de nuevo.") });
    }
  };
  const relation = c.project ? `Proyecto · ${c.project.name}` : c.lead ? `Lead · ${c.lead.name}` : "";
  return (
    <article className="rounded-2xl border border-border bg-card">
      <button type="button" aria-expanded={open} aria-label={`Ver detalle de ${c.subject || KIND_LABELS[c.kind]}`} onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-left">
        <StatusBadge tone={KIND_TONE[c.kind]}>
          {c.source === "gmail" && <Mail aria-hidden className="size-3" />}
          {c.source === "gmail" ? "Gmail" : KIND_LABELS[c.kind]}
        </StatusBadge>
        <span className="min-w-0 flex-1 basis-48">
          <b className="block truncate">{c.subject || "(sin asunto)"}</b>
          <span className="block truncate text-xs text-muted-foreground">
            {c.direction === "received" ? "↙ Recibido" : "↗ Enviado"} · {c.contactName || "Sin contacto"} · {c.owner?.name ?? "Sin responsable"}
            {showRelation && relation ? ` · ${relation}` : ""}
          </span>
        </span>
        {f && <StatusBadge tone={f.tone}>{f.text}</StatusBadge>}
        <span className="text-xs whitespace-nowrap text-muted-foreground">{formatDate(c.date)}</span>
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-4 py-3">
          {c.email && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-muted-foreground">De</dt>
              <dd className="break-all">{c.email.from}</dd>
              <dt className="text-muted-foreground">Para</dt>
              <dd className="break-all">{c.email.to.join(", ") || "—"}</dd>
              {c.email.cc.length > 0 && (
                <>
                  <dt className="text-muted-foreground">CC</dt>
                  <dd className="break-all">{c.email.cc.join(", ")}</dd>
                </>
              )}
              {c.email.matchedBy && (
                <>
                  <dt className="text-muted-foreground">Cliente</dt>
                  <dd>
                    Asociado {MATCHED[c.email.matchedBy]}
                    {c.email.sentFromApp ? " · enviado desde la app" : ""}
                  </dd>
                </>
              )}
            </dl>
          )}
          <p className="max-h-96 overflow-y-auto text-sm whitespace-pre-line">{c.body || "Sin contenido."}</p>
          {c.email?.threadId && <Thread id={c.id} />}
          {(canEdit || canReply) && (
            <div className="flex flex-wrap gap-2">
              {canReply && (
                <Button size="sm" onClick={() => setReplying(true)}>
                  <Reply /> Responder
                </Button>
              )}
              {f && (
                <Button size="sm" variant="outline" onClick={() => void act(() => commsApi.update(c.id, { followUpDone: true }), "Seguimiento hecho", () => commsApi.update(c.id, { followUpDone: false }))}>
                  Marcar seguimiento hecho
                </Button>
              )}
              {canEdit && (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void act(() => commsApi.remove(c.id), "Comunicación eliminada", () => commsApi.restore(c.id))}>
                  {c.source === "gmail" ? "Quitar de la app" : "Eliminar"}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {replying && <ComposeDialog replyTo={c} onClose={() => setReplying(false)} />}
    </article>
  );
}

/** Pestaña Comunicaciones del proyecto o del lead. */
export function CommsTab({ scope, defaultContact, defaultEmail }: { scope: { projectId: string } | { leadId: string }; defaultContact?: string; defaultEmail?: string }) {
  const { data } = useComms(scope);
  const mail = useMyMail().data;
  const [adding, setAdding] = useState(false);
  const [composing, setComposing] = useState(false);
  const list = data?.communications ?? [];
  const ready = mailReady(mail);
  return (
    <div className="space-y-3">
      {mail?.available && !ready && <GmailCard />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-subtitle text-sm text-muted-foreground">{mail?.available ? "Correos de Gmail con este cliente y registros manuales." : "Registro manual de emails, mensajes y llamadas."}</p>
        {data?.canCreate && (
          <div className="flex flex-wrap gap-2">
            {ready && (
              <Button onClick={() => setComposing(true)}>
                <Mail /> Redactar email
              </Button>
            )}
            <Button variant={ready ? "outline" : "default"} onClick={() => setAdding(true)}>
              <Plus /> Registrar comunicación
            </Button>
          </div>
        )}
      </div>
      {data && !list.length && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          <b className="block text-foreground">Sin comunicaciones</b>
          Registra el primer email, mensaje o llamada.
        </p>
      )}
      {list.map((c) => (
        <CommCard key={c.id} c={c} showRelation={false} canEdit={Boolean(data?.canCreate)} />
      ))}
      {adding && <CommDialog open onOpenChange={setAdding} fixed={scope} people={data?.people ?? []} defaultContact={defaultContact} />}
      {composing && <ComposeDialog fixed={scope} defaultTo={defaultEmail} onClose={() => setComposing(false)} />}
    </div>
  );
}
