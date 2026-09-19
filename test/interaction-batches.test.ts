import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteTestStorage, type TestStorage } from "./helpers/storage.js";
import { createGitLabTenantInput } from "./helpers/gitlab-tenant.js";
import { listAll } from "../src/storage/storage-helpers.js";

const roots: string[] = [];
const opened: TestStorage[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "reviewphin-batches-"));
  roots.push(root);
  let now = "2026-09-19T10:00:00.000Z";
  const file = join(root, "test.sqlite");
  const storage = await openSqliteTestStorage(file, { now: () => now });
  opened.push(storage);
  const second = await openSqliteTestStorage(file, { now: () => now });
  opened.push(second);
  const tenant = await storage.upsertTenant(createGitLabTenantInput());
  const request = (id: number, overrides = {}) => ({
    tenantId: tenant.id,
    codeReviewId: 7,
    commentId: id,
    dedupeKey: `event-${id}`,
    triggerJson: JSON.stringify({ kind: "direct-mention", commentId: id }),
    headSha: "head-old",
    payloadJson: JSON.stringify({ body: `Question ${id}?` }),
    ...overrides,
  });
  const admit = (id: number, at = now, debounceMs = 15000, overrides = {}) =>
    storage.stores.interactionJobs.admitInteractionTrigger({
      request: request(id, overrides),
      now: at,
      debounceMs,
    });
  const claim = (db = storage) =>
    db.stores.interactionJobs.claimNext({
      now,
      queuedAfter: "2020-01-01T00:00:00.000Z",
      workerId: "worker",
      claimToken: "claim",
      claimExpiresAt: "2026-09-19T11:00:00.000Z",
      maxJobRetries: 3,
    });
  return {
    storage,
    second,
    tenant,
    request,
    admit,
    claim,
    setNow: (value: string) => {
      now = value;
    },
  };
}

describe("durable comment admission", () => {
  it("coalesces arrivals, preserves every payload, and deduplicates without extending the quiet period", async () => {
    const { storage, admit, claim, setNow } = await setup();
    const first = await admit(1);
    const second = await admit(2, "2026-09-19T10:00:10.000Z");
    expect(second.outcome).toBe("appended");
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.availableAt).toBe("2026-09-19T10:00:25.000Z");
    const duplicate = await admit(1, "2026-09-19T10:00:14.000Z");
    expect(duplicate.outcome).toBe("duplicate");
    expect(duplicate.job.availableAt).toBe(second.job.availableAt);
    expect(
      (await listAll(storage.stores.interactionRequests)).map((r) =>
        JSON.parse(r.payloadJson),
      ),
    ).toEqual([{ body: "Question 1?" }, { body: "Question 2?" }]);
    setNow("2026-09-19T10:00:24.999Z");
    expect(await claim()).toBeNull();
    setNow("2026-09-19T10:00:25.000Z");
    expect((await claim())?.id).toBe(first.job.id);
    const late = await admit(3, "2026-09-19T10:00:25.000Z");
    expect(late.job.id).not.toBe(first.job.id);
  });

  it("bounds continuous bursts at 60 seconds and 32 requests", async () => {
    const { admit } = await setup();
    const first = await admit(1);
    for (let i = 2; i <= 6; i++) {
      const result = await admit(
        i,
        `2026-09-19T10:00:${String((i - 1) * 10).padStart(2, "0")}.000Z`,
      );
      expect(result.job.id).toBe(first.job.id);
      expect(result.job.availableAt <= "2026-09-19T10:01:00.000Z").toBe(true);
    }
    expect((await admit(7, "2026-09-19T10:01:00.000Z")).job.id).not.toBe(
      first.job.id,
    );
    let last;
    for (let i = 100; i < 132; i++)
      last = await admit(i, "2026-09-19T10:02:00.000Z");
    expect(last?.job.availableAt).toBe("2026-09-19T10:02:00.000Z");
    expect((await admit(132, "2026-09-19T10:02:00.000Z")).job.id).not.toBe(
      last?.job.id,
    );
  });

  it("seals on byte overflow and retains oversized requests intact", async () => {
    const { admit, storage } = await setup();
    const large = JSON.stringify({ body: "x".repeat(270000) });
    const first = await admit(1);
    const oversized = await admit(2, "2026-09-19T10:00:01.000Z", 15000, {
      payloadJson: large,
    });
    expect(oversized.job.id).not.toBe(first.job.id);
    expect(
      (await storage.stores.interactionJobs.get(first.job.id))?.availableAt,
    ).toBe("2026-09-19T10:00:01.000Z");
    expect(oversized.request.payloadJson).toBe(large);
    expect(oversized.job.availableAt).toBe("2026-09-19T10:00:01.000Z");
  });

  it("serializes admission against a claim from a second SQLite connection", async () => {
    const { admit, claim, second, request, storage, setNow } = await setup();
    const first = await admit(1);
    setNow("2026-09-19T10:00:15.000Z");
    const [claimed, admitted] = await Promise.all([
      claim(),
      second.stores.interactionJobs.admitInteractionTrigger({
        request: request(2),
        now: "2026-09-19T10:00:15.000Z",
        debounceMs: 15000,
      }),
    ]);
    expect(claimed?.id).toBe(first.job.id);
    expect(admitted.job.id).not.toBe(claimed?.id);
    expect(
      await listAll(storage.stores.interactionRequests, {
        filters: { interactionJobId: { eq: first.job.id } },
      }),
    ).toHaveLength(1);
    expect(
      await second.stores.interactionJobs.setInteractionJobHeadForClaim({
        jobId: first.job.id,
        claimToken: "wrong",
        headSha: "bad",
      }),
    ).toBe(false);
    expect(
      await second.stores.interactionJobs.setInteractionJobHeadForClaim({
        jobId: first.job.id,
        claimToken: "claim",
        headSha: "new",
      }),
    ).toBe(true);
    expect(
      (await storage.stores.interactionRequests.get(first.request.id))?.headSha,
    ).toBe("head-old");
  });

  it("keeps tenants, reviews, disabled debounce, and previously started jobs separate", async () => {
    const { admit, claim, setNow, storage } = await setup();
    const first = await admit(1, undefined, 0);
    const second = await admit(2, "2026-09-19T10:00:00.001Z", 0);
    expect(first.job.id).not.toBe(second.job.id);
    const other = await admit(3, undefined, 15000, { codeReviewId: 8 });
    expect(other.job.id).not.toBe(second.job.id);
    const otherTenant = await storage.upsertTenant({
      ...createGitLabTenantInput(),
      key: "https://gitlab.example.com::456",
    });
    const acrossTenant = await admit(1, undefined, 15000, {
      tenantId: otherTenant.id,
    });
    expect(acrossTenant.job.id).not.toBe(first.job.id);
    setNow("2026-09-19T10:00:01.000Z");
    expect((await claim())?.id).toBe(first.job.id);
  });
});
