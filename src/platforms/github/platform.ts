import { randomBytes } from "node:crypto";

import { Octokit } from "octokit";
import type { Logger } from "pino";
import { z } from "zod";

import type { HarnessRunLoggingContext } from "../../harness/types.js";
import type {
  IPlatform,
  LocalReviewSelector,
  PlatformInteractionJobInput,
  PlatformSetupHandler,
  PlatformWebhookRequest,
  ResolvedTenant,
} from "../IPlatform.js";
import type {
  InteractionJobRecord,
  PlatformConnectionRecord,
  PlatformConnectionStatus,
  TenantRecord,
} from "../../storage/contract/current.js";
import type { StorageHelpers } from "../../storage/storage-helpers.js";
import type { WebhookReviewTrigger } from "../../review/types.js";
import type { TriggerCommentReference } from "../../review/types.js";
import {
  isLocalReviewTrigger,
  serializeLocalReviewTrigger,
} from "../../review/local-trigger.js";
import { listAll } from "../../storage/storage-helpers.js";
import {
  githubConnectionRegistrationSchema,
  githubConnectionConfigWithSetupTokenSchema,
  pendingGitHubConnectionConfigSchema,
  readyGitHubConnectionConfigSchema,
  registeredGitHubConnectionConfigSchema,
  type ReadyGitHubConnectionConfig,
  type RegisteredGitHubConnectionConfig,
} from "./config.js";
import {
  GitHubClient,
  type GitHubAppApi,
  type GitHubAppFactoryConfig,
  type GitHubIssueComment,
  type GitHubPullRequest,
  type GitHubReviewComment,
  type GitHubReviewThread,
} from "./client.js";
import {
  renderGitHubSetupErrorPage,
  renderGitHubInstallationPage,
  renderGitHubSetupPage,
  renderGitHubSetupSuccessPage,
} from "./setup-page.js";
import {
  githubTenantConfigSchema,
  getGitHubTenantConfig,
  githubTenantRegistrationSchema,
  splitGitHubRepositoryFullName,
} from "./tenant-config.js";
import { createTenantKey } from "../../utils/ids.js";
import { sha256 } from "../../utils/hash.js";
import { NoOpPlatformTriggerLifecycle } from "../trigger-lifecycle.js";
import {
  getGitHubSignatureHeader,
  isGitHubWebhookPayload,
  parseGitHubWebhook,
  type GitHubWebhookPayload,
} from "./webhook.js";
import {
  GitHubCheckRunTriggerLifecycle,
  GitHubCommentTriggerLifecycle,
  githubCheckRunTriggerSchema,
} from "./trigger-lifecycle.js";
import { GitHubRepositoryContextResolver } from "./repository-context.js";
import { createGitHubProjectMemoryBackend } from "./project-memory-backend.js";
import { GitHubPlatformReviewRuntime } from "./review-runtime.js";
import type { InteractionRunArtifacts } from "../../review/run-artifacts.js";
import {
  classifyGitHubCommentCommand,
  createGitHubCommentTriggerJson,
  extractGitHubReviewCommand,
  githubCommentTriggerSchema,
} from "./comment-trigger.js";
import {
  parseGitHubCommentUrl,
  type GitHubCommentUrl,
} from "./url.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

const manifestConversionSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  name: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  webhook_secret: z.string().min(1),
  pem: z.string().min(1),
  html_url: z.string().url().optional(),
  permissions: z.record(z.string(), z.string()),
  events: z.array(z.string()),
  owner: z
    .union([
      z.object({
        login: z.string().min(1),
        id: z.number().int().positive(),
        type: z.string().min(1),
        avatar_url: z.string().url().optional(),
        html_url: z.string().url().optional(),
      }),
      z.object({
        slug: z.string().min(1),
        id: z.number().int().positive(),
        avatar_url: z.string().url().optional(),
        html_url: z.string().url().optional(),
      }),
    ])
    .transform((owner) =>
      "login" in owner
        ? owner
        : {
            login: owner.slug,
            id: owner.id,
            type: "Enterprise",
            avatar_url: owner.avatar_url,
            html_url: owner.html_url,
          },
    ),
});
export default class GitHubPlatform implements IPlatform {
  public constructor(
    private readonly options: {
      logger: Logger;
      publicUrl: string;
      octokit?: Octokit | undefined;
      createApp?:
        ((config: GitHubAppFactoryConfig) => GitHubAppApi) | undefined;
      now?: (() => Date) | undefined;
    },
  ) {}

  public getPlatformInfo() {
    return {
      name: "GitHub",
      description: "GitHub App integration",
      slug: "github",
    };
  }

  public getConnectionRegistrationSchema() {
    return githubConnectionRegistrationSchema;
  }

  public getTenantRegistrationSchema() {
    return githubTenantRegistrationSchema;
  }

