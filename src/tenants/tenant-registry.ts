import type { GitLabNoteHookPayload } from "../gitlab/types.js";
import { listAll, type StorageHelpers } from "../storage/storage-helpers.js";
import type { TenantRecord } from "../storage/contract/index.js";
import { normalizeGitLabBaseUrl } from "../gitlab/url.js";
import { webhookMatchesGitLabBase } from "../gitlab/webhook.js";
import { constantTimeEqual } from "../utils/hash.js";
import { createTenantKey } from "../utils/ids.js";

export class TenantRegistry {
  private readonly storage: StorageHelpers;

  public constructor(options: { storage: StorageHelpers }) {
    this.storage = options.storage;
  }

  public async getTenantById(tenantId: string): Promise<TenantRecord | null> {
    return this.storage.stores.tenants.get(tenantId);
  }

  public async resolveWebhookTenant(
    payload: GitLabNoteHookPayload,
    providedSecret: string | undefined,
  ): Promise<TenantRecord | null> {
    if (!providedSecret) {
      return null;
    }

    const projectTenants = await listAll(this.storage.stores.tenants, {
      filters: { projectId: { eq: payload.project.id } },
      order: [
        { field: "baseUrl", direction: "asc" },
        { field: "projectId", direction: "asc" },
      ],
    });
    if (projectTenants.length === 0) {
      return null;
    }

    const narrowed = projectTenants.length
      ? projectTenants.filter((tenant) =>
          webhookMatchesGitLabBase(payload, tenant.baseUrl),
        )
      : projectTenants;

    const candidates = (
      narrowed.length > 0 ? narrowed : projectTenants
    ).toSorted((left, right) => {
      return (
        normalizeGitLabBaseUrl(right.baseUrl).length -
        normalizeGitLabBaseUrl(left.baseUrl).length
      );
    });

    for (const tenant of candidates) {
      if (constantTimeEqual(tenant.webhookSecret, providedSecret)) {
        return tenant;
      }
    }

    return null;
  }

  public getTenantKey(tenant: TenantRecord): string {
    return createTenantKey(tenant.baseUrl, tenant.projectId);
  }
}
