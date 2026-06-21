import { describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../src/platforms/github/client.js";
import { GitHubRepositoryContextResolver } from "../src/platforms/github/repository-context.js";
import type { TenantRecord } from "../src/storage/contract/current.js";
import type { StorageHelpers } from "../src/storage/storage-helpers.js";

describe("GitHubRepositoryContextResolver", () => {
  it("persists a current repository full name resolved by canonical id", async () => {
    const patch = vi.fn(async () => undefined);
    const tenant = createTenant("old-owner/old-name");
    const resolver = createResolver({
      patch,
      resolveRepositoryById: vi.fn(async () => ({
        id: 2468,
        name: "new-name",
        fullName: "new-owner/new-name",
        private: true,
        htmlUrl: "https://github.com/new-owner/new-name",
        ownerLogin: "new-owner",
        ownerId: 999,
        ownerType: "Organization",
      })),
    });

    await expect(resolver.resolve(tenant)).resolves.toMatchObject({
      tenantConfig: {
        repositoryId: 2468,
        repositoryFullName: "new-owner/new-name",
      },
      repository: {
        id: 2468,
        fullName: "new-owner/new-name",
      },
    });
    expect(patch).toHaveBeenCalledWith({
      id: tenant.id,
      value: {
        platformConfigJson: JSON.stringify({
          repositoryId: 2468,
          repositoryFullName: "new-owner/new-name",
        }),
        updatedAt: expect.any(String),
      },
    });
    expect(JSON.parse(tenant.platformConfigJson)).toEqual({
      repositoryId: 2468,
      repositoryFullName: "new-owner/new-name",
    });
  });

  it("does not write unchanged repository metadata", async () => {
    const patch = vi.fn(async () => undefined);
    const resolver = createResolver({
      patch,
      resolveRepositoryById: vi.fn(async () => ({
        id: 2468,
        name: "reviewphin",
        fullName: "octo-org/reviewphin",
        private: true,
        htmlUrl: "https://github.com/octo-org/reviewphin",
        ownerLogin: "octo-org",
        ownerId: 456,
        ownerType: "Organization",
      })),
    });

    await resolver.resolve(createTenant("octo-org/reviewphin"));

    expect(patch).not.toHaveBeenCalled();
  });
});

function createResolver(input: {
  patch: ReturnType<typeof vi.fn>;
  resolveRepositoryById: ReturnType<typeof vi.fn>;
}) {
  return new GitHubRepositoryContextResolver({
    storage: {
      stores: {
        tenants: {
          patch: input.patch,
        },
      },
    } as unknown as StorageHelpers,
    client: {
      resolveRepositoryById: input.resolveRepositoryById,
    } as unknown as GitHubClient,
    logger: {
      info: vi.fn(),
    } as never,
  });
}

function createTenant(repositoryFullName: string): TenantRecord {
  return {
    id: "tenant-github",
    key: "https://api.github.com::2468",
    platform: "github",
    platformConnectionId: "connection-github",
    platformConfigJson: JSON.stringify({
      repositoryId: 2468,
      repositoryFullName,
    }),
    modelProfileName: null,
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
  };
}
