import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Mail, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatShortDateTime } from "@/lib/format";
import { errorText, toast } from "@/lib/toast";
import { commsKey, EMAIL_RE, mailApi, mailKey, splitEmails, useMyMail, type Communication, type CommsScope } from "./api";
import type { RelationOption } from "./CommsList";

/**
 * Gmail del usuario: conectar, ver el estado, sincronizar y desconectar. Siempre es el buzón de su
 * propia cuenta (@whatever.tech); el servidor lo resuelve desde la sesión.
 */
export function GmailCard() {
  const queryClient = useQueryClient();
  const { data } = useMyMail();
  const [busy, setBusy] = useState<"connect" | "sync" | "disconnect" | null>(null);
  if (!data?.available) return null;
  const conn = data.connection && data.connection.status !== "disconnected" ? data.connection : null;
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
              <StatusBadge tone={conn.status === "error" ? "danger" : "ok"} dot>
                {conn.status === "error" ? "Con error" : "Conectado"}
              </StatusBadge>
            </p>
            <p className="font-subtitle text-xs text-muted-foreground">
              {conn.status === "error" && conn.lastError ? conn.lastError : `${conn.lastSyncAt ? `Sincronizado ${formatShortDateTime(conn.lastSyncAt)}` : "Sincronizando…"} · ${conn.push ? "al instante" : "cada 5 minutos"} · solo se guardan los correos con clientes y leads`}
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
            <Button variant="outline" size="sm" loading={busy === "sync"} disabled={Boolean(busy)} onClick={() => void run("sync", mailApi.sync, "Buzón sincronizado")}>
              {busy !== "sync" && <RefreshCw />} Sincronizar
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
  const toList = splitEmails(to);
  const ccList = splitEmails(cc);
  const relation = replyTo ? {} : (fixed ?? (rel ? (rel.startsWith("p:") ? { projectId: rel.slice(2) } : { leadId: rel.slice(2) }) : null));
  const badEmail = [...toList, ...ccList].find((e) => !EMAIL_RE.test(e));
  const valid = Boolean(relation) && toList.length > 0 && !badEmail && Boolean(body.trim()) && Boolean(subject.trim());

  async function submit() {
    if (!valid || !relation) return;
    setBusy(true);
    try {
      await mailApi.send({ to: toList, cc: ccList, subject: subject.trim(), body, ...relation, replyToId: replyTo?.id ?? null });
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
          <Input id="mail-to" value={to} placeholder="juan@cliente.com, maria@cliente.com" onChange={(e) => setTo(e.target.value)} aria-invalid={Boolean(badEmail && toList.includes(badEmail))} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-caps-label" htmlFor="mail-cc">CC (opcional)</Label>
          <Input id="mail-cc" value={cc} onChange={(e) => setCc(e.target.value)} />
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
      </div>
    </Modal>
  );
}
