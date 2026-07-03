---
name: reviewphin-docs
description: Create, rewrite, fact-check, or update ReviewPhin documentation, official website copy, docs navigation, examples, diagrams, setup guides, CLI/provider/storage/deployment docs, README links, and docs contribution guidance. Use whenever Codex works on docs content, public product copy, migrated Markdown docs, or documentation quality checks for ReviewPhin.
user-invocable: true
disable-model-invocation: false
---

# ReviewPhin Docs

Use this skill for ReviewPhin documentation and official-site work. Keep facts traceable to the repository, keep writing plain, and keep the docs useful for operators and maintainers before they become marketing copy.

## Workflow

1. Gather facts from code, tests, existing docs, README, Docker files, CI, and runtime behavior before making claims.
2. Identify the reader goal: quick setup, platform setup, model configuration, storage operations, CLI reference, deployment, architecture, or provider extension.
3. Choose the target page in the docs information architecture. Do not duplicate the same guidance across many pages; link to the canonical page instead.
4. Write or update content in plain language. Explain what the reader can do before explaining how the code is built.
5. Add visual or interactive aids when they reduce confusion: setup timelines, terminal walkthroughs, architecture diagrams, comparison tables, checklists, and copyable commands.
6. Verify commands, environment variables, file paths, routes, provider names, and links against source.
7. Record assumptions in the page only when they matter to the reader; otherwise keep them in implementation notes or PR context.

## Voice And Structure

- Write for operators and maintainers.
- Keep the tone pleasant and direct without becoming chatty.
- Avoid corporate language, empty hype, and SaaS marketing tropes.
- Use short headings and task-oriented sections.
- Keep paragraphs short. If a paragraph carries multiple concepts, split it.
- When a concept needs a long explanation, simplify it, split it into steps, add a visual aid, or improve the surrounding page UX before adding more prose.
- Prefer "merge request or pull request" when content applies to both.
- Avoid internal type names, class names, and implementation details in beginner and task pages.
- Keep exact command names, environment variables, file paths, and API terms accurate in reference pages.
- Use small dolphin or code-review jokes only when they fit naturally; skip them in setup, reference, and troubleshooting content.

## Ordering Rules

- List GitLab first in navigation, examples, and comparison tables.
- Give GitHub and custom providers equal structure and depth where they are supported.
- For storage, put SQLite first where it is the simplest or default path, then Flotiq, then custom adapters.
- Do not make ReviewPhin sound GitLab-only when a concept applies across platforms.

## Visual And Static-Site Rules

- Keep visuals static-site friendly and accessible.
- Provide reduced-motion behavior for animations.
- Do not depend on server APIs for docs interactions.
- Keep no-JavaScript fallbacks where practical, especially for core setup guidance.
- Use feature-complete controls and clear labels for interactive guides.
- Do not let visual polish replace operational clarity.
- Use `frontend-design` alongside this skill for homepage and visual-heavy docs components.
- Keep visuals consistent with the current color palette and typography.

## Fact-Checking

For each substantial page, perform a fact pass:

- Check CLI examples against `src/cli.ts` and CLI tests.
- Check routes against `src/app.ts` and route tests.
- Check GitLab and GitHub behavior against platform source and tests.
- Check storage docs against storage contracts, adapters, and migrations.
- Check Docker/deployment docs against `Dockerfile`, `docker-compose.yml`, chart files, and CI.
- Flag unsupported claims instead of smoothing them over.

Use the `schema-verification-skill` alongside this skill for storage contract, schema, migration, or persisted type documentation.
Use `frontend-design` alongside this skill for the homepage and visual-heavy docs components.

## Model Collaboration

When multiple models are available, use this split:

- GPT-5.5: fact gathering, code tracing, command inventory, architecture tracing, and fact-checking.
- Opus 4.8: homepage composition, page copy, narrative clarity, visual guide design, and final copy polish.

For substantial pages, gather a concise fact brief first, write from that brief, fact-check the result, then polish without adding new factual claims.
