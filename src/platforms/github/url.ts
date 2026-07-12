export type GitHubCommentUrlKind = "issue-comment" | "review-comment";

export interface GitHubCommentUrl {
  url: string;
  kind: GitHubCommentUrlKind;
  owner: string;
  repository: string;
  codeReviewId: number;
  commentId: number;
}

export function parseGitHubCommentUrl(value: string): GitHubCommentUrl {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw unsupportedGitHubCommentUrl();
  }

  const pathMatch = parsed.pathname.match(
    /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)$/,
  );
  const issueMatch = parsed.hash.match(/^#issuecomment-([1-9]\d*)$/);
  const reviewMatch = parsed.hash.match(/^#discussion_r([1-9]\d*)$/);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    !pathMatch ||
    (!issueMatch && !reviewMatch)
  ) {
    throw unsupportedGitHubCommentUrl();
  }

  return {
    url: parsed.toString(),
    kind: issueMatch ? "issue-comment" : "review-comment",
    owner: decodeURIComponent(pathMatch[1]!),
    repository: decodeURIComponent(pathMatch[2]!),
    codeReviewId: Number(pathMatch[3]),
    commentId: Number((issueMatch ?? reviewMatch)![1]),
  };
}

function unsupportedGitHubCommentUrl(): Error {
  return new Error(
    "Unsupported GitHub comment URL. Use a canonical pull request issue or review comment URL, or provide --trigger-comment-id with --code-review-id.",
  );
}
