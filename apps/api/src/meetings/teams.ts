import type { MeetingParticipant } from "../ops/models.js";
import type { AdminStore } from "../store/admin-store.js";

/**
 * Equipo de una reunión por sus participantes: el del Team Leader cuyo correo está en la reunión.
 * Si el dueño de la grabación es un Team Leader, gana su equipo; si aparecen Team Leaders de
 * varios equipos y ninguno grabó, queda sin equipo (lo asigna el CEO/CCO).
 */
export async function teamFromParticipants(store: AdminStore, participants: MeetingParticipant[], ownerEmail?: string | null) {
  const emails = [...new Set(participants.map((p) => p.email).filter((e): e is string => Boolean(e)))];
  if (ownerEmail && !emails.includes(ownerEmail)) emails.push(ownerEmail);
  if (!emails.length) return null;
  const leads = await store.users.find({ role: "lead", active: true, email: { $in: emails }, teamId: { $type: "string" } }, { projection: { email: 1, teamId: 1 } }).toArray();
  const owner = ownerEmail ? leads.find((l) => l.email === ownerEmail) : undefined;
  if (owner?.teamId) return owner.teamId;
  const teams = [...new Set(leads.map((l) => l.teamId).filter((t): t is string => Boolean(t)))];
  return teams.length === 1 ? teams[0] : null;
}
