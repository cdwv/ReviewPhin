import z from "zod";
import type { Logger } from "pino";
import type { HarnessRunLoggingContext } from "../../harness/types.js";
import type {
  InteractionJobRecord,
  PlatformConnectionRecord,
  TenantRecord,
} from "../../storage/contract/current.js";
import type { WebhookReviewTrigger } from "../../review/types.js";
import {
  isLocalReviewTrigger,
  serializeLocalReviewTrigger,
} from "../../review/local-trigger.js";
import type { InteractionRunArtifacts } from "../../review/run-artifacts.js";
import type { StorageHelpers } from "../../storage/storage-helpers.js";
import type {
  IPlatform,
  LocalReviewSelector,
  PlatformInteractionJobInput,
  PlatformSetupHandler,
  PlatformWebhookRequest,
  ResolvedTenant,
} from "../IPlatform.js";
import {
  createInteractionJobDedupeKey,
  createTenantKey,
} from "../../utils/ids.js";
import { constantTimeEqual, sha256 } from "../../utils/hash.js";
import { parseGitLabNoteHook } from "./webhook.js";
import { extractWebhookHeadSha } from "./webhook.js";
import { extractWebhookGitLabBaseUrl } from "./webhook.js";
import type {
  GitLabDiscussion,
  GitLabMergeRequest,
  GitLabMergeRequestVersion,
  GitLabNote,
  GitLabNoteHookPayload,
  GitLabProject,
} from "./types.js";
import {
  normalizeGitLabBaseUrl,
  parseGitLabNoteUrl,
  type GitLabNoteUrl,
  urlMatchesGitLabBase,
} from "./url.js";
import { GitLabClient } from "./client.js";
import {
  getGitLabConnectionConfig,
  getGitLabTenantConfig,
} from "./tenant-config.js";
import { classifyGitLabWebhookTrigger } from "./trigger.js";
import { GitLabReviewRuntime } from "./review-runtime.js";
import { GitLabTriggerLifecycle } from "./trigger-lifecycle.js";
import { NoOpPlatformTriggerLifecycle } from "../trigger-lifecycle.js";
import { createGitLabProjectMemoryBackendForTenant } from "./project-memory-backend.js";

function validateTenantBot(botInfo: unknown): botInfo is {
  botUserId: number;
  botUsername: string;
} {
  return (
    !!botInfo &&
    typeof botInfo === "object" &&
    "botUserId" in botInfo &&
    "botUsername" in botInfo
  );
}

