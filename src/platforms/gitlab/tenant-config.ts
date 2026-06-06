import { z } from "zod";

import type {
  PlatformConnectionRecord,
  TenantRecord,
} from "../../storage/contract/index.js";

export const gitLabTenantConfigSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  webhookSecret: z.string().min(1),
});

export type GitLabTenantConfig = z.infer<typeof gitLabTenantConfigSchema>;

export function getGitLabTenantConfig(
  tenant: TenantRecord,
): GitLabTenantConfig {
  if (tenant.platform !== "gitlab") {
    throw new Error(
      `Tenant ${tenant.id} uses platform "${tenant.platform}", expected gitlab`,
    );
  }

  const parsedJson: unknown = JSON.parse(tenant.platformConfigJson);
  return gitLabTenantConfigSchema.parse(parsedJson);
}

export const gitLabConnectionConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiToken: z.string().min(1),
  botUserId: z.coerce.number().int().positive(),
  botUsername: z.string().min(1),
});

export type GitLabConnectionConfig = z.infer<
  typeof gitLabConnectionConfigSchema
>;

export function getGitLabConnectionConfig(
  connection: PlatformConnectionRecord | undefined,
  legacyTenant?: TenantRecord,
): GitLabConnectionConfig {
  if (!connection && legacyTenant) {
    return gitLabConnectionConfigSchema.parse(
      JSON.parse(legacyTenant.platformConfigJson) as unknown,
    );
  }
  if (!connection) {
    throw new Error("GitLab platform connection is required");
  }
  if (connection.platform !== "gitlab") {
    throw new Error(
      `Connection ${connection.id} uses platform "${connection.platform}", expected gitlab`,
    );
  }
  return gitLabConnectionConfigSchema.parse(
    JSON.parse(connection.platformConnectionConfigJson) as unknown,
  );
}
