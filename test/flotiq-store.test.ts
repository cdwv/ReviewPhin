import type {
  ApiRequest,
  BaseObject,
  Filter,
  ListParams,
  ListResponse,
} from "@flotiq/flotiq-api-sdk";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { createFlotiqEntityStore } from "../src/storage/adapters/flotiq/store.js";
import type {
  ModelProfileFilters,
  ModelProfileOrderField,
  ModelProfileRecord,
} from "../src/storage/contract/index.js";

type TestFlotiqApi<TObject extends BaseObject<string>> = ApiRequest<
  TObject,
  TObject,
  TObject,
  string
>;

interface RemoteModelProfile extends BaseObject<"model_profile"> {
  name?: string;
  isDefault?: boolean;
  providerBaseUrl?: string;
  wireApi?: string;
}

interface RemoteInteractionRun extends BaseObject<"interaction_run"> {
  tenantId?: Array<{ dataUrl: string; type: string }>;
  interactionJobId?: Array<{ dataUrl: string; type: string }>;
  modelProfileName?: Array<{ dataUrl: string; type: string }>;
  provider?: string;
}

interface RemoteTimestamped extends BaseObject<"timestamped"> {
  startedAt: string;
}

class InMemoryFlotiqCollection<TObject extends BaseObject<string>> {
  public readonly listCalls: Array<Partial<ListParams<TObject, string>>> = [];
  public readonly createCalls: Array<Record<string, unknown>> = [];
  public readonly updateCalls: Array<{
    id: string;
    data: Record<string, unknown>;
  }> = [];
  public readonly patchCalls: Array<{
    id: string;
    data: Record<string, unknown>;
  }> = [];
  public readonly batchCreateCalls: Array<Record<string, unknown>[]> = [];
  public readonly batchUpdateCalls: Array<Record<string, unknown>[]> = [];
  public readonly batchPatchCalls: Array<Record<string, unknown>[]> = [];

  public constructor(
    private readonly items: Array<TObject & Record<string, unknown>>,
  ) {}

  public async get(id: string): Promise<TObject | null> {
    const item = this.items.find((item) => item.id === id);
    return item ?? null;
  }

  public async list<P extends ListParams<TObject, string>>(
    params?: P,
  ): Promise<ListResponse<TObject>> {
    this.listCalls.push(params ?? {});

    let data = [...this.items];

    if (params?.ids) {
      data = data.filter((item) => params.ids?.includes(item.id));
    }

    const filters = params?.filters;
    if (filters) {
      data = data.filter((item) =>
        matchesFilters(item, filters as Record<string, Filter>),
      );
    }

    const orderBy = params?.orderBy;
    if (orderBy) {
      data.sort((left, right) => {
        const leftValue = readPath(left, orderBy);
        const rightValue = readPath(right, orderBy);

        if (leftValue === rightValue) {
          return 0;
        }

        if (typeof leftValue === "string" && typeof rightValue === "string") {
          return params.orderDirection === "desc"
            ? rightValue.localeCompare(leftValue)
            : leftValue.localeCompare(rightValue);
        }

        if (typeof leftValue === "boolean" && typeof rightValue === "boolean") {
          return params.orderDirection === "desc"
            ? Number(rightValue) - Number(leftValue)
            : Number(leftValue) - Number(rightValue);
        }

        return 0;
      });
    }

    const limit = params?.limit ?? (data.length || 1);
    const page = params?.page ?? 1;
    const start = (page - 1) * limit;
    const pageData = data.slice(start, start + limit);

    return {
      data: pageData,
      total_count: data.length,
      count: pageData.length,
      total_pages: Math.max(1, Math.ceil(data.length / limit)),
      current_page: page,
    };
  }

  public async create(data: Record<string, unknown>): Promise<TObject> {
    this.createCalls.push(data);
    const created = data as TObject & Record<string, unknown>;
    this.items.push(created);
    return created;
  }

  public async update(
    id: string,
    data: Record<string, unknown>,
  ): Promise<TObject> {
    this.updateCalls.push({ id, data });
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new Error(`Unknown item ${id}`);
    }

