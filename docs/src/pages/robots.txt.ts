import type { APIRoute } from "astro";

function parseBoolean(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

function renderRobotsTxt(allowIndexing: boolean): string {
  if (allowIndexing) {
    return ["User-agent: *", "Allow: /"].join("\n");
  }

  return [
    "User-agent: *",
    "Disallow: /",
    "",
    "User-agent: GPTBot",
    "Disallow: /",
    "",
    "User-agent: ChatGPT-User",
    "Disallow: /",
    "",
    "User-agent: ClaudeBot",
    "Disallow: /",
    "",
    "User-agent: CCBot",
    "Disallow: /",
    "",
    "User-agent: PerplexityBot",
    "Disallow: /",
    "",
    "User-agent: Google-Extended",
    "Disallow: /",
  ].join("\n");
}

const allowBotIndexing =
  parseBoolean(
    import.meta.env.REVIEWPHIN_ALLOW_BOT_INDEXING as string | undefined,
  ) ||
  parseBoolean(
    import.meta.env.REVIEWPHIN_DOCS_ALLOW_BOT_INDEXING as string | undefined,
  );

export const GET: APIRoute = () =>
  new Response(renderRobotsTxt(allowBotIndexing), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
