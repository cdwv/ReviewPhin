import type { TenantRecord } from "../storage/types.js";
import type { GitLabUser } from "./types.js";

export function isBotUser(user: Pick<GitLabUser, "id" | "username">, tenant: TenantRecord): boolean {
  if (tenant.botUserId !== null) {
    return user.id === tenant.botUserId;
  }

  if (tenant.botUsername !== null) {
    return user.username.toLowerCase() === tenant.botUsername.toLowerCase();
  }

  return false;
}
