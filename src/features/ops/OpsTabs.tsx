import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Eye, EyeOff, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { selectClass } from "@/features/admin/TeamAssignCard";
import { ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  ACCOUNT_KIND_LABELS,
  ACCOUNT_KINDS,
  accountsQuery,
  createAccount,
  createDeal,
  createMeeting,
  createTask,
  createUpdate,
  DEAL_STATUS_LABELS,
  DEAL_STATUSES,
  dealsQuery,
  deleteAccount,
  hoursText,
  meetingsQuery,
  money,
  opsKeys,
  revealAccount,
  rotateAccount,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  tasksQuery,
  updateDeal,
  updateTask,
  updatesQuery,
  useTeamMembers,
  type AccountKind,
  type Deal,
  type DealStatus,
  type OpsTask,
  type TaskStatus,
  type VaultAccount,
} from "./api";

/** Invalida todo lo del proyecto (listas y resumen) tras un cambio. */
function useRefresh(projectId: string) {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: opsKeys.project(projectId) }),
      queryClient.invalidateQueries({ queryKey: opsKeys.allProjects }),
    ]);
  };
}

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const dateText = (iso: string) => new Date(iso).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" });

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-foreground/15 p-6 text-center text-sm text-muted-foreground">{children}</p>;
}

function Loading() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

// ---- Deals --------------------------------------------------------------------------

