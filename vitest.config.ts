import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror tsconfig `paths` so app modules using the `@/` alias are testable.
    alias: { "@": path.resolve(__dirname, "app") },
  },
  test: {
    clearMocks: true,
    environment: "jsdom",
  },
});
