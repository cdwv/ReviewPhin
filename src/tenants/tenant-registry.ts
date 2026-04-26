import type { GitLabNoteHookPayload } from "../gitlab/types.js";
import type { Storage, TenantRecord } from "../storage/types.js";
import { normalizeGitLabBaseUrl } from "../gitlab/url.js";
import { webhookMatchesGitLabBase } from "../gitlab/webhook.js";
import { constantTimeEqual } from "../utils/hash.js";
import { createTenantKey } from "../utils/ids.js";

export class TenantRegistry {
  private readonly storage: Storage;

  public constructor(options: { storage: Storage }) {
    this.storage = options.storage;
  }

  public async initialize(): Promise<void> {
    await this.storage.listTenants();
  }

  public async getTenantById(tenantId: string): Promise<TenantRecord | null> {
    return this.storage.getTenantById(tenantId);
  }

  public async resolveWebhookTenant(
    payload: GitLabNoteHookPayload,
    providedSecret: string | undefined
  ): Promise<TenantRecord | null> {
    if (!providedSecret) {
      return null;
    }

    const projectTenants = await this.storage.listTenantsByProjectId(payload.project.id);
    if (projectTenants.length === 0) {
      return null;
    }

    const narrowed = projectTenants.length
      ? projectTenants.filter((tenant) => webhookMatchesGitLabBase(payload, tenant.baseUrl))
      : projectTenants;

    const candidates = (narrowed.length > 0 ? narrowed : projectTenants).slice().sort((left, right) => {
      return normalizeGitLabBaseUrl(right.baseUrl).length - normalizeGitLabBaseUrl(left.baseUrl).length;
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
