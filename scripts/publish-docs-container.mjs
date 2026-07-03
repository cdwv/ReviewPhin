import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const buildDir = resolve(root, "dist-docs-container");
const publicDir = resolve(root, "public");

if (!existsSync(resolve(buildDir, "docs"))) {
  throw new Error("Docs build output is missing docs/");
}

mkdirSync(publicDir, { recursive: true });

rmSync(resolve(publicDir, "index.html"), { force: true });
rmSync(resolve(publicDir, "docs"), { recursive: true, force: true });
rmSync(resolve(publicDir, "pagefind"), { recursive: true, force: true });

if (existsSync(resolve(buildDir, "index.html"))) {
  cpSync(resolve(buildDir, "index.html"), resolve(publicDir, "index.html"));
}

cpSync(resolve(buildDir, "docs"), resolve(publicDir, "docs"), {
  recursive: true,
});

const pagefindDir = resolve(buildDir, "pagefind");
if (existsSync(pagefindDir)) {
  cpSync(pagefindDir, resolve(publicDir, "pagefind"), { recursive: true });
}
