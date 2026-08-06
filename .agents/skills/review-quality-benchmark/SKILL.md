---
name: review-quality-benchmark
description: Assess ReviewPhin review-run quality over a user-provided time period from an exported SQLite database and existing run logs, reuse cached scores, and produce a fixed-template HTML report with quality charts over time. Use when Codex needs to benchmark generated review summaries and findings, compare prompt eras or date ranges, score review quality dimensions, or refresh an existing benchmark report without repository access.
---

# Review Quality Benchmark

Benchmark reviewer output from recorded run evidence only. Keep judgment agentic and keep selection, normalization, caching, validation, and HTML rendering deterministic through the bundled standalone Node.js script.

## Required boundaries

- Do not access target repositories, provider APIs, or the internet.
- Do not mutate the source database or run logs.
- Do not import ReviewPhin application modules or third-party Node.js packages.
- Put every generated file under `<workspace>/benchmark-report/`.
- Treat the benchmark as evidence-relative: judge how well the output is supported by the evidence recorded in the run.
- Score runs independently against the rubric. Do not rank a run relative to neighboring runs.
- Default to reviewer modes `review`, `first-pass-full`, and `incremental-rereview`. Exclude reply, chatter, and memory sessions unless the user explicitly requests otherwise.

## Workflow

1. Resolve the workspace, source SQLite database, run-log directory, inclusive `from` date, and inclusive `to` date. Use `data/review-worker.sqlite` and `data/run-logs` when present and the user did not override them.
2. Read [references/rubric.md](references/rubric.md), [references/judge-prompt.md](references/judge-prompt.md), and [references/assessment-schema.json](references/assessment-schema.json) completely before scoring.
3. Prepare normalized evidence packets and inspect cache state:

   ```powershell
   node .agents/skills/review-quality-benchmark/scripts/benchmark.mjs prepare `
     --db data/review-worker.sqlite `
     --logs data/run-logs `
     --from 2026-07-31 `
     --to 2026-08-06 `
     --judge-model gpt-5.6-sol
   ```

4. Read `benchmark-report/tmp/manifest.json`. If `pendingRuns` is empty, skip directly to rendering.
5. For each pending run, read its packet from `benchmark-report/tmp/packets/<run-id>.json`, apply the judge prompt and rubric, and write one schema-conforming JSON assessment to `benchmark-report/tmp/assessments/<run-id>.json`. Preserve the packet's `runId`, `inputDigest`, `evaluatorVersion`, and `judgeModel` exactly.
6. Store each assessment immediately so completed work survives interruption:

   ```powershell
   node .agents/skills/review-quality-benchmark/scripts/benchmark.mjs store `
     --file benchmark-report/tmp/assessments/<run-id>.json
   ```

7. Render the report after all possible pending runs are stored:

   ```powershell
   node .agents/skills/review-quality-benchmark/scripts/benchmark.mjs render
   ```

8. Return the report path, selected/scored/missing counts, cache reuse count, and any runs that failed assessment. Do not describe cached runs as newly assessed.

## Scoring rules

- Score all seven run-level categories: `noobFriendliness`, `unjargonity`, `readability`, `importance`, `targeting`, `assessmentScope`, and `groundedness`.
- Use integer scores from 0 through 10. Higher is always better.
- Set `importance` and `targeting` to `null` when a run emitted no findings. Never convert not-applicable values to zero.
- Score each finding's importance, targeting, and groundedness before deriving the run-level values.
- Judge targeting semantically from the finding, anchor, suggestion, changed-file manifest, and recorded inspection evidence. Consider whether an anchor or safe suggestion should exist, whether one exists, and whether it is useful and correct.
- Judge groundedness only against recorded evidence. Penalize claims that overreach or contradict the trace; do not penalize the absence of external repository evidence.
- Keep reasons concise and evidentiary. Do not quote secrets, source code blocks, or large log passages into assessments.

## Date and cache behavior

- Treat date-only `from` and `to` values as inclusive UTC calendar dates. Accept full ISO timestamps for precise boundaries.
- Cache identity includes normalized run evidence, rubric and judge-prompt content, assessment schema, and judge model identifier.
- Reuse a cached assessment only when every identity component matches.
- Widening a period must assess only new or invalidated runs and then rerender the complete requested period.
- Never delete the cache automatically. Use the script's `--force` option during `prepare` only when the user explicitly requests reassessment.

## Output behavior

- Use the bundled `assets/report-template.html` unchanged except for injection at its single `__REVIEW_BENCHMARK_DATA__` marker.
- Let the renderer escape embedded JSON and write reports atomically.
- Default reports to `benchmark-report/reports/review-quality-<from>--<to>.html`.
- Keep the report self-contained and offline. Do not add runtime CDN or network dependencies.
- Keep the timeline's shared scale switchable between the honest fixed `0–10` range and one fitted `min–max` range derived from all visible applicable scores. Do not fit each category independently.
- Keep timeline height independent of run count. Give the SVG explicit lane-derived pixel dimensions and let long periods scroll horizontally instead of scaling the whole chart down to the panel width.
- Preserve temporary packets and assessments under `benchmark-report/tmp` for auditability until a later benchmark invocation replaces them.

## Script help

Run `node .agents/skills/review-quality-benchmark/scripts/benchmark.mjs help` for all options and defaults.
