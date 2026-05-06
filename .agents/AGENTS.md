# Agent guidance

## Storage filtering

When querying repository stores, prefer expressing filters in the store/query layer whenever the available filter API can represent the condition clearly.

Use in-memory filtering only when:

- the condition cannot be expressed through store filters,
- the logic depends on already-loaded derived data, or
- adding the query-side version would be less clear than a small local filter.

In practice, prefer store filters for straightforward status, identity, tenant, merge request, and membership constraints, and reserve in-memory filtering for more complex post-query logic.

## Storage schema changes

Any change to the storage schema must be treated as a contract change.

When updating the schema:

- bump the storage schema/contract version,
- add the new schema version to storage history,
- update `src\storage\contract\current.d.ts`,
- add the corresponding migration to every in-app storage adapter that owns migrations.

Do not ship partial schema changes where the contract, history, current schema definition, and adapter migrations are out of sync.
