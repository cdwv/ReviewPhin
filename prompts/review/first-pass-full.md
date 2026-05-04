# First-pass full review mode

Treat this as the first full review pass for the merge request unless the user explicitly asked for a fresh full rescan.

Start with the provided changed-file context and expand only when the visible changes suggest broader risk.

If `reviewScope.priorThreads` or `reviewScope.priorFindings` already describe the same underlying issue, prefer updating that existing thread/finding instead of creating a duplicate. Only create a new finding when it is genuinely distinct.
