import { loadConfig } from "./config.js";
import { MergeRequestContextHydrator } from "./gitlab/hydrator.js";
import { WorkspaceMaterializer } from "./gitlab/workspace.js";
import { HarnessSessionRuntime } from "./harness/session.js";
import { JobQueue } from "./jobs/job-queue.js";
import { ReviewWorker } from "./jobs/review-worker.js";
import { createLogger } from "./logger.js";
import { GitLabProjectMemoryBackendFactory } from "./memory/gitlab-wiki-backend.js";
import { DiscussionReconciler } from "./reconcile/discussion-reconciler.js";
import { HarnessChatterRunnerFactory } from "./review/harness-chatter.js";
import { HarnessReviewProviderFactory } from "./review/harness-review-provider.js";
import { SqliteStorage } from "./storage/sqlite-storage.js";
import { TenantRegistry } from "./tenants/tenant-registry.js";
import { createApp } from "./app.js";
import { loadLocalEnvFile } from "./env.js";

async function main(): Promise<void> {
  loadLocalEnvFile();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const storage = new SqliteStorage({
    databasePath: config.databasePath
  });
  await storage.initialize();

  const tenantRegistry = new TenantRegistry({
    storage
  });
  await tenantRegistry.initialize();

  const workspaceMaterializer = new WorkspaceMaterializer({
    workspaceRoot: config.workspaceRoot,
    logger
  });

  const projectMemoryBackendFactory = new GitLabProjectMemoryBackendFactory();
  const harnessRuntime = new HarnessSessionRuntime({
    logger,
    projectMemoryBackendFactory,
    runLogDir: config.runLogDir,
    timeoutMs: config.copilotTimeoutMs,
    maxPromptMemoryChars: config.maxPromptMemoryChars,
    sdkLogLevel: config.copilotSdkLogLevel,
    cliPath: config.copilotCliPath
  });

  const reviewProviderFactory = new HarnessReviewProviderFactory({
    logger,
    harnessRuntime,
    maxPromptMemoryChars: config.maxPromptMemoryChars
  });
  const chatterRunnerFactory = new HarnessChatterRunnerFactory({
    harnessRuntime
  });

  const reconciler = new DiscussionReconciler({
    storage,
    logger
  });

  const hydrator = new MergeRequestContextHydrator({
    storage,
    workspaceMaterializer,
    memoryEnabled: config.memoryEnabled,
    logger,
    projectMemoryBackendFactory
  });

  const reviewWorker = new ReviewWorker({
    storage,
    tenantRegistry,
    hydrator,
      workspaceMaterializer,
      reviewProviderFactory,
      chatterRunnerFactory,
      reconciler,
    logger,
    runLogDir: config.runLogDir,
    maxJobRetries: config.maxJobRetries,
    retryBackoffMs: config.retryBackoffMs
  });

  const queue = new JobQueue({
    logger,
    processor: {
      processJob: (jobId) => reviewWorker.processJob(jobId)
    }
  });

  const queuedJobs = await storage.listQueuedInteractionJobs();
  queue.enqueueMany(queuedJobs.map((job) => job.id));

  const app = await createApp({
    logger,
    tenantRegistry,
    reviewWorker,
    queue
  });

  const close = async (): Promise<void> => {
    await app.close();
  };

  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });

  await app.listen({
    host: config.host,
    port: config.port
  });

  logger.info("GitLab interaction worker listening.");
  logger.info(
    { host: config.host, port: config.port },
    `Point your GitLab webhooks to http://${config.host}:${config.port}/webhooks/gitlab/note`
  );
}

main().catch((error) => {
  const logger = createLogger(process.env.LOG_LEVEL ?? "info");
  logger.error({ err: error }, "fatal startup error");
  process.exitCode = 1;
});
