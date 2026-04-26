import type { Logger } from "pino";

export interface QueueProcessor {
  processJob(jobId: string): Promise<{ requeueAfterMs?: number } | void>;
}

export class JobQueue {
  private readonly logger: Logger;
  private readonly processor: QueueProcessor;
  private readonly pending = new Set<string>();
  private readonly queue: string[] = [];
  private running = false;

  public constructor(options: { logger: Logger; processor: QueueProcessor }) {
    this.logger = options.logger;
    this.processor = options.processor;
  }

  public enqueue(jobId: string): void {
    if (this.pending.has(jobId)) {
      return;
    }

    this.pending.add(jobId);
    this.queue.push(jobId);
    void this.run();
  }

  public enqueueMany(jobIds: string[]): void {
    for (const jobId of jobIds) {
      this.enqueue(jobId);
    }
  }

  private async run(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      while (this.queue.length > 0) {
        const jobId = this.queue.shift();
        if (!jobId) {
          continue;
        }

        this.pending.delete(jobId);

        try {
          const result = await this.processor.processJob(jobId);
          if (result?.requeueAfterMs !== undefined) {
            setTimeout(() => this.enqueue(jobId), result.requeueAfterMs);
          }
        } catch (error) {
          this.logger.error({ err: error, jobId }, "queued job failed");
        }
      }
    } finally {
      this.running = false;
      if (this.queue.length > 0) {
        void this.run();
      }
    }
  }
}
