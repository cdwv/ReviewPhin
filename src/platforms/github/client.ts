import { App, Octokit } from "octokit";
import { z } from "zod";

import {
  DEFAULT_MAX_IMAGE_BYTES,
  normalizeImageMimeType,
  parseImageContentLength,
  readLimitedImageResponse,
  SUPPORTED_IMAGE_MIME_TYPES,
} from "../image-attachments.js";

import type {
  ReadyGitHubConnectionConfig,
  RegisteredGitHubConnectionConfig,
} from "./config.js";

export interface GitHubAppApi {
  octokit: {
    auth?(options: {
      type: "installation";
      installationId: number;
      refresh?: boolean;
    }): Promise<unknown>;
    request(
      route: string,
      parameters: Record<string, unknown>,
    ): Promise<{ data: unknown }>;
  };
  webhooks?: {
    verify(payload: string, signature: string): Promise<boolean>;
  };
  getInstallationOctokit(installationId: number): Promise<GitHubApi>;
}

export interface GitHubApi {
  request(
    route: string,
    parameters?: Record<string, unknown>,
  ): Promise<{
    data: unknown;
    status?: number;
    headers?: Record<string, string | number | undefined>;
  }>;
}

export interface GitHubClientOptions {
  config: RegisteredGitHubConnectionConfig | ReadyGitHubConnectionConfig;
  createApp?: ((config: GitHubAppFactoryConfig) => GitHubAppApi) | undefined;
}

export interface GitHubAppFactoryConfig {
  appId: number;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  apiUrl: string;
}

const installationSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({
    login: z.string().min(1),
    id: z.number().int().positive(),
    type: z.string().min(1),
  }),
  repository_selection: z.enum(["all", "selected"]),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
  suspended_at: z.string().datetime().nullable().optional(),
});

const installationRepositoriesSchema = z.object({
  total_count: z.number().int().nonnegative(),
});

const repositorySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  full_name: z.string().min(3),
  private: z.boolean(),
  html_url: z.string().url(),
  has_wiki: z.boolean().optional(),
  owner: z.object({
    login: z.string().min(1),
    id: z.number().int().positive(),
    type: z.string().min(1).optional(),
  }),
});

const checkRunSchema = z.object({
  id: z.number().int().positive(),
  head_sha: z.string().min(1),
  app: z.object({
    id: z.number().int().positive(),
  }),
  pull_requests: z.array(
    z.object({
      number: z.number().int().positive(),
      head: z
        .object({
          sha: z.string().min(1),
        })
        .optional(),
    }),
  ),
});

const provisionedCheckRunSchema = z.object({
  id: z.number().int().positive(),
  head_sha: z.string().min(1),
  external_id: z.string().nullable().optional(),
  app: z.object({
    id: z.number().int().positive(),
  }),
});

const checkRunsForRefSchema = z.object({
  check_runs: z.array(provisionedCheckRunSchema),
});

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string().url(),
  user: z
    .object({
      login: z.string().min(1),
    })
    .nullable(),
  head: z.object({
    sha: z.string().min(1),
    ref: z.string().min(1),
  }),
  base: z.object({
    sha: z.string().min(1),
    ref: z.string().min(1),
  }),
});

const pullRequestHeadSchema = z.object({
  number: z.number().int().positive(),
  head: z.object({
    sha: z.string().min(1),
  }),
});

const pullRequestFileSchema = z.object({
  sha: z.string().min(1),
  filename: z.string().min(1),
  status: z.enum([
    "added",
    "removed",
    "modified",
    "renamed",
    "copied",
    "changed",
    "unchanged",
  ]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  blob_url: z.string().url(),
  raw_url: z.string().url(),
  contents_url: z.string().url(),
  patch: z.string().optional(),
  previous_filename: z.string().min(1).optional(),
});

const githubUserSchema = z
  .object({
    id: z.number().int().positive(),
    login: z.string().min(1),
    type: z.string().min(1).optional(),
  })
  .nullable();

const issueCommentSchema = z.object({
  id: z.number().int().positive(),
  body: z.string().nullable(),
  html_url: z.string().url(),
  user: githubUserSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

const pullRequestReviewSchema = z.object({
  id: z.number().int().positive(),
  body: z.string().nullable(),
  html_url: z.string().url(),
  user: githubUserSchema,
  state: z.string().min(1),
  commit_id: z.string().nullable(),
  submitted_at: z.string().datetime().nullable().optional(),
});

const reviewCommentSchema = z.object({
  id: z.number().int().positive(),
  body: z.string(),
  html_url: z.string().url(),
  user: githubUserSchema,
  path: z.string().min(1),
  diff_hunk: z.string(),
  pull_request_review_id: z.number().int().positive().nullable(),
  in_reply_to_id: z.number().int().positive().optional(),
  line: z.number().int().positive().nullable().optional(),
  original_line: z.number().int().positive().nullable().optional(),
  side: z.enum(["LEFT", "RIGHT"]).nullable().optional(),
  start_line: z.number().int().positive().nullable().optional(),
  original_start_line: z.number().int().positive().nullable().optional(),
  start_side: z.enum(["LEFT", "RIGHT"]).nullable().optional(),
  commit_id: z.string().min(1),
  original_commit_id: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

const reviewThreadCommentSchema = z.object({
  id: z.string().min(1),
  databaseId: z.number().int().positive(),
});

const reviewThreadSchema = z.object({
  id: z.string().min(1),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  viewerCanResolve: z.boolean(),
  viewerCanUnresolve: z.boolean(),
  comments: z.object({
    nodes: z.array(reviewThreadCommentSchema),
  }),
});

const reviewThreadsResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          nodes: z.array(reviewThreadSchema),
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullable(),
          }),
        }),
      }),
    }),
  }),
});

