import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { createStringWriter } from "../src/cli/output.js";
import type { ReviewResult, ReviewTriggerKind } from "../src/review/types.js";
import { createGitLabTenantInput } from "./helpers/gitlab-tenant.js";
import { openSqliteTestStorage } from "./helpers/storage.js";

const tenantKey = "https://gitlab.example.com::123";

describe("mr report CLI", () => {
  it("lists stored reports newest first and enriches suggestions from snapshots", async () => {
    const fixture = await createReportFixture();
    try {
      let stdout = "";
      await expect(
        runCli(
          [
            "mr",
            "report",
            "--key",
            tenantKey,
            "--json",
            "--sqlite-database-path",
            fixture.databasePath,
          ],
          {
            stdout: createStringWriter((text) => (stdout += text)),
          },
        ),
      ).resolves.toBe(0);

      const reports = JSON.parse(stdout) as Array<Record<string, unknown>>;
      expect(reports).toHaveLength(2);
      expect(reports.map((report) => report.codeReviewId)).toEqual([8, 7]);
      expect(reports[0]).toEqual(
        expect.objectContaining({
          publicationMode: "publish",
          triggerType: "direct-mention",
        }),
      );
      expect(reports[1]).toEqual(
        expect.objectContaining({
          publicationMode: "no-publish",
          triggerType: "manual-review",
          suggestedChanges: [
            expect.objectContaining({
              path: "src/auth.ts",
              startLine: 10,
              endLine: 12,
              replacedText: "  return tenant.data;\n}\nexport { authorize };",
              replacement:
                'if (!tenant) {\n  throw new Error("Unknown tenant");\n}',
            }),
          ],
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("filters before selecting the latest report and accepts concise aliases", async () => {
    const fixture = await createReportFixture();
    try {
      let stdout = "";
      await runCli(
        [
          "mr",
          "report",
          "--key",
          tenantKey,
          "--code-review",
          "7",
          "--type",
          "manual-review",
          "--publication-mode",
          "no-publish",
          "--latest",
          "--json",
          "--sqlite-database-path",
          fixture.databasePath,
        ],
        { stdout: createStringWriter((text) => (stdout += text)) },
      );

      const reports = JSON.parse(stdout) as Array<Record<string, unknown>>;
      expect(reports).toHaveLength(1);
      expect(reports[0]).toEqual(
        expect.objectContaining({
          codeReviewId: 7,
          triggerType: "manual-review",
          publicationMode: "no-publish",
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("filters reports by their inclusive completion date", async () => {
    const fixture = await createReportFixture();
    try {
      let stdout = "";
      await runCli(
        [
          "mr",
          "report",
          "--key",
          tenantKey,
          "--from",
          "2026-08-02",
          "--json",
          "--sqlite-database-path",
          fixture.databasePath,
        ],
        { stdout: createStringWriter((text) => (stdout += text)) },
      );

      const reports = JSON.parse(stdout) as Array<Record<string, unknown>>;
      expect(reports).toHaveLength(1);
      expect(reports[0]).toEqual(expect.objectContaining({ codeReviewId: 8 }));
    } finally {
      await fixture.cleanup();
    }
  });

  it("reads legacy prior dispositions without discussionId", async () => {
    const fixture = await createReportFixture({ legacyDisposition: true });
    try {
      let stdout = "";
      await runCli(
        [
          "mr",
          "report",
          "--key",
          tenantKey,
          "--code-review",
          "7",
          "--json",
          "--sqlite-database-path",
          fixture.databasePath,
        ],
        { stdout: createStringWriter((text) => (stdout += text)) },
      );

      const reports = JSON.parse(stdout) as Array<{
        result: {
          overview: {
            overallAssessment: string;
            mergeReadiness: { confidence: string };
          };
          priorDispositions: Array<Record<string, unknown>>;
        };
      }>;
      expect(reports[0]?.result.overview).toEqual(
        expect.objectContaining({
          overallAssessment: "Authorization boundaries need attention.",
          mergeReadiness: expect.objectContaining({ confidence: "low" }),
        }),
      );
      expect(reports[0]?.result.priorDispositions).toEqual([
        expect.objectContaining({
          discussionId: "legacy-discussion",
          action: "keep",
        }),
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("writes matching reports as one Markdown document", async () => {
    const fixture = await createReportFixture();
    try {
      const reportPath = join(fixture.directory, "reports.md");
      let stdout = "";
      await runCli(
        [
          "mr",
          "report",
          "--key",
          tenantKey,
          "--latest",
          "--report",
          reportPath,
          "--sqlite-database-path",
          fixture.databasePath,
        ],
        { stdout: createStringWriter((text) => (stdout += text)) },
      );

      const markdown = await readFile(reportPath, "utf8");
      expect(stdout).toContain("Wrote 1 review report");
      expect(markdown).toContain("# Merge request review report");
      expect(markdown).toContain("- **Code review:** 8");
      expect(markdown).toContain("## Review result");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects conflicting result limits", async () => {
    await expect(
      runCli(["mr", "report", "--key", tenantKey, "--latest", "--limit", "2"]),
    ).rejects.toThrow("Cannot combine --latest with --limit.");
  });

  it("rejects an invalid from date", async () => {
    await expect(
      runCli(["mr", "report", "--key", tenantKey, "--from", "2026/08/02"]),
    ).rejects.toThrow("--from requires YYYY-MM-DD");
  });
});

async function createReportFixture(
  options: { legacyDisposition?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "mr-report-cli-"));
  const databasePath = join(directory, "reviewphin.sqlite");
  const storage = await openSqliteTestStorage(databasePath);
  const tenant = await storage.upsertTenant(createGitLabTenantInput());

  await seedReport(storage, {
    tenantId: tenant.id,
    dedupeKey: "local-review",
    codeReviewId: 7,
    triggerJson: JSON.stringify({
      kind: "reviewphin-local-review",
      source: "cli",
      requestId: "local-1",
      codeReviewId: 7,
      instruction: "Review this change.",
      createdAt: "2026-08-01T10:00:00.000Z",
      publicationMode: "no-publish",
    }),
    triggerType: "manual-review",
    startedAt: "2026-08-01T10:00:00.000Z",
    finishedAt: "2026-08-01T10:01:00.000Z",
    result: options.legacyDisposition
      ? {
          ...reviewResultWithSuggestion,
          overview: {
            summary: reviewResultWithSuggestion.overview.summary,
            overallSeverity:
              reviewResultWithSuggestion.overview.overallSeverity,
          },
          priorDispositions: [
            { threadId: "legacy-discussion", action: "keep" },
            { action: "resolve", resolution: "dismissed" },
          ],
        }
      : reviewResultWithSuggestion,
    diff: [
      "@@ -8,5 +8,5 @@",
      " function authorize() {",
      "   const tenant = findTenant();",
      "+  return tenant.data;",
      "+}",
      "+export { authorize };",
    ].join("\n"),
  });
  await seedReport(storage, {
    tenantId: tenant.id,
    dedupeKey: "published-review",
    codeReviewId: 8,
    triggerJson: JSON.stringify({
      kind: "github-comment",
      triggerKind: "direct-mention",
    }),
    triggerType: "direct-mention",
    startedAt: "2026-08-02T10:00:00.000Z",
    finishedAt: "2026-08-02T10:01:00.000Z",
    result: {
      overview: { summary: "No issues found.", overallSeverity: "low" },
      findings: [],
      priorDispositions: [],
    },
    diff: "",
  });
  await storage.close();

  return {
    directory,
    databasePath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function seedReport(
  storage: Awaited<ReturnType<typeof openSqliteTestStorage>>,
  input: {
    tenantId: string;
    dedupeKey: string;
    codeReviewId: number;
    triggerJson: string;
    triggerType: ReviewTriggerKind;
    startedAt: string;
    finishedAt: string;
    result: unknown;
    diff: string;
  },
): Promise<void> {
  const { job } = await storage.createOrGetInteractionJob({
    tenantId: input.tenantId,
    dedupeKey: input.dedupeKey,
    codeReviewId: input.codeReviewId,
    commentId: null,
    triggerJson: input.triggerJson,
    headSha: `head-${input.codeReviewId}`,
    payloadJson: "{}",
  });
  const run = await storage.createInteractionRun({
    interactionJobId: job.id,
    tenantId: input.tenantId,
    provider: "copilot-sdk",
    model: "gpt-5.4",
    modelProfileName: null,
    providerBaseUrl: null,
    providerType: null,
    textGenerationModel: null,
  });
  await storage.completeInteractionRun(run.id, JSON.stringify(input.result));
  await storage.stores.interactionRuns.patch({
    id: run.id,
    value: { startedAt: input.startedAt, finishedAt: input.finishedAt },
  });
  await storage.createCodeReviewSnapshot({
    interactionJobId: job.id,
    interactionRunId: run.id,
    tenantId: input.tenantId,
    codeReviewId: input.codeReviewId,
    headSha: job.headSha,
    codeReviewJson: "{}",
    versionsJson: "[]",
    changesJson: JSON.stringify([
      {
        oldPath: "src/auth.ts",
        newPath: "src/auth.ts",
        diff: input.diff,
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      },
    ]),
    commentsJson: "[]",
    discussionsJson: "[]",
    instructionsJson: "[]",
    projectMemoryJson: null,
    workspaceStrategy: "test",
  });
  await storage.upsertInteractionRunMetrics({
    interactionRunId: run.id,
    harness: "github.copilot-sdk",
    harnessSessionKey: `session-${run.id}`,
    sessionType: "review",
    triggerKind: input.triggerType,
    promptMode: "first-pass-full",
    promptChars: 10,
    promptContextChangedFiles: 1,
    promptContextPriorDiscussions: 0,
    promptContextComments: 0,
    assistantTurns: 1,
    assistantCalls: 1,
    toolExecutions: 1,
    viewToolCalls: 1,
    globToolCalls: 0,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    apiDurationMs: 1_000,
    usageUnit: null,
    usageAmount: null,
    usageByModelJson: "[]",
    repeatedViewReads: 0,
    repeatedViewPathsJson: "[]",
  });
}

const reviewResultWithSuggestion: ReviewResult = {
  overview: {
    summary: "Authorization boundaries need attention.",
    overallSeverity: "high",
    overallAssessment: "The authorization boundary is incomplete.",
    mergeReadiness: {
      status: "blocked",
      confidence: "high",
      summary: "Validate the tenant before merging.",
    },
  },
  findings: [
    {
      title: "Reject missing tenants",
      body: "Validate the tenant before accessing its data.",
      severity: "high",
      category: "security",
      anchor: {
        path: "src/auth.ts",
        startLine: 10,
        endLine: 12,
        side: "new",
      },
      suggestion: {
        replacement: 'if (!tenant) {\n  throw new Error("Unknown tenant");\n}',
        startLine: 10,
        endLine: 12,
      },
    },
  ],
  priorDispositions: [],
};
