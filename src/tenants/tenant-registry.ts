import type {
  IPlatform,
  PlatformWebhookRequest,
  ResolvedTenant,
} from "../platforms/IPlatform.js";
import { listAll, type StorageHelpers } from "../storage/storage-helpers.js";
import type { TenantRecord } from "../storage/contract/index.js";

export class TenantRegistry {
  private readonly storage: StorageHelpers;

  public constructor(options: { storage: StorageHelpers }) {
    this.storage = options.storage;
  }

  public async getTenantById(tenantId: string): Promise<TenantRecord | null> {
    return this.storage.stores.tenants.get(tenantId);
  }

  public async getResolvedTenantById(
    tenantId: string,
  ): Promise<ResolvedTenant | null> {
    const tenant = await this.getTenantById(tenantId);
    return tenant ? this.resolveTenant(tenant) : null;
  }

  public async getResolvedTenantByKey(
    tenantKey: string,
  ): Promise<ResolvedTenant | null> {
    const tenant = await this.storage.stores.tenants.find({
      key: { eq: tenantKey },
    });
    return tenant ? this.resolveTenant(tenant) : null;
  }

  public async resolveWebhookTenant(
    platform: IPlatform,
    payload: unknown,
    req: PlatformWebhookRequest,
  ): Promise<ResolvedTenant | null> {
    const tenantKey = await platform.identifyTenantKey(payload, req);
    if (!tenantKey) {
      return null;
    }

    const tenant = await this.storage.stores.tenants.find({
      key: { eq: tenantKey },
      platform: { eq: platform.getPlatformInfo().slug },
    });
    if (!tenant) {
      return null;
    }

    const resolvedTenant = await this.resolveTenant(tenant);
    if (!resolvedTenant) {
      return null;
    }
    return (await platform.isWebhookRequestAuthorized(resolvedTenant, req))
      ? resolvedTenant
      : null;
  }

  public async listTenantsForPlatform(
    platform: string,
  ): Promise<TenantRecord[]> {
    return listAll(this.storage.stores.tenants, {
      filters: { platform: { eq: platform } },
      order: [{ field: "key", direction: "asc" }],
    });
  }

  public getTenantKey(tenant: TenantRecord): string {
    return tenant.key;
  }

  private async resolveTenant(
    tenant: TenantRecord,
  ): Promise<ResolvedTenant | null> {
    const connection = await this.storage.stores.platformConnections.get(
      tenant.platformConnectionId,
    );
    if (
      !connection ||
      connection.status !== "ready" ||
      connection.platform !== tenant.platform
    ) {
      return null;
    }
    return { tenant, connection };
  }
}
