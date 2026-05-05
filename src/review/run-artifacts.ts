import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface AppLogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown> | undefined;
}

export interface GitLabHttpLogEntry {
  timestamp: string;
  requestId: string;
  phase: "request" | "response" | "error";
  method: string;
  path: string;
  requestUrl: string;
  status?: number | undefined;
  durationMs?: number | undefined;
  request?: Record<string, unknown> | undefined;
  response?: Record<string, unknown> | undefined;
  error?: {
    message: string;
    name?: string | undefined;
    stack?: string | undefined;
  } | undefined;
}

export class InteractionRunArtifacts {
  private readonly rootDir: string;
  private readonly interactionRunId: string;

  public constructor(rootDir: string, interactionRunId: string) {
    this.rootDir = rootDir;
    this.interactionRunId = sanitizeFileName(interactionRunId);
  }

  public get runDirectory(): string {
    return join(this.rootDir, this.interactionRunId);
  }

  public get copilotDirectory(): string {
    return join(this.runDirectory, "copilot");
  }

  public get appLogPath(): string {
    return join(this.runDirectory, "app.ndjson");
  }

  public get gitLabHttpLogPath(): string {
    return join(this.runDirectory, "gitlab-http.ndjson");
  }

  public get copilotSessionLogPath(): string {
    return join(this.copilotDirectory, "session.json");
  }

  public getCopilotSessionLogPath(pathSegments: string[]): string {
    return join(this.runDirectory, ...pathSegments, "session.json");
  }

  public async initialize(): Promise<void> {
    await mkdir(this.copilotDirectory, { recursive: true });
  }

  public async appendAppLog(entry: AppLogEntry): Promise<void> {
    await this.appendNdjson(this.appLogPath, entry);
  }

  public async appendGitLabHttpLog(entry: GitLabHttpLogEntry): Promise<void> {
    await this.appendNdjson(this.gitLabHttpLogPath, entry);
  }

  public async writeJsonArtifact(relativePath: string, value: unknown): Promise<void> {
    const path = join(this.runDirectory, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  private async appendNdjson(path: string, entry: object): Promise<void> {
    await mkdir(this.runDirectory, { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