export default class GitLabPlatform implements IPlatform {
  constructor(private readonly logger: Logger) {
    // Initialize any necessary properties or configurations here
    this.logger.info("GitLabPlatform initialized");
  }
  getSetupHandler(): PlatformSetupHandler | null {
    return null;
  }
  getPlatformInfo() {
    return {
      name: "GitLab",
      description: "GitLab platform integration",
      slug: "gitlab",
    };
  }
  getTenantKey(
    tenantConfig: Record<string, unknown>,
    connection: PlatformConnectionRecord,
  ): string {
    const parsedTenant = this.getTenantRegistrationSchema().parse(tenantConfig);
    const parsedConnection = getGitLabConnectionConfig(connection);
    return createTenantKey(parsedConnection.baseUrl, parsedTenant.projectId);
  }
  parseWebhookPayload(payload: unknown): GitLabNoteHookPayload {
    return parseGitLabNoteHook(payload);
  }
  async onBeforeAddConnection(
    connectionConfig: Record<string, unknown>,
  ): Promise<"ready"> {
    const apiToken = connectionConfig.apiToken;
    const baseUrl = connectionConfig.baseUrl;
    if (
      !apiToken ||
      !baseUrl ||
      typeof apiToken !== "string" ||
      typeof baseUrl !== "string"
    ) {
      throw new Error(
        "baseUrl and apiToken are required to register GitLab tenant",
      );
    }
    if (!validateTenantBot(connectionConfig)) {
      const client = new GitLabClient({
        baseUrl,
        apiToken,
        logger: this.logger,
      });
      const botUser = await client.getCurrentUser();
      connectionConfig.botUserId ??= botUser.id;
      connectionConfig.botUsername ??= botUser.username;
    }
    if (!validateTenantBot(connectionConfig)) {
      throw new Error(
        "Failed to determine bot user details from GitLab API. Please provide --bot-user-id and --bot-username explicitly or make sure token you used is correct.",
      );
    }
    return "ready";
  }
  async onBeforeUpdateConnection(
    _connection: PlatformConnectionRecord,
    connectionConfig: Record<string, unknown>,
  ): Promise<"ready"> {
    return this.onBeforeAddConnection(connectionConfig);
  }
  async onBeforeRecreateConnection(
    _connection: PlatformConnectionRecord,
    connectionConfig: Record<string, unknown>,
  ) {
    const status = await this.onBeforeAddConnection(connectionConfig);
    return {
      status,
      notices: [
        "Existing GitLab project webhooks and access tokens are not changed by recreating this local connection.",
        "Remove obsolete project webhooks manually and revoke any dedicated access token that is no longer used.",
      ],
    };
  }
  onBeforeRemoveConnection(): readonly string[] {
    return [
      "Remove this connection's webhooks from the affected GitLab projects manually.",
      "Revoke the GitLab access token if it was dedicated to this connection and is no longer used.",
    ];
  }
  async identifyTenantKey(payload: unknown): Promise<string | null> {
    const parseResult = this.tryParseNoteHookPayload(payload);
    if (!parseResult) {
      return null;
    }

    const gitlabUrl = extractWebhookGitLabBaseUrl(parseResult);
    if (!gitlabUrl) {
      return null;
    }
    return createTenantKey(gitlabUrl, parseResult.project.id);
  }
  isWebhookRequestAuthorized(
    resolvedTenant: ResolvedTenant,
    req: PlatformWebhookRequest,
  ): boolean {
    const secretHeader = req.headers["x-gitlab-token"];
    const providedSecret = Array.isArray(secretHeader)
      ? secretHeader[0]
      : secretHeader;

    if (!providedSecret) {
      return false;
    }

    return constantTimeEqual(
      getGitLabTenantConfig(resolvedTenant.tenant).webhookSecret,
      providedSecret,
    );
  }
  async classifyWebhookTrigger(
    resolvedTenant: ResolvedTenant,
    payload: unknown,
  ) {
    const parsedPayload = parseGitLabNoteHook(payload);
    const client = this.createGitLabClient(resolvedTenant);
    return classifyGitLabWebhookTrigger({
      payload: parsedPayload,
      tenant: resolvedTenant.tenant,
      connection: resolvedTenant.connection,
      client,
    });
  }
  async createInteractionJob(input: {
    resolvedTenant: ResolvedTenant;
    payload: unknown;
    trigger: WebhookReviewTrigger;
    storage: StorageHelpers;
  }): Promise<PlatformInteractionJobInput> {
    const parsedPayload = parseGitLabNoteHook(input.payload);
    if (!("comment" in input.trigger)) {
      throw new Error("GitLab interaction jobs require a comment trigger");
    }
    const tenantConfig = getGitLabTenantConfig(input.resolvedTenant.tenant);
    const connectionConfig = getGitLabConnectionConfig(
      input.resolvedTenant.connection,
    );
    return {
      dedupeKey: createInteractionJobDedupeKey({
        baseUrl: connectionConfig.baseUrl,
        projectId: tenantConfig.projectId,
        codeReviewId: parsedPayload.merge_request.iid,
        commentId: parsedPayload.object_attributes.id,
        commentAction: parsedPayload.object_attributes.action,
        commentUpdatedAt: parsedPayload.object_attributes.updated_at,
        commentBody: parsedPayload.object_attributes.note,
      }),
      codeReviewId: parsedPayload.merge_request.iid,
      commentId: parsedPayload.object_attributes.id,
      triggerJson: JSON.stringify({
        kind: "gitlab-comment",
        comment: input.trigger.comment,
      }),
      headSha: extractWebhookHeadSha(parsedPayload),
      payloadJson: JSON.stringify(parsedPayload),
    };
  }
  async createLocalInteractionJob(input: {
    resolvedTenant: ResolvedTenant;
    storage: StorageHelpers;
    selector: LocalReviewSelector;
    forceNew: boolean;
    requestId: string;
    createdAt: string;
  }): Promise<PlatformInteractionJobInput> {
    const tenantConfig = getGitLabTenantConfig(input.resolvedTenant.tenant);
    const connectionConfig = getGitLabConnectionConfig(
      input.resolvedTenant.connection,
    );
    const client = this.createGitLabClient(input.resolvedTenant);
    let urlSelection: GitLabNoteUrl | null = null;
    let codeReviewId: number;
    if (input.selector.kind === "comment-url") {
      urlSelection = parseGitLabNoteUrl(input.selector.url);
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
        `--code-review-id ${input.selector.codeReviewId} does not match GitLab comment URL merge request ${codeReviewId}.`,
      );
    }

