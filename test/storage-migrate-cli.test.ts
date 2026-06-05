import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { listAll } from "../src/storage/storage-helpers.js";
import { createGitLabTenantInput } from "./helpers/gitlab-tenant.js";
import { openSqliteTestStorage } from "./helpers/storage.js";

describe("storage migrate CLI", () => {
  vi.setConfig({ testTimeout: 20_000 });

  afterAll(() => {
    vi.resetConfig();
  });

  it("migrates all store records between sqlite providers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const sourceDatabasePath = join(workspace, "source.sqlite");
    const targetDatabasePath = join(workspace, "target.sqlite");

    const sourceStorage = await openSqliteTestStorage(sourceDatabasePath);

    try {
      await sourceStorage.upsertModelProfile({
        name: "native-gpt5",
        reviewModel: "gpt-5.4",
        textGenerationModel: "gpt-5.4-mini",
        isDefault: true,
      });

      for (let index = 1; index <= 50; index += 1) {
        await sourceStorage.upsertModelProfile({
          name: `extra-profile-${index}`,
          reviewModel: `gpt-5.4-${index}`,
        });
      }

      const tenant = await sourceStorage.upsertTenant(
        createGitLabTenantInput({
          apiToken: "glpat-source",
          webhookSecret: "replace-me",
          modelProfileName: "native-gpt5",
        }),
      );

      const interactionJob = await sourceStorage.createOrGetInteractionJob({
        tenantId: tenant.id,
        dedupeKey: "storage-migrate-job",
        codeReviewId: 7,
        commentId: 55,
        headSha: "abc123",
        payloadJson: "{}",
      });

      await sourceStorage.createCodeReviewSnapshot({
        interactionJobId: interactionJob.job.id,
        tenantId: tenant.id,
        codeReviewId: 7,
        headSha: "abc123",
        codeReviewJson: "{}",
        versionsJson: "[]",
        changesJson: "[]",
        commentsJson: "[]",
        discussionsJson: "[]",
        instructionsJson: "[]",
        projectMemoryJson: null,
        workspaceStrategy: "git",
      });

      const interactionRun = await sourceStorage.createInteractionRun({
        interactionJobId: interactionJob.job.id,
        tenantId: tenant.id,
        provider: "copilot-sdk",
        model: "gpt-5.4",
        modelProfileName: "native-gpt5",
        providerBaseUrl: null,
        providerType: null,
        textGenerationModel: "gpt-5.4-mini",
      });

      await sourceStorage.upsertInteractionRunMetrics({
        interactionRunId: interactionRun.id,
        triggerKind: "note",
        promptMode: "full",
        promptChars: 10,
        promptContextChangedFiles: 1,
        promptContextPriorDiscussions: 0,
        promptContextComments: 1,
        assistantTurns: 1,
        assistantCalls: 1,
        toolExecutions: 0,
        viewToolCalls: 0,
        globToolCalls: 0,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        apiDurationMs: 100,
        premiumRequests: 1,
        repeatedViewReads: 0,
        repeatedViewPathsJson: "[]",
      });

      await sourceStorage.replaceReviewFindings(interactionRun.id, [
        {
          interactionRunId: interactionRun.id,
          identityKey: "finding-1",
          severity: "medium",
          category: "correctness",
          title: "Migrated finding",
          body: "This record should be copied",
          anchorJson: null,
          suggestionJson: null,
          status: "open",
        },
      ]);

      await sourceStorage.upsertDiscussionMapping({
        tenantId: tenant.id,
        codeReviewId: 7,
        identityKey: "finding-1",
        findingFingerprint: "finding-1-fingerprint",
        title: "Migrated finding",
        severity: "medium",
        category: "correctness",
        body: "This record should be copied",
        platformDiscussionId: "discussion-1",
        platformCommentId: 501,
        anchorJson: null,
        positionJson: null,
        botDiscussion: true,
        botComment: true,
        commentAuthorId: 999,
        commentAuthorUsername: "review-bot",
        status: "open",
        lastInteractionRunId: interactionRun.id,
      });
    } finally {
      await sourceStorage.close();
    }

    let stdout = "";
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stdout +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8");
        return true;
      });

    const exitCode = await runCli([
      "storage",
      "migrate",
      "--from-storage-provider-module",
      "sqlite",
      "--from-sqlite-database-path",
      sourceDatabasePath,
      "--to-storage-provider-module",
      "sqlite",
      "--to-sqlite-database-path",
      targetDatabasePath,
    ]);

    stdoutSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("modelProfiles (1/3)");
    expect(stdout).toContain("modelProfiles (2/3)");
    expect(stdout).toContain("modelProfiles (3/3)");
    expect(stdout).toContain("tenants (1/1)");
    expect(stdout).toContain("Storage migration completed.");
    expect(stdout).toContain("- modelProfiles: 51");
    expect(stdout).toContain("- tenants: 1");
    expect(stdout).toContain("- interactionJobs: 1");
    expect(stdout).toContain("- codeReviewSnapshots: 1");
    expect(stdout).toContain("- interactionRuns: 1");
    expect(stdout).toContain("- interactionRunMetrics: 1");
    expect(stdout).toContain("- reviewFindings: 1");
    expect(stdout).toContain("- discussionMappings: 1");
    expect(stdout).toContain("total: 58");

    const targetStorage = await openSqliteTestStorage(targetDatabasePath);

    try {
      expect(
        await targetStorage.stores.modelProfiles.get("native-gpt5"),
      ).toMatchObject({
        name: "native-gpt5",
        reviewModel: "gpt-5.4",
        isDefault: true,
      });
      expect(await listAll(targetStorage.stores.modelProfiles)).toHaveLength(
        51,
      );

      expect(await listAll(targetStorage.stores.tenants)).toHaveLength(1);
      expect(await listAll(targetStorage.stores.interactionJobs)).toHaveLength(
        1,
      );
      expect(
        await listAll(targetStorage.stores.codeReviewSnapshots),
      ).toHaveLength(1);
      expect(await listAll(targetStorage.stores.interactionRuns)).toHaveLength(
        1,
      );
      expect(
        await listAll(targetStorage.stores.interactionRunMetrics),
      ).toHaveLength(1);
      expect(await listAll(targetStorage.stores.reviewFindings)).toHaveLength(
        1,
      );
      expect(
        await listAll(targetStorage.stores.discussionMappings),
      ).toHaveLength(1);

      expect((await listAll(targetStorage.stores.tenants))[0]).toMatchObject({
        key: "https://gitlab.example.com::123",
        modelProfileName: "native-gpt5",
      });
    } finally {
      await targetStorage.close();
    }
  });
});
