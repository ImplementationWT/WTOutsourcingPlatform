import { GithubRepoExistsError } from "../../adapters/github.js";
import { FatalError, OwnershipError } from "../../lib/errors.js";
import { pollUntil } from "../../lib/retry.js";
import type { Stage } from "../types.js";

/** template.name / template.version del package.json del repo generado (contrato §1). */
function parseTemplate(raw: string) {
  try {
    const pkg = JSON.parse(raw) as { template?: { name?: unknown; version?: unknown } };
    const { name, version } = pkg.template ?? {};
    if (typeof name === "string" && typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)) {
      return { name, version };
    }
  } catch {
    // se trata abajo como inválido
  }
  return null;
}

/**
 * Primera versión del contrato que esta plataforma sabe aprovisionar: frontend,
 * SESSION_SECRET, INITIAL_ADMIN_PASSWORD y la forma nueva de /api/meta (contrato §1).
 */
export const MIN_SUPPORTED_TEMPLATE_VERSION = "1.1.0";

/** Compara x.y.z numéricamente (negativo si a < b). */
export function compareVersions(a: string, b: string) {
  const [pa, pb] = [a, b].map((v) => v.split(/[.-]/).slice(0, 3).map(Number));
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Versión esperada: TEMPLATE_VERSION si está fijada; si no, la actual de la plantilla. */
async function expectedVersion(ctx: Parameters<Stage["run"]>[0]) {
  const { config, github } = ctx.deps;
  if (config.template.expectedVersion) return { version: config.template.expectedVersion, source: "TEMPLATE_VERSION" };
  const raw = await github.readTemplateFile("package.json");
  const template = raw === null ? null : parseTemplate(raw);
  if (!template) {
    throw new FatalError("template_source_unreadable", "No se pudo leer template.version del package.json de la plantilla.");
  }
  return { version: template.version, source: "la plantilla" };
}

export const githubRepositoryStage: Stage = {
  name: "github_repository",
  async run(ctx) {
    const { names, store, deps, client } = ctx;
    const { github } = deps;
    await ctx.plan([
      { id: "repository", label: `Crear ${names.repositoryFullName} desde la plantilla` },
      { id: "content", label: "Esperar a que GitHub copie el contenido" },
      { id: "version", label: `Verificar la versión del template ${deps.config.template.name}` }
    ]);

    await ctx.step("repository", "running");
    const { created: newClaim } = await store.claimResource("github_repository", names.repositoryFullName, client._id);

    let repo = await github.getRepository(names.repository);
    if (repo && newClaim) {
      throw new OwnershipError(
        `El repositorio ${names.repositoryFullName} ya existía y no lo creó la plataforma para este cliente. No se reutiliza.`
      );
    }

    if (!repo) {
      await ctx.report(`Creando ${names.repositoryFullName} desde la plantilla…`);
      try {
        repo = await github.createRepositoryFromTemplate(names.repository, client.description);
        await ctx.audit("github.repository.created", names.repositoryFullName, { private: true });
      } catch (error) {
        // Un intento anterior sí llegó a crearlo: el reclamo es nuestro, se reutiliza.
        if (!(error instanceof GithubRepoExistsError)) throw error;
        repo = await github.getRepository(names.repository);
        if (!repo) throw error;
      }
      await ctx.step("repository", "done", `${names.repositoryFullName} creado (privado).`);
    } else {
      await ctx.report(`${names.repositoryFullName} ya existe (creado por este cliente).`);
      await ctx.step("repository", "skipped", "Ya existía, creado por este cliente en un intento anterior.");
    }

    // GitHub copia la plantilla de forma asíncrona: se espera a que exista package.json.
    await ctx.report("Esperando el contenido de la plantilla…");
    await ctx.step("content", "running", "Esperando package.json en la rama main…");
    const raw = await pollUntil(() => github.readFile(names.repository, "package.json").then((r) => r ?? undefined), {
      timeoutMs: deps.timing.repoContentTimeoutMs,
      intervalMs: deps.timing.pollIntervalMs,
      sleep: deps.sleep
    });
    if (raw === undefined) {
      throw new FatalError("template_content_timeout", `GitHub no terminó de copiar la plantilla en ${names.repositoryFullName}. Reintenta en unos minutos.`);
    }

    await ctx.step("content", "done", "package.json disponible.");

    await ctx.step("version", "running", "Leyendo template.version de package.json…");
    const template = parseTemplate(raw);
    if (!template || template.name !== deps.config.template.name) {
      throw new FatalError(
        "template_mismatch",
        `El package.json de ${names.repositoryFullName} no declara template.name "${deps.config.template.name}" con una versión válida.`
      );
    }

    // La versión real se guarda siempre, también si no coincide: el panel muestra qué se encontró.
    await store.updateResourceRef("github_repository", names.repositoryFullName, client._id, {
      fullName: repo.fullName,
      url: repo.url,
      defaultBranch: repo.defaultBranch,
      templateVersion: template.version
    });
    await store.setClientFields(client._id, {
      template: { name: template.name, version: template.version, verifiedAt: new Date() }
    });

    if (compareVersions(template.version, MIN_SUPPORTED_TEMPLATE_VERSION) < 0) {
      throw new FatalError(
        "template_version_unsupported",
        `${names.repositoryFullName} se generó con ${template.name}@${template.version}; la plataforma necesita ${MIN_SUPPORTED_TEMPLATE_VERSION} o superior.`
      );
    }
    // Contrato §1: el repo queda fijado a la versión con la que se generó y debe ser la esperada.
    const expected = await expectedVersion(ctx);
    if (template.version !== expected.version) {
      throw new FatalError(
        "template_version_mismatch",
        `${names.repositoryFullName} se generó con ${template.name}@${template.version} y ${expected.source} indica ${expected.version}.` +
          (expected.source === "TEMPLATE_VERSION" ? " Ajusta o quita TEMPLATE_VERSION." : " Reintenta: la plantilla pudo cambiar mientras se copiaba.")
      );
    }
    await ctx.step("version", "done", `Versión verificada: ${template.name}@${template.version}.`);
    await ctx.report(`${repo.fullName} listo (template ${template.name}@${template.version} verificado).`);
  }
};
