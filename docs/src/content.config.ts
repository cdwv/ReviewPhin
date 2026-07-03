import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({
    loader: docsLoader({
      generateId: ({ entry }) => {
        const slug = entry.replace(/\\/g, "/").replace(/\.(md|mdx)$/i, "");
        const routeSlug = slug.endsWith("/index")
          ? slug.slice(0, -"/index".length)
          : slug === "index"
            ? ""
            : slug;
        return routeSlug ? `docs/${routeSlug}` : "docs";
      },
    }),
    schema: docsSchema(),
  }),
};
