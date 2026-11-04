import { Chip } from "@/components/ui/chip";
import { LEAD_STATUS_CHIP, LEAD_STATUS_LABELS, LEAD_TEMPERATURE_CHIP, LEAD_TEMPERATURE_LABELS, type LeadStatus, type LeadTemperature } from "./api";

export function LeadStatusBadge({ value }: { value: LeadStatus }) {
  return <Chip color={LEAD_STATUS_CHIP[value]}>{LEAD_STATUS_LABELS[value]}</Chip>;
}

export function TemperatureBadge({ value }: { value: LeadTemperature }) {
  return <Chip color={LEAD_TEMPERATURE_CHIP[value]}>{LEAD_TEMPERATURE_LABELS[value]}</Chip>;
}
