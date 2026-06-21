import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("treats a blank PLATFORM_MODULES value as the default module list", () => {
    const config = loadConfig({
      PLATFORM_MODULES: "",
    });

    expect(config.platformModules).toEqual([]);
  });

  it("defaults PUBLIC_URL to the local development server", () => {
    expect(loadConfig({ PORT: "4123" }).publicUrl).toBe(
      "http://localhost:4123",
    );
    expect(
      loadConfig({ PUBLIC_URL: "https://review.example.com/" }).publicUrl,
    ).toBe("https://review.example.com");
  });
});
