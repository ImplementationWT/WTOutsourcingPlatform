import { useFormContext, useWatch } from "react-hook-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { slugify } from "../config";
import { fieldClass } from "./parts";
import type { NewProjectValues } from "./schema";
import { useTeams } from "@/features/admin/api";
import { selectClass } from "@/features/admin/TeamAssignCard";
import { useIsBoss } from "@/features/auth/auth";

export default function ProjectInfoStep({
  slugTouched,
  onSlugTouched,
}: {
  slugTouched: boolean;
  onSlugTouched: () => void;
}) {
  const {
    register,
    setValue,
    control,
    formState: { errors },
  } = useFormContext<NewProjectValues>();
  const description = useWatch({ control, name: "description" }) ?? "";
  const isBoss = useIsBoss();
  const teams = useTeams();

  const nameField = register("name", {
    onChange: (e) => {
      if (!slugTouched) {
        setValue("slug", slugify(e.target.value), { shouldValidate: !!errors.slug });
      }
    },
  });

  const slugField = register("slug", {
    onChange: (e) => {
      onSlugTouched();
      // Normaliza mientras se escribe: minúsculas y solo caracteres válidos.
      const clean = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
      if (clean !== e.target.value) setValue("slug", clean);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Información del proyecto</CardTitle>
        <CardDescription>Datos básicos para identificar el proyecto en la plataforma.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="name">Nombre del proyecto *</Label>
          <Input
            id="name"
            placeholder="Acme CRM"
            autoComplete="off"
            className={fieldClass}
            aria-invalid={!!errors.name}
            {...nameField}
          />
          {errors.name && <p className="text-xs text-red-400">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="slug">Identificador del proyecto (slug) *</Label>
          <Input
            id="slug"
            placeholder="acme-crm"
            autoComplete="off"
            spellCheck={false}
            className={cn(fieldClass, "font-mono")}
            aria-invalid={!!errors.slug}
            {...slugField}
          />
          {errors.slug ? (
            <p className="text-xs text-red-400">{errors.slug.message}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Se utilizará para nombrar el repositorio, la base de datos y el subdominio. Minúsculas,
              números y guiones.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="description">Descripción del proyecto *</Label>
            <span className="text-xs text-muted-foreground tabular-nums">{description.length}/280</span>
          </div>
          <textarea
            id="description"
            rows={4}
            placeholder="¿Qué hace este proyecto y para quién es?"
            aria-invalid={!!errors.description}
            className={cn(
              "w-full min-w-0 resize-none rounded-lg border px-2.5 py-2 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:ring-3 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/40",
              fieldClass,
              "h-auto",
            )}
            {...register("description")}
          />
          {errors.description && <p className="text-xs text-red-400">{errors.description.message}</p>}
        </div>

        {isBoss && (
          <div className="space-y-2">
            <Label htmlFor="teamId">Equipo *</Label>
            <select id="teamId" className={cn(selectClass, "h-10 w-full", fieldClass)} aria-invalid={!!errors.teamId} {...register("teamId")}>
              <option value="">Elige el equipo que llevará el proyecto</option>
              {teams.data?.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
            {errors.teamId ? (
              <p className="text-xs text-red-400">{errors.teamId.message}</p>
            ) : (
              <p className="text-xs text-muted-foreground">Solo ese equipo (y los CEO/CCO) verá y operará el proyecto.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
