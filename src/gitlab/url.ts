export function normalizeGitLabBaseUrl(value: string): string {
  const parsed = new URL(value);
  const normalizedPath = stripTrailingSlashes(parsed.pathname).replace(/\/api\/v4$/i, "");
  return `${parsed.origin}${normalizedPath}`;
}

export function buildGitLabApiUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string | number | undefined> = {}
): URL {
  const normalizedBaseUrl = normalizeGitLabBaseUrl(baseUrl);
  const parsedBaseUrl = new URL(normalizedBaseUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(parsedBaseUrl.origin);
  const basePath = stripTrailingSlashes(parsedBaseUrl.pathname);
  url.pathname = `${basePath}/api/v4${normalizedPath}`.replace(/\/{2,}/g, "/");

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url;
}

export function urlMatchesGitLabBase(candidateUrl: string, baseUrl: string): boolean {
  const candidate = new URL(candidateUrl);
  const normalizedBase = new URL(normalizeGitLabBaseUrl(baseUrl));
  if (candidate.origin !== normalizedBase.origin) {
    return false;
  }

  const candidatePath = stripTrailingSlashes(candidate.pathname);
  const basePath = stripTrailingSlashes(normalizedBase.pathname);
  if (basePath === "") {
    return true;
  }

  return candidatePath === basePath || candidatePath.startsWith(`${basePath}/`);
}

function stripTrailingSlashes(value: string): string {
  if (value === "/") {
    return "";
  }

  return value.replace(/\/+$/, "");
}
