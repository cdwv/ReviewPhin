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
      "discussion-mappings",
    ],
    providerNotes: [
      "Freeze the existing SQLite table shape as-is.",
      "Track migrations in provider-owned metadata storage.",
      "Adapters must exactly match the current storage contract revision.",
    ],
  },
  {
    id: "storage-v001",
    summary:
      "Platform-provider contract with generic code-review, comment, and discussion entities.",
    changeKind: "breaking",
    affectedSurfaces: [
      "tenants",
      "interaction-jobs",
      "code-review-snapshots",
      "interaction-run-metrics",
      "discussion-mappings",
    ],
    providerNotes: [
      "Tenants store platform and platformConfigJson instead of GitLab-specific columns.",
      "Generic storage contracts use codeReview/comment/discussion names instead of mergeRequest/note/thread names.",
      "Built-in adapters must report storage-v001 and preserve provider-local migrations for existing data.",
    ],
  },
  {
    id: "storage-v002",
    summary:
      "First-class platform connections with required tenant connection references.",
    changeKind: "breaking",
    affectedSurfaces: ["platform-connections", "tenants"],
    providerNotes: [
      "Adapters add a globally name-unique platform connection store.",
      "Every tenant requires platformConnectionId.",
      "SQLite migrates reusable GitLab credentials out of tenant config.",
    ],
  },
  {
    id: "storage-v003",
    summary:
      "Provider-owned interaction trigger identity with nullable comment references.",
    changeKind: "breaking",
    affectedSurfaces: ["interaction-jobs"],
    providerNotes: [
      "Adapters add triggerJson without removing or renaming historical fields.",
      "Existing GitLab jobs derive triggerJson from their preserved commentId.",
      "commentId remains available but becomes nullable for triggers without a comment.",
    ],
  },
  {
    id: "storage-v004",
    summary:
      "First-class store-backed project memory records scoped one-to-one to tenants.",
    changeKind: "additive",
    affectedSurfaces: ["project-memories", "tenants"],
    providerNotes: [
      "Adapters add a project memory store keyed by tenant id.",
      "Each tenant may have at most one project memory record.",
      "Tenant deletion removes the tenant project memory record and reports its count.",
    ],
  },
  {
    id: "storage-v005",
    summary:
      "Claim-aware interaction-job queue with leases and optional reasoning effort.",
    changeKind: "breaking",
    affectedSurfaces: [
      "interaction-jobs",
      "interaction-runs",
      "code-review-snapshots",
      "model-profiles",
    ],
    providerNotes: [
      "Adapters implement a claim-aware interaction-job store with atomic or single-worker claim semantics.",
      "Interaction jobs add availableAt, claim fields, latestInteractionRunId, and the terminal expired status.",
      "Runs snapshot the owning claim token and both reasoning-effort values; profiles and snapshots add matching fields.",
    ],
  },
  {
    id: "storage-v006",
    summary:
      "Session-scoped harness metrics with open usage-unit keys and storage-backed reporting.",
    changeKind: "breaking",
    affectedSurfaces: ["interaction-run-metrics"],
    providerNotes: [
      "Adapters store one metrics record per harness session instead of one per interaction run.",
      "The premiumRequests field is replaced by a nullable usageUnit and usageAmount pair plus a unit-matched model breakdown.",
      "Existing metrics rows retain their counters and timestamps with deterministic legacy session identity.",
    ],
  },
] as const satisfies readonly StorageContractRevisionMetadata[];

export type StorageContractRevisionId =
  (typeof STORAGE_CONTRACT_HISTORY)[number]["id"];
