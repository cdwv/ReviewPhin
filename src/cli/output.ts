import { Writable } from "node:stream";

export const OUTPUT_MODES = ["pretty", "plain", "json"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];
export type TextStyle =
  "strong" | "heading" | "success" | "active" | "warning" | "failure" | "muted";

export interface CliOutputDependencies {
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
  readonly columns?: number;
  readonly color?: boolean;
  readonly unicode?: boolean;
  readonly now?: () => Date;
}

export interface OutputOptions {
  readonly output?: string | boolean | undefined;
  readonly json?: string | boolean | undefined;
}

export interface RenderedResult {
  readonly pretty: string | (() => string);
  readonly plain?: string | (() => string);
}

export function resolveOutputMode(options: OutputOptions): OutputMode {
  const requested = options.output;
  if (requested !== undefined && typeof requested !== "string") {
    throw new Error("--output requires one of: pretty, plain, json");
  }
  if (
    requested !== undefined &&
    !OUTPUT_MODES.includes(requested as OutputMode)
  ) {
    throw new Error(
      `Unsupported output mode: ${requested}. Choose pretty, plain, or json.`,
    );
  }

  const jsonAlias = options.json === true || options.json === "true";
  if (jsonAlias && requested !== undefined && requested !== "json") {
    throw new Error(
      `Cannot combine --json with --output ${requested}; use --output json.`,
    );
  }
  return jsonAlias
    ? "json"
    : ((requested as OutputMode | undefined) ?? "pretty");
}

export class CliOutput {
  public readonly mode: OutputMode;
  public readonly stdout: NodeJS.WritableStream;
  public readonly stderr: NodeJS.WritableStream;
  public readonly stdinIsTTY: boolean;
  public readonly stdoutIsTTY: boolean;
  public readonly columns: number;
  public readonly color: boolean;
  public readonly unicode: boolean;
  public readonly now: () => Date;

  public constructor(
    mode: OutputMode,
    dependencies: CliOutputDependencies = {},
  ) {
    this.mode = mode;
    this.stdout = dependencies.stdout ?? process.stdout;
    this.stderr = dependencies.stderr ?? process.stderr;
    this.stdinIsTTY = dependencies.stdinIsTTY ?? Boolean(process.stdin.isTTY);
    this.stdoutIsTTY =
      dependencies.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
    this.columns = Math.max(
      20,
      dependencies.columns ?? process.stdout.columns ?? 100,
    );
    this.color =
      dependencies.color ??
      (this.stdoutIsTTY && !Object.hasOwn(process.env, "NO_COLOR"));
    this.unicode = dependencies.unicode ?? true;
    this.now = dependencies.now ?? (() => new Date());
  }

  public write(text: string): void {
    this.stdout.write(ensureNewline(text));
  }

  public writeError(text: string): void {
    this.stderr.write(ensureNewline(text));
  }

  public result(value: unknown, rendered: RenderedResult): void {
    if (this.mode === "json") {
      this.stdout.write(`${JSON.stringify(value)}\n`);
      return;
    }
    const selected =
      this.mode === "plain"
        ? (rendered.plain ?? rendered.pretty)
        : rendered.pretty;
    this.write(typeof selected === "function" ? selected() : selected);
  }

  public event(
    value: { readonly type: string; readonly [key: string]: unknown },
    rendered: string | (() => string),
  ): void {
    if (this.mode === "json") {
      this.stdout.write(`${JSON.stringify(value)}\n`);
      return;
    }
    this.write(typeof rendered === "function" ? rendered() : rendered);
  }

  public error(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.mode === "json") {
      this.stderr.write(
        `${JSON.stringify({
          type: "error",
          error: {
            name: error instanceof Error ? error.name : "Error",
            message,
          },
        })}\n`,
      );
      return;
    }
    this.writeError(this.style("failure", message));
  }

  public diagnostic(
    type: "notice" | "warning",
    message: string,
    details?: unknown,
  ): void {
    if (this.mode === "json") {
      this.stderr.write(
        `${JSON.stringify({
          type,
          message,
          ...(details === undefined ? {} : { details }),
        })}\n`,
      );
      return;
    }
    this.writeError(
      this.style(
        type === "warning" ? "warning" : "active",
        `${type === "warning" ? "Warning: " : ""}${message}`,
      ),
    );
  }

  public style(semantic: TextStyle, value: string): string {
    if (this.mode !== "pretty" || !this.stdoutIsTTY) {
      return value;
    }
    const codes = {
      strong: [1],
      heading: this.color ? [1, 36] : [1],
      success: this.color ? [1, 32] : [1],
      active: this.color ? [1, 36] : [1],
      warning: this.color ? [1, 33] : [1],
      failure: this.color ? [1, 31] : [1],
      muted: [2],
    }[semantic];
    return `\u001B[${codes.join(";")}m${value}\u001B[0m`;
  }
}

export function ensureNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function formatIsoDate(value: string | null | undefined): string {
  return value ?? "~";
}

