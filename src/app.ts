import Fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "pino";

import { parseGitLabNoteHook } from "./gitlab/webhook.js";
import type { JobQueue } from "./jobs/job-queue.js";
import type { ReviewWorker } from "./jobs/review-worker.js";
import type { TenantRegistry } from "./tenants/tenant-registry.js";

interface AppOptions {
  logger: Logger;
  tenantRegistry: TenantRegistry;
  reviewWorker: ReviewWorker;
  queue: JobQueue;
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false
  });

  app.get("/healthz", async () => ({
    status: "ok"
  }));

  app.post("/webhooks/gitlab/note", async (request, reply) => {
    let payload;
    try {
      payload = parseGitLabNoteHook(request.body);
    } catch (error) {
      options.logger.warn({ err: error }, "received invalid GitLab note hook payload");
      return reply.code(400).send({
        error: "invalid-payload"
      });
    }

    const secretHeader = request.headers["x-gitlab-token"];
    const webhookSecret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
    const tenant = await options.tenantRegistry.resolveWebhookTenant(payload, webhookSecret);
    if (!tenant) {
      return reply.code(401).send({
        error: "unauthorized"
      });
    }

    const trigger = await options.reviewWorker.classifyWebhookTrigger(payload, tenant);
    if (!trigger) {
      return reply.code(202).send({
        accepted: false,
        reason: "no-trigger"
      });
    }

    const { job, created } = await options.reviewWorker.createInteractionJobFromWebhook(payload, tenant, trigger);
    if (created) {
      options.queue.enqueue(job.id);
    }

    return reply.code(202).send({
      accepted: true,
      jobId: job.id,
      deduplicated: !created
    });
  });

  return app;
}
