import type { Logger } from "pino";

import type { Storage, TenantRecord, ReviewJobRecord } from "../storage/types.js";
import type { GitLabClient } from "./client.js";
import type { HydratedMergeRequestContext } from "./types.js";
import { WorkspaceMaterializer } from "./workspace.js";

interface MergeRequestContextHydratorOptions {
  storage: Storage;
  workspaceMaterializer: WorkspaceMaterializer;
  logger: Logger;
}

export class MergeRequestContextHydrator {
  private readonly storage: Storage;
  private readonly workspaceMaterializer: WorkspaceMaterializer;
  private readonly logger: Logger;

  public constructor(options: MergeRequestContextHydratorOptions) {
    this.storage = options.storage;
    this.workspaceMaterializer = options.workspaceMaterializer;
    this.logger = options.logger;
  }

  public async hydrate(input: {
    tenant: TenantRecord;
    job: ReviewJobRecord;
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

      const workspace = await this.workspaceMaterializer.materialize({
        client,
        jobId: job.id,
        projectId: tenant.projectId,
        mergeRequestIid: job.mergeRequestIid,
        headSha: job.headSha,
        changes
      });

    const snapshot = await this.storage.createMergeRequestSnapshot({
      reviewJobId: job.id,
      tenantId: tenant.id,
      mergeRequestIid: job.mergeRequestIid,
      headSha: job.headSha,
      mergeRequestJson: JSON.stringify(mergeRequest),
      versionsJson: JSON.stringify(versions),
      changesJson: JSON.stringify(changes),
      notesJson: JSON.stringify(notes),
      discussionsJson: JSON.stringify(discussions),
      instructionsJson: JSON.stringify(workspace.instructionFiles),
      workspaceStrategy: workspace.strategy
    });

    this.logger.info(
      {
        tenantId: tenant.id,
        jobId: job.id,
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
      snapshot
    };
  }
}
