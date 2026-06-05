import type { TenantRecord } from "../../storage/contract/index.js";
import type { GitLabUser } from "./types.js";
import { getGitLabTenantConfig } from "./tenant-config.js";

export function isBotUser(
  user: Pick<GitLabUser, "id" | "username">,
  tenant: TenantRecord,
): boolean {
  return user.id === getGitLabTenantConfig(tenant).botUserId;
}
