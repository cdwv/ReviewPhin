import { z } from "zod";

import type { TenantRecord } from "../../storage/contract/index.js";
import { normalizeGitLabBaseUrl } from "./url.js";

export const gitLabTenantConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .transform((value) => normalizeGitLabBaseUrl(value)),
  projectId: z.coerce.number().int().positive(),
  apiToken: z.string().min(1),
  webhookSecret: z.string().min(1),
  botUserId: z.coerce.number().int().positive(),
  botUsername: z.string().min(1),
});

export type GitLabTenantConfig = z.infer<typeof gitLabTenantConfigSchema>;

export function getGitLabTenantConfig(tenant: TenantRecord): GitLabTenantConfig {
  if (tenant.platform !== "gitlab") {
    throw new Error(
      `Tenant ${tenant.id} uses platform "${tenant.platform}", expected gitlab`,
    );
  }

  const parsedJson: unknown = JSON.parse(tenant.platformConfigJson);
  return gitLabTenantConfigSchema.parse(parsedJson);
}
