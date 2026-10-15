// Configuración global de la plataforma. Los recursos de cada proyecto se
// derivan de su identificador (slug) y no se editan por proyecto.
export const GITHUB_ORG = "forge-org";
export const DEPLOY_DOMAIN = "apps.whatever.tech";
/** Fase 2 (despliegue). Debe coincidir con DEPLOY_ENABLED del backend. */
export const DEPLOY_ENABLED = false;

export const STACK = {
  runtime: "Node.js 22 LTS + TypeScript",
  ci: "GitHub Actions",
  versioning: "Semantic Versioning (tags vX.Y.Z)",
  environment: "VPS corporativo",
  environmentDetail: "Docker Compose + SSH restringido + Caddy",
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
export function deriveResources(slug: string) {
  const base = slug || "mi-proyecto";
  const token = base.replace(/-/g, "_");
  return {
    repository: `${base}-app`,
    database: `client_${token}`,
    dbUser: `app_${token}`,
    subdomain: `${base}.${DEPLOY_DOMAIN}`,
  };
}
