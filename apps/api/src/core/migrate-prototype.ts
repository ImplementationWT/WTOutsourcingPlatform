import type { AdminStore } from "../store/admin-store.js";

/**
 * Migración del prototipo (docs/migracion-prototipo.md). Aditiva e idempotente: solo completa los
 * campos nuevos que faltan; no renombra ni borra nada.
 *
 * Paso 2 (Proyectos): cada proyecto sin `stageSince` toma la fecha de su última actualización como
 * inicio de la etapa actual (marcada como estimada) y su developer pasa a la lista de developers.
 */
export async function migratePrototypeProjects(store: AdminStore) {
  const pending = await store.opsProjects.find({ stageSince: { $exists: false } }, { projection: { stage: 1, updatedAt: 1, developerUserId: 1, developerUserIds: 1 } }).toArray();
  for (const project of pending) {
    const at = (project.updatedAt ?? new Date()).toISOString().slice(0, 10);
    await store.opsProjects.updateOne(
      { _id: project._id, stageSince: { $exists: false } },
      {
        $set: {
          stageSince: at,
          stageHistory: [{ stage: project.stage, at, by: "migración", estimated: true }],
          developerUserIds: project.developerUserIds ?? (project.developerUserId ? [project.developerUserId] : [])
        }
      }
    );
  }
}
