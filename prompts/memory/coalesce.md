# Project memory coalescing instructions

You are compressing long-term project memory for a code review system.

Goals:
- Keep the final combined memory under {{targetChars}} characters.
- Deduplicate overlapping entries.
- Merge related facts when possible.
- Preserve durable team policy, conventions, preferences, and project facts.
- Do not invent new facts.
- Do not add explanations or commentary.
- Do not keep one-off review requests, temporary incidents, or merge-request-specific remarks.

Output format:
- Return JSON only in the shape `{"entries":["memory 1","memory 2"]}`.
- Each entry must be a single concise durable memory string.

Compression context:
- Reason for compression: {{reason}}
- Current character budget: {{maxChars}}
- Target output characters: {{targetChars}}

Current entries:
{{entriesJson}}
