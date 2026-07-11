---
name: babysit-pr
description: Publish the current work as a GitHub pull request, request ReviewPhin reviews, wait for ReviewPhin lifecycle reactions, address or rebut findings, and repeat incremental reviews until no fixes remain. Use when asked to create, publish, watch, babysit, or finish a pull request.
user-invocable: true
disable-model-invocation: false
---

# Babysit PR

Take the current work from local changes to a reviewed pull request. Keep working
through ReviewPhin findings until the pull request has no remaining actionable
findings.

Use `gh` for GitHub operations and non-interactive `git` commands. Never force
push, rewrite published history, or amend commits unless the user explicitly
requests it.

## 1. Inspect The Repository

1. Confirm the current directory is inside a Git repository and inspect:
   - `git status --short --branch`
   - the current branch and its upstream
   - the repository's default branch
   - commits and the full diff against the default branch
   - `CONTRIBUTING.md`, pull request templates, and relevant workflow files
2. Preserve unrelated user changes. Do not discard, overwrite, or silently omit
   files that belong to the requested work.
3. Check `gh auth status` before attempting remote operations.

## 2. Ensure A Feature Branch

Treat any normal branch other than the repository's default branch as an
existing feature branch.

If HEAD is detached, the current branch is the default branch, or no branch is
checked out:

1. Derive a short kebab-case name from the change.
2. Create and switch to `feat/<name>`.
3. Do not switch branches when already on a non-default branch.

Resolve the default branch from GitHub when possible:

```bash
gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
```

Fall back to the remote HEAD, then `main`, only when GitHub metadata is
unavailable.

## 3. Validate And Commit Local Changes

If tracked or untracked changes exist:

1. Review the diff and untracked files before staging. Stop rather than commit
   secrets, credentials, generated junk, or clearly unrelated work.
2. Run the repository's documented test, lint, type-check, build, or
   domain-specific verification commands. For ReviewPhin, follow
   `CONTRIBUTING.md` and invoke relevant repository skills such as schema
   verification when their scope matches.
3. Fix failures caused by the pending changes. Report pre-existing or
   environment-blocked failures accurately.
4. Stage the intended files and create a concise imperative commit. Include any
   repository-required commit trailer.
5. Recheck `git status` and the committed diff.

Do not create an empty commit. If the work is already committed, continue.

## 4. Push And Create Or Update The Pull Request

Push the current branch and set its upstream:

```bash
git push -u origin HEAD
```

Check whether the branch already has an open pull request. Reuse and update that
pull request instead of creating a duplicate.

Build the title and body from the complete diff against the default branch, not
just the last commit. Follow the repository's pull request conventions.
Write the body to a temporary file outside the repository so quoting and
multiline Markdown are preserved. Create or update the pull request with:

```bash
gh pr create --base <default-branch> --head <feature-branch> \
  --title '<title>' --body-file <body-file>
gh pr edit <number> --title '<title>' --body-file <body-file>
```

Use `gh pr create` only when no open pull request exists; otherwise use
`gh pr edit`. Remove the temporary body file after the GitHub operation.

For ReviewPhin, the body must include a Happy Changelog block, for example:

```markdown
<details><summary>Changelog: patch</summary>

### Fixed

- Reviews continue after the worker restarts.

</details>
```

Choose `major`, `minor`, or `patch` from the actual compatibility impact. Use
Keep a Changelog section names: `Added`, `Changed`, `Deprecated`, `Removed`,
`Fixed`, or `Security`.

### Changelog Writing Rules

The changelog is release-note copy, not an implementation summary.

- Include only user-facing changes.
- Treat both of these groups as users:
  - developers who request and respond to ReviewPhin reviews
  - administrators who install, configure, upgrade, and operate ReviewPhin
- Use simple language and one complete sentence per bullet.
- Describe what the user can now do, what changed for them, or what problem was
  fixed.
- Include required upgrade or migration action when administrators must act. Assume storage migrations run automatically on server start.
- Omit refactors, internal types, test additions, file names, class names, and
  other implementation-only details.
- Do not invent a user-facing change merely to populate the changelog.

The rest of the pull request body may explain implementation and testing. State
validation results truthfully; never mark an unrun check as passing.

## 5. Request A Review

Create a new pull request issue comment with this exact body:

```text
@ReviewPhin review
```

Use the REST endpoint so the returned comment ID can be recorded:

```bash
gh api --method POST \
  repos/{owner}/{repo}/issues/{pr_number}/comments \
  -f body='@ReviewPhin review' \
  --jq '.id'
```

Each review cycle must use a new trigger comment. Never reuse an earlier comment
or its reactions unless it was created for the latest changes.

