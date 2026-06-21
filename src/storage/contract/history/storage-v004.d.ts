import type {
  EntityStore,
  StoreFilters,
  StorageStores as V003StorageStores,
  TenantDeletionSummary as V003TenantDeletionSummary,
} from "./storage-v003.js";

export * from "./storage-v003.js";

export interface ProjectMemoryRecord {
  id: string;
  tenantId: string;
  entriesJson: string;
  createdAt: string;
  updatedAt: string;
}

export type ProjectMemoryQueryField =
  | "id"
  | "tenantId"
  | "createdAt"
  | "updatedAt";

export type ProjectMemoryFilters = StoreFilters<
  ProjectMemoryRecord,
  ProjectMemoryQueryField
>;

export type ProjectMemoryOrderField = ProjectMemoryQueryField;

export type ProjectMemoryStore = EntityStore<
  ProjectMemoryRecord,
  ProjectMemoryFilters,
  ProjectMemoryOrderField
>;

export interface TenantDeletionSummary extends V003TenantDeletionSummary {
  projectMemoryCount: number;
}

export interface StorageStores extends V003StorageStores {
  readonly projectMemories: ProjectMemoryStore;
}
