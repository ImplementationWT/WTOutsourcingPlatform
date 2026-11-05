import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConfirm } from "@/components/ui/confirm-context";
import { Copy, ExternalLink, Eye, EyeOff, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api-client";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Empty, ErrorLine, Loading, MeetingsPanel, UpdatesPanel } from "@/features/activity/ActivityPanels";
import { activityKeys, dateText } from "@/features/activity/api";
import { useProjectDeals } from "@/features/core/api";
import { DealsTable } from "@/features/core/DealsTable";
import {
  ACCOUNT_KIND_LABELS,
  ACCOUNT_KINDS,
  accountsQuery,
  createAccount,
  createProposal,
  createTask,
  deleteAccount,
  hoursText,
  money,
  opsBase,
  opsKeys,
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_STATUSES,
  proposalsQuery,
  revealAccount,
  rotateAccount,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  tasksQuery,
  updateProposal,
  updateTask,
  useTeamMembers,
  type AccountKind,
  type OpsTask,
  type Proposal,
  type ProposalStatus,
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
      queryClient.invalidateQueries({ queryKey: activityKeys.updates(opsBase(projectId)) }),
    ]);
  };
}

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

// ---- Deals --------------------------------------------------------------------------

/** Deals del proyecto: la misma tabla de primer nivel, filtrada por el proyecto. */
export function DealsTab({ projectId, startCreating = false }: { projectId: string; startCreating?: boolean }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Cada deal es un trato por un módulo o funcionalidad, vendido por horas. Las horas vendidas del proyecto suman sus deals aprobados en adelante.</p>
      <DealsTable projectId={projectId} prefix="d." startCreating={startCreating} />
    </div>
  );
}

// ---- Tasks --------------------------------------------------------------------------

