import {
  type ApiRequest,
  type BaseBatchResponse,
  type BaseObject,
  type Filter,
  type ListParams,
} from "@flotiq/flotiq-api-sdk";
import type { Logger } from "pino";

import type {
  EntityStore,
  StoreUpdateInput,
  StoreValueFilter,
} from "../../contract/index.js";

type JsonRecord = Record<string, unknown>;

interface FlotiqEntityStoreOptions<
  TEntity extends object,
  TObject extends BaseObject<string>,
  THydratedObject extends BaseObject<string>,
  THydratedTwiceObject extends BaseObject<string>,
  TFilterField extends string,
> {
  readonly logger?: Logger | undefined;
  readonly api: ApiRequest<
    TObject,
    THydratedObject,
    THydratedTwiceObject,
    TFilterField
  >;
  readonly ctdName: string;
  readonly toRecord: (object: TObject) => TEntity;
  readonly toRemote: (entity: TEntity) => JsonRecord;
  readonly emptyStringNullFields?: readonly (keyof TEntity & string)[];
  readonly relationFields?: Partial<
    Record<keyof TEntity & string, FlotiqRelationField>
  >;
}

interface FlotiqRelationField {
  readonly contentType: string;
}

export function createFlotiqEntityStore<
  TEntity extends object,
  TFilters extends Partial<Record<string, StoreValueFilter<unknown>>>,
  TOrder extends string,
  TObject extends BaseObject<string>,
  TFilterField extends string,
  THydratedObject extends BaseObject<string> = TObject,
  THydratedTwiceObject extends BaseObject<string> = TObject,
