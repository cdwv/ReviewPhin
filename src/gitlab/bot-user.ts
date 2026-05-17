import type { TenantRecord } from "../storage/contract/index.js";
import type { GitLabUser } from "./types.js";

export function isBotUser(
  user: Pick<GitLabUser, "id" | "username">,
  tenant: TenantRecord,
): boolean {
  return user.id === tenant.botUserId;
}
