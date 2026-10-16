import { defineConfig } from "vitest/config";
import path from "node:path";

// Tests del panel (jsdom). Los del backend viven en apps/api con su propia configuración.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    include: ["src/**/*.test.tsx"],
    environment: "jsdom",
    globals: true,
  },
});
