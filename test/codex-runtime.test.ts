import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRuntime } from "../src/harness/codex-runtime.js";

describe("Codex harness", () => {
  it("includes image and text attachments in a follow-up turn", async () => {
    const runtime = new CodexRuntime({
      command: process.execPath,
      args: ["test/fixtures/codex-app-server.mjs"],
      timeoutMs: 3000,
    });
    const result = await runtime.run({
      prompt: "attachments",
      modelConfig: {
        modelProfileName: null,
        selectionSource: "default",
        reviewModel: null,
        textGenerationModel: null,
        reviewReasoningEffort: null,
        textGenerationReasoningEffort: null,
        authToken: null,
        provider: undefined,
        providerBaseUrl: null,
        providerType: null,
      },
      tools: [],
      subagents: [],
      attachments: [
        {
          type: "blob",
          data: Buffer.from("context text").toString("base64"),
          mimeType: "text/plain",
          displayName: "notes.txt",
        },
        {
          type: "blob",
          data: "AQID",
          mimeType: "image/png",
          displayName: "image.png",
        },
      ],
    });
    expect(result.response?.data.content).toContain("context text");
    expect(result.response?.data.content).toContain(
      "data:image/png;base64,AQID",
    );
  });
  it("searches the workspace using regular expressions", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewphin-search-"));
    try {
      await writeFile(join(root, "file.ts"), "needle is ok\n");
      const runtime = new CodexRuntime({
        command: process.execPath,
        args: ["test/fixtures/codex-app-server.mjs"],
        timeoutMs: 3000,
      });
      const result = await runtime.run({
        prompt: "search",
        workingDirectory: root,
        modelConfig: {
          modelProfileName: null,
          selectionSource: "default",
          reviewModel: null,
          textGenerationModel: null,
          reviewReasoningEffort: null,
          textGenerationReasoningEffort: null,
          authToken: null,
          provider: undefined,
          providerBaseUrl: null,
          providerType: null,
        },
        tools: ["rg"],
        subagents: [],
      });
      expect(result.response?.data.content).toContain("needle is ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("includes repository-wide rules and advertises available skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewphin-guidance-"));
    try {
      await mkdir(join(root, ".reviewphin/skills/security"), {
        recursive: true,
      });
      await writeFile(join(root, ".reviewphin/AGENTS.md"), "Main guidance");
      await writeFile(
        join(root, ".reviewphin/general.instructions.md"),
        '---\napplyTo: "**"\n---\nGlobal guidance',
      );
      await writeFile(
        join(root, ".reviewphin/narrow.instructions.md"),
        '---\napplyTo: "*.go"\n---\nNarrow guidance',
      );
      await writeFile(
        join(root, ".reviewphin/skills/security/SKILL.md"),
        "---\nname: security\ndescription: Inspect security\n---\nSkill body",
      );
      const runtime = new CodexRuntime({
        command: process.execPath,
        args: ["test/fixtures/codex-app-server.mjs"],
        timeoutMs: 3000,
      });
      const result = await runtime.run({
        prompt: "instructions",
        workingDirectory: root,
        modelConfig: {
          modelProfileName: null,
          selectionSource: "default",
          reviewModel: null,
          textGenerationModel: null,
          reviewReasoningEffort: null,
          textGenerationReasoningEffort: null,
          authToken: null,
          provider: undefined,
          providerBaseUrl: null,
          providerType: null,
        },
        tools: ["view"],
        subagents: [],
      });
      expect(result.response?.data.content).toContain("Main guidance");
      expect(result.response?.data.content).toContain("Global guidance");
      expect(result.response?.data.content).toContain("Inspect security");
      expect(result.response?.data.content).toContain("Narrow guidance");
      expect(result.response?.data.content).not.toContain("Skill body");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("includes shared GitHub review rules even without .reviewphin", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewphin-shared-"));
    try {
      await mkdir(join(root, ".github/instructions"), { recursive: true });
      await writeFile(
        join(root, ".github/copilot-instructions.md"),
        "Shared guidance",
      );
      await writeFile(
        join(root, ".github/instructions/style.instructions.md"),
        "Scoped guidance",
      );
      const runtime = new CodexRuntime({
        command: process.execPath,
        args: ["test/fixtures/codex-app-server.mjs"],
        timeoutMs: 3000,
      });
      const result = await runtime.run({
        prompt: "instructions",
        workingDirectory: root,
        modelConfig: {
          modelProfileName: null,
          selectionSource: "default",
          reviewModel: null,
          textGenerationModel: null,
          reviewReasoningEffort: null,
          textGenerationReasoningEffort: null,
          authToken: null,
          provider: undefined,
          providerBaseUrl: null,
          providerType: null,
        },
        tools: ["view"],
        subagents: [],
      });
      expect(result.response?.data.content).toContain("Shared guidance");
      expect(result.response?.data.content).toContain("Scoped guidance");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("writes requested project memory through the configured service", async () => {
    const addEntry = vi
      .fn()
      .mockResolvedValue({ changed: true, action: "updated" });
    const runtime = new CodexRuntime({
      command: process.execPath,
      args: ["test/fixtures/codex-app-server.mjs"],
      timeoutMs: 3000,
      memoryService: () => ({ addEntry }),
    });
    const result = await runtime.run({
      prompt: "memory",
      modelConfig: {
        modelProfileName: null,
        selectionSource: "default",
        reviewModel: null,
        textGenerationModel: null,
        reviewReasoningEffort: null,
        textGenerationReasoningEffort: null,
        authToken: null,
        provider: undefined,
        providerBaseUrl: null,
        providerType: null,
      },
      tools: ["add_memory_entry"],
      subagents: [],
    });
    expect(addEntry).toHaveBeenCalledWith({
      memory: "Use UTC",
      rationale: "Team convention",
      supersedes: [],
    });
    expect(result.response?.data.content).toContain("updated");
  });
  it("returns a validated structured response", async () => {
    const runtime = new CodexRuntime({
      command: process.execPath,
      args: ["test/fixtures/codex-app-server.mjs"],
      timeoutMs: 3000,
    });
    const result = await runtime.run({
      prompt: "hello",
      modelConfig: {
        modelProfileName: null,
        selectionSource: "default",
        reviewModel: null,
        textGenerationModel: null,
        reviewReasoningEffort: null,
        textGenerationReasoningEffort: null,
        authToken: null,
        provider: undefined,
        providerBaseUrl: null,
        providerType: null,
      },
      tools: [],
      subagents: [],
      responseFormat: { schema: z.object({ answer: z.number() }) },
    });
    expect(result.parsed).toEqual({ answer: 42 });
    expect(result.response?.data.content).toBe('{"answer":42}');
  });
  it("repairs an invalid structured response in the same session", async () => {
    const runtime = new CodexRuntime({
      command: process.execPath,
      args: ["test/fixtures/codex-app-server.mjs"],
      timeoutMs: 3000,
    });
    const result = await runtime.run({
      prompt: "invalid",
      modelConfig: {
        modelProfileName: null,
        selectionSource: "default",
        reviewModel: null,
        textGenerationModel: null,
        reviewReasoningEffort: null,
        textGenerationReasoningEffort: null,
        authToken: null,
        provider: undefined,
        providerBaseUrl: null,
        providerType: null,
      },
      tools: [],
      subagents: [],
      responseFormat: { schema: z.object({ answer: z.number() }) },
    });
    expect(result.parsed).toEqual({ answer: 42 });
  });
  it("provides the requested read-only workspace tool to Codex", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewphin-codex-"));
    try {
      await writeFile(join(root, "file.ts"), "file content");
      const runtime = new CodexRuntime({
        command: process.execPath,
        args: ["test/fixtures/codex-app-server.mjs"],
        timeoutMs: 3000,
      });
      const result = await runtime.run({
        prompt: "tool",
        workingDirectory: root,
        modelConfig: {
          modelProfileName: null,
          selectionSource: "default",
          reviewModel: null,
          textGenerationModel: null,
          reviewReasoningEffort: null,
          textGenerationReasoningEffort: null,
          authToken: null,
          provider: undefined,
          providerBaseUrl: null,
          providerType: null,
        },
        tools: ["view"],
        subagents: [],
      });
      expect(result.response?.data.content).toBe("file content");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
