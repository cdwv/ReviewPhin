import { resolve } from "node:path";
import { z } from "zod";

import { normalizeGitLabBaseUrl } from "./gitlab/url.js";

export const tenantConfigSchema = z.object({
  baseUrl: z.string().url().transform((value) => normalizeGitLabBaseUrl(value)),
  projectId: z.coerce.number().int().positive(),
  apiToken: z.string().min(1),
  webhookSecret: z.string().min(1),
  botUserId: z.coerce.number().int().positive().optional(),
  botUsername: z.string().min(1).optional()
});

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_PATH: z.string().min(1).default("./data/review-worker.sqlite"),
  COPILOT_LOG_DIR: z.string().min(1).default("./data/copilot-session-logs"),
  WORKSPACE_ROOT: z.string().min(1).default("./tmp/review-workspaces"),
  MAX_JOB_RETRIES: z.coerce.number().int().min(0).default(3),
  RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(5_000),
  COPILOT_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  COPILOT_MODEL: z.string().min(1).optional(),
  COPILOT_CLI_PATH: z.string().min(1).optional()
});

export type TenantConfig = z.infer<typeof tenantConfigSchema>;

export interface AppConfig {
  host: string;
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  databasePath: string;
  copilotLogDir: string;
  workspaceRoot: string;
  maxJobRetries: number;
  retryBackoffMs: number;
  copilotTimeoutMs: number;
  copilotModel?: string | undefined;
  copilotCliPath?: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsedEnv = envSchema.parse({
    PORT: env.PORT,
    HOST: env.HOST,
    LOG_LEVEL: env.LOG_LEVEL,
    DATABASE_PATH: env.DATABASE_PATH,
    COPILOT_LOG_DIR: env.COPILOT_LOG_DIR,
    WORKSPACE_ROOT: env.WORKSPACE_ROOT,
    MAX_JOB_RETRIES: env.MAX_JOB_RETRIES,
    RETRY_BACKOFF_MS: env.RETRY_BACKOFF_MS,
    COPILOT_TIMEOUT_MS: env.COPILOT_TIMEOUT_MS,
    COPILOT_MODEL: env.COPILOT_MODEL,
    COPILOT_CLI_PATH: env.COPILOT_CLI_PATH
  });

  return {
    host: parsedEnv.HOST,
    port: parsedEnv.PORT,
    logLevel: parsedEnv.LOG_LEVEL,
    databasePath: resolve(parsedEnv.DATABASE_PATH),
    copilotLogDir: resolve(parsedEnv.COPILOT_LOG_DIR),
    workspaceRoot: resolve(parsedEnv.WORKSPACE_ROOT),
    maxJobRetries: parsedEnv.MAX_JOB_RETRIES,
    retryBackoffMs: parsedEnv.RETRY_BACKOFF_MS,
    copilotTimeoutMs: parsedEnv.COPILOT_TIMEOUT_MS,
    copilotModel: parsedEnv.COPILOT_MODEL,
    copilotCliPath: parsedEnv.COPILOT_CLI_PATH
  };
}
