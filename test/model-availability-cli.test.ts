import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CopilotClientOptions, ModelInfo } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";

import { runCli, runCliEntry, type CliDependencies } from "../src/cli.js";
import { createStringWriter } from "../src/cli/output.js";
import { openSqliteTestStorage } from "./helpers/storage.js";

function model(id: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name: id,
    capabilities: {
      supports: { vision: false, reasoningEffort: false },
      limits: { max_context_window_tokens: 64_000 },
    },
    ...overrides,
  };
}

function catalogDependencies(
  models: readonly ModelInfo[] | Error,
  output: Partial<CliDependencies> = {},
) {
  const start = vi.fn(async () => undefined);
  const listModels = vi.fn(async () => {
    if (models instanceof Error) {
      throw models;
    }
    return [...models];
  });
  const stop = vi.fn(async () => []);
  const factory = vi.fn((_options: CopilotClientOptions) => ({
    start,
    listModels,
    stop,
  }));
  return {
    dependencies: { ...output, modelCatalogClientFactory: factory },
    factory,
    start,
    listModels,
    stop,
  };
}

describe("model availability CLI", () => {
  it("lists a stable, sorted catalog in JSON and plain output", async () => {
    const models = [
      model("z-model"),
      model("a-model", {
        name: "A Model",
        capabilities: {
          supports: { vision: true, reasoningEffort: true },
          limits: { max_context_window_tokens: 128_000 },
        },
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
      }),
    ];
    let json = "";
    const jsonCatalog = catalogDependencies(models, {
      stdout: createStringWriter((text) => (json += text)),
    });

    await expect(
      runCli(
        ["model-profile", "available-models", "--output", "json"],
        jsonCatalog.dependencies,
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(json)).toEqual({
      source: "github-copilot",
      models: [
        {
          id: "a-model",
          name: "A Model",
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "high",
          supportsVision: true,
        },
        {
          id: "z-model",
          name: "z-model",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          supportsVision: false,
        },
      ],
    });
    expect(jsonCatalog.stop).toHaveBeenCalledOnce();

    let plain = "";
    const plainCatalog = catalogDependencies(models, {
      stdout: createStringWriter((text) => (plain += text)),
      stdoutIsTTY: true,
      color: true,
    });
    await runCli(
      ["model-profile", "available-models", "--output", "plain"],
      plainCatalog.dependencies,
    );
    expect(plain).toBe(
      "a-model\tA Model\tlow,high\thigh\ttrue\n" +
        "z-model\tz-model\t\t\tfalse\n",
    );
    expect(plain).not.toContain("\u001B");

    let pretty = "";
    const prettyCatalog = catalogDependencies(models, {
      stdout: createStringWriter((text) => (pretty += text)),
      columns: 160,
    });
    await runCli(
      ["model-profile", "available-models"],
      prettyCatalog.dependencies,
    );
    expect(pretty).toContain("Model");
    expect(pretty).toContain("Name");
    expect(pretty).toContain("Reasoning");
    expect(pretty).toContain("Default effort");
    expect(pretty).toContain("Vision");
  });

  it("uses a named native profile's token without exposing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-catalog-profile-"));
    const databasePath = join(directory, "reviewphin.sqlite");
    await runCli([
      "model-profile",
      "add",
      "--name",
      "native-token",
      "--auth-token",
      "secret-github-token",
      "--sqlite-database-path",
      databasePath,
    ]);
    let stdout = "";
    const catalog = catalogDependencies([model("gpt-5.4")], {
      stdout: createStringWriter((text) => (stdout += text)),
    });

    await expect(
      runCli(
        [
          "model-profile",
          "available-models",
          "--model-profile",
          "native-token",
          "--output",
          "json",
          "--sqlite-database-path",
          databasePath,
        ],
        catalog.dependencies,
      ),
    ).resolves.toBe(0);
    expect(catalog.factory).toHaveBeenCalledWith({
      gitHubToken: "secret-github-token",
    });
    expect(stdout).not.toContain("secret-github-token");
  });

  it("uses an ephemeral auth token without storing or exposing it", async () => {
    let stdout = "";
    const catalog = catalogDependencies([model("gpt-5.4")], {
      stdout: createStringWriter((text) => (stdout += text)),
    });

    await expect(
      runCli(
        [
          "model-profile",
          "available-models",
          "--auth-token",
          "ephemeral-github-token",
          "--output",
          "json",
        ],
        catalog.dependencies,
      ),
    ).resolves.toBe(0);
    expect(catalog.factory).toHaveBeenCalledWith({
      gitHubToken: "ephemeral-github-token",
    });
    expect(stdout).not.toContain("ephemeral-github-token");
  });

  it("rejects combining a model profile with an auth token", async () => {
    const catalog = catalogDependencies([model("unused")]);

    await expect(
      runCli(
        [
          "model-profile",
          "available-models",
          "--model-profile",
          "native-token",
          "--auth-token",
          "ephemeral-github-token",
        ],
        catalog.dependencies,
      ),
    ).rejects.toThrow("Cannot use --model-profile and --auth-token together");
    expect(catalog.factory).not.toHaveBeenCalled();
  });

  it("reports catalog failures with a stable JSON error and no secret", async () => {
    let stdout = "";
    let stderr = "";
    const catalog = catalogDependencies(new Error("secret-token failed"), {
      stdout: createStringWriter((text) => (stdout += text)),
      stderr: createStringWriter((text) => (stderr += text)),
    });

    await expect(
      runCliEntry(
        [
          "model-profile",
          "available-models",
          "--auth-token",
          "secret-token",
          "--output",
          "json",
        ],
        catalog.dependencies,
      ),
    ).resolves.toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toEqual({
      type: "error",
      error: expect.objectContaining({ code: "model_catalog_unavailable" }),
    });
    expect(stderr).not.toContain("secret-token");
    expect(catalog.factory).toHaveBeenCalledWith({
      gitHubToken: "secret-token",
    });
    expect(catalog.stop).toHaveBeenCalledOnce();
  });

  it("validates both effective models before saving and returns structured status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-validation-"));
    const databasePath = join(directory, "reviewphin.sqlite");
    let stdout = "";
    const catalog = catalogDependencies(
      [model("review-model"), model("text-model")],
      { stdout: createStringWriter((text) => (stdout += text)) },
    );

    await expect(
      runCli(
        [
          "model-profile",
          "add",
          "--name",
          "validated",
          "--review-model",
          "review-model",
          "--text-generation-model",
          "text-model",
          "--output",
          "json",
          "--sqlite-database-path",
          databasePath,
        ],
        catalog.dependencies,
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(stdout).modelValidation).toEqual({
      status: "validated",
      checkedModels: ["review-model", "text-model"],
      missingModels: [],
    });
  });

  it("rejects missing models without changing the target or current default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-missing-"));
    const databasePath = join(directory, "reviewphin.sqlite");
    await runCli([
      "model-profile",
      "add",
      "--name",
      "existing-default",
      "--default",
      "--sqlite-database-path",
      databasePath,
    ]);
    let stderr = "";
    const catalog = catalogDependencies([model("available")], {
      stderr: createStringWriter((text) => (stderr += text)),
      stdout: createStringWriter(() => undefined),
    });

    await expect(
      runCliEntry(
        [
          "model-profile",
          "add",
          "--name",
          "invalid",
          "--review-model",
          "missing-z",
          "--text-generation-model",
          "missing-a",
          "--default",
          "--output",
          "json",
          "--sqlite-database-path",
          databasePath,
        ],
        catalog.dependencies,
      ),
    ).resolves.toBe(1);
    const error = JSON.parse(stderr).error;
    expect(error).toEqual(
      expect.objectContaining({
        code: "model_not_found",
        profileName: "invalid",
        missingModels: ["missing-a", "missing-z"],
      }),
    );
    expect(error.message).toContain("model-profile available-models");
    expect(error.message).toContain("--model-profile or --auth-token");

    const storage = await openSqliteTestStorage(databasePath);
    expect(await storage.stores.modelProfiles.get("invalid")).toBeNull();
    expect(
      await storage.stores.modelProfiles.get("existing-default"),
    ).toMatchObject({ isDefault: true });
  });

  it("attempts validation and saves missing models only with the override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-ignore-"));
    const databasePath = join(directory, "reviewphin.sqlite");
    let stdout = "";
    let stderr = "";
    const catalog = catalogDependencies([], {
      stdout: createStringWriter((text) => (stdout += text)),
      stderr: createStringWriter((text) => (stderr += text)),
    });

    await expect(
      runCli(
        [
          "model-profile",
          "add",
          "--name",
          "ignored",
          "--review-model",
          "missing",
          "--ignore-missing-model",
          "--output",
          "json",
          "--sqlite-database-path",
          databasePath,
        ],
        catalog.dependencies,
      ),
    ).resolves.toBe(0);
    expect(catalog.listModels).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout).modelValidation).toEqual({
      status: "ignored_missing",
      checkedModels: ["missing"],
      missingModels: ["missing"],
    });
    expect(stderr).toContain(
      'Model \\"missing\\" was not found, but --ignore-missing-model was provided, so this result was ignored.',
    );
    const storage = await openSqliteTestStorage(databasePath);
    expect(await storage.stores.modelProfiles.get("ignored")).toMatchObject({
      reviewModel: "missing",
    });
  });

  it("attempts unavailable native validation and saves only with the override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-ignore-error-"));
    const databasePath = join(directory, "reviewphin.sqlite");
    let stdout = "";
    const catalog = catalogDependencies(new Error("authentication failed"), {
      stdout: createStringWriter((text) => (stdout += text)),
      stderr: createStringWriter(() => undefined),
    });

    await expect(
      runCli(
        [
          "model-profile",
          "add",
          "--name",
          "ignored-unavailable",
          "--review-model",
          "requested",
          "--ignore-missing-model",
          "--output",
          "json",
          "--sqlite-database-path",
          databasePath,
        ],
        catalog.dependencies,
      ),
    ).resolves.toBe(0);
    expect(catalog.listModels).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout).modelValidation).toEqual({
      status: "ignored_unavailable",
      checkedModels: ["requested"],
      missingModels: [],
    });
  });

  it("validates retained model values before a partial update", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-update-check-"));
    const databasePath = join(directory, "reviewphin.sqlite");
    const initialCatalog = catalogDependencies([model("retained")]);
    await runCli(
      [
        "model-profile",
        "add",
        "--name",
        "partial",
        "--review-model",
        "retained",
        "--sqlite-database-path",
        databasePath,
      ],
      initialCatalog.dependencies,
    );

    const missingCatalog = catalogDependencies([]);
    await expect(
      runCli(
        [
          "model-profile",
          "add",
          "--name",
          "partial",
          "--default",
          "--sqlite-database-path",
          databasePath,
        ],
        missingCatalog.dependencies,
      ),
    ).rejects.toMatchObject({ code: "model_not_found" });
    expect(missingCatalog.listModels).toHaveBeenCalledOnce();

    const storage = await openSqliteTestStorage(databasePath);
    expect(await storage.stores.modelProfiles.get("partial")).toMatchObject({
      reviewModel: "retained",
      isDefault: false,
    });
  });

  it("rejects unavailable discovery by default and permits it explicitly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-custom-"));
    const databasePath = join(directory, "reviewphin.sqlite");
    let stderr = "";
    await expect(
      runCliEntry(
        [
          "model-profile",
          "add",
          "--name",
          "custom",
          "--base-url",
          "https://models.example.com/v1",
          "--review-model",
          "custom-model",
          "--output",
          "json",
          "--sqlite-database-path",
          databasePath,
        ],
        { stderr: createStringWriter((text) => (stderr += text)) },
      ),
    ).resolves.toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("model_validation_unavailable");

    let stdout = "";
    stderr = "";
    await expect(
      runCli(
        [
          "model-profile",
          "add",
          "--name",
          "custom",
          "--base-url",
          "https://models.example.com/v1",
          "--review-model",
          "custom-model",
          "--ignore-missing-model",
          "--output",
          "json",
          "--sqlite-database-path",
          databasePath,
        ],
        {
          stdout: createStringWriter((text) => (stdout += text)),
          stderr: createStringWriter((text) => (stderr += text)),
        },
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(stdout).modelValidation.status).toBe(
      "ignored_unavailable",
    );
    expect(stderr).toContain("availability could not be verified");
  });

  it("does not query the catalog for null models or set-default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-no-preflight-"));
    const databasePath = join(directory, "reviewphin.sqlite");
    const catalog = catalogDependencies([model("unused")]);

    await expect(
      runCli(
        [
          "model-profile",
          "add",
          "--name",
          "copilot-default",
          "--output",
          "json",
          "--sqlite-database-path",
          databasePath,
        ],
        catalog.dependencies,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        [
          "model-profile",
          "set-default",
          "--name",
          "copilot-default",
          "--sqlite-database-path",
          databasePath,
        ],
        catalog.dependencies,
      ),
    ).resolves.toBe(0);
    expect(catalog.factory).not.toHaveBeenCalled();
  });
});
