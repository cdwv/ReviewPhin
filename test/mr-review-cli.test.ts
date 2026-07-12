import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { parseLocalReviewTrigger } from "../src/review/local-trigger.js";
import { listAll } from "../src/storage/storage-helpers.js";
import { createGitLabTenantInput } from "./helpers/gitlab-tenant.js";
import { openSqliteTestStorage } from "./helpers/storage.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("mr review CLI", () => {
  it("submits a fresh text job without starting a worker and emits one JSON summary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mr-review-cli-"));
    const databasePath = join(directory, "reviewphin.sqlite");
    const storage = await openSqliteTestStorage(databasePath);
    await storage.upsertTenant(createGitLabTenantInput());
    await storage.close();
    vi.stubEnv("LOG_LEVEL", "info");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: string | URL | Request) => {
        const url = new URL(
          typeof request === "string"
            ? request
            : request instanceof URL
              ? request.toString()
              : request.url,
        );
        if (url.pathname.endsWith("/projects/123")) {
          return jsonResponse({
            id: 123,
            web_url: "https://gitlab.example.com/group/project",
            path_with_namespace: "group/project",
            http_url_to_repo: "https://gitlab.example.com/group/project.git",
          });
        }
        if (url.pathname.endsWith("/merge_requests/7")) {
          return jsonResponse({
            id: 700,
            iid: 7,
            project_id: 123,
            title: "Review local changes",
            description: "",
            web_url:
              "https://gitlab.example.com/group/project/-/merge_requests/7",
            source_branch: "feature",
            target_branch: "main",
            author: { id: 1, username: "developer", name: "Developer" },
            diff_refs: {
              base_sha: "base",
              start_sha: "start",
              head_sha: "head",
            },
          });
        }
        if (url.pathname.endsWith("/merge_requests/7/versions")) {
          return jsonResponse([]);
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(
      runCli([
        "mr",
        "review",
        "--key",
        "https://gitlab.example.com::123",
        "--trigger-text",
        "Focus on authorization boundaries.",
        "--code-review-id",
        "7",
        "--no-watch",
        "--json",
        "--sqlite-database-path",
        databasePath,
      ]),
    ).resolves.toBe(0);

    const stdout = output.mock.calls.join("");
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual(
      expect.objectContaining({
        created: true,
        jobStatus: "queued",
        runId: null,
        findingCount: 0,
        liveLogsAvailable: false,
      }),
    );
    const persisted = await openSqliteTestStorage(databasePath);
    const jobs = await listAll(persisted.stores.interactionJobs);
    await persisted.close();
    expect(jobs).toHaveLength(1);
    expect(parseLocalReviewTrigger(JSON.parse(jobs[0]!.triggerJson))).toEqual(
      expect.objectContaining({
        codeReviewId: 7,
        instruction: "Focus on authorization boundaries.",
      }),
    );
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-next-page": "",
    },
  });
}
