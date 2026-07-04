const fs = require("node:fs");

const CANONICAL_DOCS_URL = "https://reviewphin.com";
const CANONICAL_REPOSITORY_URL = "https://github.com/cdwv/ReviewPhin";

const publicUrlPrefix = normalizeUrlPrefix(
  process.env.PUBLIC_SITE_URL || CANONICAL_DOCS_URL,
);
const repositoryUrl = normalizeRepositoryUrl(
  process.env.REPOSITORY_URL ||
    (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
      : CANONICAL_REPOSITORY_URL),
);
const repositoryRef =
  process.env.REPOSITORY_REF || process.env.GITHUB_REF_NAME || "main";

let content = fs.readFileSync("README.md", "utf8");

if (publicUrlPrefix !== normalizeUrlPrefix(CANONICAL_DOCS_URL)) {
  content = content.replaceAll(
    CANONICAL_DOCS_URL,
    publicUrlPrefix.replace(/\/$/, ""),
  );
}

function normalizeUrlPrefix(prefix) {
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function normalizeRepositoryUrl(url) {
  return url.replace(/\/$/, "");
}

function splitHref(href) {
  const match = href.match(/^([^?#]*)([?#].*)?$/);
  return {
    path: match?.[1] || "",
    suffix: match?.[2] || "",
  };
}

function normalizeLocalPath(path) {
  return path.replace(/^\.\//, "").replace(/^\//, "");
}

function publicHref(href) {
  const parsed = splitHref(href);
  const path = normalizeLocalPath(parsed.path).replace(/^public\//, "");
  return `${publicUrlPrefix}${path}${parsed.suffix}`;
}

function repositoryHref(href) {
  const parsed = splitHref(href);
  const path = normalizeLocalPath(parsed.path);
  return `${repositoryUrl}/blob/${repositoryRef}/${path}${parsed.suffix}`;
}

function markdownLinkHref(href) {
  const path = normalizeLocalPath(splitHref(href).path);
  if (path.startsWith("docs/") || path.startsWith("public/")) {
    return publicHref(href);
  }

  return repositoryHref(href);
}

function isRemoteOrSpecialHref(href) {
  return (
    href.startsWith("//") ||
    href.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(href)
  );
}

// Replace local image links in markdown with public image URLs.
content = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
  if (!isRemoteOrSpecialHref(src)) {
    const href = publicHref(src);
    return href !== src ? `![${alt}](${href})` : match;
  } else {
    return match;
  }
});

// Replace local image links in img tags with public image URLs.
content = content.replace(
  /<img\s+([^>]*\s+)?src=["']([^"']+)["']([^>]*)?>/g,
  (match, before, src, after) => {
    if (!isRemoteOrSpecialHref(src)) {
      const href = publicHref(src);
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
    if (!isRemoteOrSpecialHref(href)) {
      return `${imgPart}(${markdownLinkHref(href)})`;
    }
    return match;
  },
);

// Replace local links with the public site for docs/assets and GitHub for repository files.
content = content.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, text, href) => {
  if (!isRemoteOrSpecialHref(href)) {
    return `[${text}](${markdownLinkHref(href)})`;
  }
  return match;
});

fs.writeFileSync("DOCKERHUB_README.md", content, "utf8");
console.log("DOCKERHUB_README.md generated successfully");