const graphQLErrorSchema = z
  .object({
    message: z.string(),
  })
  .passthrough();

const graphQLMutationResponseSchema = z
  .object({
    data: z.record(z.string(), z.unknown()).optional(),
    errors: z.array(graphQLErrorSchema).optional(),
  })
  .passthrough();

const reviewThreadMutationPayloadSchema = z.object({
  thread: z.object({
    id: z.string().min(1),
    isResolved: z.boolean(),
  }),
});

const reactionSchema = z.object({
  id: z.number().int().positive(),
  content: z.enum([
    "+1",
    "-1",
    "laugh",
    "confused",
    "heart",
    "hooray",
    "rocket",
    "eyes",
  ]),
  user: githubUserSchema,
  created_at: z.string().datetime(),
});

const GITHUB_USER_ASSET_STORAGE_HOST =
  "github-production-user-asset-6210df.s3.amazonaws.com";

export type GitHubInstallation = z.infer<typeof installationSchema>;
export type GitHubPullRequest = z.infer<typeof pullRequestSchema>;
export type GitHubPullRequestFile = z.infer<typeof pullRequestFileSchema>;
export type GitHubIssueComment = z.infer<typeof issueCommentSchema>;
export type GitHubPullRequestReview = z.infer<typeof pullRequestReviewSchema>;
export type GitHubReviewComment = z.infer<typeof reviewCommentSchema>;
export type GitHubReviewThread = z.infer<typeof reviewThreadSchema>;
export type GitHubReaction = z.infer<typeof reactionSchema>;

export interface GitHubPendingReviewComment {
  path: string;
  body: string;
  line: number;
  side: "RIGHT";
  startLine?: number | undefined;
  startSide?: "RIGHT" | undefined;
}

export class GitHubApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitHubApiError";
  }
}

export interface GitHubDownloadedImage {
  data: string;
  mimeType: string;
  sizeBytes: number;
}

export class GitHubImageDownloadError extends Error {
  public readonly status: number;
  public readonly url: string;

  public constructor(input: {
    message: string;
    status?: number | undefined;
    url: string;
    cause?: unknown;
  }) {
    super(input.message, input.cause ? { cause: input.cause } : undefined);
    this.name = "GitHubImageDownloadError";
    this.status = input.status ?? 0;
    this.url = redactGitHubImageUrl(input.url);
  }
}

export interface GitHubRepository {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  htmlUrl: string;
  ownerLogin: string;
  ownerId: number;
  ownerType?: string | undefined;
}

export interface GitHubCheckRunPullRequest {
  checkRunId: number;
  headSha: string;
  pullRequestNumber: number;
}

export interface GitHubProvisionedCheckRun {
  checkRunId: number;
  created: boolean;
}

export type GitHubCheckRunState =
  | { status: "queued"; summary: string }
  | { status: "in_progress"; summary: string }
  | {
      status: "completed";
      conclusion: "success" | "failure";
      summary: string;
    };

export class GitHubClient {
  private readonly app: GitHubAppApi;

  public constructor(private readonly options: GitHubClientOptions) {
    this.app = this.createAuthenticatedApp();
  }

  public async getInstallation(
    installationId: number,
  ): Promise<GitHubInstallation> {
    const response = await this.app.octokit.request(
      "GET /app/installations/{installation_id}",
      {
        installation_id: installationId,
      },
    );
    return installationSchema.parse(response.data);
  }

