# Review quality rubric

Apply this rubric to one run at a time. Use only the normalized run packet. Scores are integers from 0 through 10, where higher is better. Use the anchors below as calibration points; interpolate conservatively.

## Noob friendliness

Judge whether a competent programmer who is new to the project can understand the overview and findings.

- **0:** Unusable without deep project knowledge; unexplained references dominate.
- **2:** The core concern is difficult to reconstruct and depends on missing context.
- **5:** Understandable after careful reading, but several project assumptions remain unexplained.
- **8:** The problem, consequence, and requested change are clear with enough local context.
- **10:** Immediately understandable to a newcomer without talking down to an experienced developer.

Do not penalize necessary code identifiers. Penalize unexplained project-specific behavior or conclusions that require the reader to infer the entire causal chain.

## Unjargonity

Judge whether the prose prefers concrete, simple language over abstractions and unnecessary technical or corporate jargon.

- **0:** Mostly opaque abstractions, buzzwords, or compressed specialist language.
- **2:** Frequent unexplained jargon obscures the point.
- **5:** Mixed plain and abstract language; understandable with effort.
- **8:** Mostly concrete language with only necessary technical terms.
- **10:** Precise plain language throughout; every specialized term earns its place or is explained.

Do not reward imprecision merely because words are simple.

## Readability

Judge sentence and paragraph shape, information order, scanability, and cognitive load. Use the packet's deterministic text metrics as supporting evidence, not as an automatic score.

- **0:** Dense walls of text, broken structure, or extremely difficult sentences.
- **2:** Repeated long sentences or paragraphs make the reasoning hard to follow.
- **5:** Generally readable but with noticeable compression, repetition, or awkward organization.
- **8:** Short purposeful paragraphs, sensible sentence lengths, and a clear reading order.
- **10:** Exceptionally economical and effortless to scan without losing necessary detail.

Prefer paragraph breaks between problem/effect and required action when both need explanation. Do not require lists when prose is clearer.

## Importance

Judge whether emitted findings provide material engineering value rather than minor nitpicks. Score each finding first, then derive the run score. Use `null` when the run emitted no findings.

- **0:** Incorrectly elevates cosmetic preferences or irrelevant observations.
- **2:** Mostly low-value cleanup with little practical consequence.
- **5:** A mixture of useful concerns and minor or overstated points.
- **8:** Findings identify consequential correctness, security, performance, or maintainability risks.
- **10:** Every finding exposes a material, decision-relevant risk with calibrated severity and no noise.

A valid low-severity defect can still be useful, but a run dominated by trivial findings should not score highly.

## Targeting

Judge review placement and fix assistance semantically from recorded evidence. Score each finding first, then derive the run score. Use `null` when the run emitted no findings.

For every finding, decide:

1. Whether an inline anchor should be available for this type of concern.
2. Whether the anchor is present when expected, or correctly omitted for a repository-wide or omission-based concern.
3. Whether the chosen path and range usefully locate the causal or best review location.
4. Whether the range is tight enough without losing necessary context.
5. Whether a safe replacement suggestion should reasonably be provided.
6. Whether an emitted suggestion matches the anchor range and appears complete, syntactically plausible, and consistent with the requested fix.

Calibration:

- **0:** Misleading or invalid placement, or a dangerous replacement.
- **2:** Anchor or suggestion is materially disconnected from the concern.
- **5:** Usable placement but loose, incomplete, or missing an obvious safe suggestion.
- **8:** Relevant tight placement and a sound decision about whether to suggest code.
- **10:** Ideal review location plus an exact safe suggestion whenever one is clearly warranted.

Do not demand a suggestion for broad, multi-file, design-dependent, or unsafe fixes. Do not penalize a correctly unanchored repository-wide finding.

## Assessment scope

Judge whether the overview represents the current state of the complete PR/MR under the run's review mode.

- **0:** Describes the wrong change boundary or materially misrepresents review state.
- **2:** Treats a small delta as the whole review or ignores known prior findings.
- **5:** Broadly relevant but incomplete, stale, or inconsistent with parts of the run evidence.
- **8:** Correctly synthesizes the complete review state and merge readiness for the mode.
- **10:** Concise whole-review assessment that integrates prior state, current evidence, findings, and readiness without overclaiming.

For incremental rereviews, allow finding inspection to focus on the delta, but require the overview to describe the whole current review state. Consider the changed-file manifest and recorded inspection trace; do not require every file to be opened.

## Groundedness

Judge whether overview and finding claims are supported by evidence recorded in the run. This is not an independent repository audit.

- **0:** Central claims contradict or invent evidence.
- **2:** Major causal or behavioral claims are unsupported by the recorded trace.
- **5:** Core direction is plausible but important details overreach available evidence.
- **8:** Claims are well supported and uncertainty is appropriately bounded.
- **10:** Every material statement has a clear evidence chain and severity is calibrated precisely.

Do not penalize the run merely because external repository evidence is unavailable. Penalize it when the output claims more than its own recorded evidence supports.

## Aggregation

- Average applicable per-finding scores to obtain run-level `importance` and `targeting`.
- Derive run-level `groundedness` from both per-finding evidence and overview consistency.
- Do not manufacture an overall score. Keep dimensions separate.
- Use a concise reason for each run-level score and each finding assessment.
