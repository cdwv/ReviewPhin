---
name: schema-verification-skill
description: Verify storage schema or storage contract changes in this repository. Use when reviewing or implementing changes that touch storage contract revisions, SQLite or Flotiq schemas/migrations, persisted type definitions, storage provider versions, or docs describing storage schemas/adapters.
---

# Schema Verification Skill

Use this skill to audit storage schema changes before finishing a task or code review.

## Workflow

1. Identify the schema diff.
   - Run `git diff --stat main -- src/storage docs README.md test`.
   - Inspect changed files under `src/storage/contract/`, `src/storage/adapters/`, storage tests, and storage docs.

2. Verify schema history descriptions.
   - Check `src/storage/contract/index.ts` for `CURRENT_STORAGE_CONTRACT_REVISION`.
   - Check `src/storage/contract/history/index.ts` includes metadata for the current revision.
   - Ensure old history snapshots such as `storage-v000.d.ts` remain frozen unless the task explicitly edits historical docs.
   - Ensure the current snapshot file exported by `src/storage/contract/current.d.ts` exists and matches the current revision.

3. Verify built-in adapters.
   - Check SQLite and Flotiq providers report the current contract revision from `getSupportedStorageContract()`.
   - Check SQLite and Flotiq migrations preserve existing data when columns are renamed or moved. For Flotiq, data needs to be migrated when field names change, but for SQLite, column renames can be handled with `ALTER TABLE RENAME COLUMN` without data loss. Data migrations (e.g. filling in new columns, or data changes in existing columns) should be handled properly both in SQLite and Flotiq. In Flotiq this typically means reading existing data, transforming it, and writing it back if anything changed for content object. In SQLite, this may involve creating a new table with the updated schema, copying data from the old table to the new one, and then replacing the old table with the new one.
   - Check Flotiq CTD definitions use the same entity field names as the current contract.
   - Confirm adapter-local physical column names are either migrated or intentionally mapped from legacy names.

4. Verify type definitions and mappings.
   - Compare current contract fields against mapper code in built-in adapters.
   - Grep for stale public field names that should have been renamed.
   - Treat provider-native names inside provider-specific code as acceptable when they mirror that provider API.

5. Verify docs and README.
   - Update `docs/src/content/docs/configuration/storage.md`, relevant pages under `docs/src/content/docs/providers/storage/`, and `src/storage/adapters/README.md` when the required contract revision changes.
   - Update README or CLI docs if operators or adapter authors need new environment variables, migration behavior, or compatibility notes.

6. Run validation.
   - Run `npm run build`.
   - Run relevant storage tests; prefer `npm test` for contract-wide changes.
   - Run targeted greps for stale schema names and report any intentional leftovers.

## Review Output

When reporting results, list findings first with file and line references. Include:

- contract revision mismatch
- missing history metadata
- historical snapshot mutation
- adapter version or migration mismatch
- type/mapper field mismatch
- stale docs or README guidance
- tests not run or failing