  public async onBeforeAddTenant(
    tenantConfig: Record<string, unknown>,
    connection: PlatformConnectionRecord,
  ): Promise<void> {
    if (connection.status !== "ready") {
      throw new Error(`Platform connection ${connection.name} is not ready`);
    }
    const config = readyGitHubConnectionConfigSchema.parse(
      JSON.parse(connection.platformConnectionConfigJson) as unknown,
    );
    const registration = githubTenantRegistrationSchema.parse(tenantConfig);
    const repositoryReference = splitGitHubRepositoryFullName(
      registration.repository,
    );
    const client = this.createClient(config);
    const repository = await client.resolveRepository(
      repositoryReference.owner,
      repositoryReference.repository,
    );
    for (const key of Object.keys(tenantConfig)) {
      delete tenantConfig[key];
    }
    Object.assign(tenantConfig, {
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
    });
    const pullRequests = await client.listOpenPullRequests(repository.fullName);
    for (const pullRequest of pullRequests) {
      await client.ensurePullRequestCheckRun({
        repositoryFullName: repository.fullName,
        pullRequestNumber: pullRequest.number,
        headSha: pullRequest.head.sha,
        expectedAppId: config.appId,
      });
    }
  }

  public onBeforeAddConnection(
    connectionConfig: Record<string, unknown>,
  ): PlatformConnectionStatus {
    const parsed = githubConnectionRegistrationSchema.parse(connectionConfig);
    Object.assign(connectionConfig, parsed, {
      setupToken: randomBytes(24).toString("hex"),
      setupTokenExpiresAt: new Date(
        this.now().getTime() + ONE_HOUR_MS,
      ).toISOString(),
    });
    return "setup_required";
  }

  public onBeforeUpdateConnection(
    _connection: PlatformConnectionRecord,
    _connectionConfig: Record<string, unknown>,
  ): never {
    throw new Error(
      "GitHub connection updates are not supported. Use platform connection add --recreate to register a replacement GitHub App.",
    );
  }

  public onBeforeRecreateConnection(
    connection: PlatformConnectionRecord,
    connectionConfig: Record<string, unknown>,
  ) {
    const existingConfig = this.tryGetGitHubCleanupConfig(connection);
    const status = this.onBeforeAddConnection(connectionConfig);
    if (!existingConfig) {
      return {
        status,
        notices: [
          "The existing GitHub setup is being replaced. Any GitHub App already created by the previous setup must be removed manually.",
        ],
      };
    }

    connectionConfig.previousAppCleanup = {
      appName: existingConfig.appName,
      appSlug: existingConfig.appSlug,
      ownerLogin: existingConfig.ownerLogin,
      ...("installationId" in existingConfig
        ? { installationId: existingConfig.installationId }
        : {}),
    };
    return {
      status,
      notices: this.getGitHubCleanupNotices(existingConfig),
    };
  }

  public onBeforeRemoveConnection(
    connection: PlatformConnectionRecord,
  ): readonly string[] {
    const config = this.tryGetGitHubCleanupConfig(connection);
    if (!config) {
      return [
        "Remove any GitHub App created for this connection from GitHub manually; local removal cannot revoke remote App credentials.",
      ];
    }
    return this.getGitHubCleanupNotices(config);
  }

  public getConnectionSetupUrl(
    connectionConfig: Record<string, unknown>,
  ): string {
    const config = pendingGitHubConnectionConfigSchema.parse(connectionConfig);
    return `${this.options.publicUrl}/setup/github/${config.setupToken}`;
  }