    const [project, mergeRequest, versions] = await Promise.all([
      client.getProject(tenantConfig.projectId),
      client.getCodeReview(tenantConfig.projectId, codeReviewId),
      client.listCodeReviewVersions(tenantConfig.projectId, codeReviewId),
    ]);
    this.validateLocalMergeRequest({
      project,
      mergeRequest,
      codeReviewId,
      tenantProjectId: tenantConfig.projectId,
      url: urlSelection?.url,
      baseUrl: connectionConfig.baseUrl,
    });
    const headSha = resolveGitLabHeadSha(mergeRequest, versions);

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
        headSha,
        payloadJson: triggerJson,
      };
    }

    let commentId: number;
    if (input.selector.kind === "comment-id") {
      commentId = input.selector.commentId;
    } else {
      if (!urlSelection) {
        throw new Error("GitLab comment URL selection was not resolved.");
      }
      commentId = urlSelection.commentId;
    }
    const [notes, discussions] = await Promise.all([
      client.listCodeReviewNotes(tenantConfig.projectId, codeReviewId),
      client.listCodeReviewDiscussions(tenantConfig.projectId, codeReviewId),
    ]);
    const note = findGitLabNote(notes, discussions, commentId);
    if (!note) {
      throw new Error(
        `GitLab comment ${commentId} was not found on merge request ${codeReviewId}.`,
      );
    }
    const payload = buildLocalGitLabNotePayload({
      project,
      mergeRequest,
      note,
      headSha,
    });
    const trigger = await classifyGitLabWebhookTrigger({
      payload,
      tenant: input.resolvedTenant.tenant,
      connection: input.resolvedTenant.connection,
      client: {
        listCodeReviewDiscussions: async () => discussions,
      },
    });
    if (!trigger) {
      throw new Error(
        `GitLab comment ${commentId} is not a recognized ReviewPhin review trigger.`,
      );
    }
    const interactionJob = await this.createInteractionJob({
      resolvedTenant: input.resolvedTenant,
      payload,
      trigger,
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
  createTriggerLifecycle(input: {
    resolvedTenant: ResolvedTenant;
    job: InteractionJobRecord;
    logger: Logger;
  }) {
    if (
      typeof input.job.triggerJson === "string" &&
      input.job.triggerJson.includes('"reviewphin-local-review"') &&
      isLocalReviewTrigger(JSON.parse(input.job.triggerJson))
    ) {
      return new NoOpPlatformTriggerLifecycle();
    }
    return new GitLabTriggerLifecycle(
      input.resolvedTenant,
      input.job,
      input.logger,
    );
  }

  private validateLocalMergeRequest(input: {
    project: GitLabProject;
    mergeRequest: GitLabMergeRequest;
    codeReviewId: number;
    tenantProjectId: number;
    url?: string | undefined;
    baseUrl: string;
  }): void {
    if (
      input.project.id !== input.tenantProjectId ||
      input.mergeRequest.project_id !== input.tenantProjectId ||
      input.mergeRequest.iid !== input.codeReviewId
    ) {
      throw new Error(
        `GitLab merge request ${input.codeReviewId} does not match the resolved tenant project.`,
      );
    }
    if (!input.url) {
      return;
    }
    if (!urlMatchesGitLabBase(input.url, input.baseUrl)) {
      throw new Error(
        "GitLab comment URL host or instance path does not match the resolved tenant connection.",
      );
    }
    const actual = new URL(input.url);
    actual.hash = "";
    if (
      actual.toString().replace(/\/+$/, "") !==
      input.mergeRequest.web_url.replace(/\/+$/, "")
    ) {
      throw new Error(
        "GitLab comment URL project or merge request does not match the resolved tenant.",
      );
    }
  }
  getReviewSummaryInstructions(resolvedTenant: ResolvedTenant): string[] {
    const connectionConfig = getGitLabConnectionConfig(
      resolvedTenant.connection,
    );
    return [
      `- If you made changes to the code, you can request a re-review to get new feedback by leaving new comment, e.g. \`@${connectionConfig.botUsername} review\``,
      `- You can ask \`@${connectionConfig.botUsername}\` for help or to clarify anything regarding this codebase`,
    ];
  }

  createReviewRuntime(input: {
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
      throw new Error("Resolved tenant is required");
    }
    return new GitLabReviewRuntime({ ...input, resolvedTenant });
  }
  createProjectMemoryBackend(input: {
    resolvedTenant: ResolvedTenant;
    storage: StorageHelpers;
    logger: Logger;
    enabled: boolean;
    logging?: HarnessRunLoggingContext | undefined;
  }) {
    return createGitLabProjectMemoryBackendForTenant({
      ...input,
      stores: input.storage.stores,
    });
  }
  buildHarnessTenantContext(input: {
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
        logging: input.logging,
        enabled: input.memoryEnabled,
      }),
    };
  }
  getTenantRegistrationSchema() {
    return z.object({
      projectId: z.coerce.number().int().positive(),
      webhookSecret: z.string().min(1),
    });
  }
  getConnectionRegistrationSchema() {
    return z.object({
      baseUrl: z
        .string()
        .url()
        .transform((value) => normalizeGitLabBaseUrl(value)),
      apiToken: z.string().min(1),
      botUserId: z.coerce.number().int().positive().optional(),
      botUsername: z.string().min(1).optional(),
    });
  }

  private createGitLabClient(resolvedTenant: ResolvedTenant): GitLabClient {
    const connectionConfig = getGitLabConnectionConfig(
      resolvedTenant.connection,
    );
    return new GitLabClient({
      baseUrl: connectionConfig.baseUrl,
      apiToken: connectionConfig.apiToken,
      logger: this.logger.child({
        tenantId: resolvedTenant.tenant.id,
      }),
    });
  }

  private tryParseNoteHookPayload(
    payload: unknown,
  ): GitLabNoteHookPayload | null {
    try {
      return parseGitLabNoteHook(payload);
    } catch (error) {
      this.logger.warn(
        { err: error },
        "received invalid GitLab note hook payload",
      );
      return null;
    }
  }
}

