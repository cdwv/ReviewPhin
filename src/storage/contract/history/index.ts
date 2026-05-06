export interface StorageContractRevisionMetadata {
  readonly id: string;
  readonly summary: string;
  readonly changeKind: "baseline" | "additive" | "breaking";
  readonly affectedSurfaces: readonly string[];
  readonly providerNotes: readonly string[];
}

export const STORAGE_CONTRACT_HISTORY = [
  {
    id: "storage-v000",
    summary: "Baseline contract snapshot for the pre-provider SQLite schema.",
    changeKind: "baseline",
    affectedSurfaces: [
      "model-profiles",
      "tenants",
      "interaction-jobs",
      "merge-request-snapshots",
      "interaction-runs",
      "interaction-run-metrics",
      "review-findings",
      "discussion-mappings"
    ],
    providerNotes: [
      "Freeze the existing SQLite table shape as-is.",
      "Track migrations in provider-owned metadata storage.",
      "Adapters must exactly match the current storage contract revision."
    ]
  }
] as const satisfies readonly StorageContractRevisionMetadata[];

export type StorageContractRevisionId = (typeof STORAGE_CONTRACT_HISTORY)[number]["id"];
