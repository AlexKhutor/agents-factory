// The models a new agent can be given, as the connected provider lists them.
//
// The Gateway answers query.provider.models.list from the provider's own
// catalog - for Claude Code, the controller's claude-provider.json, the same
// list the backend checks every new agent's profile against. This module turns
// that envelope into the bounded list the create-agent form shows: the
// provider, each model's id and name, the reasoning efforts it accepts and its
// default. Nothing is added here: a model or effort the provider did not list
// is never offered, so the form cannot suggest a profile the backend refuses.

export const MODELS_OPERATION = "query.provider.models.list";

// An agent profile names its provider by the backend's own id; the adapter that
// answered the model list says which one that is. The labels are the official
// product names. An adapter not listed here gets no lists: the form then falls
// back to typed fields instead of guessing a provider id. The Codex App Server
// left with the Codex path; a Codex agent would come back as an ACP agent.
const PROVIDERS = Object.freeze({
  "claude-code-sdk": Object.freeze({ profileProvider: "claude", label: "Anthropic API · Claude Code" }),
  // An ACP agent the Gateway runs beside Claude Code (acp-provider.json): DeepSeek Harness.
  "acp-stdio": Object.freeze({ profileProvider: "acp", label: "DeepSeek Harness · ACP" }),
});

/** The adapters this window knows, in the order the form offers them. */
export const KNOWN_ADAPTERS = Object.freeze(Object.keys(PROVIDERS));

const MAX_MODELS = 64;
const MAX_EFFORTS = 8;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/u;
const EFFORT = /^[a-z][a-z0-9-]{0,15}$/u;

const refuse = (code, reasonCode = null) => ({ ok: false, error: { code, reasonCode } });

function modelOf(record) {
  const id = record?.modelRef?.authority?.externalId;
  if (typeof id !== "string" || !MODEL_ID.test(id)) return null;
  const efforts = Array.isArray(record.supportedReasoningEfforts)
    ? [...new Set(record.supportedReasoningEfforts.filter((value) => typeof value === "string" && EFFORT.test(value)))]
      .slice(0, MAX_EFFORTS)
    : [];
  if (efforts.length === 0) return null;
  const name = typeof record.name === "string" && record.name.trim() !== "" ? record.name.trim().slice(0, 128) : id;
  const defaultEffort = efforts.includes(record.defaultReasoningEffort) ? record.defaultReasoningEffort : efforts[0];
  return { id, name, efforts, defaultEffort };
}

/**
 * `response` is what gateway.run returned for MODELS_OPERATION; `adapterId` is
 * the adapter discovery named for it. Returns `{ ok, data: { provider, models,
 * complete } }` or `{ ok: false, error }`.
 */
export function summarizeProviderModels(response, adapterId) {
  const provider = typeof adapterId === "string" ? PROVIDERS[adapterId] ?? null : null;
  if (provider === null) return refuse("provider_unknown", typeof adapterId === "string" ? adapterId.slice(0, 64) : null);
  if (!response?.ok) return refuse(response?.error?.code ?? "models_unreadable", response?.error?.reasonCode ?? null);
  const envelope = response.result;
  if (envelope?.outcome !== "succeeded") {
    return refuse("models_unreadable", envelope?.error?.code ?? envelope?.outcome ?? null);
  }
  const records = envelope.output?.data?.records;
  if (!Array.isArray(records)) return refuse("models_unreadable", "records_missing");
  const seen = new Set();
  const models = [];
  for (const record of records.slice(0, MAX_MODELS)) {
    const model = modelOf(record);
    if (model === null || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  if (models.length === 0) return refuse("models_empty");
  return {
    ok: true,
    data: {
      provider: { adapterId, profileProvider: provider.profileProvider, label: provider.label },
      models: models.map((model) => ({ ...model, provider: provider.profileProvider })),
      complete: envelope.output.data.completeness?.status === "complete" && records.length <= MAX_MODELS,
    },
  };
}

/**
 * Several providers in one Gateway (Claude Code and an ACP agent): their
 * summaries as one catalog. `provider` and `complete` stay those of the first
 * provider that answered; `providers` lists each one with its own models;
 * `models` holds all of them, each naming its provider. A provider that did
 * not answer is left out; when none did, the first refusal is returned.
 */
export function combineProviderModels(summaries) {
  const answered = summaries.filter((summary) => summary?.ok);
  if (answered.length === 0) return summaries[0] ?? refuse("provider_unavailable");
  return {
    ok: true,
    data: {
      provider: answered[0].data.provider,
      complete: answered.every((summary) => summary.data.complete),
      providers: answered.map((summary) => summary.data),
      models: answered.flatMap((summary) => summary.data.models),
    },
  };
}