  public async getAccessibleRepositoryCount(
    installationId: number,
  ): Promise<number> {
    const installationOctokit =
      await this.app.getInstallationOctokit(installationId);
    const response = await installationOctokit.request(
      "GET /installation/repositories",
      {
        per_page: 1,
      },
    );
    return installationRepositoriesSchema.parse(response.data).total_count;
  }

  public async resolveRepository(
    owner: string,
    repository: string,
  ): Promise<GitHubRepository> {
    const installationId = this.getConfiguredInstallationId();
    const installationOctokit =
      await this.app.getInstallationOctokit(installationId);
    try {
      const response = await installationOctokit.request(
        "GET /repos/{owner}/{repo}",
        {
          owner,
          repo: repository,
        },
      );
      const parsed = repositorySchema.parse(response.data);
      return toGitHubRepository(parsed);
    } catch (error) {
      throw new Error(
        `Repository ${owner}/${repository} is not accessible to GitHub App installation ${installationId}`,
        { cause: error },
      );
    }
  }

  public async resolveRepositoryById(
    repositoryId: number,
  ): Promise<GitHubRepository> {
    try {
      const response = await (
        await this.getInstallationOctokit()
      ).request("GET /repositories/{repository_id}", {
        repository_id: repositoryId,
      });
      return toGitHubRepository(repositorySchema.parse(response.data));
    } catch (error) {
      throw translateGitHubApiError(
        `GitHub repository ${repositoryId} is not accessible to the configured installation`,
        error,
      );
    }
  }

  public async getPullRequest(
    repositoryFullName: string,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequest> {
    const { owner, repository } = splitRepositoryFullName(repositoryFullName);
    return this.requestParsed(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo: repository,
        pull_number: pullRequestNumber,
      },
      pullRequestSchema,
      `GitHub pull request ${repositoryFullName}#${pullRequestNumber}`,
    );
  }

  public async listOpenPullRequests(
    repositoryFullName: string,
  ): Promise<GitHubPullRequest[]> {
    return this.paginate(
      repositoryFullName,
      "GET /repos/{owner}/{repo}/pulls",
      { state: "open", sort: "created", direction: "asc" },
      pullRequestSchema,
      `open GitHub pull requests for ${repositoryFullName}`,
    );
  }

