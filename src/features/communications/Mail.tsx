import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Mail, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatShortDateTime } from "@/lib/format";
import { errorText, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { commsKey, EMAIL_RE, mailApi, mailKey, RECIPIENT_SOURCE, splitEmails, useMyMail, useRecipients, useSignature, type Communication, type CommsScope } from "./api";
import type { RelationOption } from "./CommsList";

/**
 * Gmail del usuario: conectar, ver el estado, sincronizar y desconectar. Siempre es el buzón de su
 * propia cuenta (@whatever.tech); el servidor lo resuelve desde la sesión.
 */
export function GmailCard() {
  const queryClient = useQueryClient();
  const { data } = useMyMail();
  const [busy, setBusy] = useState<"connect" | "sync" | "disconnect" | null>(null);
  const syncing = Boolean(data?.connection?.syncing);
  const wasSyncing = useRef(syncing);
  // Al terminar una sincronización (al conectar, por push o cada 5 min) se recargan los correos.
  useEffect(() => {
    if (wasSyncing.current && !syncing) void queryClient.invalidateQueries({ queryKey: commsKey });
    wasSyncing.current = syncing;
  }, [syncing, queryClient]);
  if (!data?.available) return null;
  const conn = data.connection && data.connection.status !== "disconnected" ? data.connection : null;
  const spinning = syncing || busy === "sync";
  const run = async (what: "connect" | "sync" | "disconnect", fn: () => Promise<unknown>, done: string) => {
    setBusy(what);
    try {
      await fn();
      await Promise.all([queryClient.invalidateQueries({ queryKey: mailKey }), queryClient.invalidateQueries({ queryKey: commsKey })]);
      toast.success(done);
    } catch (err) {
      await queryClient.invalidateQueries({ queryKey: mailKey });
      toast.error("No se pudo completar.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label="Tu Gmail" className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-border bg-card px-4 py-3">
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent-text">
        <Mail className="size-4" />
      </span>
      <div className="min-w-0 flex-1 basis-64">
        {conn ? (
          <>
            <p className="flex flex-wrap items-center gap-2 font-semibold">
              {conn.email}
              {spinning ? (
                <StatusBadge tone="info">
                  <Loader2 className="size-3 animate-spin" aria-hidden /> Sincronizando
                </StatusBadge>
              ) : (
                <StatusBadge tone={conn.status === "error" ? "danger" : "ok"} dot>
                  {conn.status === "error" ? "Con error" : "Conectado"}
                </StatusBadge>
              )}
            </p>
            <p role="status" aria-live="polite" className="font-subtitle text-xs text-muted-foreground">
              {spinning
                ? `Trayendo tus correos con clientes y leads${conn.lastSyncAt ? "" : " de los últimos 14 días"}…`
                : conn.status === "error" && conn.lastError
                  ? conn.lastError
                  : `${conn.lastSyncAt ? `Sincronizado ${formatShortDateTime(conn.lastSyncAt)}` : "Aún sin sincronizar"} · ${conn.push ? "al instante" : "cada 5 minutos"} · solo se guardan los correos con clientes y leads`}
            </p>
          </>
        ) : (
          <>
            <p className="font-semibold">Conecta tu Gmail</p>
            <p className="font-subtitle text-xs text-muted-foreground">
              {data.email
                ? `Trae a la app los correos de ${data.email} con clientes y leads, y envía desde tu cuenta. Los correos personales nunca se guardan.`
                : "Tu usuario no tiene un correo @whatever.tech. Pide a un CEO/CCO que lo agregue en Usuarios."}
            </p>
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {conn ? (
          <>
            <Button variant="outline" size="sm" disabled={Boolean(busy) || syncing} onClick={() => void run("sync", mailApi.sync, "Buzón sincronizado")}>
              <RefreshCw className={cn(spinning && "animate-spin")} /> {spinning ? "Sincronizando…" : "Sincronizar"}
            </Button>
            <Button variant="ghost" size="sm" loading={busy === "disconnect"} disabled={Boolean(busy)} onClick={() => void run("disconnect", mailApi.disconnect, "Gmail desconectado")}>
              Desconectar
            </Button>
          </>
        ) : (
          data.canConnect && (
            <Button loading={busy === "connect"} disabled={Boolean(busy)} onClick={() => void run("connect", mailApi.connect, "Gmail conectado: trayendo los correos recientes")}>
              Conectar Gmail
            </Button>
          )
        )}
      </div>
    </section>
  );
}

/**
 * Campo de correos separados por coma con sugerencias de la última dirección que se escribe: a quién
 * ya le escribiste, contactos, leads y la gente de la app («manu» → manuel@whatever.tech).
 */
function RecipientInput({ id, value, onChange, invalid, placeholder }: { id: string; value: string; onChange: (v: string) => void; invalid?: boolean; placeholder?: string }) {
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const cut = Math.max(value.lastIndexOf(","), value.lastIndexOf(";"));
  const token = value.slice(cut + 1).trim();
  const [query, setQuery] = useState(token);
  useEffect(() => {
    const t = setTimeout(() => setQuery(token), 150);
    return () => clearTimeout(t);
  }, [token]);
  const typed = new Set(splitEmails(value.slice(0, cut + 1)).map((e) => e.toLowerCase()));
  const found = useRecipients(query).data?.suggestions ?? [];
  const options = token.length >= 2 ? found.filter((o) => !typed.has(o.email) && o.email !== token.toLowerCase()) : [];
  const open = focused && !dismissed && options.length > 0;
  const current = Math.min(active, Math.max(options.length - 1, 0));

  const pick = (email: string) => {
    const before = value.slice(0, cut + 1).trimEnd();
    onChange(`${before ? `${before} ` : ""}${email}, `);
    setActive(0);
  };

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${current}` : undefined}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid}
        onChange={(e) => {
          onChange(e.target.value);
          setDismissed(false);
          setActive(0);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive((current + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            pick(options[current].email);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setDismissed(true);
          }
        }}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label="Sugerencias" className="absolute inset-x-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-popover">
          {options.map((o, i) => (
            <li
              key={o.email}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              // mousedown (no click) para elegir antes de que el campo pierda el foco.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o.email);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn("flex cursor-default items-center gap-3 rounded-md px-2.5 py-2 text-sm", i === current && "bg-accent text-accent-foreground")}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{o.name ?? o.email}</span>
                {o.name && <span className="block truncate text-xs text-muted-foreground">{o.email}</span>}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{RECIPIENT_SOURCE[o.source]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Redactar o responder un correo desde el Gmail propio. Al responder, va en el mismo hilo y queda en
 * el proyecto o lead del correo original; uno nuevo se relaciona con un proyecto o lead.
 */
export function ComposeDialog({ onClose, replyTo, fixed, relations = [], defaultTo = "" }: { onClose: () => void; replyTo?: Communication; fixed?: CommsScope; relations?: RelationOption[]; defaultTo?: string }) {
  const queryClient = useQueryClient();
  const from = useMyMail().data?.connection?.email ?? "";
  const replyAddress = replyTo?.email ? (replyTo.direction === "received" ? replyTo.email.from : replyTo.email.to.join(", ")) : "";
  const [to, setTo] = useState(replyAddress || defaultTo);
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(replyTo ? (/^re:/i.test(replyTo.subject) ? replyTo.subject : `Re: ${replyTo.subject}`) : "");
  const [body, setBody] = useState("");
  const [rel, setRel] = useState("");
  const [busy, setBusy] = useState(false);
  const [withSignature, setWithSignature] = useState(true);
  const signature = useSignature(true);
  const signatureText = signature.data?.text ?? null;
  const toList = splitEmails(to);
  const ccList = splitEmails(cc);
  const relation = replyTo ? {} : (fixed ?? (rel ? (rel.startsWith("p:") ? { projectId: rel.slice(2) } : { leadId: rel.slice(2) }) : null));
  const badEmail = [...toList, ...ccList].find((e) => !EMAIL_RE.test(e));
  const valid = Boolean(relation) && toList.length > 0 && !badEmail && Boolean(body.trim()) && Boolean(subject.trim());

  async function submit() {
    if (!valid || !relation) return;
    setBusy(true);
    try {
      await mailApi.send({ to: toList, cc: ccList, subject: subject.trim(), body, ...relation, replyToId: replyTo?.id ?? null, signature: withSignature });
      await queryClient.invalidateQueries({ queryKey: commsKey });
      toast.success(replyTo ? "Respuesta enviada" : "Correo enviado", { description: `Desde ${from}` });
      onClose();
    } catch (err) {
      toast.error("No se pudo enviar.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={replyTo ? "Responder" : "Nuevo correo"}
      description={from ? `Se envía desde ${from}` : undefined}
      dirty={Boolean(body.trim())}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!valid} loading={busy} onClick={() => void submit()}>
            Enviar
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {!replyTo && !fixed && (
          <div className="space-y-1.5">
            <Label className="text-caps-label" htmlFor="mail-rel">Relacionado con</Label>
            <Select id="mail-rel" label="Relacionado con" value={rel || null} placeholder="Elige proyecto o lead" searchable options={relations} onValueChange={(v) => setRel(v ?? "")} />
          </div>
        )}
        <div className="space-y-1.5">
          <Label className="text-caps-label" htmlFor="mail-to">Para</Label>
          <RecipientInput id="mail-to" value={to} placeholder="juan@cliente.com, maria@cliente.com" onChange={setTo} invalid={Boolean(badEmail && toList.includes(badEmail))} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-caps-label" htmlFor="mail-cc">CC (opcional)</Label>
          <RecipientInput id="mail-cc" value={cc} onChange={setCc} />
        </div>
        {badEmail && <p role="alert" className="-mt-2 text-xs text-destructive">«{badEmail}» no es un correo válido.</p>}
        <div className="space-y-1.5">
          <Label className="text-caps-label" htmlFor="mail-subject">Asunto</Label>
          <Input id="mail-subject" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-caps-label" htmlFor="mail-body">Mensaje</Label>
          <Textarea id="mail-body" rows={9} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        {signature.isLoading ? null : signatureText ? (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={withSignature} onChange={(e) => setWithSignature(e.target.checked)} />
              Incluir mi firma de Gmail
            </label>
            {withSignature && <p className="rounded-lg border border-border bg-muted/50 px-3 py-2.5 text-sm whitespace-pre-line text-muted-foreground">{signatureText}</p>}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Tu Gmail no tiene una firma configurada; el correo sale sin firma.</p>
        )}
      </div>
    </Modal>
  );
}
