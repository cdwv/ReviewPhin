import type { Logger } from "pino";

import type {
  HarnessModelConfig,
  HarnessRunLoggingContext,
  HarnessTenantContext,
} from "../harness/types.js";
import {
  getProjectMemoryContentLength,
  mergeProjectMemoryEntries,
} from "./project-memory.js";
import type { ProjectMemoryBackend } from "./backend.js";
import type { ProjectMemoryConsolidator } from "./consolidator.js";
import type {
  ProjectMemoryContext,
  ProjectMemoryToolInput,
  ProjectMemoryUpdateResult,
} from "./types.js";

const MEMORY_SAVE_COALESCE_THRESHOLD_RATIO = 0.9;
const MEMORY_COALESCE_TARGET_RATIO = 0.75;
const MEMORY_WRITE_CONFLICT_RETRY_LIMIT = 3;

export class ProjectMemoryService {
  private static readonly tenantWriteQueues = new Map<string, Promise<void>>();
  private readonly logger: Logger;
  private readonly backend: ProjectMemoryBackend;
  private readonly consolidator: ProjectMemoryConsolidator;
  private readonly modelConfig: HarnessModelConfig;
  private readonly tenant: HarnessTenantContext;
  private readonly logging: HarnessRunLoggingContext | undefined;
  private readonly maxPromptMemoryChars: number;

  public constructor(options: {
    logger: Logger;
    backend: ProjectMemoryBackend;
    consolidator: ProjectMemoryConsolidator;
    modelConfig: HarnessModelConfig;
    tenant: HarnessTenantContext;
    logging?: HarnessRunLoggingContext | undefined;
    maxPromptMemoryChars: number;
  }) {
    this.logger = options.logger;
    this.backend = options.backend;
    this.consolidator = options.consolidator;
    this.modelConfig = options.modelConfig;
    this.tenant = options.tenant;
    this.logging = options.logging;
    this.maxPromptMemoryChars = options.maxPromptMemoryChars;
  }

  public async load(): Promise<ProjectMemoryContext> {
    return this.backend.load();
  }

  public async addEntry(
    input: ProjectMemoryToolInput,
  ): Promise<ProjectMemoryUpdateResult> {
    return this.runSerializedWrite(async () => {
      const currentMemory = await this.backend.load();
      if (!currentMemory.enabled) {
        throw new Error("Project memory is disabled");
      }

      const nextEntries = mergeProjectMemoryEntries(
        currentMemory.entries,
        input,
      );
      if (areEntriesEqual(currentMemory.entries, nextEntries)) {
        return {
          changed: false,
          action: "unchanged",
          memory: {
            ...currentMemory,
            entries: nextEntries,
          },
        };
      }

      const action = currentMemory.page === null ? "created" : "updated";
      let memory = await this.saveEntryUpdate(
        currentMemory.entries,
        nextEntries,
        input,
      );

      if (
        !shouldCoalescePersistedMemory(
          memory.entries,
          this.maxPromptMemoryChars,
        )
      ) {
        return {
          changed: true,
          action,
          memory,
        };
      }

      try {
        const baseEntries = memory.entries;
        const consolidatedEntries = await this.consolidator.coalesce({
          modelConfig: this.modelConfig,
          tenant: this.tenant,
          logging: this.logging,
          coalesceInput: {
            entries: baseEntries,
            maxChars: this.maxPromptMemoryChars,
            targetChars: Math.floor(
              this.maxPromptMemoryChars * MEMORY_COALESCE_TARGET_RATIO,
            ),
            reason: "save-threshold",
          },
        });
        memory = await this.backend.saveEntries(consolidatedEntries, {
          baseEntries,
        });
      } catch (error) {
        this.logger.warn(
          {
            err: error,
            interactionRunId: this.logging?.interactionRunId ?? null,
            tenantId: this.logging?.tenantId ?? this.tenant.id,
            reason: "save-threshold",
          },
          "project memory consolidation failed after durable write",
        );
      }

      return {
        changed: true,
        action,
        memory,
      };
    });
  }

  private async runSerializedWrite<T>(operation: () => Promise<T>): Promise<T> {
    const queueKey = createMemoryQueueKey(this.tenant);
    const previous =
      ProjectMemoryService.tenantWriteQueues.get(queueKey) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    ProjectMemoryService.tenantWriteQueues.set(queueKey, queued);
    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (ProjectMemoryService.tenantWriteQueues.get(queueKey) === queued) {
        ProjectMemoryService.tenantWriteQueues.delete(queueKey);
      }
    }
  }

  private async saveEntryUpdate(
    baseEntries: ProjectMemoryContext["entries"],
    nextEntries: ProjectMemoryContext["entries"],
    input: ProjectMemoryToolInput,
  ): Promise<ProjectMemoryContext> {
    let attemptBaseEntries = baseEntries;
    let attemptEntries = nextEntries;

    for (
      let attempt = 0;
      attempt < MEMORY_WRITE_CONFLICT_RETRY_LIMIT;
      attempt += 1
    ) {
      const memory = await this.backend.saveEntries(attemptEntries, {
        baseEntries: attemptBaseEntries,
      });
      const reappliedEntries = mergeProjectMemoryEntries(memory.entries, input);
      if (areEntriesEqual(memory.entries, reappliedEntries)) {
        return memory;
      }

      attemptBaseEntries = memory.entries;
      attemptEntries = reappliedEntries;
    }

    throw new Error(
      "Project memory update conflict could not be resolved after retries",
    );
  }
}

function createMemoryQueueKey(tenant: HarnessTenantContext): string {
  return tenant.id;
}

function shouldCoalescePersistedMemory(
  entries: ProjectMemoryContext["entries"],
  maxPromptMemoryChars: number,
): boolean {
  return (
    getProjectMemoryContentLength(entries) >
    Math.floor(maxPromptMemoryChars * MEMORY_SAVE_COALESCE_THRESHOLD_RATIO)
  );
}

function areEntriesEqual(
  left: ProjectMemoryContext["entries"],
  right: ProjectMemoryContext["entries"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
