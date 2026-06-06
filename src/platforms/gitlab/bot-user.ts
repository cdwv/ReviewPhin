import type { GitLabUser } from "./types.js";

export function isBotUser(
  user: Pick<GitLabUser, "id" | "username">,
  botUserId: number,
): boolean {
  return user.id === botUserId;
}