  public async listPullRequestFiles(
    repositoryFullName: string,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestFile[]> {
    return this.paginate(
      repositoryFullName,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      { pull_number: pullRequestNumber },
      pullRequestFileSchema,
      `files for GitHub pull request ${repositoryFullName}#${pullRequestNumber}`,
    );
  }

  public async listIssueComments(
    repositoryFullName: string,
    pullRequestNumber: number,
  ): Promise<GitHubIssueComment[]> {
    return this.paginate(
      repositoryFullName,
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { issue_number: pullRequestNumber },
      issueCommentSchema,
      `issue comments for GitHub pull request ${repositoryFullName}#${pullRequestNumber}`,
    );
  }

  public async listPullRequestReviews(
    repositoryFullName: string,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestReview[]> {
    return this.paginate(
      repositoryFullName,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      { pull_number: pullRequestNumber },
      pullRequestReviewSchema,
      `reviews for GitHub pull request ${repositoryFullName}#${pullRequestNumber}`,
    );
  }

  public async listReviewComments(
    repositoryFullName: string,
    pullRequestNumber: number,
  ): Promise<GitHubReviewComment[]> {
    return this.paginate(
      repositoryFullName,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      { pull_number: pullRequestNumber },
      reviewCommentSchema,
      `review comments for GitHub pull request ${repositoryFullName}#${pullRequestNumber}`,
    );
  }

  public async listReviewThreads(
    repositoryFullName: string,
    pullRequestNumber: number,
  ): Promise<GitHubReviewThread[]> {
    const { owner, repository } = splitRepositoryFullName(repositoryFullName);
    const installationOctokit = await this.getInstallationOctokit();
    const threads: GitHubReviewThread[] = [];
    let cursor: string | null = null;
    try {
      do {
        const response = await installationOctokit.request("POST /graphql", {
          query: `
            query ReviewPhinReviewThreads(
              $owner: String!
              $repository: String!
              $pullRequestNumber: Int!
              $cursor: String
            ) {
              repository(owner: $owner, name: $repository) {
                pullRequest(number: $pullRequestNumber) {
                  reviewThreads(first: 100, after: $cursor) {
                    nodes {
                      id
                      isResolved
                      isOutdated
                      viewerCanResolve
                      viewerCanUnresolve
                      comments(first: 100) {
                        nodes {
                          id
                          databaseId
                        }
                      }
                    }
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                  }
                }
              }
            }
          `,
          variables: {
            owner,
            repository,
            pullRequestNumber,
            cursor,
          },
        });
        const parsed = reviewThreadsResponseSchema.parse(response.data);
        threads.push(...parsed.data.repository.pullRequest.reviewThreads.nodes);
        const pageInfo =
          parsed.data.repository.pullRequest.reviewThreads.pageInfo;
        cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
      } while (cursor);
      return threads;
    } catch (error) {
      throw translateGitHubApiError(
        `review threads for GitHub pull request ${repositoryFullName}#${pullRequestNumber}`,
        error,
      );
    }
  }

  public async setReviewThreadResolved(
    threadId: string,
    resolved: boolean,
  ): Promise<void> {
    const mutationName = resolved
      ? "resolveReviewThread"
      : "unresolveReviewThread";
    const inputName = resolved
      ? "ResolveReviewThreadInput"
      : "UnresolveReviewThreadInput";
    try {
      const response = await (
        await this.getInstallationOctokit()
      ).request("POST /graphql", {
        query: `
          mutation ReviewPhinSetThreadResolved($input: ${inputName}!) {
            ${mutationName}(input: $input) {
              thread {
                id
                isResolved
              }
            }
          }
        `,
        variables: { input: { threadId } },
      });
      const parsed = graphQLMutationResponseSchema.parse(response.data);
      if (parsed.errors?.length) {
        throw new Error(parsed.errors.map((entry) => entry.message).join("; "));
      }
      const payload = reviewThreadMutationPayloadSchema.parse(
        parsed.data?.[mutationName],
      );
      if (payload.thread.id !== threadId) {
        throw new Error(
          `GitHub returned review thread ${payload.thread.id}, expected ${threadId}`,
        );
      }
      if (payload.thread.isResolved !== resolved) {
        throw new Error(
          `GitHub review thread ${threadId} isResolved=${payload.thread.isResolved}, expected ${resolved}`,
        );
      }
    } catch (error) {
      throw translateGitHubApiError(`GitHub review thread ${threadId}`, error);
    }
  }

  public async createPullRequestReview(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
    commitId: string;
    body: string;
    comments: GitHubPendingReviewComment[];
  }): Promise<GitHubPullRequestReview> {
    const { owner, repository } = splitRepositoryFullName(
      input.repositoryFullName,
    );
    return this.requestParsed(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      {
        owner,
        repo: repository,
        pull_number: input.pullRequestNumber,
        commit_id: input.commitId,
        body: input.body,
        comments: input.comments.map((comment) => ({
          path: comment.path,
          body: comment.body,
          line: comment.line,
          side: comment.side,
          ...(comment.startLine
            ? {
                start_line: comment.startLine,
                start_side: comment.startSide,
              }
            : {}),
        })),
      },
      pullRequestReviewSchema,
      `pending review for GitHub pull request ${input.repositoryFullName}#${input.pullRequestNumber}`,
    );
  }

  public async submitPullRequestReview(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
    reviewId: number;
  }): Promise<GitHubPullRequestReview> {
    const { owner, repository } = splitRepositoryFullName(
      input.repositoryFullName,
    );
    return this.requestParsed(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events",
      {
        owner,
        repo: repository,
        pull_number: input.pullRequestNumber,
        review_id: input.reviewId,
        event: "COMMENT",
      },
      pullRequestReviewSchema,
      `GitHub pull request review ${input.reviewId}`,
    );
  }

