import type { Stage } from "../types.js";
import { ensureCredential, getTemplateVersion, mongoSteps } from "./credentials.js";

export const mongodbDatabaseStage: Stage = {
  name: "mongodb_database",
  async run(ctx) {
    const { names, store, deps, client } = ctx;
    const steps = mongoSteps(names);
    await ctx.plan(steps);

    const { created: firstTime } = await store.claimResource("mongodb_database", names.database, client._id);
    const [user, db, env] = await Promise.all([
      store.getResource("mongodb_user", names.dbUser),
      store.getResource("mongodb_database", names.database),
      store.getResource("github_environment", names.repositoryFullName)
    ]);

    // Ya inicializada y con la credencial vigente escrita en GitHub: no hay nada que hacer
    // (y no se rota sin motivo). La etapa github_secrets comprueba el estado real del secret.
    const alreadyDone =
      !!db?.ref.bootstrappedAt &&
      typeof user?.ref.credentialVersion === "number" &&
      env?.ref.credentialVersion === user.ref.credentialVersion &&
      !!(await deps.atlas.getDatabaseUser(names.dbUser));

    if (alreadyDone) {
      for (const step of steps) await ctx.step(step.id, "skipped", "Ya completado en una ejecución anterior.");
      await ctx.report(`${names.database} ya está inicializada; credencial sincronizada.`);
      return;
    }

    await ensureCredential(ctx);

    await store.updateResourceRef("mongodb_database", names.database, client._id, {
      database: names.database,
      user: names.dbUser,
      cluster: deps.config.atlas.clusterName,
      collection: "app_metadata",
      templateVersion: await getTemplateVersion(ctx),
      schemaVersion: deps.config.template.schemaVersion,
      bootstrappedAt: new Date().toISOString()
    });
    if (firstTime) {
      await ctx.audit("mongodb.database.created", names.database, { collection: "app_metadata", uniqueIndex: "key" });
    }
    await ctx.report(`${names.database} inicializada y verificada. La URI se arma solo en memoria para el siguiente paso.`);
  }
};