>(
  options: FlotiqEntityStoreOptions<
    TEntity,
    TObject,
    THydratedObject,
    THydratedTwiceObject,
    TFilterField
  >,
): EntityStore<TEntity, TFilters, TOrder> {
  const emptyStringNullFields = new Set(options.emptyStringNullFields ?? []);
  const relationFields = new Map<string, FlotiqRelationField>(
    Object.entries(options.relationFields ?? {}) as Array<
      [string, FlotiqRelationField]
    >,
  );

  async function getById(id: string): Promise<TEntity | null> {
    const remoteObjects = await fetchRemoteObjects({ ids: [id], pageSize: 1 });
    const remoteObject = remoteObjects[0];
    if (!remoteObject) {
      return null;
    }

    return options.toRecord(remoteObject);
  }

  async function fetchRemoteObjects(input?: {
    filters?: Partial<
      Record<keyof TEntity & string, StoreValueFilter<unknown>>
    >;
    order?: readonly { field: TOrder; direction: "asc" | "desc" }[];
    ids?: string[];
    page?: number;
    pageSize?: number;
  }): Promise<TObject[]> {
    const mappedParams = buildRemoteListParams(
      input?.filters,
      input?.order,
      input?.ids,
    );
    const requestParams = {
      ...mappedParams,
      ...(input?.pageSize ? { limit: input.pageSize } : {}),
      ...(input?.page ? { page: input.page } : {}),
    };

    const response = await options.api.list(requestParams);

    return response.data;
  }

  function buildRemoteListParams(
    filters?: Partial<
      Record<keyof TEntity & string, StoreValueFilter<unknown>>
    >,
    order?: readonly { field: TOrder; direction: "asc" | "desc" }[],
    ids?: string[],
  ): Partial<ListParams<TObject, TFilterField>> {
    const remoteFilters: Record<string, Filter> = {};

    for (const [field, filter] of Object.entries(filters ?? {})) {
      if (!filter) {
        continue;
      }

      const relationField = relationFields.get(field);
      const remoteField = relationField
        ? `${field}[*].dataUrl`
        : mapFieldName(field);
      const translatedFilter = translateStoreFilter(filter, relationField);

      if (translatedFilter) {
        remoteFilters[remoteField] = translatedFilter;
      }
    }

    const primaryOrder = order?.[0];

    const params: Partial<ListParams<TObject, TFilterField>> = {};
    if (Object.keys(remoteFilters).length > 0) {
      params.filters = remoteFilters as NonNullable<
        ListParams<TObject, TFilterField>["filters"]
      >;
    }
    if (primaryOrder) {
      params.orderBy = mapFieldName(primaryOrder.field) as TFilterField;
      params.orderDirection = primaryOrder.direction;
    }
    if (ids && ids.length > 0) {
      params.ids = ids;
    }

    options.logger?.debug(
      { params, ctdName: options.ctdName },
      "Flotiq list params",
    );

    return params;
  }

  async function loadRecords(input?: {
    filters?: TFilters;
    order?: readonly { field: TOrder; direction: "asc" | "desc" }[];
    ids?: string[];
    page?: number;
    pageSize?: number;
  }): Promise<TEntity[]> {
    const remoteInput: {
      filters?: Partial<
        Record<keyof TEntity & string, StoreValueFilter<unknown>>
      >;
      order?: readonly { field: TOrder; direction: "asc" | "desc" }[];
      ids?: string[];
      page?: number;
      pageSize?: number;
    } = {};
    if (input?.filters) {
      remoteInput.filters = input.filters;
    }
    if (input?.order) {
      remoteInput.order = input.order;
    }
    if (input?.ids) {
      remoteInput.ids = input.ids;
    }
    if (input?.page) {
      remoteInput.page = input.page;
    }
    if (input?.pageSize) {
      remoteInput.pageSize = input.pageSize;
    }

    return (await fetchRemoteObjects(remoteInput)).map((object) =>
      options.toRecord(object),
    );
  }

  function toSanitizedRemote(entity: TEntity): JsonRecord {
    return sanitizeWritePayload(
      options.toRemote(entity),
      emptyStringNullFields,
      relationFields,
    );
  }

  function toSanitizedPatchRemote(value: Partial<TEntity>): JsonRecord {
    return sanitizeWritePayload(value, emptyStringNullFields, relationFields);
  }

  async function loadRecordsByIds(ids: readonly string[]): Promise<TEntity[]> {
    if (ids.length === 0) {
      return [];
    }

    const remoteObjects = await fetchRemoteObjects({ ids: [...ids] });
    const recordsById = new Map(
      remoteObjects.map((object) => [object.id, options.toRecord(object)]),
    );

    return ids
      .map((id) => recordsById.get(id))
      .filter((record): record is TEntity => record !== undefined);
  }

  function assertSuccessfulBatch(
    operation: string,
    response: BaseBatchResponse<TObject>,
  ): void {
    if (response.batch_error_count === 0) {
      return;
    }

    const details = response.errors
      .map(({ data, errors }) => {
        const errorMessages = Object.entries(errors)
          .map(
            ([field, messages]) =>
              `${field || "base"}: ${messages?.join(", ") ?? ""}`,
          )
          .join("; ");
        return `${data.id}: ${errorMessages}`;
      })
      .join(" | ");
    throw new Error(`Flotiq ${operation} failed: ${details}`);
  }

  async function upsertManyRecords(entities: TEntity[]): Promise<void> {
    if (entities.length === 0) {
      return;
    }

    const remoteEntities = entities.map((entity) => toSanitizedRemote(entity));

    assertSuccessfulBatch(
      "batchUpdate",
      await options.api.batchUpdate(
        remoteEntities as Parameters<typeof options.api.batchUpdate>[0],
      ),
    );
  }

  async function replaceManyRecords(entities: TEntity[]): Promise<void> {
    await updateManyRecords(
      entities.map((entity) => ({
        id: asKeyString(options.toRemote(entity).id),
        value: entity,
      })),
    );
  }

  async function updateManyRecords(
    inputs: StoreUpdateInput<TEntity>[],
  ): Promise<void> {
    if (inputs.length === 0) {
      return;
    }

    const updatePayloads = inputs.map(({ id, value }) => ({
      ...toSanitizedRemote(value),
      id,
    }));

    assertSuccessfulBatch(
      "batchUpdate",
      await options.api.batchUpdate(
        updatePayloads as Parameters<typeof options.api.batchUpdate>[0],
      ),
    );
  }

  async function patchManyRecords(
    inputs: Array<{ id: string; value: Partial<TEntity> }>,
  ): Promise<void> {
    if (inputs.length === 0) {
      return;
    }

    const patchPayloads = inputs.map((input) => ({
      ...toSanitizedPatchRemote(input.value),
      id: input.id,
    }));

    assertSuccessfulBatch(
      "batchPatch",
      await options.api.batchPatch(
        patchPayloads as Parameters<typeof options.api.batchPatch>[0],
      ),
    );
  }

  return {
    async get(id) {
      return getById(id);
    },

    async getMany(ids) {
      return loadRecordsByIds(ids);
    },

    async find(filters) {
      const records = await loadRecords({ filters, pageSize: 1 });
      return records[0] ?? null;
    },

    async list(input) {
      return loadRecords({
        ...(input.filters ? { filters: input.filters } : {}),
        ...(input.order ? { order: input.order } : {}),
        page: input.page,
        pageSize: input.pageSize,
      });
    },

    async upsert(entity) {
      await upsertManyRecords([entity]);
    },

    async upsertMany(entities) {
      return upsertManyRecords(entities);
    },

    async replace(entity) {
      const remote = toSanitizedRemote(entity);
      const id = asKeyString(remote.id);
      await options.api.update(
        id,
        remote as Parameters<typeof options.api.update>[1],
      );
    },

    async replaceMany(entities) {
      await replaceManyRecords(entities);
    },

    async update({ value }) {
      const remote = toSanitizedRemote(value);
      const id = asKeyString(remote.id);
      await options.api.update(id, { ...remote, id } as Parameters<
        typeof options.api.update
      >[1]);
    },

    async updateMany(inputs) {
      await updateManyRecords(inputs);
    },

    async patch({ id, value }) {
      await options.api.patch(
        id,
        toSanitizedPatchRemote(value) as Partial<TObject>,
      );
    },

    async patchMany(inputs) {
      await patchManyRecords(inputs);
    },

    async delete(id) {
      const existing = await getById(id);
      if (!existing) {
        return;
      }

      await options.api.delete(id);
    },

    async deleteMany(ids) {
      if (ids.length === 0) {
        return;
      }

      const existingIds = new Set(
        (await fetchRemoteObjects({ ids })).map((object) => object.id),
      );
      const deleteIds = ids.filter((id) => existingIds.has(id));
      if (deleteIds.length === 0) {
        return;
      }
      await options.api.batchDelete(deleteIds);
    },
  };
}