Before posting the trigger, fetch all current pull request issue comments and
record each ReviewPhin comment's ID, body, and `updated_at` value. In particular,
identify the bot-owned summary comment by the
`<!-- reviewphin-review-summary -->` marker and retain its current body and
`updated_at` value. ReviewPhin normally edits this existing comment instead of
posting a new summary.

## 6. Wait For ReviewPhin

Poll reactions on the trigger comment:

```text
GET repos/{owner}/{repo}/issues/comments/{comment_id}/reactions
```

Use `gh api --paginate` and inspect individual reaction records, including the
reacting user's login. Do not rely on aggregate reaction counts because other
users may react.

ReviewPhin's GitHub lifecycle is:

- `eyes`: the review was accepted and is being processed
- `hooray`: the review completed successfully
- `confused`: the review failed

Identify the ReviewPhin bot from the `eyes` reaction, then require the terminal
reaction to come from the same login. Prefer a bot account whose login contains
`reviewphin`; do not count reactions from unrelated users.

Poll at a modest interval of your choosing. Typical review takes between a minute and five minutes, but sometimes can be longer. Wait until both `eyes` and one
terminal reaction are present. Absence of a reaction is not completion.

If `confused` appears, inspect pull request comments, checks, and available
ReviewPhin diagnostics. Fix a branch-caused problem and request a fresh review
when possible. If the failure is external or cannot be resolved from the
repository, stop and report the pull request URL and blocker; do not claim the
review succeeded.

## 7. Review The Findings

After `hooray`, refetch all ReviewPhin output, including existing comments that
may have been edited during this review cycle:

- inline pull request review comments
- pull request reviews and their bodies
- issue comments, including the ReviewPhin summary

Compare IDs, bodies, and update timestamps captured before the trigger to find
new or edited output. Do not filter only for new comment IDs or creation
timestamps: the ReviewPhin summary keeps the same ID and is updated in place.
Filter by the same ReviewPhin bot identity when possible.

Always read the complete latest bot-owned summary comment after the review,
identified by the `<!-- reviewphin-review-summary -->` marker. Treat its
`### Merge readiness` status as the authoritative aggregate result, including
persisted findings from earlier cycles. A status other than `Ready` means the
pull request is not merge-ready and the watching loop cannot finish, even when
the latest cycle produced no new findings.

Evaluate every new or still-active finding represented by the refreshed output
and latest summary against the current branch:

1. Read the referenced code and surrounding behavior.
2. Reproduce or prove the issue when practical.
3. Search for existing helpers and conventions before changing code.
4. Classify the finding as actionable, already addressed, incorrect, or no
   longer applicable.

For an actionable finding, implement the complete fix and add or update tests
when behavior changes.

For an incorrect or inapplicable finding, reply with a short, evidence-based
explanation. For inline comments, reply in that review thread through the pull
request review-comment reply endpoint. For a general finding, comment on the
pull request and quote or link to the finding. Be specific and professional;
never dismiss a finding without checking it.

Do not modify code merely to satisfy a finding that is demonstrably wrong.

## 8. Repeat Incremental Reviews

When one or more code or documentation fixes were made:

1. Run the relevant validation again.
2. Commit the fixes with a focused message.
3. Push the branch normally.
4. Snapshot the current ReviewPhin output, including comment IDs, bodies, and
   update timestamps.
5. Post a new `@ReviewPhin review` trigger comment.
6. Wait for that new comment's `eyes` plus `hooray` or `confused` reactions.
7. Evaluate new or edited findings from the incremental review and refetch the
   updated ReviewPhin summary.

Repeat for as many cycles as necessary. Do not impose an arbitrary review-cycle
limit.

Stop the watching loop only when the latest successful cycle has no unresolved
actionable findings, all findings that required an answer were correctly
rebutted, no branch changes remain, and the latest ReviewPhin summary reports
`- **Status:** Ready`. No new findings by itself is not a stopping condition.

## 9. Finish

Before finishing, confirm:

- the feature branch is pushed
- the working tree is clean for the files handled by this task
- the pull request body still follows the repository conventions
- the latest trigger completed with ReviewPhin's `hooray` reaction
- the latest bot-owned ReviewPhin summary was refetched after that trigger and
  its merge readiness status is `Ready`
- every finding from the latest cycle was fixed or answered
- no fix is waiting to be committed or pushed

Report the pull request URL, the number of review cycles, fixes made, findings
rebutted, and any validation or external blocker that remains.

## 10. Reporting

Use tasks and checklists to track progress and report the pull request URL, the number of review cycles, fixes made, findings rebutted, and any validation or external blocker that remains.