  public getSetupHandler(): PlatformSetupHandler {
    return async ({ request, reply, context }) => {
      reply.type("text/html; charset=utf-8");
      if (!context.storage) {
        return reply
          .code(500)
          .send(
            renderGitHubSetupErrorPage(
              "Storage is not available.",
              this.options.publicUrl,
            ),
          );
      }

      const [setupToken, action, extra] = context.pathSuffix.split("/");
      if (
        !setupToken ||
        extra ||
        (action && action !== "return" && action !== "installed")
      ) {
        return reply
          .code(404)
          .send(
            renderGitHubSetupErrorPage(
              "Setup link not found.",
              this.options.publicUrl,
            ),
          );
      }

      const connections = await listAll(
        context.storage.stores.platformConnections,
        {
          filters: { platform: { eq: "github" } },
        },
      );
      const connection = connections.find((candidate) => {
        try {
          return (
            githubConnectionConfigWithSetupTokenSchema.parse(
              JSON.parse(candidate.platformConnectionConfigJson) as unknown,
            ).setupToken === setupToken
          );
        } catch {
          return false;
        }
      });
      if (!connection) {
        return reply
          .code(404)
          .send(
            renderGitHubSetupErrorPage(
              "Setup link is invalid or used.",
              this.options.publicUrl,
            ),
          );
      }

      const config = githubConnectionConfigWithSetupTokenSchema.parse(
        JSON.parse(connection.platformConnectionConfigJson) as unknown,
      );
      if (
        new Date(config.setupTokenExpiresAt).getTime() <= this.now().getTime()
      ) {
        return reply
          .code(410)
          .send(
            renderGitHubSetupErrorPage(
              "Setup link has expired.",
              this.options.publicUrl,
            ),
          );
      }

      if (action !== "return") {
        if (action === "installed") {
          if (!("setupPhase" in config)) {
            return reply
              .code(409)
              .send(
                renderGitHubSetupErrorPage(
                  "Register the GitHub App before installing it.",
                  this.options.publicUrl,
                ),
              );
          }
          return this.completeInstallation({
            request,
            reply,
            connection,
            config,
            storage: context.storage,
          });
        }
        if ("setupPhase" in config) {
          return reply.code(200).send(
            renderGitHubInstallationPage({
              appName: config.appName,
              owner: config.owner,
              installUrl: this.getInstallationUrl(config.appSlug),
              publicUrl: this.options.publicUrl,
            }),
          );
        }
        return reply.code(200).send(
          renderGitHubSetupPage({
            owner: config.owner,
            setupToken,
            publicUrl: this.options.publicUrl,
          }),
        );
      }

      const query = z
        .object({
          code: z.string().min(1),
          state: z.string().min(1),
        })
        .safeParse(request.query);
      if (!query.success || query.data.state !== setupToken) {
        return reply
          .code(400)
          .send(
            renderGitHubSetupErrorPage(
              "Invalid callback state or code.",
              this.options.publicUrl,
            ),
          );
      }

      try {
        const octokit =
          this.options.octokit ??
          new Octokit({
            baseUrl: config.apiUrl,
          });
        const response = await octokit.request(
          "POST /app-manifests/{code}/conversions",
          {
            code: query.data.code,
          },
        );
        const data = manifestConversionSchema.parse(response.data);
        if (data.owner.login.toLowerCase() !== config.owner.toLowerCase()) {
          return reply.code(400).send(
            renderGitHubSetupPage({
              owner: config.owner,
              setupToken,
              publicUrl: this.options.publicUrl,
              error: `GitHub returned owner "${data.owner.login}", expected "${config.owner}".`,
            }),
          );
        }

        const registeredConfig = registeredGitHubConnectionConfigSchema.parse({
          owner: config.owner,
          apiUrl: config.apiUrl,
          setupToken: config.setupToken,
          setupTokenExpiresAt: config.setupTokenExpiresAt,
          setupPhase: "app_registered",
          appId: data.id,
          appSlug: data.slug,
          appName: data.name,
          clientId: data.client_id,
          clientSecret: data.client_secret,
          webhookSecret: data.webhook_secret,
          privateKey: data.pem,
          ownerLogin: data.owner.login,
          ownerId: data.owner.id,
          ownerType: data.owner.type,
          ...(data.owner.avatar_url
            ? { ownerAvatarUrl: data.owner.avatar_url }
            : {}),
          ...(data.owner.html_url ? { ownerHtmlUrl: data.owner.html_url } : {}),
          ...(data.html_url ? { appHtmlUrl: data.html_url } : {}),
          permissions: data.permissions,
          events: data.events,
          ...(config.previousAppCleanup
            ? { previousAppCleanup: config.previousAppCleanup }
            : {}),
        });
        await context.storage.updatePlatformConnection({
          reference: connection.id,
          status: "setup_required",
          platformConnectionConfigJson: JSON.stringify(registeredConfig),
        });
        return reply.redirect(
          this.getInstallationUrl(registeredConfig.appSlug),
        );
      } catch (error) {
        this.options.logger.warn(
          { err: error, connectionId: connection.id },
          "GitHub App manifest conversion failed",
        );
        return reply
          .code(502)
          .send(
            renderGitHubSetupErrorPage(
              "GitHub rejected the manifest code.",
              this.options.publicUrl,
            ),
          );
      }
    };
  }

  public getTenantKey(
    tenantConfig: Record<string, unknown>,
    connection: PlatformConnectionRecord,
  ): string {
    const parsedTenant = githubTenantConfigSchema.parse(tenantConfig);
    const parsedConnection = readyGitHubConnectionConfigSchema.parse(
      JSON.parse(connection.platformConnectionConfigJson) as unknown,
    );
    return createTenantKey(parsedConnection.apiUrl, parsedTenant.repositoryId);
  }

  public parseWebhookPayload(
    payload: unknown,
    req?: PlatformWebhookRequest,
  ): GitHubWebhookPayload {
    return parseGitHubWebhook(payload, req);
  }

  public identifyTenantKey(payload: unknown): string | null {
    if (!isGitHubWebhookPayload(payload)) {
      return null;
    }
    if (payload.repositoryId === null) {
      return null;
    }
    return createTenantKey("https://api.github.com", payload.repositoryId);
  }

  public shouldIgnoreWebhookWithoutTenant(payload: unknown): boolean {
    return isGitHubWebhookPayload(payload) && payload.repositoryId === null;
  }

  public async isWebhookRequestAuthorized(
    resolvedTenant: ResolvedTenant,
    req: PlatformWebhookRequest,
  ): Promise<boolean> {
    if (resolvedTenant.connection.status !== "ready") {
      return false;
    }
    const signature = getGitHubSignatureHeader(req);
    if (!signature) {
      return false;
    }

    try {
      const payload = parseGitHubWebhook(req.body, req);
      const connectionConfig = readyGitHubConnectionConfigSchema.parse(
        JSON.parse(
          resolvedTenant.connection.platformConnectionConfigJson,
        ) as unknown,
      );
      const verified = await this.createClient(
        connectionConfig,
      ).verifyWebhookSignature(req.rawBody.toString("utf8"), signature);
      if (!verified) {
        return false;
      }
      const tenantConfig = getGitHubTenantConfig(resolvedTenant.tenant);
      return (
        payload.installationId !== null &&
        payload.installationId === connectionConfig.installationId &&
        payload.repositoryId !== null &&
        payload.repositoryId === tenantConfig.repositoryId
      );
    } catch (error) {
      this.options.logger.warn(
        { err: error, connectionId: resolvedTenant.connection.id },
        "GitHub webhook authorization failed",
      );
      return false;
    }
  }

