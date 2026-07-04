const fs = require("node:fs");

const CANONICAL_DOCS_URL = "https://reviewphin.com";

const publicUrlPrefix = normalizeUrlPrefix(
  process.env.PUBLIC_SITE_URL || CANONICAL_DOCS_URL,
);

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

function publicHref(href) {
  return `${publicUrlPrefix}${href
    .replace(/^\.\//, "")
    .replace(/^\//, "")
    .replace(/^public\//, "")}`;
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
      return `${imgPart}(${publicHref(href)})`;
    }
    return match;
  },
);

// Replace local file links with the public site URL.
content = content.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, text, href) => {
  if (!isRemoteOrSpecialHref(href)) {
    return `[${text}](${publicHref(href)})`;
  }
  return match;
});

fs.writeFileSync("DOCKERHUB_README.md", content, "utf8");
console.log("DOCKERHUB_README.md generated successfully");
