import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const site = process.env.REVIEWPHIN_DOCS_SITE ?? "https://reviewphin.com";
const base = process.env.REVIEWPHIN_DOCS_BASE ?? "/";
const basePath = base.endsWith("/") ? base.slice(0, -1) : base;
const withBase = (path) => `${basePath}${path}`;
const repositoryUrl = "https://github.com/cdwv/ReviewPhin";
const changelogUrl =
  "https://rgembalik.gitlab.io/changelog-browser/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fcdwv%2FReviewPhin%2Fmain%2FCHANGELOG.md";

export default defineConfig({
  site,
  base,
  publicDir: "./public",
  outDir: "../dist-docs-container",
  build: {
    assets: "docs/_astro",
  },
  redirects: {
    "/docs/quickstart": withBase("/docs/deployment"),
    "/docs/quickstart/gitlab": withBase(
      "/docs/management/platform-connections",
    ),
    "/docs/quickstart/github": withBase(
      "/docs/management/platform-connections",
    ),
    "/docs/cli": withBase("/docs/management"),
    "/docs/cli/reference": withBase("/docs/management/cli-reference"),
    "/docs/configuration": withBase("/docs/deployment/environment-variables"),
    "/docs/configuration/model-profiles": withBase(
      "/docs/management/model-profiles",
    ),
    "/docs/configuration/storage": withBase("/docs/deployment/storage"),
    "/docs/architecture": withBase("/docs/development"),
    "/docs/architecture/review-flow": withBase("/docs/development/review-flow"),
    "/docs/architecture/providers": withBase("/docs/development/providers"),
    "/docs/providers/platforms": withBase("/docs/development/providers"),
    "/docs/providers/platforms/gitlab": withBase(
      "/docs/management/platform-connections",
    ),
    "/docs/providers/platforms/github": withBase(
      "/docs/management/platform-connections",
    ),
    "/docs/providers/platforms/custom": withBase(
      "/docs/development/custom-platforms",
    ),
    "/docs/providers/storage": withBase("/docs/deployment/storage"),
    "/docs/providers/storage/sqlite": withBase("/docs/deployment/storage"),
    "/docs/providers/storage/flotiq": withBase("/docs/deployment/storage"),
    "/docs/providers/storage/custom": withBase(
      "/docs/development/custom-storage",
    ),
    "/docs/deployment/image-docs": withBase(
      "/docs/development/contributing-docs",
    ),
    "/docs/contributing/docs": withBase("/docs/development/contributing-docs"),
  },
  integrations: [
    starlight({
      title: "ReviewPhin Docs",
      description:
        "Set up, operate, and extend ReviewPhin for merge request and pull request review workflows.",
      favicon: withBase("/favicon.png"),
      customCss: ["./src/styles/starlight.css"],
      disable404Route: true,
      credits: false,
      social: [
        {
          icon: "github",
          label: "GitHub repository",
          href: repositoryUrl,
        },
      ],
      editLink: {
        baseUrl: `${repositoryUrl}/edit/main/docs/`,
      },
      sidebar: [
        { label: "Docs Home", slug: "docs" },
        {
          label: "Changelog",
          link: changelogUrl,
          attrs: {
            target: "_blank",
            rel: "noopener noreferrer",
          },
        },
        {
          label: "Using ReviewPhin",
          items: [
            { label: "Overview", slug: "docs/using-reviewphin" },
            {
              label: "Merge requests",
              slug: "docs/using-reviewphin/merge-requests",
            },
            {
              label: "Pull requests",
              slug: "docs/using-reviewphin/pull-requests",
            },
            {
              label: "Comments and triggers",
              slug: "docs/using-reviewphin/comments-and-triggers",
            },
          ],
        },
        {
          label: "Management",
          items: [
            { label: "Overview", slug: "docs/management" },
            {
              label: "Platform connections",
              slug: "docs/management/platform-connections",
            },
            { label: "Tenants", slug: "docs/management/tenants" },
            { label: "Model profiles", slug: "docs/management/model-profiles" },
            { label: "CLI reference", slug: "docs/management/cli-reference" },
          ],
        },
        {
          label: "Deployment & instance management",
          items: [
            { label: "Overview", slug: "docs/deployment" },
            { label: "Run locally", slug: "docs/deployment/run-locally" },
            { label: "Run with Docker", slug: "docs/deployment/docker" },
            { label: "Run on Kubernetes", slug: "docs/deployment/kubernetes" },
            {
              label: "Exposing webhooks",
              slug: "docs/deployment/exposing-webhooks",
            },
            {
              label: "Environment variables",
              slug: "docs/deployment/environment-variables",
            },
            { label: "Storage & migration", slug: "docs/deployment/storage" },
          ],
        },
        {
          label: "Development",
          items: [
            { label: "Overview", slug: "docs/development" },
            { label: "Review flow", slug: "docs/development/review-flow" },
            { label: "Providers", slug: "docs/development/providers" },
            {
              label: "Custom platform providers",
              slug: "docs/development/custom-platforms",
            },
            {
              label: "Custom storage adapters",
              slug: "docs/development/custom-storage",
            },
            {
              label: "Contributing to docs",
              slug: "docs/development/contributing-docs",
            },
            {
              label: "Release publication",
              slug: "docs/development/release-publication",
            },
          ],
        },
      ],
    }),
  ],
});
