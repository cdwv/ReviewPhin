import { getGitLabTenantConfig } from "../../src/platforms/gitlab/tenant-config.js";
import type {
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
  createdAt?: string;
  updatedAt?: string;
};

export function createGitLabTenantInput(
  options: GitLabTenantFixtureOptions = {},
): StorageTenantInput {
  const {
    baseUrl = "https://gitlab.example.com",
    projectId = 123,
    apiToken = "token",
    webhookSecret = "secret",
    botUserId = 999,
    botUsername = "review-bot",
    modelProfileName = null,
  } = options;

  return {
    key: createTenantKey(baseUrl, projectId),
    platform: "gitlab",
    platformConfigJson: JSON.stringify({
      baseUrl,
      projectId,
      apiToken,
      webhookSecret,
      botUserId,
      botUsername,
    }),
    modelProfileName,
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
  return getGitLabTenantConfig(tenant).baseUrl;
}
