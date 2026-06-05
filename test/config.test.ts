import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("treats a blank PLATFORM_MODULES value as the default module list", () => {
    const config = loadConfig({
      PLATFORM_MODULES: "",
    });

    expect(config.platformModules).toEqual([]);
  });
});
