# Judge prompt

Assess exactly one normalized ReviewPhin run packet.

Use only evidence contained in the packet. Do not access a repository, provider API, network resource, or unrelated workspace file. Treat the task as evaluating the quality of the recorded reviewer response, not independently rereviewing the code.

Apply `rubric.md` literally. Score independently against its fixed anchors and do not compare this run with other runs. Avoid grade inflation. A polished comment can still be ungrounded; a technically strong comment can still be hard to read.

Evaluate each finding's importance, targeting, and groundedness before assigning the corresponding run-level values. For targeting, explicitly reason about anchor expectation, anchor presence and usefulness, suggestion expectation, and suggestion correctness. The model—not a geometric validator—makes this semantic judgment from the finding and recorded run evidence.

Set run-level importance and targeting scores to `null` when there are no findings. Otherwise every run-level category score must be an integer from 0 through 10.

Return JSON only. Follow `assessment-schema.json` exactly. Copy `runId`, `inputDigest`, `evaluatorVersion`, and `judgeModel` from the packet without modification. Keep reasons short and evidence-based. Do not reproduce source-code blocks, secrets, or long log excerpts.
