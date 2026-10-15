import { MongoBinary } from "mongodb-memory-server";

/**
 * globalSetup de vitest: descarga mongod una sola vez antes de arrancar los
 * archivos de tests. Si cada archivo lo descargara a la vez (caché vacía, como en
 * CI), compiten por renombrar el mismo .tgz y los perdedores se quedan colgados.
 */
export default async function downloadMongod() {
  await MongoBinary.getPath();
}
