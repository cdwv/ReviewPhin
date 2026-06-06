import z from "zod";
import type { Logger } from "pino";
import type { HarnessRunLoggingContext } from "../../harness/types.js";
import type {
  PlatformConnectionRecord,
  TenantRecord,
} from "../../storage/contract/current.js";
import type { InteractionRunArtifacts } from "../../review/run-artifacts.js";
import type { StorageHelpers } from "../../storage/storage-helpers.js";
import type {
  IPlatform,
  PlatformSetupHandler,
  PlatformWebhookRequest,
  ResolvedTenant,
} from "../IPlatform.js";
import {
  createInteractionJobDedupeKey,
  createTenantKey,
} from "../../utils/ids.js";
import { constantTimeEqual } from "../../utils/hash.js";
import { parseGitLabNoteHook } from "./webhook.js";
import { extractWebhookHeadSha } from "./webhook.js";
import { extractWebhookGitLabBaseUrl } from "./webhook.js";
import type { GitLabNoteHookPayload } from "./types.js";
import { normalizeGitLabBaseUrl } from "./url.js";
import { GitLabClient } from "./client.js";
import {
  getGitLabConnectionConfig,
  getGitLabTenantConfig,
} from "./tenant-config.js";
import { classifyGitLabWebhookTrigger } from "./trigger.js";
import { GitLabReviewRuntime } from "./review-runtime.js";
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
  }): Promise<{
    dedupeKey: string;
    codeReviewId: number;
    commentId: number;
    headSha: string;
    payloadJson: string;
  }> {
    const parsedPayload = parseGitLabNoteHook(input.payload);
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
      headSha: extractWebhookHeadSha(parsedPayload),
      payloadJson: JSON.stringify(parsedPayload),
    };
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
  buildHarnessTenantContext(input: {
    resolvedTenant: ResolvedTenant;
    logger: Logger;
    memoryEnabled: boolean;
    logging?: HarnessRunLoggingContext | undefined;
  }) {
    return {
      id: input.resolvedTenant.tenant.id,
      memoryEnabled: input.memoryEnabled,
      projectMemoryBackend: createGitLabProjectMemoryBackendForTenant({
        resolvedTenant: input.resolvedTenant,
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
