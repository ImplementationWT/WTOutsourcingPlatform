import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { moveProject, useTeams } from "./api";

export const selectClass =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

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
          <Users className="size-4 text-violet-300" />
          Equipo
        </CardTitle>
        <CardDescription>Solo los miembros del equipo ven y operan el proyecto. Sin equipo, solo lo ven los CEO/CCO.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <select aria-label="Equipo del proyecto" className={selectClass} value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Sin equipo</option>
          {teams.data?.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={save} disabled={busy || value === (teamId ?? "")}>
          {busy && <Loader2 className="animate-spin" />}
          {teamId ? "Mover" : "Asignar"}
        </Button>
        {error && <p className="w-full text-sm text-red-300">{error}</p>}
      </CardContent>
    </Card>
  );
}
