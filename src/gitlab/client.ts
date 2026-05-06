import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { GitLabHttpLogEntry } from "../review/run-artifacts.js";
import type {
  GitLabAwardEmoji,
  GitLabDiscussion,
  GitLabDiffPosition,
  GitLabMergeRequest,
  GitLabMergeRequestChange,
  GitLabProject,
  GitLabMergeRequestVersion,
  GitLabNote,
  GitLabRepositoryTreeItem,
  GitLabWikiPage,
  TriggerNoteReference,
} from "./types.js";
import { buildGitLabApiUrl, normalizeGitLabBaseUrl } from "./url.js";

interface GitLabClientOptions {
  baseUrl: string;
  apiToken: string;
  logger: Logger;
  requestLogger?:
    | {
        log(entry: GitLabHttpLogEntry): Promise<void>;
      }
    | undefined;
}

export class GitLabApiError extends Error {
  public readonly status: number;
  public readonly responseBody: string;
  public readonly requestUrl: string;

  public constructor(
    message: string,
    status: number,
    responseBody: string,
    requestUrl: string,
  ) {
    super(message);
    this.name = "GitLabApiError";
    this.status = status;
    this.responseBody = responseBody;
    this.requestUrl = requestUrl;
  }
}

export class GitLabClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly logger: Logger;
  private readonly requestLogger: GitLabClientOptions["requestLogger"];

  public constructor(options: GitLabClientOptions) {
    this.baseUrl = normalizeGitLabBaseUrl(options.baseUrl);
    this.apiToken = options.apiToken;
    this.logger = options.logger.child({ gitlabBaseUrl: this.baseUrl });
    this.requestLogger = options.requestLogger;
  }

  public async getMergeRequest(
    projectId: number,
    mergeRequestIid: number,
  ): Promise<GitLabMergeRequest> {
    return this.requestJson<GitLabMergeRequest>(
      "GET",
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}`,
    );
  }

  public async getProject(projectId: number): Promise<GitLabProject> {
    return this.requestJson<GitLabProject>(
      "GET",
      `/projects/${encodeURIComponent(String(projectId))}`,
    );
  }

  public async listProjectWikiPages(
    projectId: number,
    options: {
      withContent?: boolean | undefined;
    } = {},
  ): Promise<GitLabWikiPage[]> {
    return this.requestPaginated<GitLabWikiPage>(
      `/projects/${encodeURIComponent(String(projectId))}/wikis`,
      {
        with_content: options.withContent ? 1 : undefined,
      },
    );
  }

  public async getProjectWikiPage(
    projectId: number,
    slug: string,
  ): Promise<GitLabWikiPage> {
    return this.requestJson<GitLabWikiPage>(
      "GET",
      `/projects/${encodeURIComponent(String(projectId))}/wikis/${encodeURIComponent(slug)}`,
    );
  }

  public async createProjectWikiPage(
    projectId: number,
    input: {
      title: string;
      content: string;
      format?: string | undefined;
    },
  ): Promise<GitLabWikiPage> {
    return this.requestForm<GitLabWikiPage>(
      "POST",
      `/projects/${encodeURIComponent(String(projectId))}/wikis`,
      {
        title: input.title,
        content: input.content,
        ...(input.format ? { format: input.format } : {}),
      },
    );
  }

  public async updateProjectWikiPage(
    projectId: number,
    slug: string,
    input: {
      title?: string | undefined;
      content?: string | undefined;
      format?: string | undefined;
    },
  ): Promise<GitLabWikiPage> {
    return this.requestForm<GitLabWikiPage>(
      "PUT",
      `/projects/${encodeURIComponent(String(projectId))}/wikis/${encodeURIComponent(slug)}`,
      input,
    );
  }

  public async listMergeRequestVersions(
    projectId: number,
    mergeRequestIid: number,
  ): Promise<GitLabMergeRequestVersion[]> {
    return this.requestPaginated<GitLabMergeRequestVersion>(
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/versions`,
    );
  }

  public async getMergeRequestChanges(
    projectId: number,
    mergeRequestIid: number,
  ): Promise<GitLabMergeRequestChange[]> {
    try {
      const response = await this.requestJson<{
        changes: GitLabMergeRequestChange[];
      }>(
        "GET",
        `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/changes`,
      );
      return response.changes;
    } catch (error) {
      if (!(error instanceof GitLabApiError) || error.status !== 404) {
        throw error;
      }

      return this.requestPaginated<GitLabMergeRequestChange>(
        `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/diffs`,
      );
    }
  }

  public async listMergeRequestNotes(
    projectId: number,
    mergeRequestIid: number,
  ): Promise<GitLabNote[]> {
    return this.requestPaginated<GitLabNote>(
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/notes`,
    );
  }

  public async listMergeRequestDiscussions(
    projectId: number,
    mergeRequestIid: number,
  ): Promise<GitLabDiscussion[]> {
    return this.requestPaginated<GitLabDiscussion>(
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/discussions`,
    );
  }

  public async listMergeRequestNoteAwardEmojis(
    projectId: number,
    mergeRequestIid: number,
    noteId: number,
  ): Promise<GitLabAwardEmoji[]> {
    return this.requestPaginated<GitLabAwardEmoji>(
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/notes/${noteId}/award_emoji`,
    );
  }

  public async listMergeRequestDiscussionNoteAwardEmojis(
    projectId: number,
    mergeRequestIid: number,
    discussionId: string,
    noteId: number,
  ): Promise<GitLabAwardEmoji[]> {
    return this.requestPaginated<GitLabAwardEmoji>(
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/discussions/${encodeURIComponent(discussionId)}/notes/${noteId}/award_emoji`,
    );
  }

  public async createMergeRequestNoteAwardEmoji(
    projectId: number,
    mergeRequestIid: number,
    noteId: number,
    name: string,
  ): Promise<GitLabAwardEmoji> {
    return this.requestForm<GitLabAwardEmoji>(
      "POST",
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/notes/${noteId}/award_emoji`,
      { name },
    );
  }

  public async createMergeRequestDiscussionNoteAwardEmoji(
    projectId: number,
    mergeRequestIid: number,
    discussionId: string,
    noteId: number,
    name: string,
  ): Promise<GitLabAwardEmoji> {
    return this.requestForm<GitLabAwardEmoji>(
      "POST",
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/discussions/${encodeURIComponent(discussionId)}/notes/${noteId}/award_emoji`,
      { name },
    );
  }

  public async listTriggerNoteAwardEmojis(
    projectId: number,
    mergeRequestIid: number,
    note: TriggerNoteReference,
  ): Promise<GitLabAwardEmoji[]> {
    return note.kind === "discussion-note"
      ? this.listMergeRequestDiscussionNoteAwardEmojis(
          projectId,
          mergeRequestIid,
          note.discussionId,
          note.noteId,
        )
      : this.listMergeRequestNoteAwardEmojis(
          projectId,
          mergeRequestIid,
          note.noteId,
        );
  }

  public async createTriggerNoteAwardEmoji(
    projectId: number,
    mergeRequestIid: number,
    note: TriggerNoteReference,
    name: string,
  ): Promise<GitLabAwardEmoji> {
    return note.kind === "discussion-note"
      ? this.createMergeRequestDiscussionNoteAwardEmoji(
          projectId,
          mergeRequestIid,
          note.discussionId,
          note.noteId,
          name,
        )
      : this.createMergeRequestNoteAwardEmoji(
          projectId,
          mergeRequestIid,
          note.noteId,
          name,
        );
  }

  public async createMergeRequestDiscussion(
    projectId: number,
    mergeRequestIid: number,
    input: { body: string; position?: GitLabDiffPosition | null },
  ): Promise<GitLabDiscussion> {
    const payload: Record<string, unknown> = { body: input.body };
    if (input.position) {
      payload.position = input.position;
    }

    return this.requestForm<GitLabDiscussion>(
      "POST",
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/discussions`,
      payload,
    );
  }

  public async createMergeRequestNote(
    projectId: number,
    mergeRequestIid: number,
    body: string,
  ): Promise<GitLabNote> {
    return this.requestForm<GitLabNote>(
      "POST",
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/notes`,
      { body },
    );
  }

  public async updateMergeRequestNote(
    projectId: number,
    mergeRequestIid: number,
    noteId: number,
    body: string,
  ): Promise<GitLabNote> {
    return this.requestForm<GitLabNote>(
      "PUT",
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/notes/${noteId}`,
      { body },
    );
  }

  public async replyToDiscussion(
    projectId: number,
    mergeRequestIid: number,
    discussionId: string,
    body: string,
  ): Promise<GitLabNote> {
    return this.requestForm<GitLabNote>(
      "POST",
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/discussions/${discussionId}/notes`,
      { body },
    );
  }

  public async updateDiscussionNote(
    projectId: number,
    mergeRequestIid: number,
    discussionId: string,
    noteId: number,
    body: string,
  ): Promise<GitLabNote> {
    return this.requestForm<GitLabNote>(
      "PUT",
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/discussions/${discussionId}/notes/${noteId}`,
      { body },
    );
  }

  public async resolveDiscussion(
    projectId: number,
    mergeRequestIid: number,
    discussionId: string,
    resolved: boolean,
  ): Promise<GitLabDiscussion> {
    return this.requestForm<GitLabDiscussion>(
      "PUT",
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mergeRequestIid}/discussions/${discussionId}`,
      { resolved },
    );
  }

  public async downloadRepositoryArchive(
    projectId: number,
    ref: string,
  ): Promise<Buffer> {
    return this.requestBuffer(
      "GET",
      `/projects/${encodeURIComponent(String(projectId))}/repository/archive.tar.gz`,
      { sha: ref },
    );
  }

  public async listRepositoryTree(
    projectId: number,
    ref: string,
    path?: string,
    recursive = false,
  ): Promise<GitLabRepositoryTreeItem[]> {
    return this.requestPaginated<GitLabRepositoryTreeItem>(
      `/projects/${encodeURIComponent(String(projectId))}/repository/tree`,
      {
        ref,
        recursive: recursive ? "true" : "false",
        path,
      },
    );
  }

  public async getRawFile(
    projectId: number,
    filePath: string,
    ref: string,
  ): Promise<string> {
    const requestUrl = this.buildUrl(
      `/projects/${encodeURIComponent(String(projectId))}/repository/files/${encodeURIComponent(filePath)}/raw`,
      { ref },
    );
    const requestId = randomUUID();
    const startedAt = Date.now();
    await this.logGitLabRequest({
      timestamp: new Date().toISOString(),
      requestId,
      phase: "request",
      method: "GET",
      path: `/projects/${encodeURIComponent(String(projectId))}/repository/files/${encodeURIComponent(filePath)}/raw`,
      requestUrl: requestUrl.toString(),
      request: {
        query: { ref },
        headers: {
          accept: "*/*",
        },
      },
    });
    const response = await fetch(requestUrl, {
      method: "GET",
      headers: this.buildHeaders({
        accept: "*/*",
      }),
    });

    const responseBody = await response.text();
    if (!response.ok) {
      await this.logGitLabRequest({
        timestamp: new Date().toISOString(),
        requestId,
        phase: "error",
        method: "GET",
        path: `/projects/${encodeURIComponent(String(projectId))}/repository/files/${encodeURIComponent(filePath)}/raw`,
        requestUrl: requestUrl.toString(),
        status: response.status,
        durationMs: Date.now() - startedAt,
        response: {
          headers: summarizeHeaders(response.headers),
          body: truncateForLog(responseBody),
        },
      });
      throw new GitLabApiError(
        `GitLab raw file request failed for ${filePath} with ${response.status}`,
        response.status,
        responseBody,
        requestUrl.toString(),
      );
    }

    await this.logGitLabRequest({
      timestamp: new Date().toISOString(),
      requestId,
      phase: "response",
      method: "GET",
      path: `/projects/${encodeURIComponent(String(projectId))}/repository/files/${encodeURIComponent(filePath)}/raw`,
      requestUrl: requestUrl.toString(),
      status: response.status,
      durationMs: Date.now() - startedAt,
      response: {
        headers: summarizeHeaders(response.headers),
        body: truncateForLog(responseBody),
      },
    });
    return responseBody;
  }

  public buildGitAuthEnv(
    baseEnv: NodeJS.ProcessEnv = process.env,
  ): NodeJS.ProcessEnv {
    return {
      ...baseEnv,
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`oauth2:${this.apiToken}`).toString("base64")}`,
    };
  }

  private async requestJson<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const requestUrl = this.buildUrl(path, query);
    const requestId = randomUUID();
    const startedAt = Date.now();
    await this.logGitLabRequest({
      timestamp: new Date().toISOString(),
      requestId,
      phase: "request",
      method,
      path,
      requestUrl: requestUrl.toString(),
      request: {
        query,
        headers: {
          accept: "application/json",
        },
      },
    });
    const response = await fetch(requestUrl, {
      method,
      headers: this.buildHeaders(),
    });

    const responseBody = await response.text();
    if (!response.ok) {
      await this.logGitLabRequest({
        timestamp: new Date().toISOString(),
        requestId,
        phase: "error",
        method,
        path,
        requestUrl: requestUrl.toString(),
        status: response.status,
        durationMs: Date.now() - startedAt,
        response: {
          headers: summarizeHeaders(response.headers),
          body: truncateForLog(responseBody),
        },
      });
      throw new GitLabApiError(
        `GitLab API request failed for ${method} ${path} with ${response.status}`,
        response.status,
        responseBody,
        requestUrl.toString(),
      );
    }

    await this.logGitLabRequest({
      timestamp: new Date().toISOString(),
      requestId,
      phase: "response",
      method,
      path,
      requestUrl: requestUrl.toString(),
      status: response.status,
      durationMs: Date.now() - startedAt,
      response: {
        headers: summarizeHeaders(response.headers),
        body: truncateForLog(responseBody),
      },
    });

    return JSON.parse(responseBody) as T;
  }

  private async requestBuffer(
    method: "GET",
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<Buffer> {
    const requestUrl = this.buildUrl(path, query);
    const requestId = randomUUID();
    const startedAt = Date.now();
    await this.logGitLabRequest({
      timestamp: new Date().toISOString(),
      requestId,
      phase: "request",
      method,
      path,
      requestUrl: requestUrl.toString(),
      request: {
        query,
        headers: {
          accept: "application/octet-stream, application/x-gzip, */*",
        },
      },
    });
    const response = await fetch(requestUrl, {
      method,
      headers: this.buildHeaders({
        accept: "application/octet-stream, application/x-gzip, */*",
      }),
    });

    if (!response.ok) {
      const responseBody = await response.text();
      await this.logGitLabRequest({
        timestamp: new Date().toISOString(),
        requestId,
        phase: "error",
        method,
        path,
        requestUrl: requestUrl.toString(),
        status: response.status,
        durationMs: Date.now() - startedAt,
        response: {
          headers: summarizeHeaders(response.headers),
          body: truncateForLog(responseBody),
        },
      });
      throw new GitLabApiError(
        `GitLab archive request failed for ${path} with ${response.status}`,
        response.status,
        responseBody,
        requestUrl.toString(),
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    await this.logGitLabRequest({
      timestamp: new Date().toISOString(),
      requestId,
      phase: "response",
      method,
      path,
      requestUrl: requestUrl.toString(),
      status: response.status,
      durationMs: Date.now() - startedAt,
      response: {
        headers: summarizeHeaders(response.headers),
        body: {
          kind: "binary",
          size: arrayBuffer.byteLength,
        },
      },
    });
    return Buffer.from(arrayBuffer);
  }

  private async requestForm<T>(
    method: "POST" | "PUT",
    path: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const body = new URLSearchParams();
    appendFormValue(body, payload);

    const requestUrl = this.buildUrl(path);
    const requestId = randomUUID();
    const startedAt = Date.now();
    await this.logGitLabRequest({
      timestamp: new Date().toISOString(),
      requestId,
      phase: "request",
      method,
      path,
      requestUrl: requestUrl.toString(),
      request: {
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: payload,
      },
    });
    const response = await fetch(requestUrl, {
      method,
      headers: this.buildHeaders({
        "content-type": "application/x-www-form-urlencoded",
      }),
      body,
    });

    const responseBody = await response.text();
    if (!response.ok) {
      await this.logGitLabRequest({
        timestamp: new Date().toISOString(),
        requestId,
        phase: "error",
        method,
        path,
        requestUrl: requestUrl.toString(),
        status: response.status,
        durationMs: Date.now() - startedAt,
        request: {
          body: payload,
        },
        response: {
          headers: summarizeHeaders(response.headers),
          body: truncateForLog(responseBody),
        },
      });
      throw new GitLabApiError(
        `GitLab form request failed for ${method} ${path} with ${response.status}`,
        response.status,
        responseBody,
        requestUrl.toString(),
      );
    }

    await this.logGitLabRequest({
      timestamp: new Date().toISOString(),
      requestId,
      phase: "response",
      method,
      path,
      requestUrl: requestUrl.toString(),
      status: response.status,
      durationMs: Date.now() - startedAt,
      response: {
        headers: summarizeHeaders(response.headers),
        body: truncateForLog(responseBody),
      },
    });

    return JSON.parse(responseBody) as T;
  }

  private async requestPaginated<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T[]> {
    const items: T[] = [];
    let page = 1;

    while (true) {
      const requestUrl = this.buildUrl(path, {
        ...query,
        page,
        per_page: 100,
      });
      const requestId = randomUUID();
      const startedAt = Date.now();
      await this.logGitLabRequest({
        timestamp: new Date().toISOString(),
        requestId,
        phase: "request",
        method: "GET",
        path,
        requestUrl: requestUrl.toString(),
        request: {
          query: {
            ...query,
            page,
            per_page: 100,
          },
          headers: {
            accept: "application/json",
          },
        },
      });
      const response = await fetch(requestUrl, {
        method: "GET",
        headers: this.buildHeaders(),
      });

      const responseBody = await response.text();
      if (!response.ok) {
        await this.logGitLabRequest({
          timestamp: new Date().toISOString(),
          requestId,
          phase: "error",
          method: "GET",
          path,
          requestUrl: requestUrl.toString(),
          status: response.status,
          durationMs: Date.now() - startedAt,
          response: {
            headers: summarizeHeaders(response.headers),
            body: truncateForLog(responseBody),
          },
        });
        throw new GitLabApiError(
          `GitLab paginated request failed for ${path} with ${response.status}`,
          response.status,
          responseBody,
          requestUrl.toString(),
        );
      }

      await this.logGitLabRequest({
        timestamp: new Date().toISOString(),
        requestId,
        phase: "response",
        method: "GET",
        path,
        requestUrl: requestUrl.toString(),
        status: response.status,
        durationMs: Date.now() - startedAt,
        response: {
          headers: summarizeHeaders(response.headers),
          body: truncateForLog(responseBody),
        },
      });

      const pageItems = JSON.parse(responseBody) as T[];
      items.push(...pageItems);

      const nextPage = response.headers.get("x-next-page");
      if (!nextPage) {
        return items;
      }

      page = Number(nextPage);
      if (!Number.isFinite(page) || page <= 0) {
        return items;
      }
    }
  }

  private buildUrl(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): URL {
    return buildGitLabApiUrl(this.baseUrl, path, query);
  }

  private buildHeaders(additional: Record<string, string> = {}): Headers {
    return new Headers({
      "private-token": this.apiToken,
      accept: "application/json",
      ...additional,
    });
  }

  private async logGitLabRequest(entry: GitLabHttpLogEntry): Promise<void> {
    if (!this.requestLogger) {
      return;
    }

    try {
      await this.requestLogger.log(entry);
    } catch (error) {
      this.logger.warn(
        { err: error, requestId: entry.requestId, path: entry.path },
        "failed to persist GitLab request log",
      );
    }
  }
}

function appendFormValue(
  params: URLSearchParams,
  value: Record<string, unknown> | unknown[],
  prefix?: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      appendUnknownFormValue(
        params,
        entry,
        prefix ? `${prefix}[${index}]` : String(index),
      );
    });
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    appendUnknownFormValue(params, entry, prefix ? `${prefix}[${key}]` : key);
  }
}

function appendUnknownFormValue(
  params: URLSearchParams,
  value: unknown,
  key: string,
): void {
  if (value === null || value === undefined) {
    return;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    params.append(key, String(value));
    return;
  }

  if (Array.isArray(value)) {
    appendFormValue(params, value, key);
    return;
  }

  appendFormValue(params, value as Record<string, unknown>, key);
}

function summarizeHeaders(headers: Headers): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === "set-cookie") {
      continue;
    }

    summary[key] = value;
  }

  return summary;
}

function truncateForLog(value: unknown, maxLength = 20_000): unknown {
  if (typeof value !== "string") {
    return value;
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]`;
}