    const updated = {
      ...this.items[index],
      ...data,
    } as TObject & Record<string, unknown>;
    this.items[index] = updated;
    return updated;
  }

  public async patch(
    id: string,
    data: Record<string, unknown>,
  ): Promise<TObject> {
    this.patchCalls.push({ id, data });
    return this.update(id, data);
  }

  public async batchCreate(data: Record<string, unknown>[]): Promise<{
    batch_total_count: number;
    batch_success_count: number;
    batch_error_count: number;
    errors: never[];
  }> {
    this.batchCreateCalls.push(data);

    for (const entry of data) {
      await this.create(entry);
    }

    return {
      batch_total_count: data.length,
      batch_success_count: data.length,
      batch_error_count: 0,
      errors: [],
    };
  }

  public async batchUpdate(data: Record<string, unknown>[]): Promise<{
    batch_total_count: number;
    batch_success_count: number;
    batch_error_count: number;
    errors: never[];
  }> {
    this.batchUpdateCalls.push(data);

    for (const entry of data) {
      const id = readPath(entry, "id");
      const existing =
        typeof id === "string"
          ? this.items.find((item) => item.id === id)
          : undefined;

      if (typeof id === "string" && existing) {
        await this.update(id, entry);
        continue;
      }

      await this.create(entry);
    }

    return {
      batch_total_count: data.length,
      batch_success_count: data.length,
      batch_error_count: 0,
      errors: [],
    };
  }

  public async batchPatch(data: Record<string, unknown>[]): Promise<{
    batch_total_count: number;
    batch_success_count: number;
    batch_error_count: number;
    errors: never[];
  }> {
    this.batchPatchCalls.push(data);

    for (const entry of data) {
      await this.update(asKeyString(readPath(entry, "id")), entry);
    }

    return {
      batch_total_count: data.length,
      batch_success_count: data.length,
      batch_error_count: 0,
      errors: [],
    };
  }

  public async delete(id: string): Promise<void> {
    const index = this.items.findIndex((item) => item.id === id);
    if (index >= 0) {
      this.items.splice(index, 1);
    }
  }

  public async batchDelete(ids: string[]): Promise<{ deletedCount: number }> {
    const before = this.items.length;
    for (const id of ids) {
      await this.delete(id);
    }

    return { deletedCount: before - this.items.length };
  }
}

