import { DealsTable } from "./DealsTable";
import { PageHeader } from "@/components/layout/PageHeader";

/** Deals: tabla de primer nivel compartida por Comercial y Operativa. */
export default function DealsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Deals" description="Cada deal es un trato por horas: valor = horas × tarifa y valor proyectado = valor × probabilidad." />
      <DealsTable />
    </div>
  );
}
