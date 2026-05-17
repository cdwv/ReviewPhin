import { z } from "zod";

import type { GitLabNoteHookPayload } from "./types.js";
import { urlMatchesGitLabBase } from "./url.js";

const GITLAB_USERNAME_TRAILING_CHAR_PATTERN = "[A-Za-z0-9_.-]";

const noteHookSchema = z.object({
  object_kind: z.literal("note"),
  event_type: z.string().optional(),
  project: z.object({
    id: z.number().int().positive(),
    web_url: z.string().url().optional(),
  }),
  repository: z
    .object({
      homepage: z.string().url().optional(),
    })
    .optional(),
  merge_request: z.object({
    iid: z.number().int().positive(),
    title: z.string(),
    description: z.string(),
    source_branch: z.string(),
    target_branch: z.string(),
    last_commit: z
      .object({
        id: z.string().min(1),
      })
      .optional(),
    diff_refs: z
      .object({
        base_sha: z.string(),
        start_sha: z.string(),
        head_sha: z.string(),
      })
      .optional(),
  }),
  object_attributes: z.object({
    id: z.number().int().positive(),
    note: z.string(),
    noteable_type: z.literal("MergeRequest"),
    action: z.enum(["create", "update"]).optional(),
    draft: z.boolean().optional(),
    author_id: z.number().int().positive().optional(),
    noteable_id: z.number().int().positive().nullable().optional(),
    system: z.boolean().optional(),
    internal: z.boolean().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    url: z.string().url().optional(),
  }),
  user: z
    .object({
      id: z.number().int().positive(),
      username: z.string(),
      name: z.string(),
      web_url: z.string().url().optional(),
    })
    .optional(),
});

export function parseGitLabNoteHook(payload: unknown): GitLabNoteHookPayload {
  return noteHookSchema.parse(payload);
}

export function containsBotMention(
  noteBody: string,
  botUsername: string,
): boolean {
  return buildBotMentionPattern(botUsername).test(noteBody);
}

export function extractBotMentionInstruction(
  noteBody: string,
  botUsername: string,
): string | null {
  const instruction = noteBody
    .replace(buildBotMentionPattern(botUsername, "ig"), "$1")
    .replace(/\s+/g, " ")
    .trim();

  return instruction.length > 0 ? instruction : null;
}

export function extractWebhookUrls(payload: GitLabNoteHookPayload): string[] {
  const urls = [
    payload.project.web_url,
    payload.repository?.homepage,
    payload.object_attributes.url,
  ]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .map((value) => {
      const parsed = new URL(value);
      parsed.hash = "";
      return parsed.toString().replace(/\/+$/, "");
    });

  return Array.from(new Set(urls));
}

export function webhookMatchesGitLabBase(
  payload: GitLabNoteHookPayload,
  baseUrl: string,
): boolean {
  return extractWebhookUrls(payload).some((url) =>
    urlMatchesGitLabBase(url, baseUrl),
  );
}

export function extractWebhookHeadSha(payload: GitLabNoteHookPayload): string {
  return (
    payload.merge_request.last_commit?.id ??
    payload.merge_request.diff_refs?.head_sha ??
    (() => {
      throw new Error(
        "GitLab note hook payload did not include a merge request head SHA",
      );
    })()
  );
}

function buildBotMentionPattern(botUsername: string, flags = "i"): RegExp {
  return new RegExp(
    `(^|[^\\w])@${escapeRegExp(botUsername)}(?!${GITLAB_USERNAME_TRAILING_CHAR_PATTERN})`,
    flags,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