export function TasksTab({ projectId, teamId, canWork, canManage, currentUserId }: { projectId: string; teamId: string; canWork: boolean; canManage: boolean; currentUserId: string }) {
  const refresh = useRefresh(projectId);
  const { data: tasks, isLoading, error } = useQuery(tasksQuery(projectId));
  const { data: deals } = useProjectDeals(projectId);
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
            <Select
              id="task-deal"
              value={dealId || null}
              emptyLabel="Sin deal"
              options={(deals ?? []).map((d) => ({ value: d.id, label: `${d.dealCode} · ${d.title}` }))}
              onValueChange={(v) => setDealId((v ?? ""))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-assignee">Responsable</Label>
            <Select
              id="task-assignee"
              value={assigneeId || null}
              emptyLabel="Sin asignar"
              options={members.map((m) => ({ value: m.id, label: m.name }))}
              onValueChange={(v) => setAssigneeId((v ?? ""))}
            />
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
              <li key={task.id} className="grid items-center gap-3 rounded-lg border border-foreground/10 p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)_10rem]">
                <div className="min-w-0">
                  <p className={cn("truncate font-medium", task.status === "done" && "text-muted-foreground line-through")}>{task.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {task.dealId ? (dealName.get(task.dealId) ?? "Deal") : "Sin deal"}
                    {task.dueDate ? ` · vence ${formatDate(task.dueDate)}` : ""}
                  </p>
                </div>
                <p className="truncate text-sm">{task.assigneeName ?? "Sin asignar"}</p>
                <p className="text-sm tabular-nums text-muted-foreground">{hoursText(task.estimatedHours)}</p>
                {editable ? (
                  <Select
                    label={`Estado de ${task.title}`}
                    value={task.status}
                    options={TASK_STATUSES.map((s) => ({ value: s, label: TASK_STATUS_LABELS[s] }))}
                    onValueChange={(v) => void setStatus(task, (v ?? "") as TaskStatus)}
                  />
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

function AccountRow({ projectId, account, canManage }: { projectId: string; account: VaultAccount; canManage: boolean }) {
  const confirm = useConfirm();
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

  // Lo revelado se oculta solo a los 30 s (y nunca queda en la caché de consultas).
  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(() => setRevealed(null), 30_000);
    return () => window.clearTimeout(timer);
  }, [revealed]);
  const box = "flex h-10 min-w-0 items-center rounded-[10px] border border-border bg-muted px-3 text-sm";
  return (
    <li className="space-y-2">
      <div className={ACCOUNT_COLS}>
        <p className={cn(box, "font-bold")} title={ACCOUNT_KIND_LABELS[account.kind]}>
          <span className="truncate">{account.label}</span>
        </p>
        <p className={box}>
          <span className="truncate">{revealed?.username ?? account.username ?? "—"}</span>
        </p>
        <div className="flex min-w-0 items-center gap-1">
          <p className={cn(box, "min-w-0 flex-1 font-mono", !revealed && "tracking-widest")}>
            <span className="truncate">{revealed ? revealed.credential : account.credentialSet ? "•••••••••••••" : "Sin valor"}</span>
          </p>
          {account.credentialSet &&
            (revealed ? (
              <button type="button" aria-label="Ocultar" title="Ocultar" onClick={() => setRevealed(null)} className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
                <EyeOff className="size-4" />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Ver"
                title="Ver la contraseña (queda registrado)"
                disabled={busy !== null}
                onClick={() =>
                  run("reveal", async () => {
                    setRevealed(await revealAccount(projectId, account.id));
                  })
                }
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {busy === "reveal" ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
              </button>
            ))}
          {revealed && (
            <button type="button" aria-label="Copiar la contraseña" title="Copiar" onClick={() => void navigator.clipboard?.writeText(revealed.credential).catch(() => undefined)} className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
              <Copy className="size-4" />
            </button>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1">
          <p className={cn(box, "min-w-0 flex-1")}>
            <span className="truncate">{account.url ?? "—"}</span>
          </p>
          {account.url && (
            <a href={account.url} target="_blank" rel="noreferrer" aria-label={`Abrir ${account.label}`} title="Abrir la página" className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
              <ExternalLink className="size-4" />
            </a>
          )}
        </div>
        <div className="flex items-center">
          {canManage && (
            <>
              <button type="button" aria-label={`Rotar ${account.label}`} title="Rotar la contraseña" disabled={busy !== null} onClick={() => setRotating((v) => !v)} className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
                <KeyRound className="size-4" />
              </button>
              <button
                type="button"
                aria-label={`Eliminar ${account.label}`}
                disabled={busy !== null}
                className="inline-flex size-9 items-center justify-center rounded-lg text-[var(--chip-red-fg)] hover:bg-accent-soft"
                onClick={async () => {
                  const ok = await confirm({
                    title: `¿Eliminar la cuenta «${account.label}»?`,
                    description: "Se borran su usuario y su clave guardados en el vault. No se puede deshacer.",
                    confirmLabel: "Eliminar cuenta",
                    tone: "danger",
                  });
                  if (!ok) return;
                  void run("delete", async () => {
                    await deleteAccount(projectId, account.id);
                    await refresh();
                  });
                }}
              >
                <Trash2 className="size-4" />
              </button>
            </>
          )}
        </div>
      </div>
      {rotating && (
        <form
          className="flex flex-wrap items-center gap-2 pl-1"
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
          <Input aria-label="Nuevo valor" type="password" autoComplete="new-password" className="h-10 max-w-xs rounded-[10px] bg-muted" value={next} onChange={(e) => setNext(e.target.value)} placeholder="Nueva contraseña" />
          <Button type="submit" disabled={!next || busy !== null}>
            {busy === "rotate" && <Loader2 className="animate-spin" />}
            Guardar
          </Button>
          {account.rotatedAt && <span className="text-xs text-muted-foreground">Rotada {dateText(account.rotatedAt)}</span>}
        </form>
      )}
      <ErrorLine error={error} />
    </li>
  );
}

/** Columnas de la tabla de cuentas (prototipo): nombre, usuario, contraseña, link y acciones. */
const ACCOUNT_COLS = "grid grid-cols-[minmax(9rem,1fr)_minmax(9rem,1fr)_minmax(10rem,1.1fr)_minmax(11rem,1.2fr)_4.75rem] items-center gap-2.5";

export function AccountsTab({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const refresh = useRefresh(projectId);
  const { data: accounts, isLoading, error } = useQuery(accountsQuery(projectId, true));
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<AccountKind>("web");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
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
      setAdding(false);
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">Accesos de este cliente: cada cuenta guarda un nombre, usuario, contraseña (oculta, cifrada y con registro de quién la ve) y el link de su página.</p>
        {canManage && !adding && (
          <Button size="lg" onClick={() => setAdding(true)}>
            <Plus /> Nueva cuenta
          </Button>
        )}
      </div>
      {canManage && adding && (
        <form onSubmit={add} aria-label="Nueva cuenta" className="grid items-end gap-3 rounded-xl border border-primary p-4 shadow-[0_0_0_3px_var(--accent-soft)] sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="acc-label" className="text-caps-label">Nombre</Label>
            <Input id="acc-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Hosting" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acc-kind" className="text-caps-label">Tipo</Label>
            <Select id="acc-kind" value={kind} options={ACCOUNT_KINDS.map((k) => ({ value: k, label: ACCOUNT_KIND_LABELS[k] }))} onValueChange={(v) => setKind((v ?? "") as AccountKind)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acc-url" className="text-caps-label">Link de página</Label>
            <Input id="acc-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acc-user" className="text-caps-label">Usuario</Label>
            <Input id="acc-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acc-secret" className="text-caps-label">Contraseña</Label>
            <Input id="acc-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" />
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => setAdding(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={label.trim().length < 2 || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />}
              Guardar cuenta
            </Button>
          </div>
        </form>
      )}
      <ErrorLine error={formError ?? (error ? message(error, "No se pudieron cargar las cuentas.") : null)} />
      {isLoading ? (
        <Loading />
      ) : !accounts?.length ? (
        <Empty>Este proyecto aún no tiene cuentas guardadas.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[52rem] space-y-2.5">
            <div className={cn(ACCOUNT_COLS, "border-b border-border pb-2.5 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase")}>
              {["Nombre", "Usuario", "Contraseña", "Link de página", "Act"].map((h) => (
                <span key={h}>{h}</span>
              ))}
            </div>
            <ul className="space-y-2.5">
              {accounts.map((a) => (
                <AccountRow key={a.id} projectId={projectId} account={a} canManage={canManage} />
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Propuestas ---------------------------------------------------------------------

export function ProposalsTab({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const refresh = useRefresh(projectId);
  const { data: proposals, isLoading, error } = useQuery(proposalsQuery(projectId));
  const { data: deals } = useProjectDeals(projectId);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [dealId, setDealId] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const dealName = new Map((deals ?? []).map((d) => [d.id, d.title]));
  const valid = title.trim().length >= 3 && /^https?:\/\//i.test(url.trim()) && (amount === "" || Number(amount) >= 0);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setFormError(null);
    try {
      await createProposal(projectId, { title: title.trim(), url: url.trim(), dealId: dealId || null, ...(amount ? { amountCents: Math.round(Number(amount) * 100) } : {}) });
      setTitle("");
      setUrl("");
      setDealId("");
      setAmount("");
      await refresh();
    } catch (err) {
      setFormError(message(err, "No se pudo crear la propuesta."));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(proposal: Proposal, status: ProposalStatus) {
    setFormError(null);
    try {
      await updateProposal(projectId, proposal.id, { status });
      await refresh();
    } catch (err) {
      setFormError(message(err, "No se pudo cambiar el estado."));
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Propuestas del proyecto: la inicial de Comercial y las que se arman aquí para nuevos módulos. Si se liga a un deal, queda como la propuesta de ese deal.</p>
      {canManage && (
        <form onSubmit={add} className="grid items-end gap-3 rounded-lg border border-foreground/10 p-4 sm:grid-cols-2 lg:grid-cols-[1.5fr_2fr_1.2fr_0.8fr_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="prop-title">Propuesta</Label>
            <Input id="prop-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ampliación: módulo de pagos" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prop-url">Enlace</Label>
            <Input id="prop-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prop-deal">Deal</Label>
            <Select
              id="prop-deal"
              value={dealId || null}
              emptyLabel="Sin deal"
              options={(deals ?? []).map((d) => ({ value: d.id, label: `${d.dealCode} · ${d.title}` }))}
              onValueChange={(v) => setDealId((v ?? ""))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prop-amount">Monto (USD)</Label>
            <Input id="prop-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Opcional" />
          </div>
          <Button type="submit" disabled={!valid || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            Agregar
          </Button>
        </form>
      )}
      <ErrorLine error={formError ?? (error ? message(error, "No se pudieron cargar las propuestas.") : null)} />
      {isLoading ? (
        <Loading />
      ) : !proposals?.length ? (
        <Empty>Este proyecto aún no tiene propuestas.</Empty>
      ) : (
        <ul className="space-y-2">
          {proposals.map((p) => (
            <li key={p.id} className="grid items-center gap-3 rounded-lg border border-foreground/10 p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_10rem]">
              <div className="min-w-0">
                <a className="truncate font-medium text-primary underline-offset-4 hover:underline" href={p.url} target="_blank" rel="noreferrer">
                  {p.title}
                </a>
                <p className="truncate text-xs text-muted-foreground">
                  {p.area === "commercial" ? "Comercial" : "Operativa"}
                  {p.dealId ? ` · ${dealName.get(p.dealId) ?? "Deal"}` : ""}
                </p>
              </div>
              <p className="text-sm tabular-nums">{p.amountCents !== null ? money(p.amountCents, p.currency) : "—"}</p>
              <p className="text-xs text-muted-foreground">{p.sentAt ? `Enviada ${dateText(p.sentAt)}` : ""}</p>
              {canManage ? (
                <Select
                  label={`Estado de ${p.title}`}
                  value={p.status}
                  options={PROPOSAL_STATUSES.map((s) => ({ value: s, label: PROPOSAL_STATUS_LABELS[s] }))}
                  onValueChange={(v) => void setStatus(p, (v ?? "") as ProposalStatus)}
                />
              ) : (
                <Badge variant="outline">{PROPOSAL_STATUS_LABELS[p.status]}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Reuniones y updates ---------------------------------------------------------------

/** Reuniones del proyecto: Claude propone; el Team Leader convierte los action items en Tasks o Change Orders. */
export function MeetingsTab({ projectId, canWork }: { projectId: string; canWork: boolean }) {
  const { data: deals } = useProjectDeals(projectId);
  return <MeetingsPanel base={opsBase(projectId)} canWork={canWork} deals={(deals ?? []).map((d) => ({ id: d.id, dealCode: d.dealCode, title: d.title }))} />;
}

export function UpdatesTab({ projectId, canWork }: { projectId: string; canWork: boolean }) {
  const refresh = useRefresh(projectId);
  return <UpdatesPanel base={opsBase(projectId)} canWork={canWork} onPosted={refresh} />;
}
