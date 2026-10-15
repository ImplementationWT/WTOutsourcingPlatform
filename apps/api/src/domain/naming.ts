import { z } from "zod";

/** Mismo formato que el formulario del panel: minúsculas, números y guiones. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const slugSchema = z.string().min(3).max(30).regex(SLUG_PATTERN);

export type Slug = string & { readonly __brand: "Slug" };

export function parseSlug(value: unknown): Slug {
  return slugSchema.parse(value) as Slug;
}

/**
 * Todos los nombres de recursos se derivan SOLO del slug ya validado; nunca
 * se aceptan desde el navegador.
 *
 * El contrato del template exige MONGODB_DB con formato ^client_[a-z0-9_]+$
 * (sin guiones), así que los guiones del slug pasan a "_". Como el slug no
 * admite "_", la transformación es inyectiva: dos slugs distintos nunca
 * producen el mismo nombre.
 */
export function deriveNames(slug: Slug, opts: { targetOwner: string; appsDomain: string }) {
  const token = slug.replace(/-/g, "_");
  const repository = `${slug}-app`;
  const host = `${slug}.${opts.appsDomain}`;
  return {
    slug,
    clientId: slug as string,
    repository,
    repositoryFullName: `${opts.targetOwner}/${repository}`,
    database: `client_${token}`,
    dbUser: `app_${token}`,
    host,
    baseUrl: `https://${host}`
  };
}

export type ClientNames = ReturnType<typeof deriveNames>;
