import { afterEach, describe, expect, it, vi } from "vitest";
import { V003_CTDS } from "../src/storage/adapters/flotiq/migrations/v003.js";
import { V002_CTDS } from "../src/storage/adapters/flotiq/migrations/v002.js";
import migrate from "../src/storage/adapters/flotiq/migrations/v007.js";

afterEach(() => vi.restoreAllMocks());

function fixture(interrupt = false) {
  const definitions = new Map(
    [...V002_CTDS, ...V003_CTDS].map((ctd) => [
      ctd.name,
      { ...structuredClone(ctd), id: `ctd-${ctd.name}` },
    ]),
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const name = String(url).split("/").at(-1)!;
    if (init?.method === "GET")
      return definitions.has(name)
        ? Response.json(definitions.get(name))
        : new Response(null, { status: 404 });
    const definition = JSON.parse(String(init?.body));
    definitions.set(definition.name, {
      ...definition,
      id: `ctd-${definition.name}`,
    });
    return Response.json(definition, {
      status: init?.method === "POST" ? 201 : 200,
    });
  });
  const jobs = Array.from({ length: 103 }, (_, i) => ({
    id: `job-${i}`,
    tenantId: [{ dataUrl: "/api/v1/content/tenant/tenant-1" }],
    codeReviewId: 7,
    dedupeKey: `event-${i}`,
    commentId: i === 0 ? null : i,
    triggerJson: JSON.stringify({
      kind: i === 0 ? "manual-review" : "direct-mention",
    }),
    payloadJson: `{"body":"Original request ${i}\\n with spacing"}`,
    headSha: "original-head",
    enqueuedAt: "2026-01-01T00:00:00.000Z",
  }));
  const original = JSON.stringify(jobs);
  const requests = new Map<string, Record<string, unknown>>();
  let stop = interrupt;
  const create = vi.fn(async (request: Record<string, unknown>) => {
    requests.set(String(request.id), structuredClone(request));
    if (stop && requests.size === 3) {
      stop = false;
      throw new Error("interrupted after remote write");
    }
    return request;
  });
  const client = {
    content: {
      interaction_job: {
        list: vi.fn(
          async ({ page, limit }: { page: number; limit: number }) => ({
            data: jobs.slice((page - 1) * limit, page * limit),
            total_pages: Math.ceil(jobs.length / limit),
          }),
        ),
      },
      interaction_request: {
        create,
        list: vi.fn(
          async ({ filters }: { filters: { id: { filter: string } } }) => ({
            data: requests.has(filters.id.filter)
              ? [
                  {
                    ...requests.get(filters.id.filter),
                    commentId:
                      requests.get(filters.id.filter)?.commentId ?? undefined,
                  },
                ]
              : [],
          }),
        ),
      },
    },
  };
  return { client, jobs, original, requests, create, definitions };
}

describe("Flotiq v007 batch migration", () => {
  it("preserves all legacy objects and resumes after an ambiguous create without duplicating requests", async () => {
    const f = fixture(true);
    await expect(migrate("fixture", f.client as never)).rejects.toThrow(
      "interrupted",
    );
    await migrate("fixture", f.client as never);
    await migrate("fixture", f.client as never);
    expect(f.requests.size).toBe(103);
    expect(f.create).toHaveBeenCalledTimes(103);
    expect(JSON.stringify(f.jobs)).toBe(f.original);
    for (const job of f.jobs) {
      const request = [...f.requests.values()].find(
        (r) => r.interactionJobId === job.id,
      );
      expect(request).toMatchObject({
        tenantId: "tenant-1",
        payloadJson: job.payloadJson,
        triggerJson: job.triggerJson,
        headSha: job.headSha,
        commentId: job.commentId,
        receivedAt: job.enqueuedAt,
        admittedAt: job.enqueuedAt,
        debounceMs: 0,
      });
    }
    expect(
      f.definitions.get("model_profile")?.schemaDefinition.allOf[1]?.properties,
    ).toHaveProperty("routingModel");
    expect(
      f.definitions.get("interaction_run")?.schemaDefinition.allOf[1]
        ?.properties,
    ).toHaveProperty("repliesJson");
  });

  it("stops on a conflicting existing request instead of overwriting original input", async () => {
    const f = fixture();
    await migrate("fixture", f.client as never);
    const request = f.requests.values().next().value!;
    request.payloadJson = "conflicting data";
    await expect(migrate("fixture", f.client as never)).rejects.toThrow(
      "verification failed",
    );
    expect(request.payloadJson).toBe("conflicting data");
    expect(JSON.stringify(f.jobs)).toBe(f.original);
  });
});
