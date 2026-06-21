import type { Logger } from "pino";

import type { StorageHelpers } from "../../storage/storage-helpers.js";
import type {
  TenantRecord,
  InteractionJobRecord,
} from "../../storage/contract/index.js";
import type { ProjectMemoryContext } from "../../memory/types.js";
import type { GitLabClient } from "./client.js";
import { createGitLabProjectMemoryBackend } from "./project-memory-backend.js";
import type {
  HydratedMergeRequestContext,
  LightweightMergeRequestContext,
  MaterializedMergeRequestContext,
} from "./types.js";
import type { WorkspaceMaterializer } from "./workspace.js";
import { getGitLabTenantConfig } from "./tenant-config.js";

interface CodeReviewContextHydratorOptions {
  storage: StorageHelpers;
  workspaceMaterializer: WorkspaceMaterializer;
  memoryEnabled: boolean;
  logger: Logger;
}

export class CodeReviewContextHydrator {
  private readonly storage: StorageHelpers;
  private readonly workspaceMaterializer: WorkspaceMaterializer;
  private readonly memoryEnabled: boolean;
  private readonly logger: Logger;

  public constructor(options: CodeReviewContextHydratorOptions) {
    this.storage = options.storage;
    this.workspaceMaterializer = options.workspaceMaterializer;
    this.memoryEnabled = options.memoryEnabled;
    this.logger = options.logger;
  }

  public async hydrate(input: {
    tenant: TenantRecord;
    job: InteractionJobRecord;
    client: GitLabClient;
    context?: MaterializedMergeRequestContext | undefined;
  }): Promise<HydratedMergeRequestContext> {
    const { tenant, job, client } = input;
    const tenantConfig = getGitLabTenantConfig(tenant);
    const [materializedContext, versions] = await Promise.all([
      input.context
        ? Promise.resolve(input.context)
        : this.loadMaterializedContext(input),
      client.listCodeReviewVersions(tenantConfig.projectId, job.codeReviewId),
    ]);

    const latestVersion =
      versions
        .slice()
        .sort(
          (left, right) =>
            new Date(right.created_at).getTime() -
            new Date(left.created_at).getTime(),
        )[0] ?? null;

    const snapshot = await this.storage.createCodeReviewSnapshot({
      interactionJobId: job.id,
      tenantId: tenant.id,
      codeReviewId: job.codeReviewId,
      headSha: job.headSha,
      codeReviewJson: JSON.stringify(materializedContext.mergeRequest),
      versionsJson: JSON.stringify(versions),
      changesJson: JSON.stringify(materializedContext.changes),
      commentsJson: JSON.stringify(materializedContext.notes),
      discussionsJson: JSON.stringify(materializedContext.discussions),
      instructionsJson: "[]",
      projectMemoryJson: JSON.stringify(materializedContext.projectMemory),
      workspaceStrategy: materializedContext.workspace.strategy,
    });

    this.logger.info(
      {
        tenantId: tenant.id,
        interactionJobId: job.id,
        codeReviewId: job.codeReviewId,
        changedFiles: materializedContext.changes.length,
        discussionCount: materializedContext.discussions.length,
        commentCount: materializedContext.notes.length,
        workspaceStrategy: materializedContext.workspace.strategy,
      },
      "hydrated merge request context",
    );

    return {
      ...materializedContext,
      versions,
      latestVersion,
      snapshot,
    };
  }

  public async loadRoutingContext(input: {
    tenant: TenantRecord;
    job: InteractionJobRecord;
    client: GitLabClient;
  }): Promise<LightweightMergeRequestContext> {
    return this.loadMaterializedContext(input);
  }

  private async loadMaterializedContext(input: {
    tenant: TenantRecord;
    job: InteractionJobRecord;
    client: GitLabClient;
  }): Promise<MaterializedMergeRequestContext> {
    const { tenant, job, client } = input;
    const tenantConfig = getGitLabTenantConfig(tenant);
    const [mergeRequest, changes, notes, discussions] = await Promise.all([
      client.getCodeReview(tenantConfig.projectId, job.codeReviewId),
      client.getCodeReviewChanges(tenantConfig.projectId, job.codeReviewId),
      client.listCodeReviewNotes(tenantConfig.projectId, job.codeReviewId),
      client.listCodeReviewDiscussions(
        tenantConfig.projectId,
        job.codeReviewId,
      ),
    ]);
    const [workspace, projectMemory] = await Promise.all([
      this.workspaceMaterializer.materialize({
        client,
        jobId: job.id,
        projectId: tenantConfig.projectId,
        codeReviewId: job.codeReviewId,
        headSha: job.headSha,
        changes,
      }),
      this.loadProjectMemorySafely({
        client,
        tenant,
        job,
      }),
    ]);

    return {
      tenant,
      job,
      mergeRequest,
      changes,
      notes,
      discussions,
      workspace,
      projectMemory,
    };
  }

  private async loadProjectMemorySafely(input: {
    client: GitLabClient;
    tenant: TenantRecord;
    job: InteractionJobRecord;
  }): Promise<ProjectMemoryContext> {
    try {
      return await createGitLabProjectMemoryBackend({
        client: input.client,
        projectId: getGitLabTenantConfig(input.tenant).projectId,
        tenantId: input.tenant.id,
        enabled: this.memoryEnabled,
        stores: this.storage.stores,
        logger: this.logger,
      }).load();
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          tenantId: input.tenant.id,
          interactionJobId: input.job.id,
          projectId: getGitLabTenantConfig(input.tenant).projectId,
        },
        "project memory unavailable; continuing review without memory for this run",
      );
      return {
        enabled: false,
        page: null,
        entries: [],
      };
    }
  }
}

export { CodeReviewContextHydrator as MergeRequestContextHydrator };
