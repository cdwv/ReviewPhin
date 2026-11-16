import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { z } from "zod";

const messageSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
type Message = z.infer<typeof messageSchema>;
const threadResult = z.object({ thread: z.object({ id: z.string() }) });
const turnResult = z.object({ turn: z.object({ id: z.string() }) });
const toolParams = z.object({ tool: z.string(), arguments: z.unknown() });
const itemParams = z.object({
  turnId: z.string(),
  item: z.object({ type: z.string(), text: z.string().optional() }),
});
const completedParams = z.object({
  turn: z.object({
    id: z.string(),
    status: z.string(),
    error: z.object({ message: z.string() }).nullable().optional(),
  }),
});

/** One bounded app-server process per harness run. */
export class CodexProtocol {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly completed = new Map<
    string,
    { text: string; error?: string }
  >();
  private readonly waiters = new Map<
    string,
    { resolve: (value: string) => void; reject: (error: Error) => void }
  >();
  private readonly messages = new Map<string, string>();
  private nextId = 1;
  private readonly timeoutMs: number;
  private readonly onToolCall: (name: string, args: unknown) => Promise<string>;

  public constructor(options: {
    command: string;
    args: string[];
    timeoutMs: number;
    onToolCall: (name: string, args: unknown) => Promise<string>;
  }) {
    this.timeoutMs = options.timeoutMs;
    this.onToolCall = options.onToolCall;
    this.child = spawn(options.command, options.args, { stdio: "pipe" });
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        this.receive(messageSchema.parse(JSON.parse(line)));
      } catch {
        this.fail(new Error("Invalid Codex protocol message"));
      }
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", () =>
      this.fail(new Error("Codex app server exited")),
    );
  }

  public async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "reviewphin", title: "ReviewPhin", version: "1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.send({ method: "initialized" });
  }

  public async startThread(params: Record<string, unknown>): Promise<string> {
    const result = threadResult.parse(
      await this.request("thread/start", params),
    );
    return result.thread.id;
  }

  public async turn(
    threadId: string,
    prompt: string,
    options?: { effort?: string; images?: string[]; timeoutMs?: number },
  ): Promise<string> {
    const result = turnResult.parse(
      await this.request("turn/start", {
        threadId,
        input: [
          { type: "text", text: prompt, text_elements: [] },
          ...(options?.images ?? []).map((url) => ({ type: "image", url })),
        ],
        ...(options?.effort ? { effort: options.effort } : {}),
      }),
    );
    const id = result?.turn?.id;
    if (typeof id !== "string") throw new Error("Codex returned no turn ID");
    const done = this.completed.get(id);
    if (done) {
      this.completed.delete(id);
      if (done.error) throw new Error(done.error);
      return done.text;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error("Codex turn timed out"));
      }, options?.timeoutMs ?? this.timeoutMs);
      this.waiters.set(id, {
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  public async close(): Promise<void> {
    this.child.kill();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ id, method, params });
    });
  }

  private send(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(message: Message): void {
    if (message.method && message.id !== undefined) {
      if (message.method === "item/tool/call") {
        const params = toolParams.parse(message.params);
        void this.onToolCall(params.tool, params.arguments).then(
          (text) =>
            this.send({
              id: message.id,
              result: {
                success: true,
                contentItems: [{ type: "inputText", text }],
              },
            }),
          (error: unknown) =>
            this.send({
              id: message.id,
              result: {
                success: false,
                contentItems: [{ type: "inputText", text: String(error) }],
              },
            }),
        );
      } else
        this.send({
          id: message.id,
          error: { code: -32601, message: "Unsupported request" },
        });
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "item/completed") {
      const parsed = itemParams.safeParse(message.params);
      if (
        parsed.success &&
        parsed.data.item.type === "agentMessage" &&
        parsed.data.item.text !== undefined
      )
        this.messages.set(parsed.data.turnId, parsed.data.item.text);
    }
    if (message.method === "turn/completed") {
      const { turn } = completedParams.parse(message.params);
      const result = {
        text: this.messages.get(turn.id) ?? "",
        ...(turn.status === "completed"
          ? {}
          : { error: turn.error?.message ?? `Codex turn ${turn.status}` }),
      };
      this.messages.delete(turn.id);
      const waiter = this.waiters.get(turn.id);
      if (waiter) {
        this.waiters.delete(turn.id);
        if (result.error) waiter.reject(new Error(result.error));
        else waiter.resolve(result.text);
      } else this.completed.set(turn.id, result);
    }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    for (const waiter of this.waiters.values()) waiter.reject(error);
    this.pending.clear();
    this.waiters.clear();
  }
}