export function DealsTab({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const refresh = useRefresh(projectId);
  const { data: deals, isLoading, error } = useQuery(dealsQuery(projectId));
  const [title, setTitle] = useState("");
  const [hours, setHours] = useState("");
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const hoursValue = Number(hours);
  const rateCents = Math.round(Number(rate) * 100);
  const valid = title.trim().length >= 3 && hoursValue > 0 && Number.isFinite(rateCents) && rateCents >= 0 && rate !== "";

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setFormError(null);
    try {
      await createDeal(projectId, { title: title.trim(), hours: hoursValue, rateCents });
      setTitle("");
      setHours("");
      setRate("");
      await refresh();
    } catch (err) {
      setFormError(message(err, "No se pudo crear el deal."));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(deal: Deal, status: DealStatus) {
    setFormError(null);
    try {
      await updateDeal(projectId, deal.id, { status });
      await refresh();
    } catch (err) {
      setFormError(message(err, "No se pudo cambiar el estado."));
    }
  }

  const total = (deals ?? []).filter((d) => d.status !== "cancelled").reduce((sum, d) => sum + d.amountCents, 0);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Cada deal es un trato por un módulo o funcionalidad, vendido por horas. Cada deal puede tener su propia propuesta.</p>
      {canManage && (
        <form onSubmit={add} className="grid items-end gap-3 rounded-lg border border-foreground/10 p-4 sm:grid-cols-[2fr_1fr_1fr_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="deal-title">Deal</Label>
            <Input id="deal-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Módulo de pedidos" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="deal-hours">Horas</Label>
            <Input id="deal-hours" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="40" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="deal-rate">Tarifa por hora (USD)</Label>
            <Input id="deal-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="25" />
          </div>
          <Button type="submit" disabled={!valid || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            Agregar
          </Button>
        </form>
      )}
      <ErrorLine error={formError ?? (error ? message(error, "No se pudieron cargar los deals.") : null)} />
      {isLoading ? (
        <Loading />
      ) : !deals?.length ? (
        <Empty>Este proyecto aún no tiene deals.</Empty>
      ) : (
        <>
          <ul className="space-y-2">
            {deals.map((deal) => (
              <li key={deal.id} className="grid items-center gap-3 rounded-lg border border-foreground/10 p-3 sm:grid-cols-[2fr_1fr_1fr_auto]">
                <div className="min-w-0">
                  <p className="truncate font-medium">{deal.title}</p>
                  {deal.proposalUrl && (
                    <a className="text-xs text-primary underline-offset-4 hover:underline" href={deal.proposalUrl} target="_blank" rel="noreferrer">
                      Ver propuesta
                    </a>
                  )}
                </div>
                <p className="text-sm tabular-nums">
                  {hoursText(deal.hours)} × {money(deal.rateCents, deal.currency)}
                </p>
                <p className="text-sm font-medium tabular-nums">{money(deal.amountCents, deal.currency)}</p>
                {canManage ? (
                  <select aria-label={`Estado de ${deal.title}`} className={selectClass} value={deal.status} onChange={(e) => void setStatus(deal, e.target.value as DealStatus)}>
                    {DEAL_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {DEAL_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Badge variant="outline">{DEAL_STATUS_LABELS[deal.status]}</Badge>
                )}
              </li>
            ))}
          </ul>
          <p className="text-right text-sm text-muted-foreground">
            Total sin cancelados: <span className="font-medium text-foreground">{money(total)}</span>
          </p>
        </>
      )}
    </div>
  );
}

// ---- Tasks --------------------------------------------------------------------------

export function TasksTab({ projectId, teamId, canWork, canManage, currentUserId }: { projectId: string; teamId: string; canWork: boolean; canManage: boolean; currentUserId: string }) {
  const refresh = useRefresh(projectId);
  const { data: tasks, isLoading, error } = useQuery(tasksQuery(projectId));
  const { data: deals } = useQuery(dealsQuery(projectId));
  const members = useTeamMembers(teamId, canWork).data ?? [];
  const [title, setTitle] = useState("");
  const [dealId, setDealId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [taskHours, setTaskHours] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const dealName = new Map((deals ?? []).map((d) => [d.id, d.title]));

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (title.trim().length < 3) return;
    setBusy(true);
    setFormError(null);
    try {
      await createTask(projectId, {
        title: title.trim(),
        dealId: dealId || null,
        assigneeUserId: assigneeId || null,
        estimatedHours: taskHours ? Number(taskHours) : 0,
      });
      setTitle("");
      setTaskHours("");
      await refresh();
    } catch (err) {
      setFormError(message(err, "No se pudo crear la tarea."));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(task: OpsTask, status: TaskStatus) {
    setFormError(null);
    try {
      await updateTask(projectId, task.id, { status });
      await refresh();
    } catch (err) {
      setFormError(message(err, "No se pudo cambiar la tarea."));
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Las tareas de cada Team Leader y Developer. Si se ligan a un deal, servirán para calcular la comisión cuando la tarea se complete y el deal se cobre.
      </p>
      {canWork && canManage && (
        <form onSubmit={add} className="grid items-end gap-3 rounded-lg border border-foreground/10 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1.2fr_1.2fr_0.7fr_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Tarea</Label>
            <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pantalla de pedidos" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-deal">Deal</Label>
            <select id="task-deal" className={cn(selectClass, "w-full")} value={dealId} onChange={(e) => setDealId(e.target.value)}>
              <option value="">Sin deal</option>
              {(deals ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-assignee">Responsable</Label>
            <select id="task-assignee" className={cn(selectClass, "w-full")} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Sin asignar</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-hours">Horas</Label>
            <Input id="task-hours" inputMode="decimal" value={taskHours} onChange={(e) => setTaskHours(e.target.value)} placeholder="6" />
          </div>
          <Button type="submit" disabled={title.trim().length < 3 || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            Agregar
          </Button>
        </form>
      )}
      <ErrorLine error={formError ?? (error ? message(error, "No se pudieron cargar las tareas.") : null)} />
      {isLoading ? (
        <Loading />
      ) : !tasks?.length ? (
        <Empty>Aún no hay tareas.</Empty>
      ) : (
        <ul className="space-y-2">
          {tasks.map((task) => {
            // Un developer solo mueve el estado de sus propias tareas (la API lo exige también).
            const editable = canWork && (canManage || task.assigneeUserId === currentUserId);
            return (
              <li key={task.id} className="grid items-center gap-3 rounded-lg border border-foreground/10 p-3 sm:grid-cols-[2fr_1.2fr_1fr_auto]">
                <div className="min-w-0">
                  <p className={cn("truncate font-medium", task.status === "done" && "text-muted-foreground line-through")}>{task.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {task.dealId ? (dealName.get(task.dealId) ?? "Deal") : "Sin deal"}
                    {task.dueDate ? ` · vence ${task.dueDate}` : ""}
                  </p>
                </div>
                <p className="truncate text-sm">{task.assigneeName ?? "Sin asignar"}</p>
                <p className="text-sm tabular-nums text-muted-foreground">{hoursText(task.estimatedHours)}</p>
                {editable ? (
                  <select aria-label={`Estado de ${task.title}`} className={selectClass} value={task.status} onChange={(e) => void setStatus(task, e.target.value as TaskStatus)}>
                    {TASK_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {TASK_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Badge variant="outline">{TASK_STATUS_LABELS[task.status]}</Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---- Cuentas (vault) ----------------------------------------------------------------

/** Valor revelado: solo vive en este componente, se oculta solo y no pasa por la caché de consultas. */
function RevealedValue({ username, credential, onHide }: { username: string | null; credential: string; onHide: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(onHide, 30_000);
    return () => window.clearTimeout(timer);
  }, [onHide]);
  return (
    <div role="status" className="mt-2 rounded-md border border-amber-400/30 bg-amber-500/10 p-3 text-sm">
      {username && (
        <p className="text-xs text-muted-foreground">
          Usuario: <span className="font-mono text-foreground">{username}</span>
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <code className="rounded border border-foreground/15 bg-foreground/5 px-2 py-1 font-mono break-all">{credential}</code>
        <Button
          size="xs"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard?.writeText(credential).catch(() => undefined);
            setCopied(true);
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copiada" : "Copiar"}
        </Button>
        <Button size="xs" variant="ghost" onClick={onHide}>
          <EyeOff />
          Ocultar
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Se oculta sola en 30 segundos. Este acceso quedó registrado.</p>
    </div>
  );
}

function AccountRow({ projectId, account, canManage }: { projectId: string; account: VaultAccount; canManage: boolean }) {
  const refresh = useRefresh(projectId);
  const [revealed, setRevealed] = useState<{ username: string | null; credential: string } | null>(null);
  const [rotating, setRotating] = useState(false);
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <li className="rounded-lg border border-foreground/10 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {account.label} <span className="text-xs font-normal text-muted-foreground">· {ACCOUNT_KIND_LABELS[account.kind]}</span>
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {account.username ?? "Sin usuario"}
            {account.rotatedAt ? ` · rotada ${dateText(account.rotatedAt)}` : ""}
          </p>
          {account.url && (
            <a className="text-xs text-primary underline-offset-4 hover:underline" href={account.url} target="_blank" rel="noreferrer">
              {account.url}
            </a>
          )}
        </div>
        {account.credentialSet ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              run("reveal", async () => {
                setRevealed(await revealAccount(projectId, account.id));
              })
            }
          >
            {busy === "reveal" ? <Loader2 className="animate-spin" /> : <Eye />}
            Ver
          </Button>
        ) : (
          <Badge variant="outline">Sin valor guardado</Badge>
        )}
        {canManage && (
          <>
            <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => setRotating((v) => !v)}>
              <KeyRound />
              Rotar
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Eliminar ${account.label}`}
              disabled={busy !== null}
              onClick={() => {
                if (!window.confirm(`¿Eliminar la cuenta "${account.label}"? No se puede deshacer.`)) return;
                void run("delete", async () => {
                  await deleteAccount(projectId, account.id);
                  await refresh();
                });
              }}
            >
              <Trash2 />
            </Button>
          </>
        )}
      </div>
      {revealed && <RevealedValue username={revealed.username} credential={revealed.credential} onHide={() => setRevealed(null)} />}
      {rotating && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!next) return;
            void run("rotate", async () => {
              await rotateAccount(projectId, account.id, next);
              setNext("");
              setRotating(false);
              setRevealed(null);
              await refresh();
            });
          }}
        >
          <Input aria-label="Nuevo valor" type="password" autoComplete="new-password" className="max-w-xs" value={next} onChange={(e) => setNext(e.target.value)} placeholder="Nuevo valor" />
          <Button size="sm" type="submit" disabled={!next || busy !== null}>
            {busy === "rotate" && <Loader2 className="animate-spin" />}
            Guardar
          </Button>
        </form>
      )}
      <ErrorLine error={error} />
    </li>
  );
}

export function AccountsTab({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const refresh = useRefresh(projectId);
  const { data: accounts, isLoading, error } = useQuery(accountsQuery(projectId, true));
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<AccountKind>("web");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (label.trim().length < 2) return;
    setBusy(true);
    setFormError(null);
    try {
      await createAccount(projectId, { label: label.trim(), kind, url: url.trim() || null, username: username.trim() || null, ...(secret ? { secret } : {}) });
      setLabel("");
      setUrl("");
      setUsername("");
      setSecret("");
      await refresh();
    } catch (err) {
      setFormError(message(err, "No se pudo guardar la cuenta."));
    } finally {
      setBusy(false);
    }
  }

  if (error instanceof ApiError && error.status === 503) return <Empty>El vault de cuentas aún no está activado en el servidor (falta ACCOUNT_VAULT_KEY_PATH).</Empty>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Pool de cuentas del proyecto: así nadie tiene que rotar ni compartir claves por chat. Los valores se guardan cifrados y cada vez que alguien los ve queda registrado.
      </p>
      {canManage && (
        <form onSubmit={add} className="grid items-end gap-3 rounded-lg border border-foreground/10 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="acc-label">Nombre</Label>
            <Input id="acc-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Panel de hosting" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acc-kind">Tipo</Label>
            <select id="acc-kind" className={cn(selectClass, "w-full")} value={kind} onChange={(e) => setKind(e.target.value as AccountKind)}>
              {ACCOUNT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {ACCOUNT_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acc-url">Enlace (opcional)</Label>
            <Input id="acc-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acc-user">Usuario (opcional)</Label>
            <Input id="acc-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acc-secret">Clave o token</Label>
            <Input id="acc-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" />
          </div>
          <Button type="submit" disabled={label.trim().length < 2 || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            Guardar cuenta
          </Button>
        </form>
      )}
      <ErrorLine error={formError ?? (error ? message(error, "No se pudieron cargar las cuentas.") : null)} />
      {isLoading ? (
        <Loading />
      ) : !accounts?.length ? (
        <Empty>Este proyecto aún no tiene cuentas guardadas.</Empty>
      ) : (
        <ul className="space-y-2">
          {accounts.map((a) => (
            <AccountRow key={a.id} projectId={projectId} account={a} canManage={canManage} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Reuniones ----------------------------------------------------------------------

export function MeetingsTab({ projectId, canWork }: { projectId: string; canWork: boolean }) {
  const refresh = useRefresh(projectId);
  const { data: meetings, isLoading, error } = useQuery(meetingsQuery(projectId));
  const [title, setTitle] = useState("");
  const [heldAt, setHeldAt] = useState("");
  const [summary, setSummary] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const lines = (value: string) => value.split("\n").map((l) => l.trim()).filter(Boolean);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (title.trim().length < 3 || !heldAt) return;
    setBusy(true);
    setFormError(null);
    try {
      await createMeeting(projectId, {
        title: title.trim(),
        heldAt: new Date(heldAt).toISOString(),
        ...(summary.trim() ? { summary: summary.trim() } : {}),
        ...(lines(feedback).length ? { feedback: lines(feedback) } : {}),
      });
      setTitle("");
      setHeldAt("");
      setSummary("");
      setFeedback("");
      await refresh();
    } catch (err) {
      setFormError(message(err, "No se pudo registrar la reunión."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Log de reuniones del proyecto. El procesamiento automático de las reuniones de Read.ai (resumen, feedback y action items) llega en la siguiente fase; por ahora se registran a mano.
      </p>
      {canWork && (
        <form onSubmit={add} className="grid gap-3 rounded-lg border border-foreground/10 p-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="meet-title">Reunión</Label>
            <Input id="meet-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Kick Off con el cliente" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meet-date">Fecha y hora</Label>
            <Input id="meet-date" type="datetime-local" value={heldAt} onChange={(e) => setHeldAt(e.target.value)} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="meet-summary">Resumen (opcional)</Label>
            <textarea id="meet-summary" rows={3} className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" value={summary} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="meet-feedback">Feedback del cliente (uno por línea, opcional)</Label>
            <textarea id="meet-feedback" rows={3} className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          </div>
          <div>
            <Button type="submit" disabled={title.trim().length < 3 || !heldAt || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />}
              Registrar reunión
            </Button>
          </div>
        </form>
      )}
      <ErrorLine error={formError ?? (error ? message(error, "No se pudieron cargar las reuniones.") : null)} />
      {isLoading ? (
        <Loading />
      ) : !meetings?.length ? (
        <Empty>Aún no hay reuniones registradas.</Empty>
      ) : (
        <ul className="space-y-2">
          {meetings.map((m) => (
            <li key={m.id} className="rounded-lg border border-foreground/10 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{m.title}</p>
                <Badge variant="outline">{m.source === "read_ai" ? "Read.ai" : "Manual"}</Badge>
                {m.status === "pending" && <Badge variant="secondary">Pendiente de procesar</Badge>}
                <span className="ml-auto text-xs text-muted-foreground">{dateText(m.heldAt)}</span>
              </div>
              {m.summary && <p className="mt-2 text-sm whitespace-pre-wrap">{m.summary}</p>}
              {m.feedback.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                  {m.feedback.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Updates ------------------------------------------------------------------------

export function UpdatesTab({ projectId, canWork }: { projectId: string; canWork: boolean }) {
  const refresh = useRefresh(projectId);
  const { data: updates, isLoading, error } = useQuery(updatesQuery(projectId));
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setFormError(null);
    try {
      await createUpdate(projectId, body.trim());
      setBody("");
      await refresh();
    } catch (err) {
      setFormError(message(err, "No se pudo publicar la novedad."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {canWork && (
        <form onSubmit={add} className="space-y-2">
          <Label htmlFor="update-body">Nueva novedad del proyecto</Label>
          <textarea
            id="update-body"
            rows={3}
            className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="¿Qué pasó con el proyecto?"
          />
          <Button type="submit" disabled={!body.trim() || busy}>
            {busy && <Loader2 className="animate-spin" />}
            Publicar
          </Button>
        </form>
      )}
      <ErrorLine error={formError ?? (error ? message(error, "No se pudieron cargar las novedades.") : null)} />
      {isLoading ? (
        <Loading />
      ) : !updates?.length ? (
        <Empty>Aún no hay novedades.</Empty>
      ) : (
        <ol className="space-y-2">
          {updates.map((u) => (
            <li key={u.id} className={cn("rounded-lg border p-3", u.kind === "system" ? "border-dashed border-foreground/15 bg-foreground/[0.02]" : "border-foreground/10")}>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{u.kind === "system" ? "Sistema" : u.authorName}</span>
                {u.kind === "system" && <span>· {u.authorName}</span>}
                <span className="ml-auto">{dateText(u.createdAt)}</span>
              </div>
              <p className="mt-1 text-sm whitespace-pre-wrap">{u.body}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
