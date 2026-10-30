import { type FormEvent, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api-client";
import { createServer } from "./api";

const EMPTY = { name: "", host: "", sshPort: "22", appsDomain: "", publicIp: "" };

/** Alta de un servidor: solo datos públicos. Launchpad genera la clave del provisioner. */
export default function NewServerForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field = (name: keyof typeof EMPTY) => ({
    id: `server-${name}`,
    value: values[name],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [name]: e.target.value })),
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createServer({
        name: values.name.trim(),
        host: values.host.trim().toLowerCase(),
        sshPort: Number(values.sshPort) || 22,
        appsDomain: values.appsDomain.trim().toLowerCase(),
        publicIp: values.publicIp.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: ["servers"] });
      setValues(EMPTY);
      onCreated();
    } catch (e) {
      const issues = e instanceof ApiError ? (e.body as { issues?: { path: string; message: string }[] } | null)?.issues : undefined;
      setError(issues?.length ? issues.map((i) => `${i.path}: ${i.message}`).join(" · ") : e instanceof Error ? e.message : "No se pudo dar de alta.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nuevo servidor</CardTitle>
        <CardDescription>
          No se piden contraseñas ni claves: Launchpad genera una clave propia para este servidor y te da la parte pública para instalarla.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="server-name">Nombre</Label>
            <Input {...field("name")} placeholder="VPS Europa" maxLength={60} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="server-appsDomain">Dominio de apps</Label>
            <Input {...field("appsDomain")} placeholder="apps2.tu-dominio.net" required />
            <p className="text-xs text-muted-foreground">Cada proyecto será &lt;proyecto&gt;.dominio. Necesita el registro A *.dominio.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="server-host">Host SSH</Label>
            <Input {...field("host")} placeholder="vps2.tu-dominio.net o 203.0.113.20" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="server-sshPort">Puerto SSH</Label>
            <Input {...field("sshPort")} inputMode="numeric" placeholder="22" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="server-publicIp">IP pública</Label>
            <Input {...field("publicIp")} placeholder="203.0.113.20" required />
            <p className="text-xs text-muted-foreground">A la que apunta el comodín *.dominio.</p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger-fg sm:col-span-2">
              {error}
            </p>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />}
              Dar de alta
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
