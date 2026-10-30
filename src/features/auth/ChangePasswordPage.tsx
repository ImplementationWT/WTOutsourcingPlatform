import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { applyTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { changePassword, logout, SESSION_KEY, useSession } from "./auth";
import NeuralBackground from "./NeuralBackground";

const MIN_LENGTH = 10;

/** Formulario de cambio de la contraseña propia (también el obligatorio del primer ingreso). */
export function ChangePasswordForm({ glass = false, onDone }: { glass?: boolean; onDone?: () => void }) {
  const queryClient = useQueryClient();
  const username = useSession().data?.username ?? "";
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const localError =
    next && next.length < MIN_LENGTH
      ? `Al menos ${MIN_LENGTH} caracteres.`
      : next && next.toLowerCase() === username.toLowerCase()
        ? "No puede ser igual a tu usuario."
        : repeat && next !== repeat
          ? "Las contraseñas no coinciden."
          : null;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (localError || !current || !next || next !== repeat) return;
    setSaving(true);
    setError(null);
    try {
      const user = await changePassword(current, next);
      queryClient.setQueryData(SESSION_KEY, user);
      setCurrent("");
      setNext("");
      setRepeat("");
      setSaved(true);
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cambiar la contraseña.");
    } finally {
      setSaving(false);
    }
  }

  const input = cn(glass && "h-11 border-foreground/15 bg-foreground/5 text-white placeholder:text-foreground/40");
  const field = (id: string, label: string, value: string, set: (v: string) => void, autoComplete: string) => (
    <div className="space-y-2">
      <Label htmlFor={id} className={cn(glass && "text-foreground/80")}>
        {label}
      </Label>
      <Input
        id={id}
        type="password"
        autoComplete={autoComplete}
        value={value}
        className={input}
        onChange={(e) => {
          set(e.target.value);
          setError(null);
          setSaved(false);
        }}
      />
    </div>
  );

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {field("current-password", "Contraseña actual", current, setCurrent, "current-password")}
      {field("new-password", "Nueva contraseña", next, setNext, "new-password")}
      {field("repeat-password", "Repite la nueva contraseña", repeat, setRepeat, "new-password")}
      <p className={cn("text-xs", localError ? "text-red-300" : "text-muted-foreground")}>
        {localError ?? `Mínimo ${MIN_LENGTH} caracteres. Usa una frase que no uses en otro sitio.`}
      </p>
      {error && (
        <p role="alert" className="rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}
      {saved && !onDone && <p className="text-sm text-emerald-400">Contraseña actualizada.</p>}
      <Button
        type="submit"
        disabled={saving || Boolean(localError) || !current || !next || next !== repeat}
        className={cn(glass && "h-11 w-full bg-white text-slate-900 hover:bg-foreground/90")}
      >
        {saving ? <Loader2 className="animate-spin" /> : <KeyRound />}
        Cambiar contraseña
      </Button>
    </form>
  );
}

/** Pantalla completa del cambio obligatorio (primer ingreso o contraseña restablecida). */
export default function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  useEffect(() => applyTheme("dark"), []);
  const queryClient = useQueryClient();
  const name = useSession().data?.name;

  async function handleLogout() {
    await logout();
    queryClient.clear();
    queryClient.setQueryData(SESSION_KEY, null);
  }

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden bg-[#0d0d12] px-4">
      <NeuralBackground />
      <div className="relative w-full max-w-sm rounded-2xl border border-foreground/15 bg-[#141418]/80 p-8 text-white shadow-[0_8px_32px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border border-foreground/20 bg-foreground/10">
            <KeyRound className="size-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{name ? `Hola, ${name}` : "Cambia tu contraseña"}</h1>
          <p className="mt-2 text-sm text-foreground/60">
            {forced ? "Antes de continuar, elige una contraseña nueva. La que te dieron era temporal." : "Elige una contraseña nueva."}
          </p>
        </div>
        <ChangePasswordForm glass />
        <button type="button" onClick={handleLogout} className="mx-auto mt-6 flex items-center gap-1.5 text-xs text-foreground/50 hover:text-foreground/80">
          <LogOut className="size-3.5" />
          Salir
        </button>
      </div>
    </div>
  );
}
