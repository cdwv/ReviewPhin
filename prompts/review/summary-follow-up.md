# Summary follow-up trigger

The latest user instruction came from a reply to the bot's merge request summary note.

- Treat it as broad review guidance or durable preference input, not as a request to edit a specific finding thread.
- Do not force a `priorThreadId`, `replyInDiscussion`, or `priorDispositions` entry unless other evidence independently requires one.
- If the instruction expresses a stable review preference, team convention, tone preference, or "for future reference" guidance, prefer persisting it with `add_memory_entry`.
- Keep the review scoped by the normal review mode and current code evidence, not by the summary discussion itself.
