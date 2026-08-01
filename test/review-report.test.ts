import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatReviewReportForTerminal,
  formatReviewReportMarkdown,
  writeReviewReport,
} from "../src/cli/review-report.js";
import { CliOutput, createStringWriter } from "../src/cli/output.js";
import type { ReviewResult } from "../src/review/types.js";

const reviewResult: ReviewResult = {
  overview: {
    summary: "Authorization boundaries need attention.",
    overallSeverity: "high",
    overallAssessment: "The implementation is close, but not ready.",
    mergeReadiness: {
      status: "needs_attention",
      confidence: "high",
      summary: "Fix the authorization bypass before merging.",
    },
    highlights: ["The storage path remains backward compatible."],
  },
  findings: [
    {
      title: "Reject untrusted `tenantId` values",
      body: "Validate the identifier before using it.\n\n- Reject missing tenants\n- Keep the error actionable",
      severity: "high",
      category: "security",
      confidence: "high",
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

describe("review report", () => {
  it("renders a complete Markdown report", () => {
    const report = formatReviewReportMarkdown(reviewResult);

    expect(report).toContain("# Review result");
    expect(report).toContain("## Merge readiness");
    expect(report).toContain("## Findings (1)");
    expect(report).toContain("`src/auth.ts`, lines 10-12 (new side)");
    expect(report).toContain("```suggestion");
    expect(report).toMatch(/\n$/);
    expect(report).not.toContain("\u001B[");
  });

  it("renders Markdown semantics as width-aware terminal text", () => {
    let stdout = "";
    const output = new CliOutput("pretty", {
      stdout: createStringWriter((text) => (stdout += text)),
      stdoutIsTTY: true,
      columns: 52,
      color: false,
    });

    const report = formatReviewReportForTerminal(reviewResult, output);

    expect(report).toContain("Review result");
    expect(report).toContain("Authorization boundaries need");
    expect(report).toContain("* Reject missing tenants");
    expect(report).not.toContain("**Overall severity:**");
    expect(stdout).toBe("");
  });

  it("replaces an existing report instead of appending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-report-"));
    const path = join(directory, "review.md");
    try {
      await writeFile(path, "old report", "utf8");

      await writeReviewReport(path, reviewResult);

      const report = await readFile(path, "utf8");
      expect(report).toBe(formatReviewReportMarkdown(reviewResult));
      expect(report).not.toContain("old report");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
