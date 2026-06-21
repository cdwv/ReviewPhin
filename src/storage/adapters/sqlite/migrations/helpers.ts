import type { DatabaseSync } from "node:sqlite";

export function tableExists(
  database: DatabaseSync,
  tableName: string,
): boolean {
  const row = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(tableName) as { name: string } | undefined;
  return row !== undefined;
}

export function getTableColumnNames(
  database: DatabaseSync,
  tableName: string,
): Set<string> {
  if (!tableExists(database, tableName)) {
    return new Set();
  }
  return new Set(
    (
      database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
}

export function hasAnyColumns(
  columnNames: ReadonlySet<string>,
  expectedColumnNames: readonly string[],
): boolean {
  return expectedColumnNames.some((columnName) => columnNames.has(columnName));
}

export function renameColumnIfNeeded(
  database: DatabaseSync,
  tableName: string,
  oldColumnName: string,
  newColumnName: string,
): void {
  const columnNames = getTableColumnNames(database, tableName);
  if (!columnNames.has(oldColumnName) || columnNames.has(newColumnName)) {
    return;
  }

  database.exec(
    `ALTER TABLE ${tableName} RENAME COLUMN ${oldColumnName} TO ${newColumnName}`,
  );
}
