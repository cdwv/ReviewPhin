import { resolve } from "node:path";
import { z } from "zod";

import { normalizeGitLabBaseUrl } from "./gitlab/url.js";

export const tenantConfigSchema = z.object({
  baseUrl: z.string().url().transform((value) => normalizeGitLabBaseUrl(value)),
  projectId: z.coerce.number().int().positive(),
  apiToken: z.string().min(1),
  webhookSecret: z.string().min(1),
  botUserId: z.coerce.number().int().positive().optional(),
  botUsername: z.string().min(1)
});

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_PATH: z.string().min(1).default("./data/review-worker.sqlite"),
  RUN_LOG_DIR: z.string().min(1).optional(),
  COPILOT_LOG_DIR: z.string().min(1).optional(),
  WORKSPACE_ROOT: z.string().min(1).default("./tmp/review-workspaces"),
  MAX_JOB_RETRIES: z.coerce.number().int().min(0).default(3),
  RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(5_000),
  COPILOT_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  REVIEWPHIN_MEMORY_ENABLED: z.enum(["true", "false"]).default("true"),
  REVIEWPHIN_MAX_PROMPT_MEMORY_CHARS: z.coerce.number().int().positive().default(5_000),
  REVIEWPHIN_TEXT_GENERATION_MODEL: z.string().min(1).default("auto"),
  COPILOT_MODEL: z.string().min(1).optional(),
  COPILOT_CLI_PATH: z.string().min(1).optional()
});

export type TenantConfig = z.infer<typeof tenantConfigSchema>;

export interface AppConfig {
  host: string;
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  databasePath: string;
  runLogDir: string;
  workspaceRoot: string;
  maxJobRetries: number;
  retryBackoffMs: number;
  copilotTimeoutMs: number;
  memoryEnabled: boolean;
  maxPromptMemoryChars: number;
  textGenerationModel: string;
  copilotModel?: string | undefined;
  copilotCliPath?: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsedEnv = envSchema.parse({
    PORT: env.PORT,
    HOST: env.HOST,
    LOG_LEVEL: env.LOG_LEVEL,
    DATABASE_PATH: env.DATABASE_PATH,
    RUN_LOG_DIR: env.RUN_LOG_DIR,
    COPILOT_LOG_DIR: env.COPILOT_LOG_DIR,
    WORKSPACE_ROOT: env.WORKSPACE_ROOT,
    MAX_JOB_RETRIES: env.MAX_JOB_RETRIES,
    RETRY_BACKOFF_MS: env.RETRY_BACKOFF_MS,
    COPILOT_TIMEOUT_MS: env.COPILOT_TIMEOUT_MS,
    REVIEWPHIN_MEMORY_ENABLED: env.REVIEWPHIN_MEMORY_ENABLED?.toLowerCase(),
    REVIEWPHIN_MAX_PROMPT_MEMORY_CHARS: env.REVIEWPHIN_MAX_PROMPT_MEMORY_CHARS,
    REVIEWPHIN_TEXT_GENERATION_MODEL: env.REVIEWPHIN_TEXT_GENERATION_MODEL,
    COPILOT_MODEL: env.COPILOT_MODEL,
    COPILOT_CLI_PATH: env.COPILOT_CLI_PATH
  });

  return {
    host: parsedEnv.HOST,
    port: parsedEnv.PORT,
    logLevel: parsedEnv.LOG_LEVEL,
    databasePath: resolve(parsedEnv.DATABASE_PATH),
    runLogDir: resolve(parsedEnv.RUN_LOG_DIR ?? parsedEnv.COPILOT_LOG_DIR ?? "./data/run-logs"),
    workspaceRoot: resolve(parsedEnv.WORKSPACE_ROOT),
    maxJobRetries: parsedEnv.MAX_JOB_RETRIES,
    retryBackoffMs: parsedEnv.RETRY_BACKOFF_MS,
    copilotTimeoutMs: parsedEnv.COPILOT_TIMEOUT_MS,
    memoryEnabled: parsedEnv.REVIEWPHIN_MEMORY_ENABLED === "true",
    maxPromptMemoryChars: parsedEnv.REVIEWPHIN_MAX_PROMPT_MEMORY_CHARS,
    textGenerationModel: parsedEnv.REVIEWPHIN_TEXT_GENERATION_MODEL,
    copilotModel: parsedEnv.COPILOT_MODEL,
    copilotCliPath: parsedEnv.COPILOT_CLI_PATH
  };
}
