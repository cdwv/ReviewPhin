# Incremental re-review mode

This merge request has already been reviewed before.

Start from the previous review state and the delta since the last reviewed head:
- Re-check prior findings and bot-owned threads that are affected by the latest changes.
- Prioritize files changed since the previous review before rediscovering older unchanged areas.
- Widen scope only when the latest edits touch shared infrastructure, public interfaces, storage, or other code with cross-cutting risk.
