const fs = require("node:fs");
const path = require("node:path");

let content = fs.readFileSync("README.md", "utf8");

// Helper function to convert image to data URI

// Replace local image links in markdown with data: URIs
content = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
  if (
    !src.startsWith("http://") &&
    !src.startsWith("https://") &&
    !src.startsWith("data:")
  ) {
    const href = `${process.env.PUBLIC_REPO_URL_PREFIX || "./"}${src.replace(/^\.\//, "")}`;
    return href !== src ? `![${alt}](${href})` : match;
  } else {
    return match;
  }
});

// Replace local image links in img tags with data: URIs
content = content.replace(
  /<img\s+([^>]*\s+)?src=["']([^"']+)["']([^>]*)?>/g,
  (match, before, src, after) => {
    if (
      !src.startsWith("http://") &&
      !src.startsWith("https://") &&
      !src.startsWith("data:")
    ) {
      const href = `${process.env.PUBLIC_REPO_URL_PREFIX || "./"}${src.replace(/^\.\//, "")}`;
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
    console.log(`Processing image link: ${match}`);
    if (
      !href.startsWith("http://") &&
      !href.startsWith("https://") &&
      !href.startsWith("#") &&
      !href.startsWith("data:")
    ) {
      return `${imgPart}(${process.env.PUBLIC_REPO_URL_PREFIX || "./"}${href.replace(/^\.\//, "")})`;
    }
    return match;
  },
);

// Replace local file links with PUBLIC_REPO_URL_PREFIX
content = content.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, text, href) => {
  console.log(`Processing link: [${text}](${href})`);
  if (
    !href.startsWith("http://") &&
    !href.startsWith("https://") &&
    !href.startsWith("#") &&
    !href.startsWith("data:")
  ) {
    return `[${text}](${process.env.PUBLIC_REPO_URL_PREFIX || "./"}${href.replace(/^\.\//, "")})`;
  }
  return match;
});

fs.writeFileSync("DOCKERHUB_README.md", content, "utf8");
console.log("DOCKERHUB_README.md generated successfully");