  public async classifyWebhookTrigger(
    resolvedTenant: ResolvedTenant,
    payload: unknown,
  ): Promise<WebhookReviewTrigger | null> {
    if (!isGitHubWebhookPayload(payload)) {
      return null;
    }
    if (payload.repositoryId === null) {
      return null;
    }
    const config = readyGitHubConnectionConfigSchema.parse(
      JSON.parse(
        resolvedTenant.connection.platformConnectionConfigJson,
      ) as unknown,
    );
    if (
      payload.eventName === "check_run" &&
      payload.action === "requested_action" &&
      payload.requestedActionIdentifier === "run_review" &&
      payload.checkRunId !== null &&
      payload.checkRunHeadSha !== null &&
      payload.checkRunAppId === config.appId
    ) {
      return {
        kind: "check-run-requested-action",
        checkRunId: payload.checkRunId,
        actionIdentifier: payload.requestedActionIdentifier,
      };
    }

    const commentCommand = classifyGitHubCommentCommand({
      payload,
      appSlug: config.appSlug,
    });
    if (
      payload.eventName === "pull_request_review_comment" &&
      payload.action === "created" &&
      payload.pullRequestNumber !== null &&
      payload.commentId !== null &&
      payload.commentBody !== null &&
      payload.commentInReplyToId !== null &&
      !this.isGitHubBotCommentAuthor(payload, config.appSlug)
    ) {
      const tenantConfig = getGitHubTenantConfig(resolvedTenant.tenant);
      const rootComment = (
        await this.createClient(config).listReviewComments(
          tenantConfig.repositoryFullName,
          payload.pullRequestNumber,
        )
      ).find((comment) => comment.id === payload.commentInReplyToId);
      const rootCommentAuthorLogin = rootComment?.user?.login ?? null;
      if (
        rootComment &&
        rootCommentAuthorLogin?.toLowerCase() ===
          `${config.appSlug}[bot]`.toLowerCase() &&
        /<!--\s*reviewphin-finding:/.test(rootComment.body)
      ) {
        return {
          kind: "follow-up-comment",
          comment: {
            kind: "discussion-comment",
            discussionId: `review-comment:${payload.commentInReplyToId}`,
            commentId: payload.commentId,
          },
        };
      }
    }
    if (!commentCommand || payload.commentId === null) {
      return null;
    }
    return {
      kind: commentCommand.kind,
      comment:
        payload.eventName === "pull_request_review_comment"
          ? {
              kind: "discussion-comment",
              discussionId: `review-comment:${payload.commentInReplyToId ?? payload.commentId}`,
              commentId: payload.commentId,
            }
          : {
              kind: "code-review-comment",
              commentId: payload.commentId,
            },
    };
  }

  public async handleWebhookEvent(
    resolvedTenant: ResolvedTenant,
    payload: unknown,
  ): Promise<boolean> {
    if (
      !isGitHubWebhookPayload(payload) ||
      payload.repositoryId === null ||
      payload.eventName !== "pull_request" ||
      !["opened", "reopened", "synchronize"].includes(payload.action ?? "") ||
      payload.pullRequestNumber === null ||
      payload.pullRequestHeadSha === null
    ) {
      return false;
    }

    const connectionConfig = readyGitHubConnectionConfigSchema.parse(
      JSON.parse(
        resolvedTenant.connection.platformConnectionConfigJson,
      ) as unknown,
    );
    const tenantConfig = getGitHubTenantConfig(resolvedTenant.tenant);
    await this.createClient(connectionConfig).ensurePullRequestCheckRun({
      repositoryFullName: tenantConfig.repositoryFullName,
      pullRequestNumber: payload.pullRequestNumber,
      headSha: payload.pullRequestHeadSha,
      expectedAppId: connectionConfig.appId,
    });
    return true;
  }