  public async deletePendingPullRequestReview(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
    reviewId: number;
  }): Promise<void> {
    const { owner, repository } = splitRepositoryFullName(
      input.repositoryFullName,
    );
    try {
      await (
        await this.getInstallationOctokit()
      ).request(
        "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}",
        {
          owner,
          repo: repository,
          pull_number: input.pullRequestNumber,
          review_id: input.reviewId,
        },
      );
    } catch (error) {
      throw translateGitHubApiError(
        `pending GitHub pull request review ${input.reviewId}`,
        error,
      );
    }
  }

  public async updateReviewComment(input: {
    repositoryFullName: string;
    commentId: number;
    body: string;
  }): Promise<GitHubReviewComment> {
    const { owner, repository } = splitRepositoryFullName(
      input.repositoryFullName,
    );
    return this.requestParsed(
      "PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}",
      {
        owner,
        repo: repository,
        comment_id: input.commentId,
        body: input.body,
      },
      reviewCommentSchema,
      `GitHub review comment ${input.commentId}`,
    );
  }

  public async replyToReviewComment(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
    commentId: number;
    body: string;
  }): Promise<GitHubReviewComment> {
    const { owner, repository } = splitRepositoryFullName(
      input.repositoryFullName,
    );
    return this.requestParsed(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies",
      {
        owner,
        repo: repository,
        pull_number: input.pullRequestNumber,
        comment_id: input.commentId,
        body: input.body,
      },
      reviewCommentSchema,
      `reply to GitHub review comment ${input.commentId}`,
    );
  }

  public async createIssueComment(input: {
    repositoryFullName: string;
    issueNumber: number;
    body: string;
  }): Promise<GitHubIssueComment> {
    const { owner, repository } = splitRepositoryFullName(
      input.repositoryFullName,
    );
    return this.requestParsed(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo: repository,
        issue_number: input.issueNumber,
        body: input.body,
      },
      issueCommentSchema,
      `GitHub issue comment on ${input.repositoryFullName}#${input.issueNumber}`,
    );
  }

  public async updateIssueComment(input: {
    repositoryFullName: string;
    commentId: number;
    body: string;
  }): Promise<GitHubIssueComment> {
    const { owner, repository } = splitRepositoryFullName(
      input.repositoryFullName,
    );
    return this.requestParsed(
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      {
        owner,
        repo: repository,
        comment_id: input.commentId,
        body: input.body,
      },
      issueCommentSchema,
      `GitHub issue comment ${input.commentId}`,
    );
  }

  public async listIssueCommentReactions(
    repositoryFullName: string,
    commentId: number,
  ): Promise<GitHubReaction[]> {
    return this.paginate(
      repositoryFullName,
      "GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
      { comment_id: commentId },
      reactionSchema,
      `reactions for GitHub issue comment ${commentId}`,
    );
  }

  public async createIssueCommentReaction(input: {
    repositoryFullName: string;
    commentId: number;
    content: GitHubReaction["content"];
  }): Promise<GitHubReaction> {
    const { owner, repository } = splitRepositoryFullName(
      input.repositoryFullName,
    );
    return this.requestParsed(
      "POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
      {
        owner,
        repo: repository,
        comment_id: input.commentId,
        content: input.content,
      },
      reactionSchema,
      `reaction for GitHub issue comment ${input.commentId}`,
    );
  }

  public async listPullRequestReviewCommentReactions(
    repositoryFullName: string,
    commentId: number,
  ): Promise<GitHubReaction[]> {
    return this.paginate(
      repositoryFullName,
      "GET /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
      { comment_id: commentId },
      reactionSchema,
      `reactions for GitHub pull request review comment ${commentId}`,
    );
  }

  public async createPullRequestReviewCommentReaction(input: {
    repositoryFullName: string;
    commentId: number;
    content: GitHubReaction["content"];
  }): Promise<GitHubReaction> {
    const { owner, repository } = splitRepositoryFullName(
      input.repositoryFullName,
    );
    return this.requestParsed(
      "POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
      {
        owner,
        repo: repository,
        comment_id: input.commentId,
        content: input.content,
      },
      reactionSchema,
      `reaction for GitHub pull request review comment ${input.commentId}`,
    );
  }

  public async downloadRepositoryArchive(
    repositoryFullName: string,
    ref: string,
  ): Promise<Buffer> {
    const { owner, repository } = splitRepositoryFullName(repositoryFullName);
    try {
      const response = await (
        await this.getInstallationOctokit()
      ).request("GET /repos/{owner}/{repo}/tarball/{ref}", {
        owner,
        repo: repository,
        ref,
      });
      if (!(
        response.data instanceof ArrayBuffer ||
        ArrayBuffer.isView(response.data)
      )) {
        throw new Error("GitHub archive response was not binary");
      }
      return Buffer.from(
        response.data instanceof ArrayBuffer
          ? new Uint8Array(response.data)
          : new Uint8Array(
              response.data.buffer,
              response.data.byteOffset,
              response.data.byteLength,
            ),
      );
    } catch (error) {
      throw translateGitHubApiError(
        `Repository archive ${repositoryFullName}@${ref}`,
        error,
      );
    }
  }

  public async downloadImage(
    url: string,
    options: {
      maxBytes?: number | undefined;
      maxRedirects?: number | undefined;
    } = {},
  ): Promise<GitHubDownloadedImage> {
    let requestUrl = parseGitHubImageUrl(url);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    const maxRedirects = options.maxRedirects ?? 5;

    for (let redirectCount = 0; ; redirectCount += 1) {
      const headers: Record<string, string> = {
        accept: "image/*, */*",
        "user-agent": "ReviewPhin",
      };
      if (requestUrl.hostname === "github.com") {
        try {
          headers.authorization = `Bearer ${await this.getInstallationToken()}`;
        } catch (error) {
          throw new GitHubImageDownloadError({
            message: "GitHub image installation authentication failed",
            url: requestUrl.toString(),
            cause: error,
          });
        }
      }

      let response: Response;
      try {
        response = await fetch(requestUrl, {
          method: "GET",
          headers,
          redirect: "manual",
        });
      } catch (error) {
        throw new GitHubImageDownloadError({
          message: `GitHub image request failed for ${redactGitHubImageUrl(requestUrl.toString())}`,
          url: requestUrl.toString(),
          cause: error,
        });
      }

      if (response.status >= 300 && response.status < 400) {
        if (redirectCount >= maxRedirects) {
          throw new GitHubImageDownloadError({
            message: `GitHub image request exceeded the ${maxRedirects} redirect limit`,
            status: response.status,
            url: requestUrl.toString(),
          });
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new GitHubImageDownloadError({
            message: "GitHub image redirect did not include a location",
            status: response.status,
            url: requestUrl.toString(),
          });
        }
        requestUrl = parseGitHubImageUrl(
          new URL(location, requestUrl).toString(),
          { allowUserAssetStorage: true },
        );
        continue;
      }

      if (!response.ok) {
        throw new GitHubImageDownloadError({
          message: `GitHub image request failed with status ${response.status}`,
          status: response.status,
          url: requestUrl.toString(),
        });
      }

      const contentType = normalizeImageMimeType(
        response.headers.get("content-type"),
      );
      if (!contentType || !SUPPORTED_IMAGE_MIME_TYPES.has(contentType)) {
        throw new GitHubImageDownloadError({
          message: `GitHub image response content type is unsupported: ${contentType ?? "missing"}`,
          status: response.status,
          url: requestUrl.toString(),
        });
      }
      const declaredSize = parseImageContentLength(
        response.headers.get("content-length"),
      );
      if (declaredSize !== null && declaredSize > maxBytes) {
        throw new GitHubImageDownloadError({
          message: `GitHub image exceeds the ${maxBytes} byte limit`,
          status: response.status,
          url: requestUrl.toString(),
        });
      }

      const buffer = await readLimitedImageResponse(
        response,
        maxBytes,
        { contentType },
        (failure) =>
          new GitHubImageDownloadError({
            message:
              failure.reason === "empty"
                ? "GitHub image response was empty"
                : `GitHub image exceeds the ${maxBytes} byte limit`,
            status: response.status,
            url: requestUrl.toString(),
          }),
      );
      return {
        data: buffer.toString("base64"),
        mimeType: contentType,
        sizeBytes: buffer.byteLength,
      };
    }
  }

  public async verifyWebhookSignature(
    payload: string,
    signature: string,
  ): Promise<boolean> {
    if (!this.app.webhooks) {
      throw new Error("GitHub App webhook verification is not available");
    }
    return this.app.webhooks.verify(payload, signature);
  }

  public async resolveCheckRunPullRequest(input: {
    repositoryFullName: string;
    checkRunId: number;
    expectedAppId: number;
  }): Promise<GitHubCheckRunPullRequest> {
    const { owner, repository } = splitRepositoryFullName(
      input.repositoryFullName,
    );
    const installationOctokit = await this.getInstallationOctokit();
    const checkRunResponse = await installationOctokit.request(
      "GET /repos/{owner}/{repo}/check-runs/{check_run_id}",
      {
        owner,
        repo: repository,
        check_run_id: input.checkRunId,
      },
    );
    const checkRun = checkRunSchema.parse(checkRunResponse.data);
    if (checkRun.app.id !== input.expectedAppId) {
      throw new Error(
        `Check Run ${input.checkRunId} belongs to GitHub App ${checkRun.app.id}, expected ${input.expectedAppId}`,
      );
    }
    if (checkRun.pull_requests.length !== 1) {
      throw new Error(
        `Check Run ${input.checkRunId} must reference exactly one pull request; found ${checkRun.pull_requests.length}`,
      );
    }

    const pullRequestNumber = checkRun.pull_requests[0]!.number;
    const pullRequestResponse = await installationOctokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo: repository,
        pull_number: pullRequestNumber,
      },
    );
    const pullRequest = pullRequestHeadSchema.parse(pullRequestResponse.data);
    if (pullRequest.head.sha !== checkRun.head_sha) {
      throw new Error(
        `Check Run ${input.checkRunId} head ${checkRun.head_sha} does not match pull request ${pullRequestNumber} head ${pullRequest.head.sha}`,
      );
    }
    const referencedHeadSha = checkRun.pull_requests[0]!.head?.sha;
    if (referencedHeadSha && referencedHeadSha !== checkRun.head_sha) {
      throw new Error(
        `Check Run ${input.checkRunId} pull request reference has a mismatched head SHA`,
      );
    }

    return {
      checkRunId: checkRun.id,
      headSha: checkRun.head_sha,
      pullRequestNumber: pullRequest.number,
    };
  }

  public async ensurePullRequestCheckRun(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
    headSha: string;
    expectedAppId: number;
  }): Promise<GitHubProvisionedCheckRun> {
    const { owner, repository } = splitRepositoryFullName(
      input.repositoryFullName,
    );
    const installationOctokit = await this.getInstallationOctokit();
    const externalId = buildPullRequestCheckRunExternalId(
      input.pullRequestNumber,
    );
    try {
      const existingResponse = await installationOctokit.request(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        {
          owner,
          repo: repository,
          ref: input.headSha,
          check_name: "ReviewPhin",
          app_id: input.expectedAppId,
          filter: "all",
          per_page: 100,
        },
      );
      const existing = checkRunsForRefSchema
        .parse(existingResponse.data)
        .check_runs.find(
          (checkRun) =>
            checkRun.app.id === input.expectedAppId &&
            checkRun.head_sha === input.headSha &&
            checkRun.external_id === externalId,
        );
      if (existing) {
        return {
          checkRunId: existing.id,
          created: false,
        };
      }

      const createdResponse = await installationOctokit.request(
        "POST /repos/{owner}/{repo}/check-runs",
        {
          owner,
          repo: repository,
          name: "ReviewPhin",
          head_sha: input.headSha,
          external_id: externalId,
          status: "completed",
          conclusion: "neutral",
          completed_at: new Date().toISOString(),
          output: {
            title: "Review ready",
            summary: "Use Run Review to request a ReviewPhin code review.",
          },
          actions: [createRunReviewAction()],
        },
      );
      const created = provisionedCheckRunSchema.parse(createdResponse.data);
      if (
        created.app.id !== input.expectedAppId ||
        created.head_sha !== input.headSha
      ) {
        throw new Error("GitHub returned a mismatched provisioned Check Run");
      }
      return {
        checkRunId: created.id,
        created: true,
      };
    } catch (error) {
      throw translateGitHubApiError(
        `ReviewPhin Check Run for GitHub pull request ${input.repositoryFullName}#${input.pullRequestNumber}`,
        error,
      );
    }
  }

  public async updateCheckRun(input: {
    repositoryFullName: string;
    checkRunId: number;
    state: GitHubCheckRunState;
  }): Promise<void> {
    const { owner, repository } = splitRepositoryFullName(
      input.repositoryFullName,
    );
    await (
      await this.getInstallationOctokit()
    ).request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      owner,
      repo: repository,
      check_run_id: input.checkRunId,
      status: input.state.status,
      output: {
        title: getCheckRunTitle(input.state),
        summary: input.state.summary,
      },
      ...(input.state.status === "in_progress"
        ? { started_at: new Date().toISOString() }
        : {}),
      ...(input.state.status === "completed"
        ? {
            conclusion: input.state.conclusion,
            completed_at: new Date().toISOString(),
            actions: [createRunReviewAction()],
          }
        : {}),
    });
  }

  private getConfiguredInstallationId(): number {
    if (!("installationId" in this.options.config)) {
      throw new Error(
        "GitHub App installation authentication requires a ready connection",
      );
    }
    return this.options.config.installationId;
  }

  private async getInstallationOctokit(): Promise<GitHubApi> {
    return this.app.getInstallationOctokit(this.getConfiguredInstallationId());
  }

  private async getInstallationToken(): Promise<string> {
    if (!this.app.octokit.auth) {
      throw new Error("GitHub App installation authentication is unavailable");
    }
    const authentication = await this.app.octokit.auth({
      type: "installation",
      installationId: this.getConfiguredInstallationId(),
    });
    if (
      typeof authentication !== "object" ||
      authentication === null ||
      !("token" in authentication) ||
      typeof authentication.token !== "string" ||
      authentication.token.length === 0
    ) {
      throw new Error(
        "GitHub App installation authentication returned no token",
      );
    }
    return authentication.token;
  }

  private async requestParsed<T>(
    route: string,
    parameters: Record<string, unknown>,
    schema: z.ZodType<T>,
    resource: string,
  ): Promise<T> {
    try {
      const response = await (
        await this.getInstallationOctokit()
      ).request(route, parameters);
      return schema.parse(response.data);
    } catch (error) {
      throw translateGitHubApiError(resource, error);
    }
  }

  private async paginate<T>(
    repositoryFullName: string,
    route: string,
    parameters: Record<string, unknown>,
    itemSchema: z.ZodType<T>,
    resource: string,
  ): Promise<T[]> {
    const { owner, repository } = splitRepositoryFullName(repositoryFullName);
    const installationOctokit = await this.getInstallationOctokit();
    const result: T[] = [];
    let page = 1;

    try {
      while (true) {
        const response = await installationOctokit.request(route, {
          owner,
          repo: repository,
          ...parameters,
          per_page: 100,
          page,
        });
        const items = z.array(itemSchema).parse(response.data);
        result.push(...items);
        if (items.length < 100) {
          return result;
        }
        page += 1;
      }
    } catch (error) {
      throw translateGitHubApiError(resource, error);
    }
  }

  private createAuthenticatedApp(): GitHubAppApi {
    const appConfig = {
      appId: this.options.config.appId,
      privateKey: this.options.config.privateKey,
      clientId: this.options.config.clientId,
      clientSecret: this.options.config.clientSecret,
      webhookSecret: this.options.config.webhookSecret,
      apiUrl: this.options.config.apiUrl,
    };
    if (this.options.createApp) {
      return this.options.createApp(appConfig);
    }
    const GitHubOctokit = Octokit.defaults({
      baseUrl: appConfig.apiUrl,
    });
    return new App({
      appId: appConfig.appId,
      privateKey: appConfig.privateKey,
      oauth: {
        clientId: appConfig.clientId,
        clientSecret: appConfig.clientSecret,
      },
      webhooks: {
        secret: appConfig.webhookSecret,
      },
      Octokit: GitHubOctokit,
    });
  }
}

