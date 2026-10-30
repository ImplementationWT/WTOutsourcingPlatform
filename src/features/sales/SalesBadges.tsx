import { cn } from "@/lib/utils";
import { LEAD_STATUS_LABELS, LEAD_STATUS_TONE, type LeadStatus } from "./api";

export function LeadStatusBadge({ value }: { value: LeadStatus }) {
  return <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap", LEAD_STATUS_TONE[value])}>{LEAD_STATUS_LABELS[value]}</span>;
}
