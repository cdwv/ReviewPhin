import type {
  EntityStore,
  InteractionJobStore as V005InteractionJobStore,
  InteractionRunOrderField,
  InteractionRunQueryField,
  InteractionRunRecord,
  InteractionRunMetricsRecord as V005InteractionRunMetricsRecord,
  StorageStores as V005StorageStores,
  StoreValueFilter as V005StoreValueFilter,
} from "./storage-v005.js";

export * from "./storage-v005.js";

export interface StoreValueFilter<TValue> extends V005StoreValueFilter<TValue> {
  gte?: TValue;
  lt?: TValue;
}

export type StoreFilters<TEntity, TKeys extends keyof TEntity> = Partial<{
  [TKey in TKeys]: StoreValueFilter<TEntity[TKey]>;
}>;

export type InteractionRunFilters = StoreFilters<
  InteractionRunRecord,
  InteractionRunQueryField
>;

export type InteractionRunStore = EntityStore<
  InteractionRunRecord,
  InteractionRunFilters,
  InteractionRunOrderField
>;

export interface UsageByModelMetric {
  model: string;
  amount: number;
}

export interface InteractionRunMetricsRecord extends Omit<
  V005InteractionRunMetricsRecord,
  "premiumRequests"
> {
  harness: string;
  harnessSessionKey: string;
  sessionType: string;
  usageUnit: string | null;
  usageAmount: number | null;
  usageByModelJson: string;
}

export type UpsertInteractionRunMetricsInput = Omit<
  InteractionRunMetricsRecord,
  "id" | "createdAt" | "updatedAt"
>;

export type InteractionRunMetricsQueryField =
  | "id"
  | "interactionRunId"
  | "harness"
  | "harnessSessionKey"
  | "sessionType"
  | "usageUnit"
  | "createdAt"
  | "updatedAt";

export type InteractionRunMetricsFilters = StoreFilters<
  InteractionRunMetricsRecord,
  InteractionRunMetricsQueryField
>;

export type InteractionRunMetricsOrderField = InteractionRunMetricsQueryField;

export type InteractionRunMetricsStore = EntityStore<
  InteractionRunMetricsRecord,
  InteractionRunMetricsFilters,
  InteractionRunMetricsOrderField
>;

export interface InteractionJobStore extends Omit<
  V005InteractionJobStore,
  "upsertInteractionRunMetricsForClaim"
> {
  upsertInteractionRunMetricsForClaim(input: {
    jobId: string;
    claimToken: string;
    interactionRunId: string;
    metrics: UpsertInteractionRunMetricsInput;
  }): Promise<boolean>;
}

export interface StorageStores extends Omit<
  V005StorageStores,
  "interactionJobs" | "interactionRuns" | "interactionRunMetrics"
> {
  readonly interactionJobs: InteractionJobStore;
  readonly interactionRuns: InteractionRunStore;
  readonly interactionRunMetrics: InteractionRunMetricsStore;
}
