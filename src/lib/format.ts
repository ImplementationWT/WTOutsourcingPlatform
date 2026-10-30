// Formatos únicos para todo el panel: montos, fechas y horas siempre con el mismo locale.

export const LOCALE = "es-PE";

const moneyFormats = new Map<string, Intl.NumberFormat>();

/** Centavos → "USD 2,380.00" (siempre 2 decimales, mismo formato en todas las pantallas). */
export function formatMoney(cents: number | null | undefined, currency = "USD") {
  if (cents === null || cents === undefined) return "—";
  let format = moneyFormats.get(currency);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    moneyFormats.set(currency, format);
  }
  return format.format(cents / 100);
}

/** Acepta ISO completo o fecha sola "AAAA-MM-DD" (sin corrimiento de zona horaria). */
const toDate = (value: string | Date) => (value instanceof Date ? value : /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value));

/** "29 oct. 2026" */
export const formatDate = (value: string | Date) => toDate(value).toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" });

/** "29 oct. 2026, 3:00 p. m." */
export const formatDateTime = (value: string | Date) => toDate(value).toLocaleString(LOCALE, { dateStyle: "medium", timeStyle: "short" });

/** "29 oct., 15:00": para listas donde el año sobra. */
export const formatShortDateTime = (value: string | Date) => toDate(value).toLocaleString(LOCALE, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

/** "15:00" */
export const formatTime = (value: string | Date) => toDate(value).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
