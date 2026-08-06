#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, "..");
const REFERENCE_DIR = join(SKILL_DIR, "references");
const TEMPLATE_PATH = join(SKILL_DIR, "assets", "report-template.html");
const REPORT_DIRECTORY_NAME = "benchmark-report";
const DEFAULT_MODES = ["review", "first-pass-full", "incremental-rereview"];
const CATEGORY_NAMES = [
  "noobFriendliness",
  "unjargonity",
  "readability",
  "importance",
  "targeting",
  "assessmentScope",
  "groundedness",
];
const REPORT_DIMENSIONS = [
  {
    key: "noobFriendliness",
    label: "Noob friendliness",
    shortLabel: "Newcomer",
    color: "#3155d9",
    description: "Can a programmer new to the project understand the review?",
  },
  {
    key: "unjargonity",
    label: "Unjargonity",
    shortLabel: "Plain language",
    color: "#7a55c5",
    description: "Does the response prefer precise simple language?",
  },
  {
    key: "readability",
    label: "Readability",
    shortLabel: "Readability",
    color: "#b34872",
    description:
      "Are sentences, paragraphs, and information order easy to scan?",
  },
  {
    key: "importance",
    label: "Importance",
    shortLabel: "Importance",
    color: "#d16d3f",
    description: "Do emitted findings provide material engineering value?",
  },
  {
    key: "targeting",
    label: "Targeting",
    shortLabel: "Targeting",
    color: "#b7891d",
    description: "Are anchors and replacement suggestions chosen well?",
  },
  {
    key: "assessmentScope",
    label: "Assessment scope",
    shortLabel: "Whole review",
    color: "#3d8266",
    description: "Does the overview represent the complete current PR or MR?",
  },
  {
    key: "groundedness",
    label: "Groundedness",
    shortLabel: "Evidence",
    color: "#177b8f",
    description: "Are claims supported by evidence recorded in the run?",
  },
];

function printHelp() {
  process.stdout.write(`Review quality benchmark\n\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(
    `  prepare --from <date> --to <date> [--db <path>] [--logs <path>] [--workspace <path>] [--modes <csv>] [--judge-model <id>] [--force]\n`,
  );
  process.stdout.write(
    `  store --file <assessment.json> [--workspace <path>]\n`,
  );
  process.stdout.write(
    `  render [--workspace <path>] [--output-name <file.html>]\n`,
  );
  process.stdout.write(`  help\n\n`);
  process.stdout.write(`Defaults:\n`);
  process.stdout.write(`  database: data/review-worker.sqlite\n`);
  process.stdout.write(`  logs: data/run-logs\n`);
  process.stdout.write(`  workspace: current directory\n`);
  process.stdout.write(`  modes: ${DEFAULT_MODES.join(",")}\n`);
  process.stdout.write(`  generated state: benchmark-report/\n`);
}

function parseArguments(argv) {
  const [command = "help", ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { command, options };
}

function requireString(options, key) {
  const value = options[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required --${key} value.`);
  }
  return value.trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
    .join(",")}}`;
}

function readUtf8(path) {
  return readFileSync(path, "utf8");
}

function readJson(path) {
  return JSON.parse(readUtf8(path));
}

function parseJson(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readReviewPhinVersion(runDirectory) {
  const appLogPath = join(runDirectory, "app.ndjson");
  if (!existsSync(appLogPath)) return null;
  try {
    for (const line of readUtf8(appLogPath).split(/\r?\n/u)) {
      if (line.trim() === "") continue;
      const entry = parseJson(line, null);
      const value = entry?.data?.reviewPhinVersion;
      if (typeof value === "string" && value.trim() !== "") {
        return value.trim();
      }
    }
  } catch {
    return null;
  }
  return null;
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function atomicWrite(path, contents) {
  ensureDirectory(dirname(path));
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, contents, "utf8");
  renameSync(temporaryPath, path);
}

function assertInside(parent, child) {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  if (
    resolvedChild !== resolvedParent &&
    !resolvedChild.startsWith(`${resolvedParent}${sep}`)
  ) {
    throw new Error(
      `Refusing to operate outside ${resolvedParent}: ${resolvedChild}`,
    );
  }
}

function replaceDirectory(parent, path) {
  assertInside(parent, path);
  rmSync(path, { recursive: true, force: true });
  ensureDirectory(path);
}

function resolveWorkspace(options) {
  return resolve(
    typeof options.workspace === "string" ? options.workspace : process.cwd(),
  );
}

function workspacePaths(options) {
  const workspace = resolveWorkspace(options);
  const reportRoot = join(workspace, REPORT_DIRECTORY_NAME);
  return {
    workspace,
    reportRoot,
    cachePath: join(reportRoot, "cache.sqlite"),
    manifestPath: join(reportRoot, "tmp", "manifest.json"),
    packetsDirectory: join(reportRoot, "tmp", "packets"),
    assessmentsDirectory: join(reportRoot, "tmp", "assessments"),
    reportsDirectory: join(reportRoot, "reports"),
  };
}

function parseRangeBoundary(value, isEnd) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value);
  const parsed = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
  if (!isEnd) return parsed.toISOString();
  const increment = dateOnly ? 24 * 60 * 60 * 1000 : 1;
  return new Date(parsed.getTime() + increment).toISOString();
}

function rangeSlug(value) {
  return value.replace(/[^0-9A-Za-z_-]+/gu, "-").replace(/-+$/u, "");
}

function openCache(path) {
  ensureDirectory(dirname(path));
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS assessments (
      run_id TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      evaluator_version TEXT NOT NULL,
      judge_model TEXT NOT NULL,
      assessed_at TEXT NOT NULL,
      assessment_json TEXT NOT NULL,
      PRIMARY KEY (run_id, input_digest, evaluator_version, judge_model)
    );
    CREATE INDEX IF NOT EXISTS assessments_run_id_idx
      ON assessments (run_id);
  `);
  return database;
}

