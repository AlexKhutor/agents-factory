// Whether the servers of the agents' models answer (owner 31.10): the window shows what is connected
// before anyone sends to an agent whose model is off (the office Qwen while the office moves).
//
// For each ACP model with a `check` address in the controller's machine-local acp-provider.json, one
// plain GET with a short timeout: no key, no body, no tokens. Any answer below 500 means the server is
// there (a 401 is a server asking for its key); 502-504, a refused connection or silence mean it is not
// (a proxy whose model server is off answers 502). A model with no address is "not checked". Answers are
// kept a little, so the window may ask often; `force` asks again at once. Claude's own state is the
// account check (claude-account.mjs).

import { readFile } from "node:fs/promises";
import path from "node:path";

export const MODEL_HEALTH_KEEP_MS = 30_000;
const TIMEOUT_MS = 3000;
const MAX_MODELS = 32;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/u;
const CHECK = /^https?:\/\/[^\s]{1,500}$/u;

/** The ACP models of acp-provider.json as the window needs them; null when there is no ACP provider. */
async function configuredModels(file) {
  let text;
  try { text = await readFile(file, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (text.length > 64 * 1024) throw new Error("acp_config_too_large");
  const models = JSON.parse(text)?.models;
  if (!Array.isArray(models)) return [];
  return models.slice(0, MAX_MODELS).filter((model) => typeof model?.id === "string" && ID.test(model.id)).map((model) => ({
    id: model.id,
    name: typeof model.displayName === "string" && model.displayName.trim() !== "" ? model.displayName.trim().slice(0, 128) : model.id,
    check: typeof model.check === "string" && CHECK.test(model.check) ? model.check : null,
  }));
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return null; } };

/** `read({ force })`: `{ state: "known", models: [...] }`, `{ state: "none" }` (no ACP provider) or `{ state: "failed" }`. */
export function createModelHealth({ controllerRoot, fetchImpl = fetch, now = () => Date.now(),
  keepMs = MODEL_HEALTH_KEEP_MS, timeoutMs = TIMEOUT_MS }) {
  const file = path.join(controllerRoot, ".project-local", "application-gateway", "acp-provider.json");
  // One check per address at a time, however many models share it or windows ask.
  const kept = new Map();

  async function probe(url) {
    const started = now();
    try {
      const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      try { await response.body?.cancel(); } catch { /* the body is not wanted */ }
      const state = response.status >= 502 && response.status <= 504 ? "not-answering" : response.status >= 500 ? "error" : "answers";
      return { state, httpStatus: response.status, reason: null, ms: now() - started };
    } catch (error) {
      return { state: "not-answering", httpStatus: null, ms: now() - started,
        reason: error?.name === "TimeoutError" ? "timeout" : "unreachable" };
    }
  }

  function check(url, force) {
    const entry = kept.get(url);
    if (entry && (entry.pending || (!force && now() - entry.at < keepMs))) return entry.result;
    const fresh = { at: now(), pending: true, result: null };
    fresh.result = probe(url).then((result) => {
      fresh.pending = false;
      fresh.at = now();
      return { ...result, checkedAtUtc: new Date(fresh.at).toISOString() };
    });
    kept.set(url, fresh);
    return fresh.result;
  }

  return {
    async read({ force = false } = {}) {
      let models;
      try { models = await configuredModels(file); } catch { return { state: "failed", reason: "acp_config_unreadable" }; }
      if (models === null) return { state: "none" };
      const results = await Promise.all(models.map(async (model) => {
        const base = { id: model.id, name: model.name, provider: "acp", address: model.check === null ? null : hostOf(model.check) };
        if (model.check === null) return { ...base, state: "not-checked", httpStatus: null, reason: null, checkedAtUtc: null };
        const { ms, ...result } = await check(model.check, force);
        return { ...base, ...result };
      }));
      return { state: "known", models: results };
    },
  };
}
