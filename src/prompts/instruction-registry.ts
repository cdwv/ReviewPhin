import type { ProjectMemoryCoalesceInput } from "../memory/types.js";
import {
  buildStaticPromptTemplate,
  definePromptFragment,
  definePromptTemplate,
  renderPromptFragment,
} from "./instruction-helpers.js";

const promptFragments = {
  "review/main.md": definePromptFragment(),
  "review/context-analyst.md": definePromptFragment(),
  "review/review-author.md": definePromptFragment(),
  "review/first-pass-full.md": definePromptFragment(),
  "review/incremental-rereview.md": definePromptFragment(),
  "review/follow-up-thread.md": definePromptFragment(),
  "review/summary-follow-up.md": definePromptFragment(),
  "reply/chatter.md": definePromptFragment(),
  "reply/direct-mention.md": definePromptFragment(),
  "reply/summary-follow-up.md": definePromptFragment(),
  "reply/review-result.md": definePromptFragment(),
  "reply/memory-update.md": definePromptFragment(),
  "memory/coalesce.md": definePromptFragment<{
    reason: ProjectMemoryCoalesceInput["reason"];
    maxChars: number;
    targetChars: number;
    entriesJson: string;
  }>({
    render: (content, params) =>
      content
        .replaceAll("{{reason}}", params.reason)
        .replaceAll("{{maxChars}}", String(params.maxChars))
        .replaceAll("{{targetChars}}", String(params.targetChars))
        .replace("{{entriesJson}}", params.entriesJson),
  }),
} as const;

export const instructionTemplates = {
  "review.first-pass-full": buildStaticPromptTemplate(promptFragments, [
    "review/main.md",
    "review/first-pass-full.md",
  ] as const),
  "review.first-pass-full.summary-follow-up": buildStaticPromptTemplate(
    promptFragments,
    [
      "review/main.md",
      "review/first-pass-full.md",
      "review/summary-follow-up.md",
    ] as const,
  ),
  "review.incremental-rereview": buildStaticPromptTemplate(promptFragments, [
    "review/main.md",
    "review/incremental-rereview.md",
  ] as const),
  "review.incremental-rereview.summary-follow-up": buildStaticPromptTemplate(
    promptFragments,
    [
      "review/main.md",
      "review/incremental-rereview.md",
      "review/summary-follow-up.md",
    ] as const,
  ),
  "review.follow-up-thread": buildStaticPromptTemplate(promptFragments, [
    "review/main.md",
    "review/follow-up-thread.md",
  ] as const),
  "subagent.context-analyst": buildStaticPromptTemplate(promptFragments, [
    "review/context-analyst.md",
  ] as const),
  "subagent.review-author": buildStaticPromptTemplate(promptFragments, [
    "review/review-author.md",
  ] as const),
  "reply.direct-mention": buildStaticPromptTemplate(promptFragments, [
    "reply/chatter.md",
    "reply/direct-mention.md",
  ] as const),
  "reply.summary-follow-up": buildStaticPromptTemplate(promptFragments, [
    "reply/chatter.md",
    "reply/summary-follow-up.md",
  ] as const),
  "reply.direct-mention.after-review": buildStaticPromptTemplate(
    promptFragments,
    [
      "reply/chatter.md",
      "reply/direct-mention.md",
      "reply/review-result.md",
    ] as const,
  ),
  "reply.summary-follow-up.after-review": buildStaticPromptTemplate(
    promptFragments,
    [
      "reply/chatter.md",
      "reply/summary-follow-up.md",
      "reply/review-result.md",
    ] as const,
  ),
  "reply.memory-update": buildStaticPromptTemplate(promptFragments, [
    "reply/chatter.md",
    "reply/memory-update.md",
  ] as const),
  "memory.coalesce": definePromptTemplate(
    (params: ProjectMemoryCoalesceInput) =>
      renderPromptFragment(promptFragments, "memory/coalesce.md", {
        reason: params.reason,
        maxChars: params.maxChars,
        targetChars: params.targetChars,
        entriesJson: JSON.stringify(
          params.entries.map((entry) => entry.text),
          null,
          2,
        ),
      }),
  ),
} as const;
