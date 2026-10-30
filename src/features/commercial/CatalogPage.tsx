import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { tableSelectClass } from "@/components/data-table/DataTable";
import { TotalCell } from "@/components/data-table/cells";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { commercialKeys, createProduct, createUseCase, updateProduct, useProducts, useUseCases } from "./api";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function Products() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useProducts();
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: commercialKeys.products });

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      await createProduct({ name: name.trim(), defaultRateCents: rate ? Math.round(Number(rate.replace(",", ".")) * 100) : 0 });
      setName("");
      setRate("");
      await refresh();
    } catch (err) {
      setError(message(err, "No se pudo crear el producto."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Productos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {data?.canWrite && (
          <form onSubmit={add} className="grid items-end gap-2 sm:grid-cols-[2fr_1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="prod-name">Producto</Label>
              <Input id="prod-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Portal web" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prod-rate">Tarifa sugerida (USD/h)</Label>
              <Input id="prod-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="25" />
            </div>
            <Button type="submit" disabled={name.trim().length < 2 || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />}
              Agregar
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : !data?.products.length ? (
          <p className="text-sm text-muted-foreground">Aún no hay productos.</p>
        ) : (
          <ul className="divide-y divide-foreground/10">
            {data.products.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className={cn("min-w-0 flex-1 font-medium", !p.active && "text-muted-foreground line-through")}>{p.name}</span>
                <TotalCell cents={p.defaultRateCents} />
                <span className="text-xs text-muted-foreground">por hora</span>
                {data.canWrite && (
                  <Button size="xs" variant="ghost" onClick={async () => {
                    await updateProduct(p.id, { active: !p.active }).catch((err) => setError(message(err, "No se pudo cambiar el producto.")));
                    await refresh();
                  }}>
                    {p.active ? "Desactivar" : "Activar"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function UseCases() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useUseCases();
  const products = useProducts().data?.products ?? [];
  const [title, setTitle] = useState("");
  const [industry, setIndustry] = useState("");
  const [productId, setProductId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const productName = new Map(products.map((p) => [p.id, p.name]));

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (title.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      await createUseCase({ title: title.trim(), industry: industry.trim() || null, productId: productId || null });
      setTitle("");
      setIndustry("");
      setProductId("");
      await queryClient.invalidateQueries({ queryKey: commercialKeys.useCases });
    } catch (err) {
      setError(message(err, "No se pudo crear el caso de uso."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Casos de uso</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {data?.canWrite && (
          <form onSubmit={add} className="grid items-end gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="uc-title">Caso de uso</Label>
              <Input id="uc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Portal de pedidos B2B" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="uc-industry">Industria</Label>
              <Input id="uc-industry" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="Retail" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="uc-product">Producto</Label>
              <select id="uc-product" className={cn(tableSelectClass, "w-full")} value={productId} onChange={(e) => setProductId(e.target.value)}>
                <option value="">Sin producto</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={title.trim().length < 3 || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />}
              Agregar
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : !data?.useCases.length ? (
          <p className="text-sm text-muted-foreground">Aún no hay casos de uso.</p>
        ) : (
          <ul className="divide-y divide-foreground/10">
            {data.useCases.map((u) => (
              <li key={u.id} className="py-2 text-sm">
                <p className="font-medium">{u.title}</p>
                <p className="text-xs text-muted-foreground">{[u.industry, u.productId ? productName.get(u.productId) : null].filter(Boolean).join(" · ") || "Sin industria ni producto"}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Catálogo de Productos y Casos de uso que se usan en las cotizaciones. */
export default function CatalogPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Catálogo</h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">Productos (con su tarifa sugerida) y casos de uso para armar las cotizaciones.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Products />
        <UseCases />
      </div>
    </div>
  );
}
