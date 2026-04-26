import { monotonicFactory } from "ulidx";

import { normalizeGitLabBaseUrl } from "../gitlab/url.js";
import { sha256 } from "./hash.js";

const ulid = monotonicFactory();

export function createId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export function createTenantKey(baseUrl: string, projectId: number): string {
  return `${normalizeGitLabBaseUrl(baseUrl)}::${projectId}`;
}

export function createReviewJobDedupeKey(input: {
  baseUrl: string;
  projectId: number;
  mergeRequestIid: number;
  noteId: number;
  headSha: string;
}): string {
  return sha256(
    [
      normalizeGitLabBaseUrl(input.baseUrl),
      input.projectId,
      input.mergeRequestIid,
      input.noteId,
      input.headSha
    ].join("::")
  );
}

export function createFindingIdentityKey(input: {
  title: string;
  category: string;
  path?: string | null | undefined;
  startLine?: number | null | undefined;
  endLine?: number | null | undefined;
  side?: string | null | undefined;
}): string {
  return sha256(
    [
      normalizeForKey(input.title),
      normalizeForKey(input.category),
      normalizeForKey(input.path ?? ""),
      input.startLine ?? "",
      input.endLine ?? "",
      normalizeForKey(input.side ?? "")
    ].join("::")
  );
}

export function createFindingFingerprint(input: {
  identityKey: string;
  body: string;
  suggestionReplacement?: string | null | undefined;
}): string {
  return sha256(
    [
      input.identityKey,
      input.body.trim(),
      input.suggestionReplacement?.trim() ?? ""
    ].join("::")
  );
}

function normalizeForKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
