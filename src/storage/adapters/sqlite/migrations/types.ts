import type { DatabaseSync } from "node:sqlite";

export interface SqliteMigration {
  readonly id: string;
  readonly transactional?: boolean;
  apply(database: DatabaseSync): void;
}