export function formatPrettyDate(value: string | null | undefined): string {
  if (!value) {
    return "~";
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  const seconds = durationMs / 1_000;
  if (seconds < 60) {
    return `${formatNumber(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function formatKeyValues(
  values: readonly (readonly [string, unknown])[],
  nullValue = "~",
  styles: {
    readonly label?: ((value: string) => string) | undefined;
    readonly value?: ((value: string, rawValue: unknown) => string) | undefined;
    readonly null?: ((value: string) => string) | undefined;
  } = {},
): string {
  return values
    .map(([label, value]) => {
      const renderedValue = formatValue(value, nullValue);
      const isNull = value === null || value === undefined || value === "";
      return `${styles.label?.(label) ?? label}: ${
        isNull
          ? (styles.null?.(renderedValue) ?? renderedValue)
          : (styles.value?.(renderedValue, value) ?? renderedValue)
      }`;
    })
    .join("\n");
}

export interface TableColumn<T> {
  readonly header: string;
  readonly value: (row: T) => unknown;
  readonly priority?: number;
  readonly minWidth?: number;
  readonly style?: ((value: string, row: T) => string) | undefined;
}

export function formatTable<T>(
  rows: readonly T[],
  columns: readonly TableColumn<T>[],
  terminalWidth = 100,
  styles: {
    readonly header?: ((value: string) => string) | undefined;
    readonly separator?: ((value: string) => string) | undefined;
  } = {},
): string {
  if (columns.length === 0) {
    return "";
  }
  const available = Math.max(20, terminalWidth);
  const selected = [...columns];
  while (selected.length > 1 && estimatedWidth(rows, selected) > available) {
    const removable = selected
      .map((column, index) => ({ column, index }))
      .filter(({ column }) => (column.priority ?? 0) > 0)
      .sort(
        (left, right) =>
          (right.column.priority ?? 0) - (left.column.priority ?? 0) ||
          right.index - left.index,
      )[0];
    if (!removable) {
      break;
    }
    selected.splice(removable.index, 1);
  }

  const gapWidth = (selected.length - 1) * 2;
  const contentWidth = Math.max(selected.length, available - gapWidth);
  const natural = selected.map((column) =>
    Math.max(
      column.minWidth ?? 3,
      column.header.length,
      ...rows.map((row) => formatTableValue(column.value(row)).length),
    ),
  );
  const widths = fitWidths(natural, selected, contentWidth);
  const header = selected
    .map((column, index) => {
      const width = widths[index] ?? 1;
      const styled = styles.header?.(column.header) ?? column.header;
      return `${styled}${" ".repeat(Math.max(0, width - column.header.length))}`;
    })
    .join("  ");
  const rawSeparator = widths.map((width) => "-".repeat(width)).join("  ");
  const separator = styles.separator?.(rawSeparator) ?? rawSeparator;
  const body = rows.flatMap((row) => {
    const cells = selected.map((column, index) =>
      wrap(formatTableValue(column.value(row)), widths[index] ?? 1),
    );
    const height = Math.max(...cells.map((cell) => cell.length));
    return Array.from({ length: height }, (_, line) =>
      cells
        .map((cell, index) => {
          const raw = cell[line] ?? "";
          const styled = selected[index]?.style?.(raw, row) ?? raw;
          return `${styled}${" ".repeat(Math.max(0, (widths[index] ?? 1) - raw.length))}`;
        })
        .join("  ")
        .trimEnd(),
    );
  });
  return [header, separator, ...body].join("\n");
}

function estimatedWidth<T>(
  rows: readonly T[],
  columns: readonly TableColumn<T>[],
): number {
  return (
    columns.reduce(
      (sum, column) =>
        sum +
        Math.max(
          column.minWidth ?? 3,
          column.header.length,
          ...rows.map((row) => formatTableValue(column.value(row)).length),
        ),
      0,
    ) +
    Math.max(0, columns.length - 1) * 2
  );
}

function fitWidths<T>(
  natural: readonly number[],
  columns: readonly TableColumn<T>[],
  available: number,
): number[] {
  const widths = [...natural];
  while (widths.reduce((sum, width) => sum + width, 0) > available) {
    const index = widths.reduce(
      (best, width, current) =>
        width > (widths[best] ?? 0) && width > (columns[current]?.minWidth ?? 3)
          ? current
          : best,
      0,
    );
    const minimum = columns[index]?.minWidth ?? 3;
    if ((widths[index] ?? 0) <= minimum) {
      break;
    }
    widths[index] = (widths[index] ?? minimum) - 1;
  }
  return widths;
}

function wrap(value: string, width: number): string[] {
  if (value.length <= width) {
    return [value];
  }
  const lines: string[] = [];
  let remaining = value;
  while (remaining.length > width) {
    let split = remaining.lastIndexOf(" ", width);
    if (split < Math.floor(width / 2)) {
      split = width;
    }
    lines.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  lines.push(remaining);
  return lines;
}

function formatValue(value: unknown, nullValue = "~"): string {
  if (value === null || value === undefined || value === "") {
    return nullValue;
  }
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  if (typeof value === "number") {
    return formatNumber(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return "~";
}

function formatTableValue(value: unknown): string {
  return value === "" ? "" : formatValue(value);
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d*[1-9])0+$/, "$1");
}

export function createStringWriter(onWrite: (text: string) => void): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      onWrite(Buffer.from(chunk).toString("utf8"));
      callback();
    },
  });
}
