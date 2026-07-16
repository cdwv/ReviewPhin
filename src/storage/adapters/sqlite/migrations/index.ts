import baselineMigration from "./0001-v0-baseline.js";
import platformTenantsMigration from "./0002-v1-platform-tenants.js";
import reviewEntityIdsMigration from "./0003-v1-review-entity-ids.js";
import tenantScopedReviewsMigration from "./0004-v1-tenant-scoped-reviews.js";
import codeReviewSnapshotsMigration from "./0005-v1-code-review-snapshots.js";
import dropLegacyTenantColumnsMigration from "./0006-v1-drop-legacy-tenant-columns.js";
import genericStorageColumnNamesMigration from "./0007-v1-generic-storage-column-names.js";
import platformConnectionsMigration from "./0008-v2-platform-connections.js";
import providerTriggersMigration from "./0009-v3-provider-triggers.js";
import projectMemoriesMigration from "./0010-v4-project-memories.js";
import jobClaimsAndReasoningEffortMigration from "./0011-v5-job-claims-and-reasoning-effort.js";
import sessionMetricsMigration from "./0012-v6-session-metrics.js";
import type { SqliteMigration } from "./types.js";

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  baselineMigration,
  platformTenantsMigration,
  reviewEntityIdsMigration,
  tenantScopedReviewsMigration,
  codeReviewSnapshotsMigration,
  dropLegacyTenantColumnsMigration,
  genericStorageColumnNamesMigration,
  platformConnectionsMigration,
  providerTriggersMigration,
  projectMemoriesMigration,
  jobClaimsAndReasoningEffortMigration,
  sessionMetricsMigration,
];
