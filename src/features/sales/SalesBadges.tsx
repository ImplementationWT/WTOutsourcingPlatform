import { cn } from "@/lib/utils";
import { LEAD_STATUS_LABELS, LEAD_STATUS_TONE, LEAD_TEMPERATURE_LABELS, LEAD_TEMPERATURE_TONE, type LeadStatus, type LeadTemperature } from "./api";

export function LeadStatusBadge({ value }: { value: LeadStatus }) {
  return <span className={cn("inline-flex h-5 w-fit items-center rounded-full px-2 text-xs font-medium whitespace-nowrap", LEAD_STATUS_TONE[value])}>{LEAD_STATUS_LABELS[value]}</span>;
}

export function TemperatureBadge({ value }: { value: LeadTemperature }) {
  return <span className={cn("inline-flex h-5 w-fit items-center rounded-full px-2 text-xs font-medium whitespace-nowrap", LEAD_TEMPERATURE_TONE[value])}>{LEAD_TEMPERATURE_LABELS[value]}</span>;
}
