import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function loadLocalEnvFile(path = ".env"): void {
  const resolvedPath = resolve(path);
  if (!existsSync(resolvedPath) || typeof process.loadEnvFile !== "function") {
    return;
  }

  process.loadEnvFile(resolvedPath);
}
