---
title: Review quality benchmark
description: Compare recorded review comments across time, prompt changes, and releases.
---

The review quality benchmark helps maintainers check whether generated review comments improve after prompt or application changes. It scores completed review runs from an exported SQLite database and their saved run logs, then produces a self-contained HTML report.

The benchmark works from recorded evidence only. It does not open the reviewed repositories or call GitLab, GitHub, model-provider, or storage-provider APIs.

## What you need

Run the benchmark from a ReviewPhin source checkout with the bundled Codex skill available. Copy these artifacts from the instance you want to analyze:

| Input | Default path | Purpose |
| --- | --- | --- |
| SQLite database | `data/review-worker.sqlite` | Completed runs, review output, findings, and snapshots. |
| Run logs | `data/run-logs/` | Prompt, inspection, model, and session evidence recorded for each run. |

The source artifacts are read-only during benchmarking. A run remains usable when some older evidence is absent, but the assessment should state the limitation instead of inferring missing context.

## Generate a report

Ask Codex to use the skill and provide an inclusive UTC date range:

```text
Use $review-quality-benchmark to assess runs from 2026-08-01 through 2026-08-06.
```

Mention different database or run-log paths in the request when the exports are not under `data/`.

By default, the benchmark includes completed full reviews, incremental rereviews, and targeted review runs. It excludes chatter, reply-only, and memory sessions because they do not represent a complete review result.

## Scores

Each applicable dimension is scored from 0 through 10. Higher is better.

| Dimension | Question |
| --- | --- |
| Noob friendliness | Can a programmer new to the project understand the review? |
| Unjargonity | Does the response prefer precise, simple language? |
| Readability | Are sentences, paragraphs, and information order easy to scan? |
| Importance | Do emitted findings provide material engineering value? |
| Targeting | Are anchors and replacement suggestions chosen well? |
| Assessment scope | Does the overview represent the complete current merge request or pull request? |
| Groundedness | Are claims supported by evidence recorded in the run? |

Importance and targeting are not applicable when a run emitted no findings. The report displays those gaps as missing values, not zero scores.

## Output and cache

All generated files stay under the gitignored `benchmark-report/` directory:

```text
benchmark-report/
  cache.sqlite       reusable assessments
  reports/           self-contained HTML reports
  tmp/               normalized packets, manifest, and pending assessments
```

The cache reuses a score only when the normalized evidence, rubric, assessment schema, judge prompt, and judge model still match. Widening the date range assesses only new or invalidated runs before rendering the complete requested period.

The HTML report works offline. Use its filters to isolate tenants, review modes, models, or prompt fingerprints. Long periods scroll horizontally so the seven quality lanes keep a readable height. The score range can switch between the fixed 0–10 scale and one shared range fitted to the visible results.

## Prompt and release markers

Prompt-change markers come from the reviewer prompt fingerprint recorded with each run. Release markers use the ReviewPhin version saved in the run log. Runs created before those fields were recorded remain in the report but cannot contribute the corresponding marker.

Treat small eras cautiously. A handful of runs can suggest a change, but it is not enough to separate prompt effects from different repositories, change sizes, review modes, or models.

## Keep reports private

Reports and normalized packets can contain review titles, tenant identifiers, finding text, anchors, and replacement suggestions. `benchmark-report/` is ignored by Git; keep it that way. Review the generated file before sharing it outside the team.
