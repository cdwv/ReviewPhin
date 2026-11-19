import { describe, expect, it } from "vitest";
import { CodexProtocol } from "../src/harness/codex-protocol.js";

describe("Codex app-server protocol", () => {
  it("returns a completed agent response from a running app server", async () => {
    const server = new CodexProtocol({
      command: process.execPath,
      args: ["test/fixtures/codex-app-server.mjs"],
      timeoutMs: 3000,
      onToolCall: async () => "ok",
    });
    try {
      await server.initialize();
      const threadId = await server.startThread({});
      expect(await server.turn(threadId, "hello")).toBe('{"answer":42}');
    } finally {
      await server.close();
    }
  });

  it("forwards requested tools and returns their result to the server", async () => {
    const calls: unknown[] = [];
    const server = new CodexProtocol({
      command: process.execPath,
      args: ["test/fixtures/codex-app-server.mjs"],
      timeoutMs: 3000,
      onToolCall: async (name, args) => {
        calls.push({ name, args });
        return "file content";
      },
    });
    try {
      await server.initialize();
      const threadId = await server.startThread({});
      expect(await server.turn(threadId, "tool")).toBe("file content");
      expect(calls).toEqual([{ name: "view", args: { path: "file.ts" } }]);
    } finally {
      await server.close();
    }
  });
});
