import { Users } from "lucide-react";
import { setTeamFilter, useTeamFilter, useTeams } from "@/features/admin/api";
import { selectClass } from "@/features/admin/TeamAssignCard";
import { useIsBoss } from "@/features/auth/auth";

/** Jefes: acotar Dashboard, Proyectos y Costos a un equipo (o ver todos). */
export default function TeamSelector() {
  const isBoss = useIsBoss();
  const teamId = useTeamFilter();
  const teams = useTeams();
  if (!isBoss) return null;
  // Un equipo guardado que ya no existe se ignora.
  const value = teams.data?.some((t) => t.id === teamId) ? teamId! : "";
  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <Users className="size-4" />
      <span className="sr-only">Equipo</span>
      <select aria-label="Filtrar por equipo" className={selectClass} value={value} onChange={(e) => setTeamFilter(e.target.value || null)}>
        <option value="">Todos los equipos</option>
        {teams.data?.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
    </label>
  );
}
