import { z } from "zod";

import type { TenantRecord } from "../../storage/contract/current.js";

const repositoryFullNameSchema = z
  .string()
  .trim()
  .regex(/^[^/\s]+\/[^/\s]+$/, {
    message: "repository must use the owner/repository format",
  });

export const githubTenantRegistrationSchema = z.object({
  repository: repositoryFullNameSchema,
});

export const githubTenantConfigSchema = z.object({
  repositoryId: z.number().int().positive(),
  repositoryFullName: repositoryFullNameSchema,
});

export type GitHubTenantConfig = z.infer<typeof githubTenantConfigSchema>;

export function splitGitHubRepositoryFullName(fullName: string): {
  owner: string;
  repository: string;
} {
  const parsed = repositoryFullNameSchema.parse(fullName);
  const separator = parsed.indexOf("/");
  return {
    owner: parsed.slice(0, separator),
    repository: parsed.slice(separator + 1),
  };
}

export function getGitHubTenantConfig(
  tenant: TenantRecord,
): GitHubTenantConfig {
  if (tenant.platform !== "github") {
    throw new Error(
      `Tenant ${tenant.id} uses platform "${tenant.platform}", expected github`,
    );
  }
  return githubTenantConfigSchema.parse(
    JSON.parse(tenant.platformConfigJson) as unknown,
  );
}
