// A stand-in ACP agent for tests: newline-delimited JSON-RPC over stdio, the
// subset DeepSeek Harness speaks. What a prompt does depends on its text:
// "tool" calls a pwsh tool after asking permission; a line "read <path>" calls
// its read tool the same way; "slow" waits for session/cancel; anything else
// answers with a thought and a message.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

const log = process.env.FAKE_ACP_LOG ?? null;
const sessions = new Map();
const waiting = new Map();
let nextId = 1;
let buffer = "";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
const record = (entry) => { if (log) appendFileSync(log, `${JSON.stringify(entry)}\n`); };
const options = (model) => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [] }];

function ask(method, params) {
  const id = `agent-${nextId++}`;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function prompt(params) {
  const { sessionId } = params;
  const text = params.prompt.map((part) => part.text).join("\n");
  const session = sessions.get(sessionId);
  record({ method: "prompt", sessionId, text, model: session.model });
  update(sessionId, { sessionUpdate: "agent_thought_chunk", messageId: "m1", content: { type: "text", text: "thinking" } });
  if (text.includes("slow")) {
    await new Promise((resolve) => { session.cancel = resolve; });
    return { stopReason: "cancelled" };
  }
  // As DeepSeek Harness answers when the model server behind a proxy is off, and when something else breaks.
  if (text.includes("model down")) throw new Error("Internal error: turn failed: 502 status code (no body)");
  if (text.includes("broken")) throw new Error("Internal error: tool registry is corrupt");
  const reading = /^read (.+)$/mu.exec(text);
  if (text.includes("tool") || reading) {
    const toolCallId = `call_${randomUUID().slice(0, 8)}`;
    const [title, rawInput] = reading ? ["read", { file_path: reading[1] }]
      : ["pwsh", { command: "Get-ChildItem", description: "list files" }];
    update(sessionId, { sessionUpdate: "tool_call", toolCallId, title, kind: "other", status: "in_progress", rawInput });
    const answer = await ask("session/request_permission", { sessionId, toolCall: { toolCallId },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" }] });
    const allowed = answer?.outcome?.optionId === "allow-once";
    record({ method: "permission", allowed });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: allowed ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: allowed ? "a.txt" : "rejected" } }] });
  }
  update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: `echo: ${text}` } });
  update(sessionId, { sessionUpdate: "usage_update", used: 1200, size: 98304 });
  return { stopReason: "end_turn" };
}

async function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  const { id, method, params } = message;
  record({ method });
  try {
    let result;
    if (method === "initialize") {
      result = { protocolVersion: 1, agentInfo: { name: "fake-acp", version: "0" },
        agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } }, authMethods: [] };
    } else if (method === "session/new") {
      const sessionId = randomUUID();
      sessions.set(sessionId, { model: "[\"p\",\"a\"]", mcpServers: params.mcpServers });
      record({ method: "session/new.mcp", mcpServers: params.mcpServers });
      result = { sessionId, configOptions: options("[\"p\",\"a\"]") };
    } else if (method === "session/resume") {
      sessions.set(params.sessionId, { model: "[\"p\",\"a\"]" });
      result = { configOptions: options("[\"p\",\"a\"]") };
    } else if (method === "session/set_config_option") {
      sessions.get(params.sessionId).model = params.value;
      result = { configOptions: options(params.value) };
    } else if (method === "session/prompt") {
      result = await prompt(params);
    } else if (method === "session/cancel") {
      sessions.get(params.sessionId)?.cancel?.();
      return;
    } else {
      send({ id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (id !== undefined) send({ id, result });
  } catch (error) {
    if (id !== undefined) send({ id, error: { code: -32603, message: String(error?.message ?? error) } });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
