import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { moveProject, useTeams } from "./api";

/** CEO/CCO: asignar el proyecto a un equipo o moverlo a otro. */
export default function TeamAssignCard({ slug, teamId }: { slug: string; teamId: string | null }) {
  const queryClient = useQueryClient();
  const teams = useTeams();
  const [value, setValue] = useState(teamId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await moveProject(slug, value || null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client", slug] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "teams"] }),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cambiar el equipo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4 text-brand-300" />
          Equipo
        </CardTitle>
        <CardDescription>Solo los miembros del equipo ven y operan el proyecto. Sin equipo, solo lo ven los CEO/CCO.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Select
          label="Equipo del proyecto"
          className="w-auto min-w-48"
          value={value || null}
          emptyLabel="Sin equipo"
          options={(teams.data ?? []).map((team) => ({ value: team.id, label: team.name }))}
          onValueChange={(v) => setValue((v ?? ""))}
        />
        <Button size="sm" onClick={save} disabled={busy || value === (teamId ?? "")}>
          {busy && <Loader2 className="animate-spin" />}
          {teamId ? "Mover" : "Asignar"}
        </Button>
        {error && <p className="w-full text-sm text-danger-fg">{error}</p>}
      </CardContent>
    </Card>
  );
}
