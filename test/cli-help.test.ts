import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { detectCliCommand, runCli, runCliEntry } from "../src/cli.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("detectCliCommand", () => {
  it("uses the explicit command override", () => {
    expect(
      detectCliCommand({ REVIEWPHIN_CLI_COMMAND: "reviewphin" }, [
        "node",
        "/app/dist/cli.js",
      ]),
    ).toBe("reviewphin");
  });

  it("detects the pnpm cli lifecycle", () => {
    expect(
      detectCliCommand(
        {
          npm_lifecycle_event: "cli",
          npm_execpath: "/pnpm/pnpm.cjs",
        },
        ["node", "/repo/src/cli.ts"],
      ),
    ).toBe("pnpm cli");
  });

  it("shows the direct node script invocation", () => {
    expect(detectCliCommand({}, ["node", "path/to/cli.js"])).toBe(
      "node path/to/cli.js",
    );
  });
});

describe("CLI help", () => {
  it("shows matching commands and fails for an incomplete command", async () => {
    vi.stubEnv("REVIEWPHIN_CLI_COMMAND", "pnpm cli");
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(runCli(["tenant"])).resolves.toBe(1);

    const help = output.mock.calls.join("");
    expect(help).toContain("pnpm cli tenant add ");
    expect(help).toContain("pnpm cli tenant list ");
    expect(help).not.toContain("pnpm cli model-profile ");
  });

  it("shows matching commands and succeeds for --help", async () => {
    vi.stubEnv("REVIEWPHIN_CLI_COMMAND", "pnpm cli");
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(runCli(["tenant", "add", "--help"])).resolves.toBe(0);

    const help = output.mock.calls.join("");
    expect(help).toContain("pnpm cli tenant add ");
    expect(help).not.toContain("pnpm cli tenant list ");
  });

  it("falls back to all commands for an unknown positional prefix", async () => {
    vi.stubEnv("REVIEWPHIN_CLI_COMMAND", "pnpm cli");
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(runCli(["tenant", "nosuchsubcommand"])).resolves.toBe(1);

    const help = output.mock.calls.join("");
    expect(help).toContain("pnpm cli tenant add ");
    expect(help).toContain("pnpm cli model-profile add ");
  });

  it("includes --help in every displayed usage entry", async () => {
    vi.stubEnv("REVIEWPHIN_CLI_COMMAND", "pnpm cli");
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(runCli(["tenant"])).resolves.toBe(1);

    const usageLines = output.mock.calls
      .join("")
      .split("\n")
      .filter((line) => line.startsWith("  pnpm cli"));
    expect(usageLines.length).toBeGreaterThan(0);
    expect(usageLines.every((line) => line.endsWith("[--help]"))).toBe(true);
  });

  it("shows matching help when a valid command fails", async () => {
    vi.stubEnv("REVIEWPHIN_CLI_COMMAND", "pnpm cli");
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const errorOutput = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(runCliEntry(["tenant", "set-profile"])).resolves.toBe(1);

    const help = output.mock.calls.join("");
    expect(help).toContain("pnpm cli tenant set-profile ");
    expect(help).not.toContain("pnpm cli tenant add ");
    expect(errorOutput).toHaveBeenCalled();
  });

  it("shows matching help when a valid command returns a failure", async () => {
    vi.stubEnv("REVIEWPHIN_CLI_COMMAND", "pnpm cli");
    const directory = await mkdtemp(join(tmpdir(), "cli-help-"));
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(
      runCliEntry([
        "model-profile",
        "remove",
        "--name",
        "missing",
        "--sqlite-database-path",
        join(directory, "test.sqlite"),
      ]),
    ).resolves.toBe(1);

    const text = output.mock.calls.join("");
    expect(text).toContain("Model profile missing not found.");
    expect(text).toContain("pnpm cli model-profile remove ");
    expect(text).not.toContain("pnpm cli model-profile add ");
  });
});
