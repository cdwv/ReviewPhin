import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["tmp/**", "dist/**", "node_modules/**"],
    reporters: ["default", "junit"],
    outputFile: {
      junit: "./coverage/junit.xml",
    },
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "cobertura"],
      reportsDirectory: "./coverage",
    },
  },
});
