import { DealsTable } from "./DealsTable";

/** Deals: tabla de primer nivel compartida por Comercial y Operativa. */
export default function DealsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Deals</h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">Cada deal es un trato por horas: valor = horas × tarifa y valor proyectado = valor × probabilidad.</p>
      </div>
      <DealsTable />
    </div>
  );
}
