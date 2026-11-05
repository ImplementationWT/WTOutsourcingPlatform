import { randomUUID } from "node:crypto";
import type { SessionUser } from "../auth/users.js";
import type { OpsProjectDoc } from "../ops/models.js";
import type { AdminStore } from "../store/admin-store.js";
import { leadTitle, type LeadDoc } from "./models.js";

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Lead ganado → proyecto nuevo, con lo que coincide del lead: nombre, cliente (el contacto del lead,
 * que se crea en Contactos si solo estaba escrito) con su empresa, Priority Medium, Stage Kick Off y
 * Sentiment Happy. El equipo es el que tiene menos proyectos activos (el CEO/CCO lo cambia en el
 * detalle) y su Team Leader queda como lead. Los deals y propuestas del lead pasan al proyecto.
 * Si el lead ya tenía proyecto, no se crea otro.
 */
export async function projectFromWonLead(store: AdminStore, user: SessionUser, lead: LeadDoc): Promise<OpsProjectDoc | null> {
  if (lead.projectId) return null;
  const teams = await store.teams.find({}).toArray();
  if (!teams.length) return null;
  const load = await store.opsProjects.aggregate<{ _id: string; n: number }>([{ $match: { stage: { $ne: "completed" } } }, { $group: { _id: "$teamId", n: { $sum: 1 } } }]).toArray();
  const count = new Map(load.map((r) => [r._id, r.n]));
  const team = [...teams].sort((a, b) => (count.get(a._id) ?? 0) - (count.get(b._id) ?? 0) || a.name.localeCompare(b.name, "es"))[0];

  const at = new Date();
  // El cliente del proyecto es un contacto: el enlazado al lead o uno nuevo con sus datos.
  let contactId = lead.contactId ?? null;
  if (!contactId && lead.contactName.trim()) {
    contactId = randomUUID();
    await store.contacts.insertOne({ _id: contactId, name: lead.contactName.trim(), emails: lead.email ? [lead.email] : [], phone: lead.phone ?? null, title: null, company: lead.company.trim() || null, linkedinUrl: null, createdBy: user.username, createdAt: at, updatedAt: at });
    await store.leads.updateOne({ _id: lead._id }, { $set: { contactId } });
  }

  const project: OpsProjectDoc = {
    _id: randomUUID(),
    name: (lead.name || leadTitle(lead)).slice(0, 80),
    customerName: (lead.company || lead.contactName || leadTitle(lead)).slice(0, 80),
    contactIds: contactId ? [contactId] : [],
    teamId: team._id,
    leadUserId: team.leadUserId ?? null,
    developerUserId: null,
    developerUserIds: [],
    clientSlug: null,
    sowUrl: null,
    kickoffDate: null,
    hourlyRateCents: null,
    stage: "kickoff",
    stageSince: today(),
    stageHistory: [{ stage: "kickoff", at: today(), by: user.username }],
    health: "happy",
    priority: "medium",
    paymentType: null,
    nextAction: null,
    leadId: lead._id,
    createdBy: user.username,
    createdAt: at,
    updatedAt: at
  };
  await store.opsProjects.insertOne(project);
  await store.leads.updateOne({ _id: lead._id }, { $set: { projectId: project._id, updatedAt: at } });
  // Lo que ya se vendió o se propuso al lead sigue en el proyecto.
  const deals = await store.deals.updateMany({ leadId: lead._id, projectId: null }, { $set: { projectId: project._id, teamId: team._id, updatedAt: at } });
  await store.proposals.updateMany({ leadId: lead._id, projectId: null }, { $set: { projectId: project._id, updatedAt: at } });
  await store.projectUpdates.insertOne({ _id: randomUUID(), projectId: project._id, kind: "system", body: `Proyecto creado al ganar el lead «${leadTitle(lead)}»${deals.modifiedCount ? ` (con ${deals.modifiedCount} ${deals.modifiedCount === 1 ? "deal" : "deals"})` : ""}.`, authorUsername: user.username, authorName: user.name, createdAt: at });
  await store.leadUpdates.insertOne({ _id: randomUUID(), leadId: lead._id, kind: "system", body: `Ganado: se creó el proyecto «${project.name}» en ${team.name}.`, authorUsername: user.username, authorName: user.name, createdAt: at });
  await store.audit({ actor: user.username, action: "ops.project_created_from_lead", clientId: `ops:${project._id}`, target: project.name, details: { leadId: lead._id, deals: deals.modifiedCount } });
  return project;
}
