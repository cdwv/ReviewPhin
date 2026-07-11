import { resolve } from "node:path";
import { z } from "zod";

export const modelProfileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message:
      "profile names may contain letters, numbers, dots, underscores, and dashes",
  });

export const tenantConfigSchema = z.object({
  modelProfileName: modelProfileNameSchema.optional(),
});

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  PUBLIC_URL: z.string().url().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  STORAGE_PROVIDER_MODULE: z.string().min(1).optional(),
  PLATFORM_MODULES: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0
        ? undefined
        : value,
    z.string().optional(),
  ),
  RUN_LOG_DIR: z.string().min(1).optional(),
  WORKSPACE_ROOT: z.string().min(1).default("./tmp/review-workspaces"),
  MAX_JOB_RETRIES: z.coerce.number().int().min(0).default(3),
  RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(5_000),
  REVIEWPHIN_JOB_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(2_000),
  REVIEWPHIN_MAX_QUEUED_JOB_AGE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(21_600_000),
  REVIEWPHIN_JOB_LEASE_MS: z.coerce.number().int().min(1_000).default(120_000),
  REVIEWPHIN_JOB_RUNNER_ENABLED: z.enum(["true", "false"]).default("true"),
  COPILOT_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  REVIEWPHIN_MEMORY_ENABLED: z.enum(["true", "false"]).default("true"),
  REVIEWPHIN_MAX_PROMPT_MEMORY_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(5_000),
  COPILOT_SDK_LOG_LEVEL: z
    .enum(["none", "error", "warning", "info", "debug", "all"])
    .optional(),
  COPILOT_CLI_PATH: z.string().min(1).optional(),
  REVIEWPHIN_ALLOW_BOT_INDEXING: z.enum(["true", "false"]).default("false"),
  REVIEWPHIN_BOT_INDEXING_ALLOWED_HOSTS: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0
        ? undefined
        : value,
    z.string().optional(),
  ),
});

export type TenantConfig = z.infer<typeof tenantConfigSchema>;

export interface AppConfig {
  host: string;
  port: number;
  publicUrl: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  storageProviderModule?: string | undefined;
  platformModules: string[];
  runLogDir: string;
  workspaceRoot: string;
  maxJobRetries: number;
  retryBackoffMs: number;
  jobPollIntervalMs: number;
  maxQueuedJobAgeMs: number;
  jobLeaseMs: number;
  jobRunnerEnabled: boolean;
  copilotTimeoutMs: number;
  memoryEnabled: boolean;
  maxPromptMemoryChars: number;
  copilotSdkLogLevel?:
    | "none"
    | "error"
    | "warning"
    | "info"
    | "debug"
    | "all"
    | undefined;
  copilotCliPath?: string | undefined;
  allowBotIndexing: boolean;
  botIndexingAllowedHosts: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsedEnv = envSchema.parse({
    PORT: env.PORT,
    HOST: env.HOST,
    PUBLIC_URL: env.PUBLIC_URL,
    LOG_LEVEL: env.LOG_LEVEL,
    STORAGE_PROVIDER_MODULE: env.STORAGE_PROVIDER_MODULE,
    PLATFORM_MODULES: env.PLATFORM_MODULES,
    RUN_LOG_DIR: env.RUN_LOG_DIR,
    WORKSPACE_ROOT: env.WORKSPACE_ROOT,
    MAX_JOB_RETRIES: env.MAX_JOB_RETRIES,
    RETRY_BACKOFF_MS: env.RETRY_BACKOFF_MS,
    REVIEWPHIN_JOB_POLL_INTERVAL_MS: env.REVIEWPHIN_JOB_POLL_INTERVAL_MS,
    REVIEWPHIN_MAX_QUEUED_JOB_AGE_MS: env.REVIEWPHIN_MAX_QUEUED_JOB_AGE_MS,
    REVIEWPHIN_JOB_LEASE_MS: env.REVIEWPHIN_JOB_LEASE_MS,
    REVIEWPHIN_JOB_RUNNER_ENABLED: env.REVIEWPHIN_JOB_RUNNER_ENABLED?.toLowerCase(),
    COPILOT_TIMEOUT_MS: env.COPILOT_TIMEOUT_MS,
    REVIEWPHIN_MEMORY_ENABLED: env.REVIEWPHIN_MEMORY_ENABLED?.toLowerCase(),
    REVIEWPHIN_MAX_PROMPT_MEMORY_CHARS: env.REVIEWPHIN_MAX_PROMPT_MEMORY_CHARS,
    COPILOT_SDK_LOG_LEVEL: env.COPILOT_SDK_LOG_LEVEL,
    COPILOT_CLI_PATH: env.COPILOT_CLI_PATH,
    REVIEWPHIN_ALLOW_BOT_INDEXING:
      env.REVIEWPHIN_ALLOW_BOT_INDEXING?.toLowerCase(),
    REVIEWPHIN_BOT_INDEXING_ALLOWED_HOSTS:
      env.REVIEWPHIN_BOT_INDEXING_ALLOWED_HOSTS,
  });

  return {
    host: parsedEnv.HOST,
    port: parsedEnv.PORT,
    publicUrl: normalizePublicUrl(
      parsedEnv.PUBLIC_URL ?? `http://localhost:${parsedEnv.PORT}`,
    ),
    logLevel: parsedEnv.LOG_LEVEL,
    storageProviderModule: parsedEnv.STORAGE_PROVIDER_MODULE,
    platformModules: parseModuleList(parsedEnv.PLATFORM_MODULES),
    runLogDir: resolve(parsedEnv.RUN_LOG_DIR ?? "./data/run-logs"),
    workspaceRoot: resolve(parsedEnv.WORKSPACE_ROOT),
    maxJobRetries: parsedEnv.MAX_JOB_RETRIES,
    retryBackoffMs: parsedEnv.RETRY_BACKOFF_MS,
    jobPollIntervalMs: parsedEnv.REVIEWPHIN_JOB_POLL_INTERVAL_MS,
    maxQueuedJobAgeMs: parsedEnv.REVIEWPHIN_MAX_QUEUED_JOB_AGE_MS,
    jobLeaseMs: parsedEnv.REVIEWPHIN_JOB_LEASE_MS,
    jobRunnerEnabled: parsedEnv.REVIEWPHIN_JOB_RUNNER_ENABLED === "true",
    copilotTimeoutMs: parsedEnv.COPILOT_TIMEOUT_MS,
    memoryEnabled: parsedEnv.REVIEWPHIN_MEMORY_ENABLED === "true",
    maxPromptMemoryChars: parsedEnv.REVIEWPHIN_MAX_PROMPT_MEMORY_CHARS,
    copilotSdkLogLevel: parsedEnv.COPILOT_SDK_LOG_LEVEL,
    copilotCliPath: parsedEnv.COPILOT_CLI_PATH,
    allowBotIndexing: parsedEnv.REVIEWPHIN_ALLOW_BOT_INDEXING === "true",
    botIndexingAllowedHosts: parseHostList(
      parsedEnv.REVIEWPHIN_BOT_INDEXING_ALLOWED_HOSTS,
    ),
  };
}

function normalizePublicUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseModuleList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseHostList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => normalizeHost(entry))
    .filter((entry) => entry.length > 0);
}

function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) {
    return "";
  }

  return trimmed.replace(/\.$/, "");
}