function translateStoreFilter(
  filter: StoreValueFilter<unknown>,
  relationField?: FlotiqRelationField,
): Filter | null {
  const operators = getDefinedOperators(filter);

  if (operators.length !== 1) {
    return null;
  }

  switch (operators[0]) {
    case "eq":
      return relationField
        ? translateRelationEqualsFilter(filter.eq, relationField)
        : translateEqualsFilter(filter.eq);
    case "neq":
      return relationField
        ? translateRelationNotEqualsFilter(filter.neq, relationField)
        : translateNotEqualsFilter(filter.neq);
    case "in":
      return relationField
        ? translateRelationInFilter(filter.in ?? [], relationField)
        : { type: "equals", filter: toRemoteScalarArray(filter.in ?? []) };
    case "notIn":
      return relationField
        ? translateRelationNotInFilter(filter.notIn ?? [], relationField)
        : {
            type: "notEqual",
            filter: toRemoteScalarArray(filter.notIn ?? []),
          };
    case "isNull":
      return { type: filter.isNull ? "empty" : "notEmpty" };
    default:
      return null;
  }
}

function sanitizeWritePayload(
  value: JsonRecord,
  emptyStringNullFields: ReadonlySet<string>,
  relationFields: ReadonlyMap<string, FlotiqRelationField>,
): JsonRecord {
  const entries = Object.entries(value)
    .filter(([key]) => key !== "internal")
    .map(
      ([key, entryValue]) =>
        [
          key,
          sanitizeWriteValue(
            key,
            normalizeRelationWriteValue(key, entryValue, relationFields),
            emptyStringNullFields,
            relationFields,
          ),
        ] as const,
    )
    .filter(([, entryValue]) => entryValue !== undefined);

  return Object.fromEntries(entries);
}

function sanitizeWriteValue(
  key: string,
  value: unknown,
  emptyStringNullFields: ReadonlySet<string>,
  relationFields: ReadonlyMap<string, FlotiqRelationField>,
): unknown {
  if (key === "createdAt" || key === "updatedAt") {
    return undefined;
  }

  if (value === null) {
    return emptyStringNullFields.has(key) ? "" : undefined;
  }

  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const sanitizedItems = value
      .map((item) =>
        sanitizeWriteValue("", item, emptyStringNullFields, relationFields),
      )
      .filter((item) => item !== undefined);
    return sanitizedItems;
  }

  if (typeof value === "object") {
    return sanitizeWritePayload(
      value as JsonRecord,
      emptyStringNullFields,
      new Map(),
    );
  }

  return value;
}

