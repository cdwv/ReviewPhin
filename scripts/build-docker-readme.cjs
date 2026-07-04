const fs = require("node:fs");

const CANONICAL_DOCS_URL = "https://reviewphin.com";
const DEFAULT_REPO_URL_PREFIX = "https://github.com/cdwv/reviewphin/blob/main/";

const repoUrlPrefix = normalizeUrlPrefix(
  process.env.PUBLIC_REPO_URL_PREFIX || DEFAULT_REPO_URL_PREFIX,
);

let content = fs.readFileSync("README.md", "utf8");

if (CANONICAL_DOCS_URL !== "https://reviewphin.com") {
  content = content.replaceAll("https://reviewphin.com", CANONICAL_DOCS_URL);
}

function normalizeUrlPrefix(prefix) {
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function repositoryHref(href) {
  return `${repoUrlPrefix}${href.replace(/^\.\//, "")}`;
}

// Replace local image links in markdown with repository blob URLs.
content = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
  if (
    !src.startsWith("http://") &&
    !src.startsWith("https://") &&
    !src.startsWith("data:")
  ) {
    const href = repositoryHref(src);
    return href !== src ? `![${alt}](${href})` : match;
  } else {
    return match;
  }
});

// Replace local image links in img tags with repository blob URLs.
content = content.replace(
  /<img\s+([^>]*\s+)?src=["']([^"']+)["']([^>]*)?>/g,
  (match, before, src, after) => {
    if (
      !src.startsWith("http://") &&
      !src.startsWith("https://") &&
      !src.startsWith("data:")
    ) {
      const href = repositoryHref(src);
      return href !== src
        ? `<img ${before || ""}src="${href}"${after || ""}>`
        : match;
    } else {
      return match;
    }
  },
);

// Replace local links that wrap images: [![alt](img_url)](local_link)
// Must run before the general link regex, which cannot handle nested brackets
content = content.replace(
  /(\[!\[[^\]]*\]\([^)]+\)\])\(([^)]+)\)/g,
  (match, imgPart, href) => {
    if (
      !href.startsWith("http://") &&
      !href.startsWith("https://") &&
      !href.startsWith("#") &&
      !href.startsWith("data:")
    ) {
      return `${imgPart}(${repositoryHref(href)})`;
    }
    return match;
  },
);

// Replace local file links with PUBLIC_REPO_URL_PREFIX
content = content.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, text, href) => {
  if (
    !href.startsWith("http://") &&
    !href.startsWith("https://") &&
    !href.startsWith("#") &&
    !href.startsWith("data:")
  ) {
    return `[${text}](${repositoryHref(href)})`;
  }
  return match;
});

fs.writeFileSync("DOCKERHUB_README.md", content, "utf8");
console.log("DOCKERHUB_README.md generated successfully");