  public async createInteractionJob(input: {
    resolvedTenant: ResolvedTenant;
    payload: unknown;
    trigger: WebhookReviewTrigger;
    storage: StorageHelpers;
  }): Promise<PlatformInteractionJobInput> {
    if (!isGitHubWebhookPayload(input.payload)) {
      throw new Error("GitHub interaction jobs require a GitHub webhook");
    }
    if (input.payload.repositoryId === null) {
      throw new Error("GitHub interaction jobs require repository context");
    }
    const config = readyGitHubConnectionConfigSchema.parse(
      JSON.parse(
        input.resolvedTenant.connection.platformConnectionConfigJson,
      ) as unknown,
    );
    const client = this.createClient(config);
    const { tenantConfig } = await new GitHubRepositoryContextResolver({
      storage: input.storage,
      client,
      logger: this.options.logger,
    }).resolve(input.resolvedTenant.tenant);
    if (input.trigger.kind !== "check-run-requested-action") {
      if (
        input.payload.pullRequestNumber === null ||
        input.payload.commentId === null ||
        input.payload.commentBody === null
      ) {
        throw new Error(
          "GitHub comment interaction jobs require pull request comment context",
        );
      }
      const pullRequest = await client.getPullRequest(
        tenantConfig.repositoryFullName,
        input.payload.pullRequestNumber,
      );
      const instruction =
        input.trigger.kind === "direct-mention"
          ? extractGitHubReviewCommand(
              input.payload.commentBody,
              config.appSlug,
            )
          : input.payload.commentBody.trim();
      return {
        dedupeKey: sha256(
          [
            "github-comment",
            String(input.payload.repositoryId),
            String(input.payload.pullRequestNumber),
            String(input.payload.commentId),
            input.trigger.kind,
          ].join("::"),
        ),
        codeReviewId: input.payload.pullRequestNumber,
        commentId: input.payload.commentId,
        triggerJson: createGitHubCommentTriggerJson({
          payload: input.payload,
          triggerKind: input.trigger.kind,
          comment: input.trigger.comment,
          instruction,
        }),
        headSha: pullRequest.head.sha,
        payloadJson: JSON.stringify(input.payload),
      };
    }
    const pullRequest = await client.resolveCheckRunPullRequest({
      repositoryFullName: tenantConfig.repositoryFullName,
      checkRunId: input.trigger.checkRunId,
      expectedAppId: config.appId,
    });
    if (
      input.payload.checkRunHeadSha !== null &&
      input.payload.checkRunHeadSha !== pullRequest.headSha
    ) {
      throw new Error(
        `GitHub Check Run webhook head ${input.payload.checkRunHeadSha} does not match the current Check Run head ${pullRequest.headSha}`,
      );
    }

    const triggerJson = JSON.stringify({
      kind: "github-check-run",
      deliveryId: input.payload.deliveryId,
      checkRunId: pullRequest.checkRunId,
      actionIdentifier: "run_review",
      repositoryId: input.payload.repositoryId,
    });
    return {
      dedupeKey: sha256(
        [
          "github-check-run",
          input.payload.deliveryId,
          pullRequest.checkRunId,
          input.trigger.actionIdentifier,
        ].join("::"),
      ),
      codeReviewId: pullRequest.pullRequestNumber,
      commentId: null,
      triggerJson,
      headSha: pullRequest.headSha,
      payloadJson: JSON.stringify(input.payload),
    };
  }

  public async createLocalInteractionJob(input: {
    resolvedTenant: ResolvedTenant;
    storage: StorageHelpers;
    selector: LocalReviewSelector;
    forceNew: boolean;
    requestId: string;
    createdAt: string;
  }): Promise<PlatformInteractionJobInput> {
    const connectionConfig = readyGitHubConnectionConfigSchema.parse(
      JSON.parse(
        input.resolvedTenant.connection.platformConnectionConfigJson,
      ) as unknown,
    );
    const tenantConfig = getGitHubTenantConfig(input.resolvedTenant.tenant);
    const client = this.createClient(connectionConfig);
    let urlSelection: GitHubCommentUrl | null = null;
    let codeReviewId: number;
    if (input.selector.kind === "comment-url") {
      urlSelection = parseGitHubCommentUrl(input.selector.url);
      codeReviewId = urlSelection.codeReviewId;
    } else {
      codeReviewId = input.selector.codeReviewId;
    }
    if (
      input.selector.kind === "comment-url" &&
      input.selector.codeReviewId !== undefined &&
      input.selector.codeReviewId !== codeReviewId
    ) {
      throw new Error(
        `--code-review-id ${input.selector.codeReviewId} does not match GitHub comment URL pull request ${codeReviewId}.`,
      );
    }

    const pullRequest = await client.getPullRequest(
      tenantConfig.repositoryFullName,
      codeReviewId,
    );
    validateGitHubLocalSelection({
      tenantRepository: tenantConfig.repositoryFullName,
      pullRequest,
      codeReviewId,
      urlSelection,
    });

    if (input.selector.kind === "text") {
      const triggerJson = serializeLocalReviewTrigger({
        kind: "reviewphin-local-review",
        source: "cli",
        requestId: input.requestId,
        codeReviewId,
        instruction: input.selector.text,
        createdAt: input.createdAt,
      });
      return {
        dedupeKey: sha256(
          [
            "reviewphin-local-review",
            input.resolvedTenant.tenant.id,
            codeReviewId,
            input.requestId,
          ].join("::"),
        ),
        codeReviewId,
        commentId: null,
        triggerJson,
        headSha: pullRequest.head.sha,
        payloadJson: triggerJson,
      };
    }

    let commentId: number;
    if (input.selector.kind === "comment-id") {
      commentId = input.selector.commentId;
    } else {
      if (!urlSelection) {
        throw new Error("GitHub comment URL selection was not resolved.");
      }
      commentId = urlSelection.commentId;
    }
    const [issueComments, reviewComments, reviewThreads] = await Promise.all([
      client.listIssueComments(tenantConfig.repositoryFullName, codeReviewId),
      client.listReviewComments(tenantConfig.repositoryFullName, codeReviewId),
      client.listReviewThreads(tenantConfig.repositoryFullName, codeReviewId),
    ]);
    const located = locateGitHubLocalComment({
      commentId,
      issueComments,
      reviewComments,
      reviewThreads,
      expectedKind: urlSelection?.kind,
    });
    if (!located) {
      throw new Error(
        `GitHub comment ${commentId} was not found on pull request ${codeReviewId}.`,
      );
    }
    if (urlSelection && located.comment.html_url !== urlSelection.url) {
      throw new Error(
        "GitHub comment URL does not match the selected comment in the resolved tenant repository.",
      );
    }
    const payload = buildLocalGitHubCommentPayload({
      requestId: input.requestId,
      connectionInstallationId: connectionConfig.installationId,
      repositoryId: tenantConfig.repositoryId,
      repositoryFullName: tenantConfig.repositoryFullName,
      pullRequest,
      located,
    });
    const trigger = await this.classifyWebhookTrigger(
      input.resolvedTenant,
      payload,
    );
    if (!trigger || trigger.kind === "check-run-requested-action") {
      throw new Error(
        `GitHub comment ${commentId} is not a recognized ReviewPhin review trigger.`,
      );
    }
    const nativeTrigger: WebhookReviewTrigger = {
      ...trigger,
      comment: located.reference,
    };
    const interactionJob = await this.createInteractionJob({
      resolvedTenant: input.resolvedTenant,
      payload,
      trigger: nativeTrigger,
      storage: input.storage,
    });
    return input.forceNew
      ? {
          ...interactionJob,
          dedupeKey: sha256(
            `${interactionJob.dedupeKey}::${input.requestId}`,
          ),
        }
      : interactionJob;
  }

