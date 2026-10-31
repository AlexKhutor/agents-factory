import { tx } from "../host/i18n.mjs";
// Turns a Paperclip run log into chat items.
//
// A run log is NDJSON rows of { ts, stream, chunk }. The chunks of stdout,
// joined, are themselves JSON lines written by the adapter, in one of two
// shapes: Claude's stream-json (the CLI engine) or acpx.* events (the ACP
// engine). Both are reduced to the same small list:
//
//   { kind: "assistant" | "tool" | "change" | "thinking" | "service", text, at }
//
// "thinking" carries the reasoning text when the provider gave one (a summary),
// and null when it only said that reasoning happened. "service" is a call the
// agent made to Paperclip's own API - posting a comment, setting the task's
// status: bookkeeping of the backend, named in one line instead of shown as a
// terminal command with a page of JSON.

const OUTPUT_LIMIT = 1200;
export const CHANGE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const clip = (text, limit) => (text.length > limit ? tx("{value}\n… (truncated)", { value: text.slice(0, limit) }) : text);

export function describeTool(name, input) {
  const value = input !== null && typeof input === "object" ? input : {};
  if (name === "Bash" && typeof value.command === "string") return `$ ${value.command}`;
  if (typeof value.file_path === "string") return `${name} ${value.file_path}`;
  if (name === "Skill" && typeof value.skill === "string") return `Skill ${value.skill}`;
  const rest = JSON.stringify(value);
  return rest === "{}" ? name : `${name} ${clip(rest, 300)}`;
}

/** What a shell command did to Paperclip itself, in words - or null when it is ordinary work. */
export function describeServiceCall(command) {
  if (typeof command !== "string" || !/\$\{?PAPERCLIP_(API|TASK|RUN)/.test(command)) return null;
  const said = [];
  if (/\/comments\b/.test(command) && /-X\s+POST|--data|\s-d\s/.test(command)) said.push(tx("comment in the task"));
  const status = /\\?"status\\?"\s*:\s*\\?"([a-z_]+)\\?"/.exec(command);
  if (status !== null) said.push(tx("task status → {value}", { value: status[1] }));
  if (/\/interactions\b/.test(command)) said.push(tx("question to the person"));
  if (/\/documents\//.test(command)) said.push("task document");
  return tx("Paperclip: {value}", { value: said.length === 0 ? tx("internal call") : said.join(", ") });
}

export function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

/** stdout of the run as complete lines, each with the time of the row that completed it. */
function* stdoutLines(ndjson) {
  let buffer = "";
  for (const raw of ndjson.split("\n")) {
    if (raw.trim() === "") continue;
    let row;
    try {
      row = JSON.parse(raw);
    } catch {
      continue;
    }
    if (row.stream !== "stdout" || typeof row.chunk !== "string") continue;
    buffer += row.chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      yield { line: buffer.slice(0, newline), at: row.ts ?? null };
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim() !== "") yield { line: buffer, at: null };
}

export function parseRunLog(ndjson) {
  const items = [];
  const tools = new Map();
  let pendingText = "";
  let pendingAt = null;

  const flushText = () => {
    if (pendingText.trim() !== "") items.push({ kind: "assistant", text: pendingText.trim(), at: pendingAt });
    pendingText = "";
    pendingAt = null;
  };
  let pendingThought = "";
  let thoughtAt = null;
  /** Reasoning: its text when there is one, otherwise one mark that it happened. */
  const thinking = (at, said = "") => {
    const words = said.trim();
    const last = items[items.length - 1];
    if (words !== "") items.push({ kind: "thinking", text: words, at });
    else if (last === undefined || last.kind !== "thinking") items.push({ kind: "thinking", text: null, at });
  };
  const flushThought = () => {
    if (thoughtAt !== null) thinking(thoughtAt, pendingThought);
    pendingThought = "";
    thoughtAt = null;
  };

  for (const { line, at } of stdoutLines(typeof ndjson === "string" ? ndjson : "")) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record === null || typeof record !== "object") continue;

    // --- Claude stream-json (CLI engine) ---
    if (record.type === "assistant" && Array.isArray(record.message?.content)) {
      for (const part of record.message.content) {
        if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
          items.push({ kind: "assistant", text: part.text.trim(), at });
        } else if (part.type === "thinking") {
          thinking(at, typeof part.thinking === "string" ? part.thinking : "");
        } else if (part.type === "tool_use") {
          const service = part.name === "Bash" ? describeServiceCall(part.input?.command) : null;
          const item = service !== null ? { kind: "service", title: service, output: "", at } : {
            kind: CHANGE_TOOLS.has(part.name) ? "change" : "tool",
            title: describeTool(part.name, part.input), output: "", at,
          };
          tools.set(part.id, item);
          items.push(item);
        }
      }
      continue;
    }
    if (record.type === "user" && Array.isArray(record.message?.content)) {
      for (const part of record.message.content) {
        if (part.type !== "tool_result") continue;
        const item = tools.get(part.tool_use_id);
        if (item !== undefined) item.output = resultText(part.content);
      }
      continue;
    }

    // --- acpx events (ACP engine) ---
    if (record.type === "acpx.text_delta" && typeof record.text === "string") {
      if (record.channel === "output") {
        flushThought();
        if (pendingAt === null) pendingAt = at;
        pendingText += record.text;
      } else {
        flushText();
        if (thoughtAt === null) thoughtAt = at;
        pendingThought += record.text;
      }
      continue;
    }
    if (record.type === "acpx.tool_call" && typeof record.toolCallId === "string") {
      flushText();
      flushThought();
      let item = tools.get(record.toolCallId);
      if (item === undefined) {
        item = { kind: "tool", title: "", output: "", at };
        tools.set(record.toolCallId, item);
        items.push(item);
      }
      // One call is named several times: "Terminal", then the command itself,
      // then "Terminal" again. The fullest name says what was done.
      const name = typeof record.name === "string" ? record.name : "";
      if (name === "Terminal") item.terminal = true;
      const generic = item.title === "" || item.title === "Terminal";
      if (name !== "" && !name.startsWith("Preparing") && (generic ? name !== item.title : name !== "Terminal" && name.length > item.title.length)) {
        item.title = name;
        if (/^(Write|Edit)\b/.test(name)) item.kind = "change";
      }
      if (record.status === "completed" || record.status === "failed") {
        item.output = String(record.text ?? "").replace(/^tool call \((completed|failed)\):\s*/, "");
      }
      continue;
    }
  }
  flushText();
  flushThought();

  return items.map((item) => {
    if (item.kind === "service") return { kind: "service", at: item.at, text: item.title };
    if (item.kind !== "tool" && item.kind !== "change") return item;
    if (item.terminal === true && item.title !== "Terminal") {
      const service = describeServiceCall(item.title);
      if (service !== null) return { kind: "service", at: item.at, text: service };
      item.title = `$ ${item.title}`;
    }
    const title = item.title === "" ? "tool" : item.title;
    // A terminal's output arrives wrapped in a console fence; the desk shows it as plain output.
    const output = item.output.trim().replace(/^```console\n([\s\S]*?)\n?```$/, "$1").trim();
    return { kind: item.kind, at: item.at, text: output === "" ? title : `${title}\n\n${clip(output, OUTPUT_LIMIT)}` };
  });
}
