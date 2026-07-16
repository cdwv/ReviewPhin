---
name: html-plan
description: Create and update ReviewPhin HTML implementation plans in .agents/plans. Use when Codex needs to turn proposed project changes into a new HTML plan, revise an existing plan after requirements or code change, add a plan to the plans index, or check a plan for clear language, useful visual aids, implementation detail, and consistency with the shared plan template.
---

# HTML Plan

Create plans that explain project changes to readers who do not know the code. Use `assets/plan-template.html` as the starting structure for a new plan and keep the shared styles in `.agents/plans/_plan.css`.

## Build an evidence-based plan

1. Inspect `.agents/plans/index.html`, the most closely related existing plan, and `.agents/plans/_plan.css`.
2. Inspect the relevant code, tests, configuration, and documentation. Describe the current state only after verifying it.
3. Separate confirmed facts from proposed choices. State an important unresolved choice plainly instead of hiding it in implementation detail.
4. Decide the plan's order, priority, stored-data effect, previous plan, and next plan before editing navigation.
5. For a new plan, start from `assets/plan-template.html`. For an update, preserve the existing page structure unless the content needs a different visual aid.
6. Update `.agents/plans/index.html` and neighboring footer links when adding, removing, or reordering a plan.

## Write for any project contributor

- Use short sentences, familiar words, and concrete examples.
- Explain what happens today, what must happen instead, why the change matters, and enough detail to implement it.
- Introduce one idea at a time. Expand or replace abbreviations on first use.
- Prefer product behavior such as “save the result before posting” over internal language such as “persist before adapter dispatch.”
- Avoid unnecessary terminology. If a precise technical term is required outside the technical notes, explain it immediately in ordinary language.
- Make headings answer the reader's likely questions: “What is wrong today?”, “What do we want instead?”, “How do we fix it?”, “Work steps”, and “How do we know it works?”.
- Make acceptance checks observable and specific. Include the relevant test and build commands at the end.

## Keep code references in technical notes

Put exact file paths, symbols, methods, types, schemas, storage contract versions, and code links only inside one dedicated `<details>` element with the summary `Technical notes for the implementing agent`.

Keep the proposed implementation outside that element in simple language. Explain responsibilities, order of work, important rules, failure behavior, and data effects without requiring the reader to recognize internal code names. Do not move essential product decisions into the technical notes; the main plan must remain complete on its own.

## Use visual aids when they clarify the plan

Choose the smallest visual that makes a relationship easier to understand:

- Use `.flow` for three or more stages, handoffs, or state changes.
- Use a two-column table for repeated problem-to-change or before-to-after mappings.
- Use `.card-grid` for several independent problems, outcomes, or audiences.
- Use `.sequence` for ordered implementation work.
- Use `.checklist` for goals and acceptance checks.
- Use `.callout` for one important rule, warning, or constraint.

Do not add a visual only as decoration. Give each visual an accessible label, keep its text concise, and ensure the same meaning remains clear when read from top to bottom on a small screen.

## Preserve the plan format

- Save plan pages under `.agents/plans/<number>.<short-kebab-title>.html`.
- Keep the skip link, side rail, page table of contents, hero metadata, finished-result callout, five core sections, technical `<details>`, acceptance checks, and footer navigation.
- Set `data-priority` to `critical`, `high`, `medium`, or `low`.
- Keep `_plan.css` as the relative stylesheet link. Extend it only when an existing component cannot express a useful visual.
- Use semantic HTML, useful link text, meaningful heading order, and `aria-label` text for visual flows and navigation.
- Link code references relative to the plan page so they remain usable from the generated HTML.
- Match the existing formatter's HTML style after writing the content.

## Review before finishing

1. Read only the main content outside `<details>`. Confirm that a developer unfamiliar with the code can explain the current state, desired change, reason, implementation outline, and success conditions.
2. Search outside `<details>` for leaked code paths, symbol names, unexplained abbreviations, and project jargon. Rewrite them in plain language.
3. Confirm that a visual aid is present wherever it materially reduces reading effort, and remove any visual that adds no information.
4. Check every section and table-of-contents link, relative code link, index link, and previous/next link.
5. Preview the page at desktop and narrow widths when browser preview is available. Check keyboard focus, horizontal overflow, and readable print output.
6. Run the repository's formatter or targeted validation for the changed HTML, then inspect the diff for accidental changes.