function toGitHubRepository(
  parsed: z.infer<typeof repositorySchema>,
): GitHubRepository {
  return {
    id: parsed.id,
    name: parsed.name,
    fullName: parsed.full_name,
    private: parsed.private,
    htmlUrl: parsed.html_url,
    ownerLogin: parsed.owner.login,
    ownerId: parsed.owner.id,
    ...(parsed.owner.type ? { ownerType: parsed.owner.type } : {}),
  };
}

function translateGitHubApiError(
  resource: string,
  error: unknown,
): GitHubApiError {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : null;
  return new GitHubApiError(
    `${resource} request failed${status === null ? "" : ` with status ${status}`}`,
    status,
    { cause: error },
  );
}

function splitRepositoryFullName(value: string): {
  owner: string;
  repository: string;
} {
  const [owner, repository, extra] = value.split("/");
  if (!owner || !repository || extra) {
    throw new Error(`Invalid GitHub repository full name: ${value}`);
  }
  return { owner, repository };
}

function parseGitHubImageUrl(
  value: string,
  options: { allowUserAssetStorage?: boolean | undefined } = {},
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new GitHubImageDownloadError({
      message: "GitHub image URL is invalid",
      url: value,
      cause: error,
    });
  }
  if (!isAllowedGitHubImageUrl(url, options)) {
    throw new GitHubImageDownloadError({
      message: `GitHub image URL is not an allowed attachment location: ${redactGitHubImageUrl(url.toString())}`,
      url: url.toString(),
    });
  }
  return url;
}

function isAllowedGitHubImageUrl(
  url: URL,
  options: { allowUserAssetStorage?: boolean | undefined },
): boolean {
  if (url.protocol !== "https:" || url.username || url.password) {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "github.com") {
    return url.pathname.startsWith("/user-attachments/assets/");
  }
  if (
    options.allowUserAssetStorage &&
    hostname === GITHUB_USER_ASSET_STORAGE_HOST
  ) {
    return true;
  }
  return (
    hostname === "user-images.githubusercontent.com" ||
    hostname === "private-user-images.githubusercontent.com"
  );
}

export function redactGitHubImageUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "(invalid GitHub image URL)";
  }
}

function getCheckRunTitle(state: GitHubCheckRunState): string {
  switch (state.status) {
    case "queued":
      return "Review queued";
    case "in_progress":
      return "Review in progress";
    case "completed":
      return state.conclusion === "success"
        ? "Review completed"
        : "Review failed";
  }
}

function buildPullRequestCheckRunExternalId(pullRequestNumber: number): string {
  return `reviewphin:pull-request:${pullRequestNumber}`;
}

function createRunReviewAction() {
  return {
    label: "Run Review",
    description: "Request a ReviewPhin code review",
    identifier: "run_review",
  };
}