function evaluatorVersion() {
  const resources = [
    readUtf8(join(REFERENCE_DIR, "rubric.md")),
    readUtf8(join(REFERENCE_DIR, "judge-prompt.md")),
    readUtf8(join(REFERENCE_DIR, "assessment-schema.json")),
  ];
  return sha256(resources.join("\n---review-quality-resource---\n"));
}

function listSessionFiles(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  const visit = (path, depth) => {
    if (depth > 6) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child, depth + 1);
      if (entry.isFile() && entry.name === "session.json") found.push(child);
    }
  };
  visit(directory, 0);
  return found.sort((left, right) => {
    const leftReviewer = /[\\/]reviewer[\\/]/u.test(left) ? 1 : 0;
    const rightReviewer = /[\\/]reviewer[\\/]/u.test(right) ? 1 : 0;
    if (leftReviewer !== rightReviewer) return rightReviewer - leftReviewer;
    return statSync(right).size - statSync(left).size;
  });
}

function extractAgentInstructions(content) {
  if (typeof content !== "string") return "";
  const match = content.match(
    /<agent_instructions>([\s\S]*?)<\/agent_instructions>/u,
  );
  return match?.[1]?.trim() ?? "";
}

function eventResultText(event) {
  const candidates = [
    event?.data?.result?.content,
    event?.data?.result?.detailedContent,
    event?.data?.content,
  ];
  return candidates.find((value) => typeof value === "string") ?? "";
}

function truncateText(value, maximum) {
  if (typeof value !== "string") return "";
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}\n[…truncated ${value.length - maximum} characters]`;
}

function tokenizeEvidence(findings, changedFiles, result) {
  const terms = new Set();
  const addTerm = (term) => {
    const normalized = String(term ?? "").trim();
    if (normalized.length >= 4 && normalized.length <= 100)
      terms.add(normalized);
  };
  for (const finding of findings) {
    const anchor = parseJson(finding.anchor_json, finding.anchor ?? null);
    if (anchor?.path) {
      addTerm(anchor.path);
      addTerm(anchor.path.split(/[\\/]/u).at(-1));
    }
    for (const match of `${finding.title ?? ""}\n${finding.body ?? ""}`.matchAll(
      /`([^`\n]{2,100})`/gu,
    )) {
      addTerm(match[1]);
    }
    for (const word of `${finding.title ?? ""}`.match(/[\p{L}\p{N}_-]{6,}/gu) ??
      []) {
      addTerm(word);
    }
  }
  for (const change of changedFiles.slice(0, 250)) {
    const path = change.newPath ?? change.oldPath ?? change.path;
    if (path) addTerm(path.split(/[\\/]/u).at(-1));
  }
  const summary = result?.overview?.summary ?? "";
  for (const word of summary.match(/[\p{L}\p{N}_-]{7,}/gu) ?? []) addTerm(word);
  return [...terms].slice(0, 400);
}

