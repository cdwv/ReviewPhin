import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GITHUB_APP_EVENTS,
  GITHUB_APP_PERMISSIONS,
} from "./manifest.js";

type SetupPageName = "register" | "installation" | "success" | "error";

export type GitHubSetupPageData =
  | {
      page: "register";
      owner: string;
      setupToken: string;
      publicUrl: string;
      permissions: typeof GITHUB_APP_PERMISSIONS;
      events: typeof GITHUB_APP_EVENTS;
      error?: string | undefined;
    }
  | {
      page: "installation";
      appName: string;
      installUrl: string;
      owner: string;
    }
  | {
      page: "success";
      appName: string;
      appSlug: string;
      appHtmlUrl?: string | undefined;
      ownerLogin: string;
      ownerType: string;
      ownerAvatarUrl?: string | undefined;
      installationId: number;
      accessibleRepositoryCount: number;
      repositorySelection: string;
      iconUrl: string;
    }
  | {
      page: "error";
      message: string;
    };

const templateCache = new Map<SetupPageName, string>();

export function renderGitHubSetupPage(input: {
  owner: string;
  setupToken: string;
  publicUrl: string;
  error?: string | undefined;
}): string {
  const publicUrl = normalizePublicUrl(input.publicUrl);
  return renderTemplate("register", {
    title: "Register GitHub App",
    iconUrl: `${publicUrl}/favicon.png`,
    publicUrl,
    data: {
      page: "register",
      owner: input.owner,
      setupToken: input.setupToken,
      publicUrl,
      permissions: GITHUB_APP_PERMISSIONS,
      events: GITHUB_APP_EVENTS,
      error: input.error,
    },
  });
}

export function renderGitHubSetupSuccessPage(input: {
  appName: string;
  appSlug: string;
  appHtmlUrl?: string | undefined;
  ownerLogin: string;
  ownerType: string;
  ownerAvatarUrl?: string | undefined;
  installationId: number;
  accessibleRepositoryCount: number;
  repositorySelection: string;
  iconUrl: string;
  publicUrl: string;
}): string {
  const { publicUrl, ...data } = input;
  return renderTemplate("success", {
    title: "GitHub connection ready",
    iconUrl: input.iconUrl,
    publicUrl,
    data: {
      page: "success",
      ...data,
    },
  });
}

export function renderGitHubInstallationPage(input: {
  appName: string;
  installUrl: string;
  owner: string;
  publicUrl: string;
}): string {
  const { publicUrl: inputPublicUrl, ...data } = input;
  const publicUrl = normalizePublicUrl(inputPublicUrl);
  return renderTemplate("installation", {
    title: "Install GitHub App",
    iconUrl: `${publicUrl}/favicon.png`,
    publicUrl,
    data: {
      page: "installation",
      ...data,
    },
  });
}

export function renderGitHubSetupErrorPage(
  message: string,
  publicUrl: string,
): string {
  const normalizedPublicUrl = normalizePublicUrl(publicUrl);
  return renderTemplate("error", {
    title: "GitHub setup failed",
    iconUrl: `${normalizedPublicUrl}/favicon.png`,
    publicUrl: normalizedPublicUrl,
    data: {
      page: "error",
      message,
    },
  });
}

function renderTemplate(
  name: SetupPageName,
  input: {
    title: string;
    iconUrl: string;
    data: GitHubSetupPageData;
    publicUrl?: string | undefined;
  },
): string {
  const publicUrl =
    input.publicUrl ??
    ("publicUrl" in input.data ? input.data.publicUrl : undefined) ??
    "";
  const assetBaseUrl = `${normalizePublicUrl(publicUrl)}/github/setup/assets`;
  return getTemplate(name)
    .replaceAll("{{title}}", escapeHtml(input.title))
    .replaceAll("{{iconUrl}}", escapeHtml(input.iconUrl))
    .replaceAll("{{assetBaseUrl}}", escapeHtml(assetBaseUrl))
    .replaceAll("{{setupDataJson}}", serializeSetupData(input.data));
}

function getTemplate(name: SetupPageName): string {
  const cached = templateCache.get(name);
  if (cached !== undefined) {
    return cached;
  }

  const template = readFileSync(
    resolve(
      resolvePublicRoot(),
      "github",
      "setup",
      "templates",
      `${name}.html`,
    ),
    "utf8",
  );
  templateCache.set(name, template);
  return template;
}

function resolvePublicRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "..", "..", "..", "public"),
    resolve(moduleDirectory, "..", "..", "..", "..", "public"),
  ];
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  );
}

function normalizePublicUrl(publicUrl: string): string {
  return publicUrl.replace(/\/+$/, "");
}

function serializeSetupData(data: GitHubSetupPageData): string {
  return JSON.stringify(data)
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
