import { devNull } from "node:os";

import { describe, expect, it } from "vitest";

import { getGitConfigNullDevice } from "../src/platforms/git-environment.js";

describe("getGitConfigNullDevice", () => {
  it("uses the Git for Windows null-device spelling", () => {
    expect(getGitConfigNullDevice("win32")).toBe("NUL");
  });

  it("uses the operating-system null device outside Windows", () => {
    expect(getGitConfigNullDevice("linux")).toBe(devNull);
  });
});
