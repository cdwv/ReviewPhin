# Incremental re-review mode

This code review has already been reviewed before.

Start from the previous review state and the delta since the last reviewed head:

- Re-check `reviewScope.priorFindings`, especially entries still marked `open`, and any live bot-owned discussions that are affected by the latest changes.
- Prioritize files changed since the previous review before rediscovering older unchanged areas.
- When requests reference findings or discussions, reassess every referenced concern and its related code. Keep the other prior findings in the review state; a discussion identifies where to focus, not a separate review mode.
- Prefer updating an existing finding when the concern still applies but needs corrected wording or refreshed evidence.
- Widen scope only when the latest edits touch shared infrastructure, public interfaces, storage, or other code with cross-cutting risk.
