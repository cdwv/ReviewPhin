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
