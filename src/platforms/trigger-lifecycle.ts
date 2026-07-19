import type { Logger } from "pino";

import type { InteractionJobRecord } from "../storage/contract/index.js";
import type {
  PlatformTriggerLifecycle,
  PlatformTriggerOutcome,
} from "./IPlatform.js";

export class NoOpPlatformTriggerLifecycle implements PlatformTriggerLifecycle {
  public async queued(): Promise<void> {}

  public async inProgress(): Promise<void> {}

  public async completed(_outcome?: PlatformTriggerOutcome): Promise<void> {}

  public async retry(_error: string): Promise<void> {}

  public async failed(_error: string): Promise<void> {}
}

export async function syncPlatformTriggerLifecycle(input: {
  logger: Logger;
  job: InteractionJobRecord;
  phase: string;
  update: () => Promise<void>;
}): Promise<void> {
  try {
    await input.update();
  } catch (error) {
    input.logger.warn(
      {
        err: error,
        interactionJobId: input.job.id,
        triggerLifecyclePhase: input.phase,
      },
      "failed to synchronize provider trigger lifecycle",
    );
  }
}

export async function syncPlatformTriggerLifecycleForJob(input: {
  logger: Logger;
  job: InteractionJobRecord;
  lifecycle: PlatformTriggerLifecycle;
}): Promise<void> {
  const error =
    input.job.lastError ?? "ReviewPhin could not complete the requested work.";
  switch (input.job.status) {
    case "queued":
      await syncPlatformTriggerLifecycle({
        logger: input.logger,
        job: input.job,
        phase: "queued",
        update: () => input.lifecycle.queued(),
      });
      return;
    case "in_progress":
      await syncPlatformTriggerLifecycle({
        logger: input.logger,
        job: input.job,
        phase: "in_progress",
        update: () => input.lifecycle.inProgress(),
      });
      return;
    case "completed":
      await syncPlatformTriggerLifecycle({
        logger: input.logger,
        job: input.job,
        phase: "completed",
        update: () => input.lifecycle.completed(),
      });
      return;
    case "failed":
    case "cancelled":
    case "expired":
      await syncPlatformTriggerLifecycle({
        logger: input.logger,
        job: input.job,
        phase: input.job.status,
        update: () => input.lifecycle.failed(error),
      });
  }
}