function resolveGitLabHeadSha(
  mergeRequest: GitLabMergeRequest,
  versions: GitLabMergeRequestVersion[],
): string {
  if (mergeRequest.diff_refs?.head_sha) {
    return mergeRequest.diff_refs.head_sha;
  }
  const newestVersion = [...versions].sort(
    (left, right) =>
      Date.parse(right.created_at) - Date.parse(left.created_at) ||
      right.id - left.id,
  )[0];
  if (newestVersion?.head_commit_sha) {
    return newestVersion.head_commit_sha;
  }
  throw new Error(
    `GitLab merge request ${mergeRequest.iid} did not provide a current head SHA.`,
  );
}

function findGitLabNote(
  notes: GitLabNote[],
  discussions: GitLabDiscussion[],
  commentId: number,
): GitLabNote | null {
  return (
    notes.find((note) => note.id === commentId) ??
    discussions
      .flatMap((discussion) => discussion.notes)
      .find((note) => note.id === commentId) ??
    null
  );
}

function buildLocalGitLabNotePayload(input: {
  project: GitLabProject;
  mergeRequest: GitLabMergeRequest;
  note: GitLabNote;
  headSha: string;
}): GitLabNoteHookPayload {
  const action =
    input.note.updated_at !== input.note.created_at ? "update" : "create";
  return {
    object_kind: "note",
    event_type: "note",
    project: {
      id: input.project.id,
      web_url: input.project.web_url,
      path_with_namespace: input.project.path_with_namespace,
    },
    repository: {
      homepage: input.project.web_url,
    },
    merge_request: {
      iid: input.mergeRequest.iid,
      title: input.mergeRequest.title,
      description: input.mergeRequest.description,
      source_branch: input.mergeRequest.source_branch,
      target_branch: input.mergeRequest.target_branch,
      last_commit: { id: input.headSha },
      ...(input.mergeRequest.diff_refs
        ? { diff_refs: input.mergeRequest.diff_refs }
        : {}),
    },
    object_attributes: {
      id: input.note.id,
      note: input.note.body,
      noteable_type: "MergeRequest",
      action,
      author_id: input.note.author.id,
      system: input.note.system,
      created_at: input.note.created_at,
      updated_at: input.note.updated_at,
      url: `${input.mergeRequest.web_url}#note_${input.note.id}`,
    },
    user: input.note.author,
  };
}
