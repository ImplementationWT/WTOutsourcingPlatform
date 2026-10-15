import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // mongodb-memory-server descarga mongod la primera vez: una sola descarga antes de los tests.
    globalSetup: ["tests/helpers/download-mongod.ts"],
    hookTimeout: 120_000,
    testTimeout: 30_000,
    // Los tests no deben depender del .env del desarrollador.
    env: { DOTENV_CONFIG_PATH: "/dev/null" }
  }
});
