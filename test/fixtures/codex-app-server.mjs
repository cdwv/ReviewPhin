import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let repair = false;
let instructions = "";
const finish = (text) => {
  send({
    method: "item/completed",
    params: { turnId: "turn-1", item: { type: "agentMessage", text } },
  });
  send({
    method: "turn/completed",
    params: { turn: { id: "turn-1", status: "completed" } },
  });
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if ((request.id === 999 || request.id === "memory-call") && request.result)
    finish(request.result.contentItems[0].text);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") {
    instructions = request.params.developerInstructions ?? "";
    send({ id: request.id, result: { thread: { id: "thread-1" } } });
  }
  if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "turn-1" } } });
    if (request.params.input[0].text === "instructions") {
      finish(instructions);
      return;
    }
    if (request.params.input[0].text.startsWith("attachments")) {
      finish(JSON.stringify(request.params.input));
      return;
    }
    if (request.params.input[0].text === "invalid") {
      repair = true;
      finish("not json");
      return;
    }
    if (repair) {
      repair = false;
      finish('{"answer":42}');
      return;
    }
    if (request.params.input[0].text === "tool") {
      send({
        id: 999,
        method: "item/tool/call",
        params: { tool: "view", arguments: { path: "file.ts" } },
      });
      return;
    }
    if (request.params.input[0].text === "search") {
      send({
        id: 999,
        method: "item/tool/call",
        params: {
          tool: "rg",
          arguments: { query: "needle.+ok", pattern: "*.ts" },
        },
      });
      return;
    }
    if (request.params.input[0].text === "memory") {
      send({
        id: "memory-call",
        method: "item/tool/call",
        params: {
          tool: "add_memory_entry",
          arguments: { memory: "Use UTC", rationale: "Team convention" },
        },
      });
      return;
    }
    finish('{"answer":42}');
  }
});
