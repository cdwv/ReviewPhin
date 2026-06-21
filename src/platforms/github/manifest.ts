export const GITHUB_APP_PERMISSIONS = {
  checks: "write",
  contents: "read",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
} as const;

export const GITHUB_APP_EVENTS = [
  "check_run",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
] as const;

export function buildGitHubAppManifest(input: {
  appName: string;
  description: string;
  publicUrl: string;
  returnUrl: string;
  setupUrl: string;
}) {
  const publicUrl = input.publicUrl.replace(/\/+$/, "");
  return {
    name: input.appName,
    url: publicUrl,
    description: input.description,
    hook_attributes: {
      url: `${publicUrl}/webhooks/github`,
      active: true,
    },
    redirect_url: input.returnUrl,
    setup_url: input.setupUrl,
    public: false,
    default_permissions: GITHUB_APP_PERMISSIONS,
    default_events: GITHUB_APP_EVENTS,
  };
}
