// Configuración global de la plataforma. Los recursos de cada proyecto se
// derivan de su identificador (slug) y no se editan por proyecto.
/** Valor por defecto mientras carga /api/platform (que manda el backend). */
export const DEPLOY_DOMAIN = "apps.whatever.tech";

export const STACK = {
  runtime: "Node.js 24 + TypeScript",
  ci: "GitHub Actions",
  versioning: "Versión del template en package.json (template.version)",
  environment: "VPS corporativo",
  environmentDetail: "Docker Compose + SSH con comando forzado + nginx y Certbot",
  healthPath: "/health/ready",
  metaPath: "/api/meta",
};

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

/**
 * Vista previa de los nombres. El backend los vuelve a derivar del slug
 * validado (nunca los toma del navegador); aquí solo se muestran.
 * MONGODB_DB debe cumplir ^client_[a-z0-9_]+$, por eso los guiones pasan a "_".
 */
export function deriveResources(slug: string, domain = DEPLOY_DOMAIN) {
  const base = slug || "mi-proyecto";
  const token = base.replace(/-/g, "_");
  return {
    repository: `${base}-app`,
    database: `client_${token}`,
    dbUser: `app_${token}`,
    subdomain: `${base}.${domain}`,
  };
}
