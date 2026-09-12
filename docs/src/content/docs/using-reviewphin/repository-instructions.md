---
title: Repository instructions and skills
description: Give ReviewPhin committed review guidance alongside shared repository instructions.
---

Commit a `.reviewphin` directory to give ReviewPhin its own review instructions
and skills. This works with GitLab and GitHub, using Copilot subscription models
or a custom model endpoint.

```text
.reviewphin/
  AGENTS.md
  instructions/
    review.instructions.md
  skills/
    security-review/
      SKILL.md
      references/
        checklist.md
```

## Add review instructions

Put repository-wide review guidance in `.reviewphin/AGENTS.md`. Use the uppercase
filename, including on Windows, so the file also works on Linux workers.

```markdown
# Review guidance

Focus on authorization boundaries and data-loss risks.
Treat generated files as context; report fixes against their source templates.
Keep the overall assessment concise.
```

ReviewPhin adds this file to the model's system instructions without replacing
shared instructions such as the root `AGENTS.md` or
`.github/copilot-instructions.md`. It applies to reviews and follow-up replies
that have a repository workspace. Memory-only sessions without a workspace do
not load the directory.

Files come from the commit under review, so a pull request or merge request can
introduce or update its own review guidance. No worker restart is needed for a
new review session to use the updated files.

## Split rules across files

Use `*.instructions.md` files anywhere beneath `.reviewphin` to organize
repository-wide rules. Copilot loads these through its native instruction loader.
For example, `.reviewphin/instructions/review.instructions.md`:

```markdown
---
applyTo: "**"
---

Check that database writes and their related events remain consistent.
```

The supported scope in this release is repository-wide guidance. ReviewPhin does
not enforce path-specific rules against the changed-file list. Narrow `applyTo`
patterns are interpreted by Copilot, and did not reliably activate after file
inspection in the bundled-runtime compatibility check. Use the main instruction
file or `applyTo: "**"` for rules that must be supplied to every review.

## Add skills

Each skill lives in an immediate subdirectory of `.reviewphin/skills` with a
`SKILL.md` file:

```markdown
---
name: security-review
description: Review changes to authentication, authorization, and permission checks.
---

Trace how caller identity reaches the changed permission checks.
Read references/checklist.md for the team's review checklist.
```

ReviewPhin makes these skills available to its review roles and repository-backed
replies. The model chooses when to activate a skill; placing a skill in the
directory does not force every review to use it. Activation loads the skill's
instructions, and the model can read its text reference files.

Skills use the existing read-only review tools. They cannot enable shell
execution, install tools or start MCP servers. Repository-defined agents,
plugins and hooks are not enabled by adding this directory. Per-review skill
selection commands and review-depth settings are not part of this feature.

## Shared instructions and memory

Keep rules used by all coding agents in the existing shared instruction files.
Use `.reviewphin` for guidance meant for ReviewPhin. Learned project memory stays
available alongside both sources.

Avoid conflicting rules: this feature does not introduce a guaranteed precedence
order between committed guidance and memory. Model compliance can vary even when
all instructions are present in the request.

## Loading and troubleshooting

ReviewPhin reads `.reviewphin/AGENTS.md` from the local workspace and passes the
instruction and skills directories to Copilot. Copilot discovers the modular
rules and skills; ReviewPhin does not scan or validate every file in the directory.
Skill reference assets retain their original bytes. How a skill can use an asset
depends on the available model and tools.

Run logs include a `repositoryCustomizations` record with the configured native
directories. This does not prove that Copilot loaded every file or that the model
followed each rule or activated every skill. Normal application logs do not print
the instruction contents.

A missing `.reviewphin` directory leaves existing behavior unchanged. For local
verification, add an easily observable instruction, such as a distinctive review
summary sign-off, and start a new review.
