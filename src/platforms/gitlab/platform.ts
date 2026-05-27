import z from "zod";
import type { Logger } from "pino";
import type { HarnessRunLoggingContext } from "../../harness/types.js";
import type { TenantRecord } from "../../storage/contract/current.js";
import type { InteractionRunArtifacts } from "../../review/run-artifacts.js";
import type { StorageHelpers } from "../../storage/storage-helpers.js";
import type { IPlatform, PlatformWebhookRequest } from "../IPlatform.js";
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
import { getGitLabTenantConfig } from "./tenant-config.js";
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
  getSetupRoutes() {
    return [];
  }
  getPlatformInfo() {
    return {
      name: "GitLab",
      description: "GitLab platform integration",
      slug: "gitlab",
    };
  }
  getTenantKey(platformConfig: Record<string, unknown>): string {
    const parsedConfig = this.getRegistrationSchema().parse(platformConfig);
    return createTenantKey(parsedConfig.baseUrl, parsedConfig.projectId);
  }
  parseWebhookPayload(payload: unknown): GitLabNoteHookPayload {
    return parseGitLabNoteHook(payload);
  }
  async onBeforeRegisterTenant(
    _tenantConfig: Record<string, unknown>,
    platformConfig: Record<string, unknown>,
  ): Promise<void> {
    const apiToken = platformConfig.apiToken;
    const baseUrl = platformConfig.baseUrl;
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
    if (!validateTenantBot(platformConfig)) {
      const client = new GitLabClient({
        baseUrl,
        apiToken,
        logger: this.logger,
      });
      const botUser = await client.getCurrentUser();
      platformConfig.botUserId ??= botUser.id;
      platformConfig.botUsername ??= botUser.username;
    }
    if (!validateTenantBot(platformConfig)) {
      throw new Error(
        "Failed to determine bot user details from GitLab API. Please provide --bot-user-id and --bot-username explicitly or make sure token you used is correct.",
      );
    }
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
    tenant: TenantRecord,
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
      getGitLabTenantConfig(tenant).webhookSecret,
      providedSecret,
    );
  }
  async classifyWebhookTrigger(tenant: TenantRecord, payload: unknown) {
    const parsedPayload = parseGitLabNoteHook(payload);
    const client = this.createGitLabClient(tenant);
    return classifyGitLabWebhookTrigger({
      payload: parsedPayload,
      tenant,
      client,
    });
  }
  async createInteractionJob(input: {
    tenant: TenantRecord;
    payload: unknown;
  }): Promise<{
    dedupeKey: string;
    codeReviewId: number;
    noteId: number;
    headSha: string;
    payloadJson: string;
  }> {
    const parsedPayload = parseGitLabNoteHook(input.payload);
    const tenantConfig = getGitLabTenantConfig(input.tenant);
    return {
      dedupeKey: createInteractionJobDedupeKey({
        baseUrl: tenantConfig.baseUrl,
        projectId: tenantConfig.projectId,
        codeReviewId: parsedPayload.merge_request.iid,
        noteId: parsedPayload.object_attributes.id,
        noteAction: parsedPayload.object_attributes.action,
        noteUpdatedAt: parsedPayload.object_attributes.updated_at,
        noteBody: parsedPayload.object_attributes.note,
      }),
      codeReviewId: parsedPayload.merge_request.iid,
      noteId: parsedPayload.object_attributes.id,
      headSha: extractWebhookHeadSha(parsedPayload),
      payloadJson: JSON.stringify(parsedPayload),
    };
  }
  getReviewSummaryInstructions(tenant: TenantRecord): string[] {
    const tenantConfig = getGitLabTenantConfig(tenant);
    return [
      `- If you made changes to the code, you can request a re-review to get new feedback by leaving new comment, e.g. \`@${tenantConfig.botUsername} review\``,
      `- You can ask \`@${tenantConfig.botUsername}\` for help or to clarify anything regarding this codebase`,
    ];
  }
  createReviewRuntime(input: {
    storage: StorageHelpers;
    logger: Logger;
    tenant: TenantRecord;
    interactionJobId: string;
    workspaceRoot: string;
    memoryEnabled: boolean;
    interactionRunId?: string | undefined;
    runArtifacts?: InteractionRunArtifacts | undefined;
  }) {
    return new GitLabReviewRuntime(input);
  }
  buildHarnessTenantContext(input: {
    tenant: TenantRecord;
    logger: Logger;
    memoryEnabled: boolean;
    logging?: HarnessRunLoggingContext | undefined;
  }) {
    return {
      id: input.tenant.id,
      memoryEnabled: input.memoryEnabled,
      projectMemoryBackend: createGitLabProjectMemoryBackendForTenant({
        tenant: input.tenant,
        logger: input.logger,
        logging: input.logging,
        enabled: input.memoryEnabled,
      }),
    };
  }
  getRegistrationSchema() {
    return z.object({
      baseUrl: z
        .string()
        .url()
        .transform((value) => normalizeGitLabBaseUrl(value)),
      projectId: z.coerce.number().int().positive(),
      apiToken: z.string().min(1),
      webhookSecret: z.string().min(1),
      botUserId: z.coerce.number().int().positive().optional(),
      botUsername: z.string().min(1).optional(),
    });
  }

  private createGitLabClient(tenant: TenantRecord): GitLabClient {
    const tenantConfig = getGitLabTenantConfig(tenant);
    return new GitLabClient({
      baseUrl: tenantConfig.baseUrl,
      apiToken: tenantConfig.apiToken,
      logger: this.logger.child({
        tenantId: tenant.id,
      }),
    });
  }

  private tryParseNoteHookPayload(payload: unknown): GitLabNoteHookPayload | null {
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
