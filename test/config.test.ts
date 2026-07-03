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

  it("blocks bot indexing by default", () => {
    const config = loadConfig({});

    expect(config.allowBotIndexing).toBe(false);
    expect(config.botIndexingAllowedHosts).toEqual([]);
  });

  it("parses bot indexing host allowlist and global override", () => {
    const config = loadConfig({
      REVIEWPHIN_ALLOW_BOT_INDEXING: "true",
      REVIEWPHIN_BOT_INDEXING_ALLOWED_HOSTS:
        " reviewphin.example.com, docs.reviewphin.example.com ",
    });

    expect(config.allowBotIndexing).toBe(true);
    expect(config.botIndexingAllowedHosts).toEqual([
      "reviewphin.example.com",
      "docs.reviewphin.example.com",
    ]);
  });
});
