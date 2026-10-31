import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

// A minimal Agent Client Protocol client: JSON-RPC 2.0 as newline-delimited
// JSON over the standard input and output of one agent process (for example
// `dsh --profile acp`). The Gateway is the client; the process is the agent.
// The agent's own requests to the client (session/request_permission) go to
// handlers registered with onRequest; everything the client did not register
// is answered "method not found", so an agent never gets a capability the
// client did not offer (file system, terminals).

export const ACP_STDIO_CLIENT_VERSION = "v0.1.0";
const MAX_LINE_BYTES = 8 * 1024 * 1024;

function fail(code, message = code, extra = {}) { throw Object.assign(new Error(message), { code, ...extra }); }

export class AcpStdioClient extends EventEmitter {
  #command; #args; #env; #cwd; #onDiagnostic;
  #child = null;
  #nextId = 1;
  #pending = new Map();
  #handlers = new Map();
  #buffer = "";
  #closed = false;

  /** `env` is the whole environment of the agent process (nothing is inherited implicitly). */
  constructor({ command, args = [], env = null, cwd = undefined, onDiagnostic = () => {} } = {}) {
    super();
    if (typeof command !== "string" || command.length === 0 || !Array.isArray(args)) fail("acp_client_invalid");
    this.#command = command; this.#args = [...args]; this.#env = env; this.#cwd = cwd;
    this.#onDiagnostic = onDiagnostic;
  }

  get running() { return this.#child !== null && !this.#closed; }

  #diagnostic(record) {
    try { this.#onDiagnostic({ component: "acp-stdio-client", ...record }); } catch { /* never changes traffic */ }
  }

  start() {
    if (this.#child !== null || this.#closed) fail("acp_client_state");
    const child = spawn(this.#command, this.#args, { cwd: this.#cwd, env: this.#env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#read(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/u)) {
        if (line.trim()) this.#diagnostic({ phase: "stderr", message: line.slice(0, 400) });
      }
    });
    child.on("error", (error) => this.#end("acp_process_failed", error?.message));
    child.on("exit", (code, signal) => this.#end("acp_process_exited", `exit ${code ?? signal}`));
    child.stdin.on("error", () => { /* the exit handler reports it */ });
  }

  #read(chunk) {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_LINE_BYTES && !this.#buffer.includes("\n")) {
      this.#diagnostic({ phase: "read", reasonCode: "acp_line_too_long" });
      this.#buffer = "";
      return;
    }
    let index;
    while ((index = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        this.#diagnostic({ phase: "read", reasonCode: "acp_invalid_json", message: line.slice(0, 200) });
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (message?.jsonrpc !== "2.0") return;
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
        && !Object.hasOwn(message, "method")) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      pending.cleanup();
      if (message.error) {
        pending.reject(Object.assign(new Error(String(message.error.message ?? "ACP error").slice(0, 400)),
          { code: "acp_error", rpcCode: message.error.code ?? null, data: message.error.data ?? null }));
      } else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    if (Object.hasOwn(message, "id")) { this.#answer(message); return; }
    this.emit("notification", message.method, message.params ?? {});
  }

  async #answer(message) {
    const handler = this.#handlers.get(message.method);
    if (!handler) {
      this.#write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      return;
    }
    try {
      const result = await handler(message.params ?? {});
      this.#write({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
    } catch (error) {
      this.#write({ jsonrpc: "2.0", id: message.id,
        error: { code: -32603, message: String(error?.message ?? "Internal error").slice(0, 400) } });
    }
  }

  #write(message) {
    if (!this.running) return false;
    try { this.#child.stdin.write(`${JSON.stringify(message)}\n`); return true; }
    catch { return false; }
  }

  /** Handles one kind of request the agent sends to the client. */
  onRequest(method, handler) {
    if (typeof method !== "string" || typeof handler !== "function") fail("acp_client_invalid");
    this.#handlers.set(method, handler);
  }

  request(method, params = {}, { timeoutMs = 0, signal = null } = {}) {
    if (!this.running) return Promise.reject(Object.assign(new Error("provider_disconnected"), { code: "provider_disconnected" }));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      const onAbort = () => {
        this.#pending.delete(id); cleanup();
        reject(Object.assign(new Error("acp_request_aborted"), { code: "acp_request_aborted" }));
      };
      const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort); };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.#pending.delete(id); cleanup();
          reject(Object.assign(new Error(`${method} timed out`), { code: "acp_request_timeout" }));
        }, timeoutMs);
        timer.unref?.();
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });
      this.#pending.set(id, { resolve, reject, cleanup });
      if (!this.#write({ jsonrpc: "2.0", id, method, params })) {
        this.#pending.delete(id); cleanup();
        reject(Object.assign(new Error("provider_disconnected"), { code: "provider_disconnected" }));
      }
    });
  }

  notify(method, params = {}) { return this.#write({ jsonrpc: "2.0", method, params }); }

  #end(code, message) {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(Object.assign(new Error("provider_disconnected"), { code: "provider_disconnected" }));
    }
    this.#pending.clear();
    this.#diagnostic({ phase: "exit", reasonCode: code, message: String(message ?? "").slice(0, 200) });
    this.emit("exit", { code });
  }

  async close() {
    if (this.#child === null || this.#closed) { this.#closed = true; return; }
    try { this.#child.stdin.end(); } catch { /* already gone */ }
    const exited = new Promise((resolve) => this.once("exit", resolve));
    const timer = setTimeout(() => { try { this.#child.kill(); } catch { /* gone */ } }, 3000);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    clearTimeout(timer);
    this.#end("acp_client_closed", "closed by the Gateway");
  }
}
