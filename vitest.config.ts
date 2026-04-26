import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["tmp/**", "dist/**", "node_modules/**"],
    coverage: {
      provider: "v8"
    }
  }
});
