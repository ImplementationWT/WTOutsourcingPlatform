import { z } from "zod";
import { SLUG_PATTERN } from "../config";

export const newProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(3, "El nombre debe tener al menos 3 caracteres")
    .max(60, "Máximo 60 caracteres"),
  slug: z
    .string()
    .min(3, "El identificador debe tener al menos 3 caracteres")
    .max(30, "Máximo 30 caracteres")
    .regex(SLUG_PATTERN, "Solo minúsculas, números y guiones (sin guiones al inicio o al final)")
    .refine((slug) => !slug.startsWith("preview-"), "«preview-» está reservado para las vistas previas"),
  description: z
    .string()
    .trim()
    .min(10, "Describe el proyecto en al menos 10 caracteres")
    .max(280, "Máximo 280 caracteres"),
  /** Servidor donde se desplegará (fijo para siempre); vacío: el que elija la plataforma por defecto. */
  serverId: z.string().optional(),
  /** Integraciones por proveedor del catálogo. Las credenciales solo viven en el formulario. */
  integrations: z.record(z.string(), z.object({ enabled: z.boolean(), credentials: z.record(z.string(), z.string()) })),
});

export type NewProjectValues = z.infer<typeof newProjectSchema>;
