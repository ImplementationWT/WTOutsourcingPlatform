import { z } from "zod";
import { PROPOSAL_STATUSES, type ProposalDoc, type ProposalStatus } from "./models.js";

const url = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v), "Debe empezar por http:// o https://");

const fields = {
  title: z.string().trim().min(3).max(160),
  url,
  amountCents: z.number().int().min(0).max(100_000_000_000).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.enum(PROPOSAL_STATUSES),
  dealId: z.string().uuid().nullable()
};

export const createProposalSchema = z
  .object({ title: fields.title, url: fields.url, amountCents: fields.amountCents.optional(), currency: fields.currency.optional(), status: fields.status.optional(), dealId: fields.dealId.optional() })
  .strict();

export const updateProposalSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "No hay nada que cambiar.");

export const PROPOSAL_LABELS: Record<ProposalStatus, string> = { draft: "Borrador", sent: "Enviada", accepted: "Aceptada", rejected: "Rechazada" };

/** Fechas que acompañan al estado: cuándo se envió y cuándo se decidió. */
export function statusDates(next: ProposalStatus, previous: ProposalStatus | null, at: Date) {
  const set: Partial<ProposalDoc> = {};
  if (next === previous) return set;
  if (next === "sent") set.sentAt = at;
  if (next === "accepted" || next === "rejected") set.decidedAt = at;
  return set;
}

export const proposalView = (proposal: ProposalDoc) => ({
  id: proposal._id,
  leadId: proposal.leadId,
  projectId: proposal.projectId,
  dealId: proposal.dealId,
  title: proposal.title,
  url: proposal.url,
  amountCents: proposal.amountCents,
  currency: proposal.currency,
  status: proposal.status,
  area: proposal.area,
  sentAt: proposal.sentAt ?? null,
  decidedAt: proposal.decidedAt ?? null,
  createdAt: proposal.createdAt,
  updatedAt: proposal.updatedAt
});
