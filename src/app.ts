import { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { Logger } from "pino";

import type { JobQueue } from "./jobs/job-queue.js";
import type { ReviewWorker } from "./jobs/review-worker.js";
import type { IPlatform } from "./platforms/IPlatform.js";
import { getPlatforms } from "./platforms/platform-registry.js";
import type { TenantRegistry } from "./tenants/tenant-registry.js";
import type { StorageHelpers } from "./storage/storage-helpers.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

interface AppOptions {
  logger: Logger;
  tenantRegistry: TenantRegistry;
  reviewWorker: ReviewWorker;
  queue: JobQueue;
  platforms?: readonly IPlatform[] | undefined;
  storage?: StorageHelpers | undefined;
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  });

  await app.register(fastifyStatic, {
    root: resolvePublicRoot(),
    prefix: "/",
  });

  app.addHook("preParsing", (request, _reply, payload, done) => {
    const urlPath = request.raw.url?.split("?")[0] ?? "";
    if (!urlPath.startsWith("/webhooks/") && !urlPath.startsWith("/setup/")) {
      return done(null, payload);
    }

    const chunks: Buffer[] = [];
    payload.on("data", (chunk: string | Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    payload.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      request.rawBody = rawBody;
      const replayStream = Readable.from(rawBody) as Readable & {
        receivedEncodedLength: number;
      };
      replayStream.receivedEncodedLength = rawBody.length;
      done(null, replayStream);
    });
    payload.on("error", (error) => {
      done(error);
    });
  });

  app.get("/healthz", async () => ({
    status: "ok",
  }));

  for (const platform of options.platforms ?? getPlatforms()) {
    const setupHandler = platform.getSetupHandler?.();
    if (setupHandler) {
      const handleSetup = async (
        request: FastifyRequest,
        reply: FastifyReply,
      ) =>
        setupHandler({
          request,
          reply,
          context: {
            pathSuffix: getRouteSuffix(request.params, "setupPath"),
            rawBody: getRequestRawBody(request),
            storage: options.storage,
          },
        });

      app.route({
        method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        url: `/setup/${platform.getPlatformInfo().slug}`,
        handler: handleSetup,
      });
      app.route({
        method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        url: `/setup/${platform.getPlatformInfo().slug}/*`,
        handler: handleSetup,
      });
    }

    const handleWebhook = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      const webhookRequest = {
        headers: request.headers,
        body: request.body,
        rawBody: getRequestRawBody(request),
        pathSuffix: getRouteSuffix(request.params, "webhookPath"),
      };
      let payload: unknown;
      try {
        payload = platform.parseWebhookPayload(request.body, webhookRequest);
      } catch (error) {
        options.logger.warn(
          { err: error, platform: platform.getPlatformInfo().slug },
          "received invalid platform webhook payload",
        );
        return reply.code(400).send({
          error: "invalid-payload",
        });
      }

      const resolvedTenant = await options.tenantRegistry.resolveWebhookTenant(
        platform,
        payload,
        webhookRequest,
      );
      if (!resolvedTenant) {
        if (
          (await platform.shouldIgnoreWebhookWithoutTenant?.(
            payload,
            webhookRequest,
          )) === true
        ) {
          return reply.code(202).send({
            accepted: false,
            reason: "no-trigger",
          });
        }
        return reply.code(404).send({
          error: "not-found",
        });
      }

      const eventHandled =
        (await platform.handleWebhookEvent?.(resolvedTenant, payload)) ?? false;
      const trigger = await options.reviewWorker.classifyWebhookTrigger(
        payload,
        resolvedTenant,
      );
      if (!trigger) {
        if (eventHandled) {
          return reply.code(202).send({
            accepted: true,
            reason: "event-handled",
          });
        }
        return reply.code(202).send({
          accepted: false,
          reason: "no-trigger",
        });
      }

      const { job, created } =
        await options.reviewWorker.createInteractionJobFromWebhook(
          payload,
          resolvedTenant,
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
    app.post(`/webhooks/${platform.getPlatformInfo().slug}/*`, handleWebhook);
  }

  return app;
}

function resolvePublicRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "..", "public"),
    resolve(moduleDirectory, "..", "..", "public"),
  ];
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  );
}

function getRequestRawBody(request: FastifyRequest): Buffer {
  if (request.rawBody) {
    return request.rawBody;
  }

  if (request.body === undefined || request.body === null) {
    return Buffer.alloc(0);
  }

  return Buffer.from(JSON.stringify(request.body));
}

function getRouteSuffix(params: unknown, key: string): string {
  if (!params || typeof params !== "object") {
    return "";
  }

  const record = params as Record<string, unknown>;
  const value = record[key] ?? record["*"];
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .join("/");
  }

  return "";
}