describe("Flotiq entity store adapter", () => {
  it("uses the injected logger for remote list params", async () => {
    const api = new InMemoryFlotiqCollection<RemoteModelProfile>([]);
    const logger = createLoggerMock();
    const consoleDebugSpy = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);

    try {
      const store = createFlotiqEntityStore<
        ModelProfileRecord,
        ModelProfileFilters,
        ModelProfileOrderField,
        RemoteModelProfile,
        string
      >({
        logger,
        ctdName: "model_profile",
        api: api as unknown as TestFlotiqApi<RemoteModelProfile>,
        toRecord: (item) => ({
          name: readPath(item, "name") as string,
          providerBaseUrl: null,
          providerType: null,
          wireApi: null,
          authToken: null,
          reviewModel: null,
          textGenerationModel: null,
          reviewReasoningEffort: null,
          textGenerationReasoningEffort: null,
          isDefault: Boolean(readPath(item, "isDefault")),
          createdAt: readPath(item, "internal.createdAt") as string,
          updatedAt: readPath(item, "internal.updatedAt") as string,
        }),
        toRemote: (item) => ({
          id: item.name,
          name: item.name,
        }),
      });

      await store.list({
        filters: {
          name: { eq: "alpha" },
        },
        page: 1,
        pageSize: 10,
      });

      expect(logger.debug).toHaveBeenCalledWith(
        {
          ctdName: "model_profile",
          params: {
            filters: {
              name: { type: "equals", filter: "alpha" },
            },
          },
        },
        "Flotiq list params",
      );
      expect(consoleDebugSpy).not.toHaveBeenCalled();
    } finally {
      consoleDebugSpy.mockRestore();
    }
  });

  it("chunks getMany requests and preserves the requested id order", async () => {
    const remoteItems = Array.from({ length: 105 }, (_, index) => {
      const id = `profile-${index.toString().padStart(3, "0")}`;
      return {
        id,
        name: id,
        internal: {
          contentType: "model_profile" as const,
          createdAt: "2026-05-07T09:00:00.000Z",
          updatedAt: "2026-05-07T09:00:00.000Z",
          deletedAt: "",
          objectTitle: id,
          latestVersion: 1,
          status: "public",
          publishedAt: "2026-05-07T09:00:00.000Z",
          publicVersion: 1,
        },
      };
    });
    const api = new InMemoryFlotiqCollection<RemoteModelProfile>(remoteItems);
    const requestedIds = remoteItems.map(({ id }) => id).reverse();
    const store = createFlotiqEntityStore<
      { id: string },
      Record<string, never>,
      never,
      RemoteModelProfile,
      string
    >({
      ctdName: "model_profile",
      api: api as unknown as TestFlotiqApi<RemoteModelProfile>,
      toRecord: ({ id }) => ({ id }),
      toRemote: ({ id }) => ({ id }),
    });

    expect(await store.getMany(requestedIds)).toEqual(
      requestedIds.map((id) => ({ id })),
    );
    expect(api.listCalls).toEqual([
      {
        ids: requestedIds.slice(0, 100),
        limit: 100,
      },
      {
        ids: requestedIds.slice(100),
        limit: 5,
      },
    ]);
  });

  it("applies inclusive lower and exclusive upper range boundaries", async () => {
    const timestamps = [
      "2026-05-31T23:59:59.999Z",
      "2026-06-01T00:00:00.000Z",
      "2026-06-30T23:59:59.999Z",
      "2026-07-01T00:00:00.000Z",
    ];
    const api = new InMemoryFlotiqCollection<RemoteTimestamped>(
      timestamps.map((startedAt, index) => ({
        id: `run-${index}`,
        startedAt,
        internal: {
          contentType: "timestamped",
          createdAt: startedAt,
          updatedAt: startedAt,
          deletedAt: "",
          objectTitle: `run-${index}`,
          latestVersion: 1,
          status: "public",
          publishedAt: startedAt,
          publicVersion: 1,
        },
      })),
    );
    const store = createFlotiqEntityStore<
      { id: string; startedAt: string },
      { startedAt?: { gte?: string; lt?: string } },
      "startedAt",
      RemoteTimestamped,
      string
    >({
      ctdName: "timestamped",
      api: api as unknown as TestFlotiqApi<RemoteTimestamped>,
      toRecord: ({ id, startedAt }) => ({ id, startedAt }),
      toRemote: (value) => value,
    });

    const rows = await store.list({
      filters: {
        startedAt: {
          gte: "2026-06-01T00:00:00.000Z",
          lt: "2026-07-01T00:00:00.000Z",
        },
      },
      order: [{ field: "startedAt", direction: "asc" }],
      page: 1,
      pageSize: 10,
    });

    expect(rows.map((row) => row.startedAt)).toEqual(timestamps.slice(1, 3));
    expect(api.listCalls[0]?.filters).toBeUndefined();
  });

  it("uses Flotiq ids and maps supported server filters", async () => {
    const api = new InMemoryFlotiqCollection<RemoteModelProfile>([
      {
        id: "alpha",
        name: "alpha",
        isDefault: true,
        providerBaseUrl: "https://llm.example.com/v1",
        wireApi: "responses",
        internal: {
          contentType: "model_profile",
          createdAt: "2026-05-07T09:00:00.000Z",
          updatedAt: "2026-05-07T09:00:00.000Z",
          deletedAt: "",
          objectTitle: "alpha",
          latestVersion: 1,
          status: "public",
          publishedAt: "2026-05-07T09:00:00.000Z",
          publicVersion: 1,
        },
      },
      {
        id: "beta",
        name: "beta",
        isDefault: false,
        wireApi: "completions",
        internal: {
          contentType: "model_profile",
          createdAt: "2026-05-07T10:00:00.000Z",
          updatedAt: "2026-05-07T10:00:00.000Z",
          deletedAt: "",
          objectTitle: "beta",
          latestVersion: 1,
          status: "public",
          publishedAt: "2026-05-07T10:00:00.000Z",
          publicVersion: 1,
        },
      },
    ]);

    const store = createFlotiqEntityStore<
      ModelProfileRecord,
      ModelProfileFilters,
      ModelProfileOrderField,
      RemoteModelProfile,
      string
    >({
      ctdName: "model_profile",
      api: api as unknown as TestFlotiqApi<RemoteModelProfile>,
      toRecord: (item) => ({
        name: readPath(item, "name") as string,
        providerBaseUrl:
          typeof readPath(item, "providerBaseUrl") === "string" &&
          readPath(item, "providerBaseUrl") !== ""
            ? (readPath(item, "providerBaseUrl") as string)
            : null,
        providerType: null,
        wireApi:
          typeof readPath(item, "wireApi") === "string" &&
          readPath(item, "wireApi") !== ""
            ? (readPath(item, "wireApi") as "completions" | "responses")
            : null,
        authToken: null,
        reviewModel: null,
        textGenerationModel: null,
        reviewReasoningEffort: null,
        textGenerationReasoningEffort: null,
        isDefault: Boolean(readPath(item, "isDefault")),
        createdAt: readPath(item, "internal.createdAt") as string,
        updatedAt: readPath(item, "internal.updatedAt") as string,
      }),
      toRemote: (item) => ({
        id: item.name,
        name: item.name,
        providerBaseUrl: item.providerBaseUrl,
        isDefault: item.isDefault,
        wireApi: item.wireApi,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }),
      emptyStringNullFields: ["providerBaseUrl", "wireApi"],
    });

    expect(await store.get("alpha")).toMatchObject({
      name: "alpha",
      wireApi: "responses",
      isDefault: true,
    });

    const listed = await store.list({
      filters: {
        name: { in: ["alpha", "beta"] },
        isDefault: { neq: true },
      },
      order: [
        { field: "createdAt", direction: "desc" },
        { field: "name", direction: "asc" },
      ],
      page: 1,
      pageSize: 10,
    });

    expect(listed.map((item) => item.name)).toEqual(["beta"]);
    expect(api.listCalls.at(-1)).toMatchObject({
      filters: {
        name: { type: "equals", filter: ["alpha", "beta"] },
        isDefault: { type: "notEqual", filter: true },
      },
      orderBy: "internal.createdAt",
      orderDirection: "desc",
      page: 1,
      limit: 10,
    });
    expect(api.listCalls.at(-1)?.orderBy).not.toContain(",");

    await store.patch({
      id: "alpha",
      value: { wireApi: "completions" },
    });

    expect((await store.get("alpha"))?.wireApi).toBe("completions");
    expect(api.patchCalls.at(-1)).toMatchObject({
      id: "alpha",
      data: {
        wireApi: "completions",
      },
    });
    expect(api.patchCalls.at(-1)?.data).not.toHaveProperty("createdAt");
    expect(api.patchCalls.at(-1)?.data).not.toHaveProperty("updatedAt");

    await store.patch({
      id: "alpha",
      value: {
        providerBaseUrl: null,
        wireApi: null,
      },
    });

    expect(api.patchCalls.at(-1)).toMatchObject({
      id: "alpha",
      data: {
        providerBaseUrl: "",
        wireApi: "",
      },
    });
    expect(await store.get("alpha")).toMatchObject({
      name: "alpha",
      providerBaseUrl: null,
      wireApi: null,
    });

    await store.upsert({
      name: "gamma",
      providerBaseUrl: null,
      providerType: null,
      wireApi: "responses",
      authToken: null,
      reviewModel: null,
      textGenerationModel: null,
      reviewReasoningEffort: null,
      textGenerationReasoningEffort: null,
      isDefault: false,
      createdAt: "2026-05-07T11:00:00.000Z",
      updatedAt: "2026-05-07T11:00:00.000Z",
    });

    expect(await store.get("gamma")).toMatchObject({
      name: "gamma",
      wireApi: "responses",
    });
    expect(api.batchUpdateCalls.at(-1)).toEqual([
      {
        id: "gamma",
        name: "gamma",
        providerBaseUrl: "",
        isDefault: false,
        wireApi: "responses",
      },
    ]);
    expect(api.batchUpdateCalls.at(-1)?.[0]).not.toHaveProperty("createdAt");
    expect(api.batchUpdateCalls.at(-1)?.[0]).not.toHaveProperty("updatedAt");

    const listCallsBeforeUpsertMany = api.listCalls.length;
    await store.upsertMany([
      {
        name: "alpha",
        providerBaseUrl: "https://llm.example.com/v2",
        providerType: null,
        wireApi: "responses",
        authToken: null,
        reviewModel: null,
        textGenerationModel: null,
        reviewReasoningEffort: null,
        textGenerationReasoningEffort: null,
        isDefault: true,
        createdAt: "2026-05-07T09:00:00.000Z",
        updatedAt: "2026-05-07T12:00:00.000Z",
      },
      {
        name: "delta",
        providerBaseUrl: null,
        providerType: null,
        wireApi: null,
        authToken: null,
        reviewModel: null,
        textGenerationModel: null,
        reviewReasoningEffort: null,
        textGenerationReasoningEffort: null,
        isDefault: false,
        createdAt: "2026-05-07T13:00:00.000Z",
        updatedAt: "2026-05-07T13:00:00.000Z",
      },
    ]);

    expect(api.listCalls).toHaveLength(listCallsBeforeUpsertMany);
    expect(await store.getMany(["alpha", "delta"])).toMatchObject([
      {
        name: "alpha",
        providerBaseUrl: "https://llm.example.com/v2",
        wireApi: "responses",
      },
      {
        name: "delta",
        providerBaseUrl: null,
        wireApi: null,
      },
    ]);
    expect(api.listCalls.at(-1)).toMatchObject({
      ids: ["alpha", "delta"],
      limit: 2,
    });
    expect(api.batchUpdateCalls.at(-1)).toEqual([
      {
        id: "alpha",
        name: "alpha",
        providerBaseUrl: "https://llm.example.com/v2",
        isDefault: true,
        wireApi: "responses",
      },
      {
        id: "delta",
        name: "delta",
        providerBaseUrl: "",
        isDefault: false,
        wireApi: "",
      },
    ]);
    expect(api.batchCreateCalls).toHaveLength(0);

    const listCallsBeforePatchMany = api.listCalls.length;
    await store.patchMany([
      {
        id: "alpha",
        value: {
          providerBaseUrl: null,
          wireApi: null,
        },
      },
    ]);

    expect(api.listCalls).toHaveLength(listCallsBeforePatchMany);
    expect(await store.get("alpha")).toMatchObject({
      name: "alpha",
      providerBaseUrl: null,
      wireApi: null,
    });
    expect(api.batchPatchCalls.at(-1)).toEqual([
      {
        id: "alpha",
        providerBaseUrl: "",
        wireApi: "",
      },
    ]);

    const listCallsBeforeUpdateMany = api.listCalls.length;
    await store.updateMany([
      {
        id: "alpha",
        value: {
          name: "alpha",
          providerBaseUrl: "https://llm.example.com/v3",
          providerType: null,
          wireApi: "responses",
          authToken: null,
          reviewModel: null,
          textGenerationModel: null,
          reviewReasoningEffort: null,
          textGenerationReasoningEffort: null,
          isDefault: true,
          createdAt: "2026-05-07T09:00:00.000Z",
          updatedAt: "2026-05-07T14:00:00.000Z",
        },
      },
    ]);

    expect(api.listCalls).toHaveLength(listCallsBeforeUpdateMany);
    expect(await store.get("alpha")).toMatchObject({
      name: "alpha",
      providerBaseUrl: "https://llm.example.com/v3",
      wireApi: "responses",
    });
    expect(api.batchUpdateCalls.at(-1)).toEqual([
      {
        id: "alpha",
        name: "alpha",
        providerBaseUrl: "https://llm.example.com/v3",
        isDefault: true,
        wireApi: "responses",
      },
    ]);
  });

  it("maps relation ids to datasource filters and payloads", async () => {
    const api = new InMemoryFlotiqCollection<RemoteInteractionRun>([
      {
        id: "run-1",
        tenantId: [
          { type: "internal", dataUrl: "/api/v1/content/tenant/tenant-1" },
        ],
        interactionJobId: [
          {
            type: "internal",
            dataUrl: "/api/v1/content/interaction_job/job-1",
          },
        ],
        modelProfileName: [
          {
            type: "internal",
            dataUrl: "/api/v1/content/model_profile/profile-a",
          },
        ],
        provider: "openai",
        internal: {
          contentType: "interaction_run",
          createdAt: "2026-05-08T09:00:00.000Z",
          updatedAt: "2026-05-08T09:00:00.000Z",
          deletedAt: "",
          objectTitle: "run-1",
          latestVersion: 1,
          status: "public",
          publishedAt: "2026-05-08T09:00:00.000Z",
          publicVersion: 1,
        },
      },
      {
        id: "run-2",
        tenantId: [
          { type: "internal", dataUrl: "/api/v1/content/tenant/tenant-2" },
        ],
        interactionJobId: [
          {
            type: "internal",
            dataUrl: "/api/v1/content/interaction_job/job-2",
          },
        ],
        provider: "azure",
        internal: {
          contentType: "interaction_run",
          createdAt: "2026-05-08T10:00:00.000Z",
          updatedAt: "2026-05-08T10:00:00.000Z",
          deletedAt: "",
          objectTitle: "run-2",
          latestVersion: 1,
          status: "public",
          publishedAt: "2026-05-08T10:00:00.000Z",
          publicVersion: 1,
        },
      },
    ]);

    const store = createFlotiqEntityStore<
      {
        id: string;
        tenantId: string;
        interactionJobId: string;
        modelProfileName: string | null;
        provider: string;
      },
      {
        tenantId?: { eq?: string; in?: readonly string[] };
        interactionJobId?: { in?: readonly string[] };
      },
      never,
      RemoteInteractionRun,
      string
    >({
      ctdName: "interaction_run",
      api: api as unknown as TestFlotiqApi<RemoteInteractionRun>,
      toRecord: (item) => ({
        id: readPath(item, "id") as string,
        tenantId: readRelationId(readPath(item, "tenantId"), "tenantId"),
        interactionJobId: readRelationId(
          readPath(item, "interactionJobId"),
          "interactionJobId",
        ),
        modelProfileName: readNullableRelationId(
          readPath(item, "modelProfileName"),
          "modelProfileName",
        ),
        provider: readPath(item, "provider") as string,
      }),
      toRemote: (item) => ({ ...item }),
      relationFields: {
        tenantId: { contentType: "tenant" },
        interactionJobId: { contentType: "interaction_job" },
        modelProfileName: { contentType: "model_profile" },
      },
    });

    const listed = await store.list({
      filters: {
        interactionJobId: { in: ["job-1"] },
      },
      page: 1,
      pageSize: 10,
    });

    expect(listed).toEqual([
      {
        id: "run-1",
        tenantId: "tenant-1",
        interactionJobId: "job-1",
        modelProfileName: "profile-a",
        provider: "openai",
      },
    ]);
    expect(api.listCalls.at(-1)).toMatchObject({
      filters: {
        "interactionJobId[*].dataUrl": {
          type: "overlaps",
          filter: ["/api/v1/content/interaction_job/job-1"],
        },
      },
    });

    const listedWithMultipleRelationIds = await store.list({
      filters: {
        tenantId: { eq: "tenant-1" },
        interactionJobId: { in: ["job-1", "job-3"] },
      },
      page: 1,
      pageSize: 10,
    });

    expect(listedWithMultipleRelationIds).toEqual([
      {
        id: "run-1",
        tenantId: "tenant-1",
        interactionJobId: "job-1",
        modelProfileName: "profile-a",
        provider: "openai",
      },
    ]);
    expect(api.listCalls.at(-1)).toMatchObject({
      filters: {
        "tenantId[*].dataUrl": {
          type: "overlaps",
          filter: ["/api/v1/content/tenant/tenant-1"],
        },
        "interactionJobId[*].dataUrl": {
          type: "overlaps",
          filter: [
            "/api/v1/content/interaction_job/job-1",
            "/api/v1/content/interaction_job/job-3",
          ],
        },
      },
    });

    await store.patch({
      id: "run-1",
      value: {
        modelProfileName: null,
      },
    });

    expect(api.patchCalls.at(-1)).toMatchObject({
      id: "run-1",
      data: {
        modelProfileName: [],
      },
    });

    await store.update({
      id: "run-1",
      value: {
        id: "run-1",
        tenantId: "tenant-1",
        interactionJobId: "job-1",
        modelProfileName: "profile-b",
        provider: "openai",
      },
    });

    expect(api.updateCalls.at(-1)).toMatchObject({
      id: "run-1",
      data: {
        id: "run-1",
        tenantId: [
          { type: "internal", dataUrl: "/api/v1/content/tenant/tenant-1" },
        ],
        interactionJobId: [
          {
            type: "internal",
            dataUrl: "/api/v1/content/interaction_job/job-1",
          },
        ],
        modelProfileName: [
          {
            type: "internal",
            dataUrl: "/api/v1/content/model_profile/profile-b",
          },
        ],
      },
    });
  });
});

