import { loadConfig } from "./config.js";
import { HarnessSessionRuntime } from "./harness/session.js";
import { JobQueue } from "./jobs/job-queue.js";
import { ReviewWorker } from "./jobs/review-worker.js";
import { createLogger } from "./logger.js";
import { initializePlatformRegistry } from "./platforms/platform-registry.js";
import { DiscussionReconciler } from "./reconcile/discussion-reconciler.js";
import { HarnessChatterRunnerFactory } from "./review/harness-chatter.js";
import { HarnessReviewProviderFactory } from "./review/harness-review-provider.js";
import { initializeStorageRuntime } from "./storage/runtime.js";
import { listAll } from "./storage/storage-helpers.js";
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

  const queue = new JobQueue({
    logger,
    processor: {
      processJob: (jobId) => reviewWorker.processJob(jobId),
    },
  });

  const queuedJobs = await listAll(storage.stores.interactionJobs, {
    filters: { status: { eq: "queued" } },
    order: [
      { field: "enqueuedAt", direction: "asc" },
      { field: "id", direction: "asc" },
    ],
  });
  queue.enqueueMany(queuedJobs.map((job) => job.id));

  const app = await createApp({
    logger,
    tenantRegistry,
    reviewWorker,
    queue,
    storage,
    publicUrl: config.publicUrl,
    enableGitHubSetupSamples: isPnpmDevServer(),
    allowBotIndexing: config.allowBotIndexing,
    botIndexingAllowedHosts: config.botIndexingAllowedHosts,
  });

  const close = async (): Promise<void> => {
    await app.close();
    await storageProvider.close();
  };

  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });

  await app.listen({
    host: config.host,
    port: config.port,
  });

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
