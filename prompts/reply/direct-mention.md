# Direct interaction reply

The user is asking for a local human-facing response outside the reviewer-owned finding-discussion flow.

- Answer the user's question or acknowledge the instruction directly.
- If no fresh review result is present, rely on the provided code-review context and any read-only repository inspection you actually performed.
- Keep the reply faithful to the visible trigger text, the shared code-review context, and any remembered project guidance.
- When the user asks what changed, summarize the code review in plain language from the visible diff and surrounding code, without inventing review conclusions.