  public createTriggerLifecycle(input: {
    resolvedTenant: ResolvedTenant;
    job: InteractionJobRecord;
  }) {
    const parsedTrigger: unknown = JSON.parse(input.job.triggerJson);
    if (isLocalReviewTrigger(parsedTrigger)) {
      return new NoOpPlatformTriggerLifecycle();
    }
    if (githubCommentTriggerSchema.safeParse(parsedTrigger).success) {
      const config = readyGitHubConnectionConfigSchema.parse(
        JSON.parse(
          input.resolvedTenant.connection.platformConnectionConfigJson,
        ) as unknown,
      );
      return new GitHubCommentTriggerLifecycle(
        this.createClient(config),
        getGitHubTenantConfig(input.resolvedTenant.tenant),
        input.job,
        `${config.appSlug}[bot]`.toLowerCase(),
      );
    }
    githubCheckRunTriggerSchema.parse(parsedTrigger);
    const config = readyGitHubConnectionConfigSchema.parse(
      JSON.parse(
        input.resolvedTenant.connection.platformConnectionConfigJson,
      ) as unknown,
    );
    return new GitHubCheckRunTriggerLifecycle(
      this.createClient(config),
      getGitHubTenantConfig(input.resolvedTenant.tenant),
      input.job,
    );
  }

  public createReviewRuntime(input: {
    storage: StorageHelpers;
    logger: Logger;
    resolvedTenant?: ResolvedTenant;
    tenant?: TenantRecord;
    connection?: PlatformConnectionRecord;
    interactionJobId: string;
    workspaceAttemptId?: string | undefined;
    workspaceRoot: string;
    memoryEnabled: boolean;
    interactionRunId?: string | undefined;
    runArtifacts?: InteractionRunArtifacts | undefined;
  }) {
    const resolvedTenant =
      input.resolvedTenant ??
      (input.tenant && input.connection
        ? { tenant: input.tenant, connection: input.connection }
        : null);
    if (!resolvedTenant) {
      throw new Error(
        "GitHub review runtime requires a resolved tenant and connection",
      );
    }
    const config = readyGitHubConnectionConfigSchema.parse(
      JSON.parse(
        resolvedTenant.connection.platformConnectionConfigJson,
      ) as unknown,
    );
    const client = this.createClient(config);
    return new GitHubPlatformReviewRuntime({
      storage: input.storage,
      logger: input.logger,
      resolvedTenant,
      workspaceRoot: input.workspaceRoot,
      client,
      projectMemoryBackend: createGitHubProjectMemoryBackend({
        stores: input.storage.stores,
        tenantId: resolvedTenant.tenant.id,
        enabled: input.memoryEnabled,
      }),
    });
  }

  public createProjectMemoryBackend(input: {
    resolvedTenant: ResolvedTenant;
    storage: StorageHelpers;
    logger: Logger;
    enabled: boolean;
    logging?: HarnessRunLoggingContext | undefined;
  }) {
    return createGitHubProjectMemoryBackend({
      stores: input.storage.stores,
      tenantId: input.resolvedTenant.tenant.id,
      enabled: input.enabled,
    });
  }

  public buildHarnessTenantContext(input: {
    resolvedTenant: ResolvedTenant;
    storage: StorageHelpers;
    logger: Logger;
    memoryEnabled: boolean;
    logging?: HarnessRunLoggingContext | undefined;
  }) {
    return {
      id: input.resolvedTenant.tenant.id,
      memoryEnabled: input.memoryEnabled,
      projectMemoryBackend: this.createProjectMemoryBackend({
        resolvedTenant: input.resolvedTenant,
        storage: input.storage,
        logger: input.logger,
        enabled: input.memoryEnabled,
        logging: input.logging,
      }),
    };
  }

  public getReviewSummaryInstructions(): string[] {
    return [
      "- Apply suggested changes directly from eligible inline review comments, or reply when a finding needs clarification.",
      "- Use the Run Review action on the ReviewPhin Check Run after pushing changes, or comment `/reviewphin review`, to request another review.",
    ];
  }