function matchesFilters(
  entity: Record<string, unknown>,
  filters: Record<string, Filter>,
): boolean {
  return Object.entries(filters).every(([key, filter]) =>
    matchesFilterValue(readPath(entity, key), filter),
  );
}

function matchesFilterValue(value: unknown, filter: Filter): boolean {
  switch (filter.type) {
    case "equals":
      return Array.isArray(filter.filter)
        ? includesUnknown(filter.filter, value)
        : value === filter.filter;
    case "notEqual":
      return Array.isArray(filter.filter)
        ? !includesUnknown(filter.filter, value)
        : value !== filter.filter;
    case "empty":
      return value === null || value === undefined || value === "";
    case "notEmpty":
      return value !== null && value !== undefined && value !== "";
    case "includes":
      return Array.isArray(value) && value.includes(filter.filter);
    case "overlaps":
      return (
        Array.isArray(value) &&
        Array.isArray(filter.filter) &&
        filter.filter.some((entry) => value.includes(entry))
      );
    case "contains":
      return matchesContainsFilter(value, filter.filter);
    case "notContains":
      return matchesNotContainsFilter(value, filter.filter);
    default:
      throw new Error(`Unsupported test filter ${filter.type}`);
  }
}

function matchesContainsFilter(value: unknown, filterValue: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }

  return Array.isArray(filterValue)
    ? filterValue.every((entry) => value.includes(entry))
    : value.includes(filterValue);
}

