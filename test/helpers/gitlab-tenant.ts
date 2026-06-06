import { getGitLabTenantConfig } from "../../src/platforms/gitlab/tenant-config.js";
import type {
  PlatformConnectionRecord,
  StorageTenantInput,
  TenantRecord,
} from "../../src/storage/contract/index.js";
import { createTenantKey } from "../../src/utils/ids.js";

type GitLabTenantFixtureOptions = {
  id?: string;
  baseUrl?: string;
  projectId?: number;
  apiToken?: string;
  webhookSecret?: string;
  botUserId?: number;
  botUsername?: string;
  modelProfileName?: string | null;
  platformConnectionId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export function createGitLabTenantInput(
  options: GitLabTenantFixtureOptions = {},
): StorageTenantInput {
  const {
    baseUrl = "https://gitlab.example.com",
    projectId = 123,
    webhookSecret = "secret",
    modelProfileName = null,
    platformConnectionId = "connection-1",
  } = options;

  return {
    key: createTenantKey(baseUrl, projectId),
    platform: "gitlab",
    platformConnectionId,
    platformConfigJson: JSON.stringify({
      projectId,
      webhookSecret,
    }),
    modelProfileName,
  };
}

export function createGitLabConnectionRecord(
  options: GitLabTenantFixtureOptions = {},
): PlatformConnectionRecord {
  const {
    baseUrl = "https://gitlab.example.com",
    apiToken = "token",
    botUserId = 999,
    botUsername = "review-bot",
    platformConnectionId = "connection-1",
    createdAt = "2026-05-08T12:00:00.000Z",
    updatedAt = "2026-05-08T12:00:00.000Z",
  } = options;
  return {
    id: platformConnectionId,
    name: `test-${platformConnectionId}`,
    platform: "gitlab",
    status: "ready",
    platformConnectionConfigJson: JSON.stringify({
      baseUrl,
      apiToken,
      botUserId,
      botUsername,
    }),
    createdAt,
    updatedAt,
  };
}

export function createGitLabTenantRecord(
  options: GitLabTenantFixtureOptions = {},
): TenantRecord {
  const {
    id = "tenant-1",
    createdAt = "2026-05-08T12:00:00.000Z",
    updatedAt = "2026-05-08T12:00:00.000Z",
  } = options;
  const tenantInput = createGitLabTenantInput(options);

  return {
    id,
    key: tenantInput.key,
    platform: tenantInput.platform,
    platformConnectionId: tenantInput.platformConnectionId,
    platformConfigJson: tenantInput.platformConfigJson,
    modelProfileName: tenantInput.modelProfileName ?? null,
    createdAt,
    updatedAt,
  };
}

export function getGitLabTenantProjectId(tenant: TenantRecord): number {
  return getGitLabTenantConfig(tenant).projectId;
}

export function getGitLabTenantBaseUrl(tenant: TenantRecord): string {
  return tenant.key.split("::")[0] ?? "";
}
