import { monotonicFactory } from "ulidx";

import { sha256 } from "./hash.js";

const ulid = monotonicFactory();

export function createId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export function createTenantKey(baseUrl: string, projectId: number): string {
  return `${normalizeBaseUrl(baseUrl)}::${projectId}`;
}

export function createInteractionJobDedupeKey(input: {
  baseUrl: string;
  projectId: number;
  codeReviewId: number;
  commentId: number;
  commentAction?: "create" | "update" | undefined;
  commentUpdatedAt?: string | undefined;
  commentBody?: string | undefined;
}): string {
  return sha256(
    [
      normalizeBaseUrl(input.baseUrl),
      input.projectId,
      input.codeReviewId,
      input.commentId,
      input.commentAction ?? "create",
      resolveInteractionJobCommentRevision(input),
    ].join("::"),
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
      normalizeForKey(input.side ?? ""),
    ].join("::"),
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
      input.suggestionReplacement?.trim() ?? "",
    ].join("::"),
  );
}

function normalizeForKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveInteractionJobCommentRevision(input: {
  commentAction?: "create" | "update" | undefined;
  commentUpdatedAt?: string | undefined;
  commentBody?: string | undefined;
}): string {
  if (input.commentAction !== "update") {
    return "initial";
  }

  if (input.commentUpdatedAt && input.commentUpdatedAt.length > 0) {
    return `updated-at:${input.commentUpdatedAt}`;
  }

  return `body:${sha256(input.commentBody ?? "")}`;
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  const normalizedPath = stripTrailingSlashes(parsed.pathname).replace(
    /\/api\/v4$/i,
    "",
  );
  return `${parsed.origin}${normalizedPath}`;
}

function stripTrailingSlashes(value: string): string {
  if (value === "/") {
    return "";
  }

  return value.replace(/\/+$/, "");
}
