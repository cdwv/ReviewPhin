import type { StoreValueFilter } from "../../contract/current.js";
import type { SqlValue } from "./types.js";

export function buildSqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export const WHERE_OPERATORS: Record<
  string,
  (
    filter: StoreValueFilter<unknown>,
    column: string,
  ) => { clause?: string; params?: SqlValue[] }
> = {
  isNull: (filter: StoreValueFilter<unknown>, column: string) => {
    return { clause: `${column} IS ${filter.isNull ? "" : "NOT "}NULL` };
  },
  eq: (filter: StoreValueFilter<unknown>, column: string) => {
    if (filter.eq === null) {
      return { clause: `${column} IS NULL` };
    } else {
      return { clause: `${column} = ?`, params: [toSqlValue(filter.eq)] };
    }
  },
  neq: (filter: StoreValueFilter<unknown>, column: string) => {
    if (filter.neq === null) {
      return { clause: `${column} IS NOT NULL` };
    } else {
      return { clause: `${column} != ?`, params: [toSqlValue(filter.neq)] };
    }
  },
  gte: (filter: StoreValueFilter<unknown>, column: string) => {
    return { clause: `${column} >= ?`, params: [toSqlValue(filter.gte)] };
  },
  lt: (filter: StoreValueFilter<unknown>, column: string) => {
    return { clause: `${column} < ?`, params: [toSqlValue(filter.lt)] };
  },
  in: (filter: StoreValueFilter<unknown>, column: string) => {
    if (!Array.isArray(filter.in) || filter.in.length === 0) {
      return { clause: "1 = 0" };
    } else {
      return {
        clause: `${column} IN (${buildSqlPlaceholders(filter.in.length)})`,
        params: filter.in.map(toSqlValue),
      };
    }
  },
  notIn: (filter: StoreValueFilter<unknown>, column: string) => {
    if (!Array.isArray(filter.notIn) || filter.notIn.length === 0) {
      return {};
    } else {
      return {
        clause: `${column} NOT IN (${buildSqlPlaceholders(filter.notIn.length)})`,
        params: filter.notIn.map(toSqlValue),
      };
    }
  },
};

function toSqlValue(value: unknown): SqlValue {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (
    typeof value === "number" ||
    typeof value === "string" ||
    value === null
  ) {
    return value;
  }

  throw new Error(`Unsupported SQL filter value type: ${typeof value}`);
}
