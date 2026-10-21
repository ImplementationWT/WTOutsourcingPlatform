import type { ProjectRepo } from "@/types/project";

/** Búsqueda de la página de Proyectos (en la URL, ?q=…): nombre, descripción o etiqueta. */
export function searchProjects(projects: ProjectRepo[], q: string): ProjectRepo[] {
  const query = q.trim().toLowerCase();
  if (!query) return projects;
  return projects.filter((repo) => [repo.name, repo.description ?? "", ...repo.topics].some((text) => text.toLowerCase().includes(query)));
}

/** Convierte lo que escribe el usuario al formato de GitHub: "Cliente X" → "cliente-x". */
export function normalizeTag(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}
