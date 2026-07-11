import { loadConfig } from "./config.js";
import { HarnessSessionRuntime } from "./harness/session.js";
import { StorageBackedJobRunner } from "./jobs/storage-backed-job-runner.js";
import { ReviewWorker } from "./jobs/review-worker.js";
import { createLogger } from "./logger.js";
import { initializePlatformRegistry } from "./platforms/platform-registry.js";
import { DiscussionReconciler } from "./reconcile/discussion-reconciler.js";
import { HarnessChatterRunnerFactory } from "./review/harness-chatter.js";
import { HarnessReviewProviderFactory } from "./review/harness-review-provider.js";
import { initializeStorageRuntime } from "./storage/runtime.js";
import { TenantRegistry } from "./tenants/tenant-registry.js";
import { createApp } from "./app.js";
import { loadLocalEnvFile } from "./env.js";

async function main(): Promise<void> {
  loadLocalEnvFile();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  await initializePlatformRegistry({
    platformModules: config.platformModules,
    env: process.env,
    logger: logger.child({ component: "platform-registry" }),
  });

  const storageRuntime = await initializeStorageRuntime({
    providerModule: config.storageProviderModule,
    logger: logger.child({ component: "storage-runtime" }),
  });
  const { provider: storageProvider, storage } = storageRuntime;

  const tenantRegistry = new TenantRegistry({
    storage,
  });

  const harnessRuntime = new HarnessSessionRuntime({
    logger,
    runLogDir: config.runLogDir,
    timeoutMs: config.copilotTimeoutMs,
    maxPromptMemoryChars: config.maxPromptMemoryChars,
    sdkLogLevel: config.copilotSdkLogLevel,
    cliPath: config.copilotCliPath,
  });

  const reviewProviderFactory = new HarnessReviewProviderFactory({
    logger,
    harnessRuntime,
    maxPromptMemoryChars: config.maxPromptMemoryChars,
  });
  const chatterRunnerFactory = new HarnessChatterRunnerFactory({
    harnessRuntime,
  });

  const reconciler = new DiscussionReconciler({
    storage,
    logger,
  });

  const reviewWorker = new ReviewWorker({
    storage,
    tenantRegistry,
    reviewProviderFactory,
    chatterRunnerFactory,
    reconciler,
    logger,
    runLogDir: config.runLogDir,
    workspaceRoot: config.workspaceRoot,
    memoryEnabled: config.memoryEnabled,
    maxJobRetries: config.maxJobRetries,
    retryBackoffMs: config.retryBackoffMs,
  });

  const runner = new StorageBackedJobRunner({
    storage,
    worker: reviewWorker,
    logger: logger.child({ component: "job-runner" }),
    pollIntervalMs: config.jobPollIntervalMs,
    maxQueuedJobAgeMs: config.maxQueuedJobAgeMs,
    leaseMs: config.jobLeaseMs,
    maxJobRetries: config.maxJobRetries,
  });

  if (storage.stores.interactionJobs.claimMode === "single-worker") {
    logger.warn(
      "Storage adapter reports single-worker claim mode: exactly one ReviewPhin " +
        "process may run the job runner. Additional HTTP replicas must set " +
        "REVIEWPHIN_JOB_RUNNER_ENABLED=false to disable job execution.",
    );
  }

  const app = await createApp({
    logger,
    tenantRegistry,
    reviewWorker,
    storage,
    publicUrl: config.publicUrl,
    enableGitHubSetupSamples: isPnpmDevServer(),
    allowBotIndexing: config.allowBotIndexing,
    botIndexingAllowedHosts: config.botIndexingAllowedHosts,
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      // A second signal terminates the process immediately, leaving the
      // unfinished lease for another runner to recover rather than closing
      // storage beneath live worker code.
      logger.warn("received second shutdown signal; terminating immediately");
      process.exit(1);
    }
    shuttingDown = true;
    try {
      // Phase 1: stop accepting and drain in-flight HTTP requests.
      await app.close();
      // Phase 2: stop the runner and drain the active attempt.
      await runner.stop();
      // Phase 3: close the storage provider once no worker code is running.
      await storageProvider.close();
    } catch (error) {
      logger.error({ err: error }, "error during graceful shutdown");
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  await app.listen({
    host: config.host,
    port: config.port,
  });

  if (config.jobRunnerEnabled) {
    runner.start();
    logger.info(
      { workerId: runner.workerId },
      "Storage-backed job runner started.",
    );
  } else {
    logger.info(
      "Job runner disabled via REVIEWPHIN_JOB_RUNNER_ENABLED=false; this process serves HTTP only.",
    );
  }

  logger.info("Interaction worker listening.");

  if (config.allowBotIndexing) {
    logger.info(
      "Bot indexing is enabled for /docs only via REVIEWPHIN_ALLOW_BOT_INDEXING=true.",
    );
  } else if (config.botIndexingAllowedHosts.length > 0) {
    logger.info(
      {
        hosts: config.botIndexingAllowedHosts,
      },
      "Bot indexing is blocked by default and allowed only for /docs on configured hosts.",
    );
  } else {
    logger.info("Bot indexing is blocked by default for all routes, including /docs.");
  }

  if (isPnpmDevServer()) {
    logger.info(
      { url: `http://localhost:${config.port}/github/setup/samples` },
      `GitHub setup samples available at http://localhost:${config.port}/github/setup/samples`,
    );
  } else if (config.publicUrl) {
    logger.info(`Website is available under ${config.publicUrl}`);

    logger.info(`Docs are available at ${config.publicUrl}/docs`);

    logger.info(`Webhook base is ${config.publicUrl}/webhooks/{platformSlug}`);
  } else {
    logger.info(
      `Website is available under http://${config.host}:${config.port}`,
    );

    logger.info(
      `Docs are available at http://${config.host}:${config.port}/docs`,
    );

    logger.info(
      `Webhook base is http://${config.host}:${config.port}/webhooks/{platformSlug}`,
    );
  }
}

function isPnpmDevServer(): boolean {
  return process.env.npm_lifecycle_event === "dev";
}

try {
  await main();
} catch (error) {
  const logger = createLogger(process.env.LOG_LEVEL ?? "info");
  logger.error({ err: error }, "fatal startup error");
  process.exitCode = 1;
}
