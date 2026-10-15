import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Layers3, Lock, LogIn, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api-client";
import { login, SESSION_KEY, useSession } from "./auth";
import NeuralBackground from "./NeuralBackground";

const schema = z.object({
  username: z.string().min(1, "Ingresa tu usuario"),
  password: z.string().min(1, "Ingresa tu contraseña"),
});

type LoginValues = z.infer<typeof schema>;

const glassInput =
  "h-11 border-white/15 bg-white/5 dark:bg-white/5 pl-10 text-white placeholder:text-white/40 focus-visible:border-white/40 focus-visible:ring-white/20";

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({ resolver: zodResolver(schema) });

  if (session.data) return <Navigate to="/dashboard" replace />;

  const from = (location.state as { from?: string } | null)?.from ?? "/dashboard";

  async function onSubmit(values: LoginValues) {
    try {
      const user = await login(values.username, values.password);
      queryClient.setQueryData(SESSION_KEY, user);
      navigate(from, { replace: true });
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? "Usuario o contraseña incorrectos." : "No se pudo conectar con el servidor.");
    }
  }

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden bg-[radial-gradient(ellipse_at_top,#1e1b4b_0%,#0b0a1f_55%,#020617_100%)] px-4">
      <NeuralBackground />

      {/* Halos de color detrás del vidrio para que el blur tenga algo que difuminar */}
      <div className="pointer-events-none absolute top-1/2 left-1/2 size-[28rem] -translate-x-[60%] -translate-y-[60%] rounded-full bg-violet-600/30 blur-3xl" />
      <div className="pointer-events-none absolute top-1/2 left-1/2 size-80 -translate-x-[10%] -translate-y-[10%] rounded-full bg-sky-500/20 blur-3xl" />

      <div className="relative w-full max-w-sm rounded-2xl border border-white/15 bg-white/10 p-8 text-white shadow-[0_8px_32px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-xl border border-white/20 bg-white/10">
            <Layers3 className="size-6" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Forge</h1>
          <p className="mt-1 text-sm text-white/60">by Whatever Tech</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
          <div className="space-y-2">
            <Label htmlFor="username" className="text-white/80">Usuario</Label>
            <div className="relative">
              <User className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-white/50" />
              <Input
                id="username"
                autoComplete="username"
                placeholder="admin"
                className={glassInput}
                aria-invalid={!!errors.username}
                {...register("username", { onChange: () => setError(null) })}
              />
            </div>
            {errors.username && <p className="text-xs text-red-300">{errors.username.message}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="password" className="text-white/80">Contraseña</Label>
            <div className="relative">
              <Lock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-white/50" />
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                className={glassInput}
                aria-invalid={!!errors.password}
                {...register("password", { onChange: () => setError(null) })}
              />
            </div>
            {errors.password && <p className="text-xs text-red-300">{errors.password.message}</p>}
          </div>

          {error && (
            <p role="alert" className="rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </p>
          )}

          <Button
            type="submit"
            disabled={isSubmitting}
            className="h-11 w-full bg-white text-slate-900 hover:bg-white/90"
          >
            <LogIn />
            Ingresar
          </Button>
        </form>
      </div>
    </div>
  );
}
