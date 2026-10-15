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

export const githubRepositoryStage: Stage = {
  name: "github_repository",
  async run(ctx) {
    const { names, store, deps, client } = ctx;
    const { github } = deps;

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
    } else {
      await ctx.report(`${names.repositoryFullName} ya existe (creado por este cliente).`);
    }

    // GitHub copia la plantilla de forma asíncrona: se espera a que exista package.json.
    await ctx.report("Esperando el contenido de la plantilla…");
    const raw = await pollUntil(() => github.readFile(names.repository, "package.json").then((r) => r ?? undefined), {
      timeoutMs: deps.timing.repoContentTimeoutMs,
      intervalMs: deps.timing.pollIntervalMs,
      sleep: deps.sleep
    });
    if (raw === undefined) {
      throw new FatalError("template_content_timeout", `GitHub no terminó de copiar la plantilla en ${names.repositoryFullName}. Reintenta en unos minutos.`);
    }

    const template = parseTemplate(raw);
    if (!template || template.name !== deps.config.template.name) {
      throw new FatalError(
        "template_mismatch",
        `El package.json de ${names.repositoryFullName} no declara template.name "${deps.config.template.name}" con una versión válida.`
      );
    }

    await store.updateResourceRef("github_repository", names.repositoryFullName, client._id, {
      fullName: repo.fullName,
      url: repo.url,
      defaultBranch: repo.defaultBranch,
      templateVersion: template.version
    });
    await ctx.report(`${repo.fullName} listo (template ${template.name}@${template.version}).`);
  }
};