function summarizeSessions(runDirectory, logsRoot, terms) {
  const paths = listSessionFiles(runDirectory);
  if (paths.length === 0) {
    return {
      available: false,
      promptFingerprint: null,
      sessions: [],
      inspectionEvidence: [],
    };
  }

  const sessions = [];
  const evidenceCandidates = [];
  let promptFingerprint = null;

  for (const path of paths.slice(0, 3)) {
    let session;
    try {
      session = readJson(path);
    } catch {
      continue;
    }
    const events = Array.isArray(session.events) ? session.events : [];
    const eventCounts = {};
    for (const event of events) {
      const type = String(event?.type ?? "unknown");
      eventCounts[type] = (eventCounts[type] ?? 0) + 1;
    }
    const systemContent = events.find(
      (event) => event?.type === "system.message",
    )?.data?.content;
    const agentInstructions = extractAgentInstructions(systemContent);
    const currentFingerprint = agentInstructions
      ? sha256(agentInstructions).slice(0, 16)
      : null;
    promptFingerprint ??= currentFingerprint;

    const calls = events
      .filter(
        (event) =>
          event?.type === "tool.execution_start" ||
          event?.type === "external_tool.requested",
      )
      .slice(0, 250)
      .map((event) => ({
        type: event.type,
        toolCallId: event?.data?.toolCallId ?? event?.data?.id ?? null,
        detail: truncateText(
          canonicalStringify(
            Object.fromEntries(
              Object.entries(event?.data ?? {}).filter(
                ([key]) => !["interactionId", "turnId", "model"].includes(key),
              ),
            ),
          ),
          1800,
        ),
      }));

    for (const event of events) {
      if (
        event?.type !== "tool.execution_complete" &&
        event?.type !== "external_tool.completed"
      ) {
        continue;
      }
      const text = eventResultText(event);
      if (!text) continue;
      const lower = text.toLocaleLowerCase();
      let relevance = 0;
      for (const term of terms) {
        if (lower.includes(term.toLocaleLowerCase())) {
          relevance += term.includes("/") || term.includes("\\") ? 8 : 2;
        }
      }
      if (/\[git_readonly operation=(diff|view|show|blame)/u.test(text)) {
        relevance += 3;
      }
      evidenceCandidates.push({
        relevance,
        sessionPath: relative(logsRoot, path).replaceAll("\\", "/"),
        toolCallId: event?.data?.toolCallId ?? null,
        content: text,
      });
    }

    sessions.push({
      path: relative(logsRoot, path).replaceAll("\\", "/"),
      startedAt: session.startedAt ?? null,
      finishedAt: session.finishedAt ?? null,
      prompt: truncateText(session.prompt ?? "", 12_000),
      response: truncateText(
        typeof session.response === "string"
          ? session.response
          : canonicalStringify(session.response ?? null),
        20_000,
      ),
      promptFingerprint: currentFingerprint,
      eventCounts,
      calls,
    });
  }

  evidenceCandidates.sort(
    (left, right) =>
      right.relevance - left.relevance ||
      right.content.length - left.content.length,
  );
  const inspectionEvidence = [];
  let totalCharacters = 0;
  for (const candidate of evidenceCandidates) {
    if (inspectionEvidence.length >= 20 || totalCharacters >= 120_000) break;
    const content = truncateText(candidate.content, 14_000);
    if (totalCharacters + content.length > 120_000) continue;
    inspectionEvidence.push({ ...candidate, content });
    totalCharacters += content.length;
  }

  return {
    available: sessions.length > 0,
    promptFingerprint,
    sessions,
    inspectionEvidence,
  };
}

function cleanProse(value) {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/gu, " code block ")
    .replace(/`[^`\n]+`/gu, " identifier ")
    .replace(/https?:\/\/\S+/gu, " link ")
    .replace(/^\s*[-*+]\s+/gmu, "")
    .replace(/^\s*#{1,6}\s+/gmu, "")
    .trim();
}

function countWords(value) {
  return value.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function summarizeTextMetrics(result, findings) {
  const overview = result?.overview ?? {};
  const texts = [
    overview.summary,
    overview.overallAssessment,
    overview.mergeReadiness?.summary,
    ...findings.flatMap((finding) => [finding.title, finding.body]),
  ]
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .map(cleanProse);
  const combined = texts.join("\n\n");
  const paragraphs = combined.split(/\n\s*\n/gu).filter(Boolean);
  const sentences = combined
    .split(/(?<=[.!?])\s+|\n+/gu)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const sentenceWords = sentences.map(countWords);
  const paragraphWords = paragraphs.map(countWords);
  const average = (values) =>
    values.length === 0
      ? 0
      : Math.round(
          (values.reduce((sum, value) => sum + value, 0) / values.length) * 10,
        ) / 10;
  return {
    totalWords: countWords(combined),
    sentenceCount: sentences.length,
    averageSentenceWords: average(sentenceWords),
    longestSentenceWords: Math.max(0, ...sentenceWords),
    paragraphCount: paragraphs.length,
    averageParagraphWords: average(paragraphWords),
    longestParagraphWords: Math.max(0, ...paragraphWords),
  };
}

function selectRuns(source, fromInclusive, toExclusive, modes) {
  const placeholders = modes.map(() => "?").join(", ");
  return source
    .prepare(
      `SELECT
         r.id,
         r.interaction_job_id,
         r.tenant_id,
         r.provider,
         r.model,
         r.status,
         r.result_json,
         r.error,
         r.started_at,
         r.finished_at,
         r.model_profile_name,
         r.provider_type,
         r.text_generation_model,
         j.code_review_id,
         j.trigger_json,
         j.head_sha,
         t.tenant_key,
         t.platform,
         (
           SELECT m.prompt_mode
           FROM interaction_run_metrics m
           WHERE m.interaction_run_id = r.id
             AND m.prompt_mode IN (${placeholders})
           ORDER BY m.created_at ASC
           LIMIT 1
         ) AS prompt_mode
       FROM interaction_runs r
       JOIN interaction_jobs j ON j.id = r.interaction_job_id
       JOIN tenants t ON t.id = r.tenant_id
       WHERE r.status = 'completed'
         AND r.started_at >= ?
         AND r.started_at < ?
         AND EXISTS (
           SELECT 1
           FROM interaction_run_metrics m
           WHERE m.interaction_run_id = r.id
             AND m.prompt_mode IN (${placeholders})
         )
       ORDER BY r.started_at ASC, r.id ASC`,
    )
    .all(...modes, fromInclusive, toExclusive, ...modes);
}

function loadSnapshot(source, run) {
  const direct = source
    .prepare(
      `SELECT * FROM code_review_snapshots
       WHERE interaction_run_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(run.id);
  if (direct) return direct;
  return (
    source
      .prepare(
        `SELECT * FROM code_review_snapshots
         WHERE interaction_job_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(run.interaction_job_id) ?? null
  );
}

function loadFindings(source, runId) {
  return source
    .prepare(
      `SELECT id, identity_key, severity, category, title, body,
              anchor_json, suggestion_json, status, created_at
       FROM review_findings
       WHERE interaction_run_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(runId);
}

function loadMetrics(source, runId) {
  return source
    .prepare(
      `SELECT harness, harness_session_key, session_type, trigger_kind,
              prompt_mode, prompt_chars, prompt_context_changed_files,
              prompt_context_prior_discussions, prompt_context_comments,
              assistant_turns, assistant_calls, tool_executions,
              view_tool_calls, glob_tool_calls, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, reasoning_tokens,
              api_duration_ms, usage_unit, usage_amount, repeated_view_reads,
              repeated_view_paths_json
       FROM interaction_run_metrics
       WHERE interaction_run_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(runId)
    .map((metric) => ({
      ...metric,
      repeated_view_paths: parseJson(metric.repeated_view_paths_json, []),
      repeated_view_paths_json: undefined,
    }));
}

function buildPacket(source, run, logsRoot, identity) {
  const snapshot = loadSnapshot(source, run);
  const findings = loadFindings(source, run.id);
  const metrics = loadMetrics(source, run.id);
  const result = parseJson(run.result_json, null);
  const changedFiles = parseJson(snapshot?.changes_json, []);
  const terms = tokenizeEvidence(findings, changedFiles, result);
  const sessions = summarizeSessions(join(logsRoot, run.id), logsRoot, terms);
  const reviewPhinVersion = readReviewPhinVersion(join(logsRoot, run.id));
  const normalizedFindings = findings.map((finding) => ({
    id: finding.id,
    identityKey: finding.identity_key,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    body: finding.body,
    anchor: parseJson(finding.anchor_json, null),
    suggestion: parseJson(finding.suggestion_json, null),
    status: finding.status,
    createdAt: finding.created_at,
  }));
  const evidence = {
    run: {
      id: run.id,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      provider: run.provider,
      model: run.model,
      providerType: run.provider_type,
      modelProfileName: run.model_profile_name,
      textGenerationModel: run.text_generation_model,
      promptMode: run.prompt_mode,
      reviewPhinVersion,
      trigger: parseJson(run.trigger_json, null),
    },
    codeReview: {
      id: run.code_review_id,
      tenantKey: run.tenant_key,
      platform: run.platform,
      headSha: run.head_sha,
      details: parseJson(snapshot?.code_review_json, null),
      versions: parseJson(snapshot?.versions_json, null),
      changedFiles,
      comments: parseJson(snapshot?.comments_json, []),
      discussions: parseJson(snapshot?.discussions_json, []),
      instructions: parseJson(snapshot?.instructions_json, []),
      projectMemory: parseJson(snapshot?.project_memory_json, null),
    },
    reviewOutput: {
      result,
      findings: normalizedFindings,
    },
    metrics,
    textMetrics: summarizeTextMetrics(result, normalizedFindings),
    sessionEvidence: sessions,
  };
  const inputDigest = sha256(canonicalStringify(evidence));
  return {
    schemaVersion: 1,
    runId: run.id,
    inputDigest,
    evaluatorVersion: identity.evaluatorVersion,
    judgeModel: identity.judgeModel,
    evidence,
  };
}

function cacheContains(cache, packet) {
  return Boolean(
    cache
      .prepare(
        `SELECT 1 FROM assessments
         WHERE run_id = ? AND input_digest = ?
           AND evaluator_version = ? AND judge_model = ?`,
      )
      .get(
        packet.runId,
        packet.inputDigest,
        packet.evaluatorVersion,
        packet.judgeModel,
      ),
  );
}

function prepare(options) {
  const paths = workspacePaths(options);
  const fromInput = requireString(options, "from");
  const toInput = requireString(options, "to");
  const fromInclusive = parseRangeBoundary(fromInput, false);
  const toExclusive = parseRangeBoundary(toInput, true);
  if (fromInclusive >= toExclusive) {
    throw new Error("The --from boundary must be earlier than --to.");
  }
  const databasePath = resolve(
    paths.workspace,
    typeof options.db === "string" ? options.db : "data/review-worker.sqlite",
  );
  const logsRoot = resolve(
    paths.workspace,
    typeof options.logs === "string" ? options.logs : "data/run-logs",
  );
  if (!existsSync(databasePath))
    throw new Error(`Database not found: ${databasePath}`);
  if (!existsSync(logsRoot)) throw new Error(`Run logs not found: ${logsRoot}`);
  const modes = (
    typeof options.modes === "string" ? options.modes.split(",") : DEFAULT_MODES
  )
    .map((mode) => mode.trim())
    .filter(Boolean);
  if (modes.length === 0)
    throw new Error("At least one prompt mode is required.");
  const judgeModel =
    typeof options["judge-model"] === "string"
      ? options["judge-model"].trim()
      : "codex-current";
  const identity = { evaluatorVersion: evaluatorVersion(), judgeModel };

  ensureDirectory(paths.reportRoot);
  replaceDirectory(paths.reportRoot, paths.packetsDirectory);
  replaceDirectory(paths.reportRoot, paths.assessmentsDirectory);
  ensureDirectory(paths.reportsDirectory);

  const source = new DatabaseSync(databasePath, { readOnly: true });
  const cache = openCache(paths.cachePath);
  let runs;
  try {
    runs = selectRuns(source, fromInclusive, toExclusive, modes);
    const selectedRuns = [];
    const cachedRuns = [];
    const pendingRuns = [];
    for (const run of runs) {
      const packet = buildPacket(source, run, logsRoot, identity);
      const packetPath = join(paths.packetsDirectory, `${run.id}.json`);
      atomicWrite(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
      const cached =
        options.force === true ? false : cacheContains(cache, packet);
      const title =
        packet.evidence.codeReview.details?.title ??
        `Code review ${packet.evidence.codeReview.id}`;
      const summary = {
        runId: run.id,
        inputDigest: packet.inputDigest,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        codeReviewId: run.code_review_id,
        title,
        tenantKey: run.tenant_key,
        platform: run.platform,
        promptMode: run.prompt_mode,
        reviewPhinVersion: packet.evidence.run.reviewPhinVersion,
        reviewModel: run.model,
        promptFingerprint: packet.evidence.sessionEvidence.promptFingerprint,
        findingCount: packet.evidence.reviewOutput.findings.length,
        changedFileCount: packet.evidence.codeReview.changedFiles.length,
        packetPath: relative(paths.workspace, packetPath).replaceAll("\\", "/"),
      };
      selectedRuns.push(summary);
      (cached ? cachedRuns : pendingRuns).push(run.id);
    }
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      workspace: paths.workspace,
      databasePath,
      logsRoot,
      reportRoot: paths.reportRoot,
      range: {
        fromInput,
        toInput,
        fromInclusive,
        toExclusive,
        slug: `${rangeSlug(fromInput)}--${rangeSlug(toInput)}`,
      },
      modes,
      judgeModel,
      evaluatorVersion: identity.evaluatorVersion,
      force: options.force === true,
      selectedRuns,
      cachedRuns,
      pendingRuns,
    };
    atomicWrite(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify(
        {
          manifest: relative(paths.workspace, paths.manifestPath).replaceAll(
            "\\",
            "/",
          ),
          selected: selectedRuns.length,
          cached: cachedRuns.length,
          pending: pendingRuns.length,
          pendingRuns,
          evaluatorVersion: identity.evaluatorVersion,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    source.close();
    cache.close();
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertIntegerScore(value, label, nullable = false) {
  assertPlainObject(value, label);
  if (value.score === null && nullable) {
    if (typeof value.reason !== "string" || value.reason.trim() === "") {
      throw new Error(`${label}.reason must be a non-empty string.`);
    }
    return;
  }
  if (!Number.isInteger(value.score) || value.score < 0 || value.score > 10) {
    throw new Error(`${label}.score must be an integer from 0 through 10.`);
  }
  if (typeof value.reason !== "string" || value.reason.trim() === "") {
    throw new Error(`${label}.reason must be a non-empty string.`);
  }
}

function assertStringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.length > 5 ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error(`${label} must contain at most five non-empty strings.`);
  }
}

function validateAssessment(assessment, packet) {
  assertPlainObject(assessment, "assessment");
  if (assessment.schemaVersion !== 1)
    throw new Error("schemaVersion must be 1.");
  for (const key of [
    "runId",
    "inputDigest",
    "evaluatorVersion",
    "judgeModel",
  ]) {
    if (assessment[key] !== packet[key]) {
      throw new Error(`${key} does not match the prepared packet.`);
    }
  }
  assertPlainObject(assessment.categories, "categories");
  for (const category of CATEGORY_NAMES) {
    assertIntegerScore(
      assessment.categories[category],
      `categories.${category}`,
      category === "importance" || category === "targeting",
    );
  }
  assertStringArray(assessment.strengths, "strengths");
  assertStringArray(assessment.weaknesses, "weaknesses");
  if (!Array.isArray(assessment.findings)) {
    throw new Error("findings must be an array.");
  }
  const expectedFindings = packet.evidence.reviewOutput.findings;
  const expectedIds = new Set(expectedFindings.map((finding) => finding.id));
  const actualIds = new Set();
  for (const [index, finding] of assessment.findings.entries()) {
    const label = `findings[${index}]`;
    assertPlainObject(finding, label);
    if (
      !expectedIds.has(finding.findingId) ||
      actualIds.has(finding.findingId)
    ) {
      throw new Error(
        `${label}.findingId is missing, unexpected, or duplicated.`,
      );
    }
    actualIds.add(finding.findingId);
    if (
      !Number.isInteger(finding.importance) ||
      finding.importance < 0 ||
      finding.importance > 10
    ) {
      throw new Error(
        `${label}.importance must be an integer from 0 through 10.`,
      );
    }
    if (
      !Number.isInteger(finding.groundedness) ||
      finding.groundedness < 0 ||
      finding.groundedness > 10
    ) {
      throw new Error(
        `${label}.groundedness must be an integer from 0 through 10.`,
      );
    }
    if (typeof finding.reason !== "string" || finding.reason.trim() === "") {
      throw new Error(`${label}.reason must be a non-empty string.`);
    }
    assertPlainObject(finding.targeting, `${label}.targeting`);
    if (
      !Number.isInteger(finding.targeting.score) ||
      finding.targeting.score < 0 ||
      finding.targeting.score > 10
    ) {
      throw new Error(
        `${label}.targeting.score must be an integer from 0 through 10.`,
      );
    }
    for (const key of [
      "anchorExpected",
      "anchorPresent",
      "suggestionExpected",
      "suggestionPresent",
    ]) {
      if (typeof finding.targeting[key] !== "boolean") {
        throw new Error(`${label}.targeting.${key} must be boolean.`);
      }
    }
    for (const key of ["anchorQuality", "suggestionQuality"]) {
      if (
        typeof finding.targeting[key] !== "string" ||
        finding.targeting[key].trim() === ""
      ) {
        throw new Error(
          `${label}.targeting.${key} must be a non-empty string.`,
        );
      }
    }
  }
  if (actualIds.size !== expectedIds.size) {
    throw new Error(
      "Assessment must contain exactly one entry for every emitted finding.",
    );
  }
  if (expectedIds.size === 0) {
    if (
      assessment.categories.importance.score !== null ||
      assessment.categories.targeting.score !== null
    ) {
      throw new Error(
        "Runs without findings require null importance and targeting scores.",
      );
    }
  } else {
    if (
      assessment.categories.importance.score === null ||
      assessment.categories.targeting.score === null
    ) {
      throw new Error(
        "Runs with findings require numeric importance and targeting scores.",
      );
    }
    const roundedImportance = Math.round(
      assessment.findings.reduce(
        (sum, finding) => sum + finding.importance,
        0,
      ) / assessment.findings.length,
    );
    const roundedTargeting = Math.round(
      assessment.findings.reduce(
        (sum, finding) => sum + finding.targeting.score,
        0,
      ) / assessment.findings.length,
    );
    if (assessment.categories.importance.score !== roundedImportance) {
      throw new Error(
        `Run importance must equal rounded per-finding average (${roundedImportance}).`,
      );
    }
    if (assessment.categories.targeting.score !== roundedTargeting) {
      throw new Error(
        `Run targeting must equal rounded per-finding average (${roundedTargeting}).`,
      );
    }
  }
}

function store(options) {
  const paths = workspacePaths(options);
  const file = resolve(paths.workspace, requireString(options, "file"));
  assertInside(paths.reportRoot, file);
  if (!existsSync(file)) throw new Error(`Assessment file not found: ${file}`);
  if (!existsSync(paths.manifestPath)) {
    throw new Error("Prepare a benchmark period before storing assessments.");
  }
  const assessment = readJson(file);
  const packetPath = join(paths.packetsDirectory, `${assessment.runId}.json`);
  if (!existsSync(packetPath)) {
    throw new Error(`Prepared packet not found for ${assessment.runId}.`);
  }
  const packet = readJson(packetPath);
  validateAssessment(assessment, packet);
  const cache = openCache(paths.cachePath);
  try {
    cache
      .prepare(
        `INSERT OR REPLACE INTO assessments (
           run_id, input_digest, evaluator_version, judge_model,
           assessed_at, assessment_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        assessment.runId,
        assessment.inputDigest,
        assessment.evaluatorVersion,
        assessment.judgeModel,
        new Date().toISOString(),
        JSON.stringify(assessment),
      );
  } finally {
    cache.close();
  }
  process.stdout.write(
    `${JSON.stringify({ stored: assessment.runId, cache: relative(paths.workspace, paths.cachePath).replaceAll("\\", "/") }, null, 2)}\n`,
  );
}

function loadCachedAssessment(cache, selected, manifest) {
  const row = cache
    .prepare(
      `SELECT assessment_json, assessed_at
       FROM assessments
       WHERE run_id = ? AND input_digest = ?
         AND evaluator_version = ? AND judge_model = ?`,
    )
    .get(
      selected.runId,
      selected.inputDigest,
      manifest.evaluatorVersion,
      manifest.judgeModel,
    );
  if (!row) return null;
  return {
    assessment: JSON.parse(row.assessment_json),
    assessedAt: row.assessed_at,
  };
}

function escapeEmbeddedJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function render(options) {
  const paths = workspacePaths(options);
  if (!existsSync(paths.manifestPath)) {
    throw new Error("Prepare a benchmark period before rendering.");
  }
  if (!existsSync(TEMPLATE_PATH))
    throw new Error(`Template not found: ${TEMPLATE_PATH}`);
  const manifest = readJson(paths.manifestPath);
  const cache = openCache(paths.cachePath);
  const reportRuns = [];
  const missingRuns = [];
  try {
    for (const selected of manifest.selectedRuns) {
      const cached = loadCachedAssessment(cache, selected, manifest);
      if (!cached) {
        missingRuns.push(selected.runId);
        continue;
      }
      const packetPath = join(paths.packetsDirectory, `${selected.runId}.json`);
      const packet = existsSync(packetPath) ? readJson(packetPath) : null;
      reportRuns.push({
        ...selected,
        assessedAt: cached.assessedAt,
        categories: cached.assessment.categories,
        findingAssessments: cached.assessment.findings,
        strengths: cached.assessment.strengths,
        weaknesses: cached.assessment.weaknesses,
        findings:
          packet?.evidence?.reviewOutput?.findings?.map((finding) => ({
            id: finding.id,
            title: finding.title,
            severity: finding.severity,
            category: finding.category,
            anchor: finding.anchor,
            suggestion: finding.suggestion,
          })) ?? [],
        textMetrics: packet?.evidence?.textMetrics ?? null,
      });
    }
  } finally {
    cache.close();
  }

  const cachedAtPrepare = new Set(manifest.cachedRuns);
  const data = {
    schemaVersion: 1,
    metadata: {
      title: "Review quality benchmark",
      generatedAt: new Date().toISOString(),
      range: manifest.range,
      modes: manifest.modes,
      judgeModel: manifest.judgeModel,
      evaluatorVersion: manifest.evaluatorVersion,
      selectedCount: manifest.selectedRuns.length,
      scoredCount: reportRuns.length,
      missingCount: missingRuns.length,
      cacheReuseCount: reportRuns.filter((run) =>
        cachedAtPrepare.has(run.runId),
      ).length,
      newlyAssessedCount: reportRuns.filter(
        (run) => !cachedAtPrepare.has(run.runId),
      ).length,
      missingRuns,
    },
    dimensions: REPORT_DIMENSIONS,
    runs: reportRuns,
  };
  const template = readUtf8(TEMPLATE_PATH);
  const marker = "__REVIEW_BENCHMARK_DATA__";
  const markerCount = template.split(marker).length - 1;
  if (markerCount !== 1) {
    throw new Error(
      `Report template must contain exactly one ${marker} marker.`,
    );
  }
  const html = template.replace(marker, escapeEmbeddedJson(data));
  const outputName =
    typeof options["output-name"] === "string"
      ? options["output-name"]
      : `review-quality-${manifest.range.slug}.html`;
  if (!/^[A-Za-z0-9._-]+\.html$/u.test(outputName)) {
    throw new Error("--output-name must be a simple .html filename.");
  }
  const outputPath = join(paths.reportsDirectory, outputName);
  assertInside(paths.reportRoot, outputPath);
  atomicWrite(outputPath, html);
  process.stdout.write(
    `${JSON.stringify(
      {
        report: relative(paths.workspace, outputPath).replaceAll("\\", "/"),
        selected: manifest.selectedRuns.length,
        scored: reportRuns.length,
        missing: missingRuns.length,
        cacheReused: data.metadata.cacheReuseCount,
        newlyAssessed: data.metadata.newlyAssessedCount,
        missingRuns,
      },
      null,
      2,
    )}\n`,
  );
}

function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "prepare") {
    prepare(options);
    return;
  }
  if (command === "store") {
    store(options);
    return;
  }
  if (command === "render") {
    render(options);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `review-quality-benchmark: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
