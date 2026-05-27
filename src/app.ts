import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { Logger } from "pino";

import type { JobQueue } from "./jobs/job-queue.js";
import type { ReviewWorker } from "./jobs/review-worker.js";
import { getPlatforms } from "./platforms/platform-registry.js";
import type { TenantRegistry } from "./tenants/tenant-registry.js";

interface AppOptions {
  logger: Logger;
  tenantRegistry: TenantRegistry;
  reviewWorker: ReviewWorker;
  queue: JobQueue;
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  });

  app.get("/healthz", async () => ({
    status: "ok",
  }));

  for (const platform of getPlatforms()) {
    const handleWebhook = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      let payload: unknown;
      try {
        payload = platform.parseWebhookPayload(request.body);
      } catch (error) {
        options.logger.warn(
          { err: error, platform: platform.getPlatformInfo().slug },
          "received invalid platform webhook payload",
        );
        return reply.code(400).send({
          error: "invalid-payload",
        });
      }

      const tenant = await options.tenantRegistry.resolveWebhookTenant(
        platform,
        payload,
        {
          headers: request.headers,
          body: request.body,
        },
      );
      if (!tenant) {
        return reply.code(401).send({
          error: "unauthorized",
        });
      }

      const trigger = await options.reviewWorker.classifyWebhookTrigger(
        payload,
        tenant,
      );
      if (!trigger) {
        return reply.code(202).send({
          accepted: false,
          reason: "no-trigger",
        });
      }

      const { job, created } =
        await options.reviewWorker.createInteractionJobFromWebhook(
          payload,
          tenant,
          trigger,
        );
      if (created) {
        options.queue.enqueue(job.id);
      }

      return reply.code(202).send({
        accepted: true,
        jobId: job.id,
        deduplicated: !created,
      });
    };

    app.post(`/webhooks/${platform.getPlatformInfo().slug}`, handleWebhook);
    app.post(
      `/webhooks/${platform.getPlatformInfo().slug}/:legacyPath*`,
      handleWebhook,
    );
  }

  return app;
}
