import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { HarnessSessionRuntime } from "../src/harness/session.js";
import type { HarnessSubagentId } from "../src/harness/types.js";

// Opt in: starts the bundled CLI, but all model requests go to loopback.
it.skipIf(process.env.REVIEWPHIN_CLI_TESTS !== "1")(
  "delivers shared and dedicated instructions and activates skills in each review role",
  async () => {
    const root = await mkdtemp(
      join(tmpdir(), "reviewphin-cli-customizations-"),
    );
    const workspace = join(root, "repo");
    await mkdir(join(workspace, ".reviewphin/skills/probe/references"), {
      recursive: true,
    });
    await mkdir(join(workspace, ".reviewphin/instructions/nested"), {
      recursive: true,
    });
    await mkdir(join(workspace, ".github/instructions"), { recursive: true });
    await mkdir(join(workspace, ".github/skills/unrelated"), {
      recursive: true,
    });
    await mkdir(join(workspace, "src"));
    execFileSync("git", ["init", "--quiet", workspace]);
    const contents: Record<string, string> = {
      "AGENTS.md": "SHARED_ROOT_SENTINEL",
      ".github/skills/unrelated/SKILL.md":
        "---\nname: unrelated\ndescription: UNRELATED_SKILL_SENTINEL\n---\nUnrelated skill",
      ".github/copilot-instructions.md": "SHARED_COPILOT_SENTINEL",
      ".github/instructions/shared.instructions.md":
        '---\napplyTo: "**"\n---\nSHARED_MODULAR_SENTINEL',
      ".reviewphin/AGENTS.md": "DEDICATED_ROOT_SENTINEL",
      ".reviewphin/instructions/nested/all.instructions.md":
        '---\napplyTo: "**"\n---\nDEDICATED_MODULAR_SENTINEL',
      ".reviewphin/instructions/types.instructions.md":
        '---\napplyTo: "**/*.ts"\n---\nMATCHING_TYPES_SENTINEL',
      ".reviewphin/instructions/python.instructions.md":
        '---\napplyTo: "**/*.py"\n---\nNONMATCHING_PYTHON_SENTINEL',
      ".reviewphin/skills/probe/SKILL.md":
        "---\nname: probe\ndescription: SKILL_CATALOG_SENTINEL\n---\nSKILL_BODY_SENTINEL. Read references/checklist.md.",
      ".reviewphin/skills/probe/references/checklist.md":
        "SKILL_REFERENCE_SENTINEL",
      "src/probe.ts": "export const value = 1;",
    };
    for (const [path, content] of Object.entries(contents))
      await writeFile(join(workspace, path), content);
    let requests: string[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        if (request.method !== "POST") {
          response.writeHead(404).end();
          return;
        }
        requests.push(raw);
        const actions = [
          { name: "skill", arguments: JSON.stringify({ skill: "probe" }) },
          {
            name: "view",
            arguments: JSON.stringify({
              path: join(
                workspace,
                ".reviewphin/skills/probe/references/checklist.md",
              ),
            }),
          },
          {
            name: "view",
            arguments: JSON.stringify({
              path: join(workspace, "src/probe.ts"),
            }),
          },
        ];
        const action = actions[requests.length - 1];
        if (request.url?.endsWith("/responses")) {
          const result = {
            id: `resp_${requests.length}`,
            object: "response",
            created_at: 1,
            status: "completed",
            model: "probe-model",
            output: action
              ? [
                  {
                    type: "function_call",
                    id: `fc_${requests.length}`,
                    call_id: `call_${requests.length}`,
                    name: action.name,
                    arguments: action.arguments,
                    status: "completed",
                  },
                ]
              : [
                  {
                    type: "message",
                    id: "msg_done",
                    role: "assistant",
                    status: "completed",
                    content: [
                      { type: "output_text", text: "OK", annotations: [] },
                    ],
                  },
                ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          };
          if (JSON.parse(raw).stream) {
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.end(
              `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1, response: result })}\n\n`,
            );
          } else {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(result));
          }
          return;
        }
        if (!JSON.parse(raw).stream) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              id: "chatcmpl-probe",
              object: "chat.completion",
              created: 1,
              model: "probe-model",
              choices: [
                {
                  index: 0,
                  message: action
                    ? {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            id: `call_${requests.length}`,
                            type: "function",
                            function: action,
                          },
                        ],
                      }
                    : { role: "assistant", content: "OK" },
                  finish_reason: action ? "tool_calls" : "stop",
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            }),
          );
          return;
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const choice of [
          {
            delta: action
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${requests.length}`,
                      type: "function",
                      function: action,
                    },
                  ],
                }
              : { role: "assistant", content: "OK" },
            finish_reason: null,
          },
          { delta: {}, finish_reason: action ? "tool_calls" : "stop" },
        ])
          response.write(
            `data: ${JSON.stringify({ id: "chatcmpl-probe", object: "chat.completion.chunk", created: 1, model: "probe-model", choices: [{ index: 0, ...choice }] })}\n\n`,
          );
        response.end("data: [DONE]\n\n");
      })().catch(() => response.writeHead(500).end());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No probe port");
    try {
      for (const { agent, wireApi } of [
        undefined,
        "review-author",
        "context-analyst",
      ].flatMap((agent) =>
        (["completions", "responses"] as const).map((wireApi) => ({
          agent: agent as HarnessSubagentId | undefined,
          wireApi,
        })),
      )) {
        requests = [];
        const runtime = new HarnessSessionRuntime({
          logger: pino({ level: "silent" }),
          runLogDir: join(root, "logs"),
          timeoutMs: 20_000,
          maxPromptMemoryChars: 5000,
        });
        await runtime.run({
          prompt: "Review the synthetic repository.",
          modelConfig: {
            modelProfileName: "probe",
            selectionSource: "tenant",
            reviewModel: "probe-model",
            textGenerationModel: "probe-model",
            reviewReasoningEffort: null,
            textGenerationReasoningEffort: null,
            authToken: null,
            provider: {
              type: "openai",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              wireApi,
              apiKey: "dummy",
            },
            providerBaseUrl: null,
            providerType: "openai",
          },
          model: "probe-model",
          workingDirectory: workspace,
          tools: ["glob", "rg", "view"],
          subagents: ["context-analyst", "review-author"],
          ...(agent ? { agent } : {}),
        });
        expect(requests.length).toBe(4);
        const first = requests[0]!;
        for (const marker of [
          "SHARED_ROOT_SENTINEL",
          "SHARED_COPILOT_SENTINEL",
          "SHARED_MODULAR_SENTINEL",
          "DEDICATED_ROOT_SENTINEL",
          "DEDICATED_MODULAR_SENTINEL",
          "SKILL_CATALOG_SENTINEL",
        ])
          expect(first.includes(marker), `${agent}/${wireApi}: ${marker}`).toBe(
            true,
          );
        expect(first.includes("UNRELATED_SKILL_SENTINEL")).toBe(false);
        const last = requests.at(-1)!;
        for (const marker of [
          "SKILL_BODY_SENTINEL",
          "SKILL_REFERENCE_SENTINEL",
        ])
          expect(last.includes(marker), `${agent}: ${marker}`).toBe(true);
        expect(last).not.toContain("NONMATCHING_PYTHON_SENTINEL");
        const tools = JSON.parse(first).tools.flatMap(
          (tool: {
            name?: string;
            function?: { name: string };
            tools?: Array<{ name: string }>;
          }) =>
            tool.tools?.map((item) => item.name) ?? [
              tool.function?.name ?? tool.name,
            ],
        );
        expect(tools).toContain("skill");
        expect(tools).not.toContain("bash");
        expect(tools).not.toContain("powershell");
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  },
  90_000,
);
