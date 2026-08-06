import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { reviewPhinVersion } from "../src/app-version.js";

describe("ReviewPhin version evidence", () => {
  it("reads the application version from package metadata", () => {
    const packageMetadata = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(reviewPhinVersion).toBe(packageMetadata.version);
  });
});
