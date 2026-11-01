import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createDeal } from "@/features/core/api";
import { errorText, toast } from "@/lib/toast";
import type { Lead } from "./api";

/** Crea el deal ligado al lead (con su contacto) y lo abre. */
export function useCreateDeal(lead: Pick<Lead, "id" | "title" | "contactId"> | null) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  async function create() {
    if (!lead) return;
    setBusy(true);
    try {
      const { deal } = await createDeal({ title: lead.title.length >= 3 ? lead.title : `Deal ${lead.title}`, leadId: lead.id, contactIds: lead.contactId ? [lead.contactId] : [] });
      toast.success(`Deal ${deal.dealCode} creado`);
      navigate(`/deals/${deal.id}`);
    } catch (err) {
      toast.error("No se pudo crear el deal.", { description: errorText(err, "Inténtalo de nuevo.") });
    } finally {
      setBusy(false);
    }
  }
  return { create, busy };
}
