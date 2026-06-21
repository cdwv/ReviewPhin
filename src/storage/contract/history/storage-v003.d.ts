import type {
  CreateInteractionJobInput as V002CreateInteractionJobInput,
  EntityStore,
  InteractionJobOrderField,
  InteractionJobQueryField,
  InteractionJobRecord as V002InteractionJobRecord,
  StoreFilters,
  StorageStores as V002StorageStores,
} from "./storage-v002.js";

export * from "./storage-v002.js";

export interface InteractionJobRecord extends Omit<
  V002InteractionJobRecord,
  "commentId"
> {
  commentId: number | null;
  triggerJson: string;
}

export type CreateInteractionJobInput = Omit<
  V002CreateInteractionJobInput,
  "commentId"
> & {
  commentId: number | null;
  triggerJson?: string;
};

export type InteractionJobFilters = StoreFilters<
  InteractionJobRecord,
  InteractionJobQueryField
>;

export type InteractionJobStore = EntityStore<
  InteractionJobRecord,
  InteractionJobFilters,
  InteractionJobOrderField
>;

export interface StorageStores extends Omit<
  V002StorageStores,
  "interactionJobs"
> {
  readonly interactionJobs: InteractionJobStore;
}