function getDefinedOperators(filter: StoreValueFilter<unknown>): string[] {
  return [
    filter.eq === undefined ? null : "eq",
    filter.neq === undefined ? null : "neq",
    Array.isArray(filter.in) ? "in" : null,
    Array.isArray(filter.notIn) ? "notIn" : null,
    filter.isNull === undefined ? null : "isNull",
  ].filter((value): value is string => value !== null);
}

function translateEqualsFilter(value: unknown): Filter {
  if (value === null) {
    return { type: "empty" };
  }

  return { type: "equals", filter: value as string | number | boolean };
}

function translateNotEqualsFilter(value: unknown): Filter {
  if (value === null) {
    return { type: "notEmpty" };
  }

  return { type: "notEqual", filter: value as string | number | boolean };
}

function translateRelationEqualsFilter(
  value: unknown,
  relationField: FlotiqRelationField,
): Filter {
  if (value === null) {
    return { type: "empty" };
  }

  return {
    type: "overlaps",
    filter: [toRelationDataUrl(value, relationField)],
  };
}

function translateRelationNotEqualsFilter(
  value: unknown,
  relationField: FlotiqRelationField,
): Filter {
  if (value === null) {
    return { type: "notEmpty" };
  }

  return {
    type: "notContains",
    filter: toRelationDataUrl(value, relationField),
  };
}

function translateRelationInFilter(
  values: readonly unknown[],
  relationField: FlotiqRelationField,
): Filter {
  return {
    type: "overlaps",
    filter: values.map((value) => toRelationDataUrl(value, relationField)),
  };
}

function translateRelationNotInFilter(
  values: readonly unknown[],
  relationField: FlotiqRelationField,
): Filter {
  if (values.length === 1) {
    return {
      type: "notContains",
      filter: toRelationDataUrl(values[0], relationField),
    };
  }

  return {
    type: "notContains",
    filter: values.map((value) => toRelationDataUrl(value, relationField)),
  };
}

function toRemoteScalarArray(
  values: readonly unknown[],
): string[] | number[] | boolean[] {
  if (values.length === 0) {
    return [];
  }

  if (values.every((value) => typeof value === "string")) {
    return [...values];
  }

  if (values.every((value) => typeof value === "number")) {
    return [...values];
  }

  if (values.every((value) => typeof value === "boolean")) {
    return [...values];
  }

  throw new TypeError(
    "Flotiq array filters must contain values of one scalar type",
  );
}

function mapFieldName(field: string): string {
  if (field === "createdAt" || field === "updatedAt") {
    return `internal.${field}`;
  }

  return field;
}

function asKeyString(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  throw new TypeError("Unsupported Flotiq key value");
}

function normalizeRelationWriteValue(
  key: string,
  value: unknown,
  relationFields: ReadonlyMap<string, FlotiqRelationField>,
): unknown {
  const relationField = relationFields.get(key);
  if (!relationField) {
    return value;
  }

  return toRelationWriteValue(value, relationField);
}

function toRelationWriteValue(
  value: unknown,
  relationField: FlotiqRelationField,
): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => toRelationWriteEntries(item, relationField));
  }

  return toRelationWriteEntries(value, relationField);
}

function toRelationWriteEntries(
  value: unknown,
  relationField: FlotiqRelationField,
): JsonRecord[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (typeof value === "object") {
    const entry = value as JsonRecord;
    if (typeof entry.dataUrl === "string") {
      return [entry];
    }

    if (typeof entry.id === "string") {
      return [
        createRelationEntry(relationField.contentType, asKeyString(entry.id)),
      ];
    }
  }

  return [createRelationEntry(relationField.contentType, asKeyString(value))];
}

function createRelationEntry(contentType: string, id: string): JsonRecord {
  return {
    type: "internal",
    dataUrl: buildRelationDataUrl(contentType, id),
  };
}

function toRelationDataUrl(
  value: unknown,
  relationField: FlotiqRelationField,
): string {
  return buildRelationDataUrl(relationField.contentType, asKeyString(value));
}

function buildRelationDataUrl(contentType: string, id: string): string {
  return `/api/v1/content/${contentType}/${id}`;
}
