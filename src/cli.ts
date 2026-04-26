import { pathToFileURL } from "node:url";

import { z } from "zod";

import { loadConfig, tenantConfigSchema } from "./config.js";
import { loadLocalEnvFile } from "./env.js";
import { SqliteStorage } from "./storage/sqlite-storage.js";

interface ParsedCliArgs {
  readonly positionals: string[];
  readonly options: Record<string, string | boolean>;
}

const tenantAddSchema = tenantConfigSchema.extend({
  databasePath: z.string().min(1).optional()
});

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  loadLocalEnvFile();

  const { positionals, options } = parseCliArgs(argv);
  const [resource, action] = positionals;

  if (resource === "tenant" && action === "add") {
    const config = loadConfig();
    const tenant = tenantAddSchema.parse({
      baseUrl: options["base-url"],
      projectId: options["project-id"],
      apiToken: options["api-token"],
      webhookSecret: options["webhook-secret"],
      botUserId: options["bot-user-id"],
      botUsername: options["bot-username"],
      databasePath: options["database-path"]
    });

    const storage = new SqliteStorage({
      databasePath: tenant.databasePath ?? config.databasePath
    });
    await storage.initialize();

    const savedTenant = await storage.upsertTenant(tenant);
    process.stdout.write(
      [
        "Tenant saved.",
        `id: ${savedTenant.id}`,
        `key: ${savedTenant.key}`,
        `project: ${savedTenant.baseUrl} :: ${savedTenant.projectId}`
      ].join("\n") + "\n"
    );
    return 0;
  }

  if (resource === "tenant" && action === "list") {
    const config = loadConfig();
    const databasePath = typeof options["database-path"] === "string" ? options["database-path"] : config.databasePath;
    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();

    const tenants = await storage.listTenants();
    if (tenants.length === 0) {
      process.stdout.write("No tenants registered.\n");
      return 0;
    }

    process.stdout.write(
      `${JSON.stringify(
        tenants.map((tenant) => ({
          id: tenant.id,
          key: tenant.key,
          baseUrl: tenant.baseUrl,
          projectId: tenant.projectId,
          botUserId: tenant.botUserId,
          botUsername: tenant.botUsername
        })),
        null,
        2
      )}\n`
    );
    return 0;
  }

  printHelp();
  return 1;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      positionals.push(token ?? "");
      continue;
    }

    const option = token.slice(2);
    const [key, inlineValue] = option.split("=", 2);
    if (!key) {
      continue;
    }

    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }

    const nextToken = argv[index + 1];
    if (nextToken && !nextToken.startsWith("--")) {
      options[key] = nextToken;
      index += 1;
      continue;
    }

    options[key] = true;
  }

  return { positionals, options };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  pnpm cli tenant add --base-url <url> --project-id <id> --api-token <token> --webhook-secret <secret> [--bot-user-id <id>] [--bot-username <name>] [--database-path <path>]",
      "  pnpm cli tenant list [--database-path <path>]"
    ].join("\n") + "\n"
  );
}

async function main(): Promise<void> {
  const exitCode = await runCli();
  process.exitCode = exitCode;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
