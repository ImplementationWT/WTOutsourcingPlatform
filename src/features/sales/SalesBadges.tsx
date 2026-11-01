import { StatusBadge } from "@/components/ui/status-badge";
import { LEAD_STATUS_LABELS, LEAD_STATUS_TONE, LEAD_TEMPERATURE_LABELS, LEAD_TEMPERATURE_TONE, type LeadStatus, type LeadTemperature } from "./api";

export function LeadStatusBadge({ value }: { value: LeadStatus }) {
  return <StatusBadge tone={LEAD_STATUS_TONE[value]}>{LEAD_STATUS_LABELS[value]}</StatusBadge>;
}

export function TemperatureBadge({ value }: { value: LeadTemperature }) {
  return <StatusBadge tone={LEAD_TEMPERATURE_TONE[value]}>{LEAD_TEMPERATURE_LABELS[value]}</StatusBadge>;
}