function includesUnknown(values: readonly unknown[], value: unknown): boolean {
  return values.includes(value);
}

function matchesNotContainsFilter(
  value: unknown,
  filterValue: unknown,
): boolean {
  if (!Array.isArray(value)) {
    return true;
  }

  return Array.isArray(filterValue)
    ? filterValue.every((entry) => !value.includes(entry))
    : !value.includes(filterValue);
}

function readPath(entity: object, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (Array.isArray(current)) {
      return current
        .map((item) => readPathValue(item, segment))
        .filter((item) => item !== undefined);
    }

    return readPathValue(current, segment);
  }, entity);
}

function readPathValue(current: unknown, segment: string): unknown {
  if (!current || typeof current !== "object") {
    return undefined;
  }

  if (segment.endsWith("[*]")) {
    const collection = (current as Record<string, unknown>)[
      segment.slice(0, -3)
    ];
    return Array.isArray(collection) ? collection : undefined;
  }

  return (current as Record<string, unknown>)[segment];
}

function asKeyString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Expected string id, received ${String(value)}`);
}

function readRelationId(value: unknown, key: string): string {
  const relationId = readNullableRelationId(value, key);
  if (relationId === null) {
    throw new Error(`Expected relation value for ${key}`);
  }

  return relationId;
}

function readNullableRelationId(value: unknown, key: string): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (Array.isArray(value)) {
    const first = value[0];
    return first === undefined ? null : readNullableRelationId(first, key);
  }

  if (typeof value === "object") {
    const relation = value as Record<string, unknown>;
    if (typeof relation.dataUrl === "string") {
      return relation.dataUrl.slice(relation.dataUrl.lastIndexOf("/") + 1);
    }
  }

  throw new Error(`Unsupported relation value for ${key}`);
}

function createLoggerMock(): Logger {
  const logger = {
    child: vi.fn(() => logger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;

  return logger;
}
