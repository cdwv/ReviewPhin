export function normalizeGitLabBaseUrl(value: string): string {
  const parsed = new URL(value);
  const normalizedPath = stripTrailingSlashes(parsed.pathname).replace(
    /\/api\/v4$/i,
    "",
  );
  return `${parsed.origin}${normalizedPath}`;
}

export function buildGitLabApiUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string | number | undefined> = {},
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

export function urlMatchesGitLabBase(
  candidateUrl: string,
  baseUrl: string,
): boolean {
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

export interface GitLabNoteUrl {
  url: string;
  codeReviewId: number;
  commentId: number;
}

export function parseGitLabNoteUrl(value: string): GitLabNoteUrl {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw unsupportedGitLabNoteUrl();
  }

  const pathMatch = parsed.pathname.match(
    /^\/.+\/-\/merge_requests\/([1-9]\d*)$/,
  );
  const fragmentMatch = parsed.hash.match(/^#note_([1-9]\d*)$/);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    !pathMatch ||
    !fragmentMatch
  ) {
    throw unsupportedGitLabNoteUrl();
  }

  return {
    url: parsed.toString(),
    codeReviewId: Number(pathMatch[1]),
    commentId: Number(fragmentMatch[1]),
  };
}

function unsupportedGitLabNoteUrl(): Error {
  return new Error(
    "Unsupported GitLab comment URL. Use the canonical merge request note URL or provide --trigger-comment-id with --code-review-id.",
  );
}

function stripTrailingSlashes(value: string): string {
  if (value === "/") {
    return "";
  }

  return value.replace(/\/+$/, "");
}