  private isGitHubBotCommentAuthor(
    payload: GitHubWebhookPayload,
    appSlug: string,
  ): boolean {
    const authorLogin = payload.commentAuthorLogin?.toLowerCase() ?? null;
    return (
      authorLogin === `${appSlug}[bot]`.toLowerCase() ||
      authorLogin?.endsWith("[bot]") === true ||
      payload.commentAuthorType?.toLowerCase() === "bot"
    );
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async completeInstallation(input: {
    request: Parameters<PlatformSetupHandler>[0]["request"];
    reply: Parameters<PlatformSetupHandler>[0]["reply"];
    connection: PlatformConnectionRecord;
    config: z.infer<typeof registeredGitHubConnectionConfigSchema>;
    storage: NonNullable<
      Parameters<PlatformSetupHandler>[0]["context"]["storage"]
    >;
  }) {
    const query = z
      .object({
        installation_id: z.coerce.number().int().positive(),
        setup_action: z.enum(["install", "update"]).optional(),
      })
      .safeParse(input.request.query);
    if (!query.success) {
      return input.reply
        .code(400)
        .send(
          renderGitHubSetupErrorPage(
            "GitHub did not provide a valid installation ID.",
            this.options.publicUrl,
          ),
        );
    }

    try {
      const client = this.createClient(input.config);
      const installation = await client.getInstallation(
        query.data.installation_id,
      );
      if (
        installation.account.login.toLowerCase() !==
        input.config.owner.toLowerCase()
      ) {
        return input.reply
          .code(400)
          .send(
            renderGitHubSetupErrorPage(
              `GitHub installed the app on "${installation.account.login}", expected "${input.config.owner}".`,
              this.options.publicUrl,
            ),
          );
      }

      const accessibleRepositoryCount =
        await client.getAccessibleRepositoryCount(installation.id);
      const {
        setupToken: _setupToken,
        setupTokenExpiresAt: _setupTokenExpiresAt,
        setupPhase: _setupPhase,
        ...registeredConfig
      } = input.config;
      const readyConfig = {
        ...registeredConfig,
        installationId: installation.id,
        installationAccountLogin: installation.account.login,
        installationAccountId: installation.account.id,
        installationAccountType: installation.account.type,
        repositorySelection: installation.repository_selection,
        accessibleRepositoryCount,
        ...(installation.created_at
          ? { installationCreatedAt: installation.created_at }
          : {}),
        ...(installation.updated_at
          ? { installationUpdatedAt: installation.updated_at }
          : {}),
        ...(installation.suspended_at !== undefined
          ? { installationSuspendedAt: installation.suspended_at }
          : {}),
      };
      await input.storage.updatePlatformConnection({
        reference: input.connection.id,
        status: "ready",
        platformConnectionConfigJson: JSON.stringify(readyConfig),
      });
      return input.reply.code(200).send(
        renderGitHubSetupSuccessPage({
          appName: readyConfig.appName,
          appSlug: readyConfig.appSlug,
          appHtmlUrl: readyConfig.appHtmlUrl,
          ownerLogin: readyConfig.ownerLogin,
          ownerType: readyConfig.ownerType,
          ownerAvatarUrl: readyConfig.ownerAvatarUrl,
          installationId: readyConfig.installationId,
          accessibleRepositoryCount: readyConfig.accessibleRepositoryCount,
          repositorySelection: readyConfig.repositorySelection,
          iconUrl: `${this.options.publicUrl}/favicon.png`,
          publicUrl: this.options.publicUrl,
        }),
      );
    } catch (error) {
      this.options.logger.warn(
        { err: error, connectionId: input.connection.id },
        "GitHub App installation validation failed",
      );
      return input.reply
        .code(502)
        .send(
          renderGitHubSetupErrorPage(
            "GitHub App installation could not be validated.",
            this.options.publicUrl,
          ),
        );
    }
  }

  private createClient(
    config: RegisteredGitHubConnectionConfig | ReadyGitHubConnectionConfig,
  ): GitHubClient {
    return new GitHubClient({
      config,
      ...(this.options.createApp ? { createApp: this.options.createApp } : {}),
    });
  }

  private getInstallationUrl(appSlug: string): string {
    return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;
  }

  private getGitHubCleanupNotices(
    config: RegisteredGitHubConnectionConfig | ReadyGitHubConnectionConfig,
  ): readonly string[] {
    return [
      "installationId" in config
        ? `GitHub App "${config.appName}" (${config.appSlug}) remains installed on ${config.ownerLogin}; uninstall installation ${config.installationId} in GitHub.`
        : `GitHub App "${config.appName}" (${config.appSlug}) was registered for ${config.ownerLogin} but has no validated installation.`,
      `Delete the old GitHub App "${config.appName}" from ${config.ownerLogin}'s Developer settings after uninstalling it. Local credentials cannot remove the remote App automatically.`,
    ];
  }

  private tryGetGitHubCleanupConfig(
    connection: PlatformConnectionRecord,
  ): RegisteredGitHubConnectionConfig | ReadyGitHubConnectionConfig | null {
    try {
      const rawConfig = JSON.parse(
        connection.platformConnectionConfigJson,
      ) as unknown;
      const readyConfig =
        readyGitHubConnectionConfigSchema.safeParse(rawConfig);
      if (readyConfig.success) {
        return readyConfig.data;
      }
      const registeredConfig =
        registeredGitHubConnectionConfigSchema.safeParse(rawConfig);
      return registeredConfig.success ? registeredConfig.data : null;
    } catch {
      return null;
    }
  }
}

type LocatedGitHubComment =
    | {
        eventName: "issue_comment";
        comment: GitHubIssueComment;
        reference: TriggerCommentReference;
      }
    | {
        eventName: "pull_request_review_comment";
        comment: GitHubReviewComment;
        reference: TriggerCommentReference;
      };

function validateGitHubLocalSelection(input: {
    tenantRepository: string;
    pullRequest: GitHubPullRequest;
    codeReviewId: number;
    urlSelection: GitHubCommentUrl | null;
  }): void {
    if (input.pullRequest.number !== input.codeReviewId) {
      throw new Error(
        `GitHub pull request ${input.codeReviewId} does not match the resolved tenant repository.`,
      );
    }
    if (!input.urlSelection) {
      return;
    }
    const selectedRepository =
      `${input.urlSelection.owner}/${input.urlSelection.repository}`.toLowerCase();
    if (selectedRepository !== input.tenantRepository.toLowerCase()) {
      throw new Error(
        "GitHub comment URL repository does not match the resolved tenant.",
      );
    }
    const selectedUrl = new URL(input.urlSelection.url);
    selectedUrl.hash = "";
    const pullRequestUrl = new URL(input.pullRequest.html_url);
    if (
      selectedUrl.origin !== pullRequestUrl.origin ||
      selectedUrl.pathname.toLowerCase() !==
        pullRequestUrl.pathname.toLowerCase()
    ) {
      throw new Error(
        "GitHub comment URL host, repository, or pull request does not match the resolved tenant.",
      );
    }
  }

function locateGitHubLocalComment(input: {
    commentId: number;
    issueComments: GitHubIssueComment[];
    reviewComments: GitHubReviewComment[];
    reviewThreads: GitHubReviewThread[];
    expectedKind?: GitHubCommentUrl["kind"] | undefined;
  }): LocatedGitHubComment | null {
    const issueComment = input.issueComments.find(
      (comment) => comment.id === input.commentId,
    );
    if (issueComment && input.expectedKind !== "review-comment") {
      return {
        eventName: "issue_comment",
        comment: issueComment,
        reference: {
          kind: "code-review-comment",
          commentId: input.commentId,
        },
      };
    }
    const reviewComment = input.reviewComments.find(
      (comment) => comment.id === input.commentId,
    );
    if (!reviewComment || input.expectedKind === "issue-comment") {
      return null;
    }
    const thread = input.reviewThreads.find((entry) =>
      entry.comments.nodes.some(
        (comment) => comment.databaseId === input.commentId,
      ),
    );
    return {
      eventName: "pull_request_review_comment",
      comment: reviewComment,
      reference: {
        kind: "discussion-comment",
        discussionId:
          thread?.id ??
          `review-comment:${reviewComment.in_reply_to_id ?? reviewComment.id}`,
        commentId: input.commentId,
      },
    };
  }

function buildLocalGitHubCommentPayload(input: {
    requestId: string;
    connectionInstallationId: number;
    repositoryId: number;
    repositoryFullName: string;
    pullRequest: GitHubPullRequest;
    located: LocatedGitHubComment;
  }): GitHubWebhookPayload {
    const user = input.located.comment.user;
    const body = {
      action: "created",
      installation: { id: input.connectionInstallationId },
      repository: {
        id: input.repositoryId,
        full_name: input.repositoryFullName,
      },
      ...(input.located.eventName === "issue_comment"
        ? {
            issue: {
              number: input.pullRequest.number,
              pull_request: {},
            },
          }
        : {
            pull_request: {
              number: input.pullRequest.number,
              head: { sha: input.pullRequest.head.sha },
            },
          }),
      comment: {
        id: input.located.comment.id,
        body: input.located.comment.body ?? "",
        ...(input.located.eventName === "pull_request_review_comment" &&
        input.located.comment.in_reply_to_id
          ? { in_reply_to_id: input.located.comment.in_reply_to_id }
          : {}),
        user: user
          ? {
              id: user.id,
              login: user.login,
              ...(user.type ? { type: user.type } : {}),
            }
          : null,
      },
    };
    return {
      body,
      deliveryId: input.requestId,
      eventName: input.located.eventName,
      action: "created",
      installationId: input.connectionInstallationId,
      repositoryId: input.repositoryId,
      requestedActionIdentifier: null,
      checkRunId: null,
      checkRunHeadSha: null,
      checkRunAppId: null,
      pullRequestNumber: input.pullRequest.number,
      pullRequestHeadSha: input.pullRequest.head.sha,
      issueIsPullRequest: input.located.eventName === "issue_comment",
      commentId: input.located.comment.id,
      commentBody: input.located.comment.body ?? "",
      commentAuthorLogin: user?.login ?? null,
      commentAuthorType: user?.type ?? null,
      commentInReplyToId:
        input.located.eventName === "pull_request_review_comment"
          ? (input.located.comment.in_reply_to_id ?? null)
          : null,
    };
}
