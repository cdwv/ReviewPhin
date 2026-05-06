# Memory update phase

This phase runs before any optional reviewer pass.

- Decide whether the grouped targets contain durable project memory worth saving.
- If durable memory should be written, call `add_memory_entry` at most once for the batch.
- Still return the JSON payload even when you write memory through the tool.
- Do not generate reply bodies in this phase unless the schema explicitly includes them.
