import type { Logger } from "pino";

import type { TenantRecord } from "../../storage/contract/current.js";
import type { StorageHelpers } from "../../storage/storage-helpers.js";
import type { GitHubClient, GitHubRepository } from "./client.js";
import {
  getGitHubTenantConfig,
  type GitHubTenantConfig,
} from "./tenant-config.js";

export interface ResolvedGitHubRepositoryContext {
  repository: GitHubRepository;
  tenantConfig: GitHubTenantConfig;
}

export class GitHubRepositoryContextResolver {
  public constructor(
    private readonly options: {
      storage: StorageHelpers;
      client: GitHubClient;
      logger: Logger;
    },
  ) {}

  public async resolve(
    tenant: TenantRecord,
  ): Promise<ResolvedGitHubRepositoryContext> {
    const tenantConfig = getGitHubTenantConfig(tenant);
    const repository = await this.options.client.resolveRepositoryById(
      tenantConfig.repositoryId,
    );
    if (repository.id !== tenantConfig.repositoryId) {
      throw new Error(
        `GitHub returned repository ${repository.id}, expected ${tenantConfig.repositoryId}`,
      );
    }
    if (repository.fullName === tenantConfig.repositoryFullName) {
      return { repository, tenantConfig };
    }

    const refreshedTenantConfig = {
      ...tenantConfig,
      repositoryFullName: repository.fullName,
    };
    await this.options.storage.stores.tenants.patch({
      id: tenant.id,
      value: {
        platformConfigJson: JSON.stringify(refreshedTenantConfig),
        updatedAt: new Date().toISOString(),
      },
    });
    tenant.platformConfigJson = JSON.stringify(refreshedTenantConfig);

    this.options.logger.info(
      {
        tenantId: tenant.id,
        repositoryId: tenantConfig.repositoryId,
        previousRepositoryFullName: tenantConfig.repositoryFullName,
        repositoryFullName: repository.fullName,
      },
      "refreshed GitHub tenant repository metadata",
    );

    return {
      repository,
      tenantConfig: refreshedTenantConfig,
    };
  }
}
