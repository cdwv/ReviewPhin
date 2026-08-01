import type { HarnessResponseFormat, HarnessRunParseError } from "./types.js";

const MAX_REPORTED_ZOD_ISSUES = 8;
const MAX_ISSUE_MESSAGE_LENGTH = 200;

export interface HarnessParseErrorSummary {
  reason: HarnessRunParseError["reason"];
  message: string;
  issues: string[];
}

export function parseHarnessStructuredResponse<TParsed>(
  content: string | undefined,
  format: HarnessResponseFormat<TParsed> | undefined,
): {
  parsed?: TParsed | undefined;
  parseError?: HarnessRunParseError | undefined;
} {
  if (!format) {
    return {};
  }

  const trimmed = content?.trim();
  if (!trimmed) {
    return {
      parseError: {
        reason: "no-json",
        message: "Harness response did not contain JSON content",
      },
    };
  }

  let fallback: TParsed | null = null;
  let schemaError: HarnessRunParseError | null = null;
  const jsonParseErrors: string[] = [];
  let sawJsonObject = false;

  const parseJsonObject = (candidate: string): Record<string, unknown> | null =>
    tryParseJsonObject(candidate, (error) => {
      if (jsonParseErrors.length === 0) {
        jsonParseErrors.push(summarizeJsonParseError(error));
      }
    });

  const recordResult = (
    candidate: Record<string, unknown>,
  ): { parsed?: TParsed | undefined } => {
    sawJsonObject = true;
    const parsed = format.schema.safeParse(candidate);
    if (!parsed.success) {
      schemaError ??= {
        reason: "schema-mismatch",
        message:
          "Harness response contained JSON objects, but none matched the expected schema",
        zodIssues: parsed.error.issues,
      };
      return {};
    }

    if (!format.looksLike || format.looksLike(candidate)) {
      return {
        parsed: parsed.data,
      };
    }

    fallback ??= parsed.data;
    return {};
  };

  if (trimmed.startsWith("{")) {
    const directObject = parseJsonObject(trimmed);
    if (directObject) {
      const directResult = recordResult(directObject);
      if (directResult.parsed !== undefined) {
        return directResult;
      }
    }
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const fencedObject = parseJsonObject(fenced[1].trim());
    if (fencedObject) {
      const fencedResult = recordResult(fencedObject);
      if (fencedResult.parsed !== undefined) {
        return fencedResult;
      }
    }
  }

  const candidates = extractJsonObjectCandidates(trimmed);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate === undefined) {
      continue;
    }

    const parsed = parseJsonObject(candidate);
    if (!parsed) {
      continue;
    }

    const candidateResult = recordResult(parsed);
    if (candidateResult.parsed !== undefined) {
      return candidateResult;
    }
  }

  if (fallback !== null) {
    return {
      parsed: fallback,
    };
  }

  if (schemaError) {
    return {
      parseError: schemaError,
    };
  }

  return {
    parseError: {
      reason: sawJsonObject ? "schema-mismatch" : "no-json",
      message: sawJsonObject
        ? "Harness response contained JSON objects, but none matched the expected schema"
        : jsonParseErrors[0]
          ? `Harness response contained invalid JSON: ${jsonParseErrors[0]}`
          : "Harness response did not contain a JSON object",
    },
  };
}

export function summarizeHarnessParseError(
  error: HarnessRunParseError,
): HarnessParseErrorSummary {
  return {
    reason: error.reason,
    message: error.message,
    issues: (error.zodIssues ?? [])
      .slice(0, MAX_REPORTED_ZOD_ISSUES)
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "root";
        const message = issue.message.replace(/\s+/g, " ").trim();
        return `${path}: ${message.slice(0, MAX_ISSUE_MESSAGE_LENGTH)}`;
      }),
  };
}

function tryParseJsonObject(
  content: string,
  onParseError: (error: unknown) => void,
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    onParseError(error);
    return null;
  }
}

function summarizeJsonParseError(error: unknown): string {
  if (!(error instanceof SyntaxError)) {
    return "JSON parsing failed";
  }

  const location = error.message.match(
    /(?:position \d+|line \d+ column \d+)/gi,
  );
  return location
    ? `JSON parsing failed at ${location.join(", ")}`
    : "JSON parsing failed";
}

function extractJsonObjectCandidates(content: string): string[] {
  const candidates: string[] = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        candidates.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}
