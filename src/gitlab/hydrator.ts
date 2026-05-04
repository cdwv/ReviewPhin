import type { Logger } from "pino";

import type { Storage, TenantRecord, InteractionJobRecord } from "../storage/types.js";
import type { ProjectMemoryBackendFactory } from "../memory/backend.js";
import { GitLabProjectMemoryBackendFactory } from "../memory/gitlab-wiki-backend.js";
import type { ProjectMemoryContext } from "../memory/types.js";
import type { GitLabClient } from "./client.js";
import type { HydratedMergeRequestContext } from "./types.js";
import { WorkspaceMaterializer } from "./workspace.js";

interface MergeRequestContextHydratorOptions {
  storage: Storage;
  workspaceMaterializer: WorkspaceMaterializer;
  memoryEnabled: boolean;
  logger: Logger;
  projectMemoryBackendFactory?: ProjectMemoryBackendFactory | undefined;
}

export class MergeRequestContextHydrator {
  private readonly storage: Storage;
  private readonly workspaceMaterializer: WorkspaceMaterializer;
  private readonly memoryEnabled: boolean;
  private readonly logger: Logger;
  private readonly projectMemoryBackendFactory: ProjectMemoryBackendFactory;

  public constructor(options: MergeRequestContextHydratorOptions) {
    this.storage = options.storage;
    this.workspaceMaterializer = options.workspaceMaterializer;
    this.memoryEnabled = options.memoryEnabled;
    this.logger = options.logger;
    this.projectMemoryBackendFactory = options.projectMemoryBackendFactory ?? new GitLabProjectMemoryBackendFactory();
  }

  public async hydrate(input: {
    tenant: TenantRecord;
    job: InteractionJobRecord;
    client: GitLabClient;
  }): Promise<HydratedMergeRequestContext> {
    const { tenant, job, client } = input;
    const [mergeRequest, versions, changes, notes, discussions] = await Promise.all([
      client.getMergeRequest(tenant.projectId, job.mergeRequestIid),
      client.listMergeRequestVersions(tenant.projectId, job.mergeRequestIid),
      client.getMergeRequestChanges(tenant.projectId, job.mergeRequestIid),
      client.listMergeRequestNotes(tenant.projectId, job.mergeRequestIid),
      client.listMergeRequestDiscussions(tenant.projectId, job.mergeRequestIid)
    ]);

    const latestVersion =
      versions
        .slice()
        .sort(
          (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
        )[0] ?? null;

    const [workspace, projectMemory] = await Promise.all([
      this.workspaceMaterializer.materialize({
        client,
        jobId: job.id,
        projectId: tenant.projectId,
        mergeRequestIid: job.mergeRequestIid,
        headSha: job.headSha,
        changes
      }),
      this.loadProjectMemorySafely({
        client,
        tenant,
        job
      })
    ]);

    const snapshot = await this.storage.createMergeRequestSnapshot({
      interactionJobId: job.id,
      tenantId: tenant.id,
      mergeRequestIid: job.mergeRequestIid,
      headSha: job.headSha,
      mergeRequestJson: JSON.stringify(mergeRequest),
      versionsJson: JSON.stringify(versions),
      changesJson: JSON.stringify(changes),
      notesJson: JSON.stringify(notes),
      discussionsJson: JSON.stringify(discussions),
      instructionsJson: JSON.stringify(workspace.instructionFiles),
      projectMemoryJson: JSON.stringify(projectMemory),
      workspaceStrategy: workspace.strategy
    });

    this.logger.info(
      {
        tenantId: tenant.id,
        interactionJobId: job.id,
        mergeRequestIid: job.mergeRequestIid,
        changedFiles: changes.length,
        discussionCount: discussions.length,
        noteCount: notes.length,
        workspaceStrategy: workspace.strategy
      },
      "hydrated merge request context"
    );

    return {
      tenant,
      job,
      mergeRequest,
      versions,
      latestVersion,
      changes,
      notes,
      discussions,
      workspace,
      projectMemory,
      snapshot
    };
  }

  private async loadProjectMemorySafely(input: {
    client: GitLabClient;
    tenant: TenantRecord;
    job: InteractionJobRecord;
  }): Promise<ProjectMemoryContext> {
    try {
      return await this.projectMemoryBackendFactory.createForGitLabClient({
        client: input.client,
        projectId: input.tenant.projectId,
        enabled: this.memoryEnabled
      }).load();
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          tenantId: input.tenant.id,
          interactionJobId: input.job.id,
          projectId: input.tenant.projectId
        },
        "project memory unavailable; continuing review without wiki-backed memory"
      );
      return {
        enabled: false,
        page: null,
        entries: []
      };
    }
  }
}
