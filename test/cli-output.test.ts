import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli, runCliEntry } from "../src/cli.js";
import {
  CliOutput,
  createStringWriter,
  resolveOutputMode,
} from "../src/cli/output.js";
import { createGitLabTenantInput } from "./helpers/gitlab-tenant.js";
import { openSqliteTestStorage } from "./helpers/storage.js";

describe("CLI output contract", () => {
  it("defaults to pretty, supports all modes, and validates the JSON alias", () => {
    expect(resolveOutputMode({})).toBe("pretty");
    expect(resolveOutputMode({ output: "plain" })).toBe("plain");
    expect(resolveOutputMode({ output: "json" })).toBe("json");
    expect(resolveOutputMode({ json: true })).toBe("json");
    expect(resolveOutputMode({ output: "json", json: true })).toBe("json");
    expect(() => resolveOutputMode({ output: "yaml" })).toThrow(
      "Unsupported output mode",
    );
    expect(() => resolveOutputMode({ output: "plain", json: true })).toThrow(
      "Cannot combine --json with --output plain",
    );
  });

  it("tracks the current terminal width when no fixed width is injected", () => {
    const stdout = createStringWriter(() => undefined) as ReturnType<
      typeof createStringWriter
    > & { columns: number };
    stdout.columns = 90;
    const output = new CliOutput("pretty", { stdout, stdoutIsTTY: true });

    expect(output.columns).toBe(90);
    stdout.columns = 132;
    expect(output.columns).toBe(132);
  });

  it("renders safe list projections as one JSON value and plain text without ANSI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-output-"));
    const databasePath = join(directory, "reviewphin.sqlite");
    await runCli([
      "model-profile",
      "add",
      "--name",
      "private-profile",
      "--auth-token",
      "secret-token-value",
      "--default",
      "--sqlite-database-path",
      databasePath,
    ]);

    let jsonOutput = "";
    await expect(
      runCli(
        [
          "model-profile",
          "list",
          "--output",
          "json",
          "--sqlite-database-path",
          databasePath,
        ],
        { stdout: createStringWriter((text) => (jsonOutput += text)) },
      ),
    ).resolves.toBe(0);

    expect(jsonOutput.trim().split("\n")).toHaveLength(1);
    const profiles = JSON.parse(jsonOutput) as Array<Record<string, unknown>>;
    expect(profiles).toEqual([
      expect.objectContaining({
        name: "private-profile",
        isDefault: true,
      }),
    ]);
    expect(jsonOutput).not.toContain("secret-token-value");

    let plainOutput = "";
    await runCli(
      [
        "model-profile",
        "list",
        "--output",
        "plain",
        "--sqlite-database-path",
        databasePath,
      ],
      {
        stdout: createStringWriter((text) => (plainOutput += text)),
        stdoutIsTTY: true,
        color: true,
        columns: 40,
      },
    );
    expect(plainOutput).toContain("name: private-profile");
    expect(plainOutput).not.toContain("\u001B");

    let prettyOutput = "";
    await runCli(
      ["model-profile", "list", "--sqlite-database-path", databasePath],
      {
        stdout: createStringWriter((text) => (prettyOutput += text)),
        stdoutIsTTY: true,
        color: true,
      },
    );
    expect(prettyOutput).toContain("\u001B[1mDEFAULT");
    expect(prettyOutput).toContain("\u001B[1;32m✓");
    expect(prettyOutput).toContain("\u001B[2m");

    let redirectedPrettyOutput = "";
    await runCli(
      ["model-profile", "list", "--sqlite-database-path", databasePath],
      {
        stdout: createStringWriter((text) => (redirectedPrettyOutput += text)),
        stdoutIsTTY: false,
        color: true,
      },
    );
    expect(redirectedPrettyOutput).not.toContain("\u001B");
  });

  it("enriches tenant JSON with the connection name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-tenant-output-"));
    const databasePath = join(directory, "reviewphin.sqlite");
    const storage = await openSqliteTestStorage(databasePath);
    const connection = await storage.createPlatformConnection({
      name: "main-gitlab",
      platform: "gitlab",
      status: "ready",
      platformConnectionConfigJson: JSON.stringify({
        baseUrl: "https://gitlab.example.com",
        apiToken: "secret",
        botUserId: 1,
        botUsername: "reviewphin",
      }),
    });
    await storage.upsertTenant(
      createGitLabTenantInput({ platformConnectionId: connection.id }),
    );
    await storage.close();

    let stdout = "";
    await runCli(
      [
        "tenant",
        "list",
        "--output",
        "json",
        "--sqlite-database-path",
        databasePath,
      ],
      { stdout: createStringWriter((text) => (stdout += text)) },
    );
    expect(JSON.parse(stdout)).toEqual([
      expect.objectContaining({
        platformConnectionId: connection.id,
        platformConnectionName: "main-gitlab",
      }),
    ]);
    expect(stdout).not.toContain("secret");
  });

  it("keeps JSON errors on stderr and leaves stdout empty", async () => {
    let stdout = "";
    let stderr = "";
    await expect(
      runCliEntry(["unknown", "command", "--output", "json"], {
        stdout: createStringWriter((text) => (stdout += text)),
        stderr: createStringWriter((text) => (stderr += text)),
      }),
    ).resolves.toBe(1);

    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toEqual({
      type: "error",
      error: expect.objectContaining({
        name: "Error",
        message: expect.stringContaining("Unsupported command"),
      }),
    });
  });

  it("forwards injected output streams through successful entry invocations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-entry-output-"));
    let stdout = "";

    await expect(
      runCliEntry(
        [
          "model-profile",
          "list",
          "--output",
          "json",
          "--sqlite-database-path",
          join(directory, "reviewphin.sqlite"),
        ],
        { stdout: createStringWriter((text) => (stdout += text)) },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(stdout)).toEqual([]);
  });

  it("emits independently parseable migration events in JSON mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-migration-output-"));
    let stdout = "";
    await expect(
      runCli(
        [
          "storage",
          "migrate",
          "--from-storage-provider-module",
          "sqlite",
          "--from-sqlite-database-path",
          join(directory, "source.sqlite"),
          "--to-storage-provider-module",
          "sqlite",
          "--to-sqlite-database-path",
          join(directory, "target.sqlite"),
          "--output",
          "json",
        ],
        { stdout: createStringWriter((text) => (stdout += text)) },
      ),
    ).resolves.toBe(0);

    const events = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events[0]?.type).toBe("migration_step_started");
    expect(events.some((event) => event.type === "migration_progress")).toBe(
      true,
    );
    expect(events.at(-1)?.type).toBe("migration_completed");
  });
});
