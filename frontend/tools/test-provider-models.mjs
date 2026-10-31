// The create-agent form offers exactly what the provider listed: its models,
// each with the reasoning efforts it accepts, under the provider the Gateway
// named. Nothing is invented - an unknown adapter, a failed read or an empty
// list yields a refusal, and the form falls back to typed fields.

import {
  KNOWN_ADAPTERS, MODELS_OPERATION, combineProviderModels, summarizeProviderModels,
} from "../src/host/provider-models.mjs";
import { ALLOWED_OPERATIONS } from "../src/host/operations.mjs";
import { CHANNEL_NAMES } from "../src/host/ipc.mjs";

const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

const record = (id, name, efforts, defaultEffort = "default") => ({
  modelRef: { kind: "provider-item", authority: { authorityType: "provider", externalId: id } },
  name, supportedReasoningEfforts: efforts, defaultReasoningEffort: defaultEffort,
});
const answer = (records, completeness = { status: "complete", nextCursor: null }) => ({
  ok: true,
  result: { outcome: "succeeded", output: { contractVersion: "v0.1.0", data: { records, completeness } } },
});
const ALL = ["default", "low", "medium", "high", "xhigh", "max"];

{
  const summary = summarizeProviderModels(answer([
    record("claude-opus-5-5", "Claude Opus 5.5", ALL),
    record("claude-haiku-4-5-20251001", "Claude Haiku 4.5", ["default"]),
    record("claude-opus-4-6", "Claude Opus 4.6 (legacy)", ["default", "low", "medium", "high", "max"]),
  ]), "claude-code-sdk");
  check("claude-code-list-as-backend-sent-it",
    summary.ok
      && summary.data.provider.profileProvider === "claude"
      && summary.data.provider.label === "Anthropic API · Claude Code"
      && summary.data.models.map((item) => item.id).join(",") === "claude-opus-5-5,claude-haiku-4-5-20251001,claude-opus-4-6"
      && summary.data.models[0].efforts.join(",") === ALL.join(",")
      && summary.data.models[1].efforts.join(",") === "default"
      && !summary.data.models[2].efforts.includes("xhigh")
      && summary.data.complete === true,
    summary);
}

{
  const summary = summarizeProviderModels(answer([
    record("claude-opus-5-5", "Claude Opus 5.5", ["default", "low", "low", "bad effort!", 7]),
    record("claude-opus-5-5", "Duplicate", ALL),
    record("bad id", "x", ALL),
    record("claude-sonnet-5-5", "", ["medium", "high"], "max"),
    record("claude-no-efforts", "x", []),
  ]), "claude-code-sdk");
  check("foreign-values-dropped-not-fixed",
    summary.ok
      && summary.data.models.length === 2
      && summary.data.models[0].efforts.join(",") === "default,low"
      && summary.data.models[0].name === "Claude Opus 5.5"
      && summary.data.models[1].name === "claude-sonnet-5-5"
      && summary.data.models[1].defaultEffort === "medium",
    summary);
}

{
  const unknown = summarizeProviderModels(answer([record("m", "m", ["default"])]), "some-adapter");
  const none = summarizeProviderModels(answer([record("m", "m", ["default"])]), null);
  check("unknown-provider-not-guessed",
    !unknown.ok && unknown.error.code === "provider_unknown" && unknown.error.reasonCode === "some-adapter"
      && !none.ok && none.error.code === "provider_unknown",
    { unknown, none });
}

{
  const failed = summarizeProviderModels({ ok: true, result: { outcome: "failed", error: { code: "provider_disconnected" } } },
    "claude-code-sdk");
  const refused = summarizeProviderModels({ ok: false, error: { code: "unsupported_capability", reasonCode: "x" } },
    "claude-code-sdk");
  const empty = summarizeProviderModels(answer([]), "claude-code-sdk");
  check("failure-or-empty-list-is-refusal",
    !failed.ok && failed.error.reasonCode === "provider_disconnected"
      && !refused.ok && refused.error.code === "unsupported_capability"
      && !empty.ok && empty.error.code === "models_empty",
    { failed, refused, empty });
}

{
  const partial = summarizeProviderModels(answer([record("claude-opus-5-5", "Claude Opus 5.5", ALL)],
    { status: "partial", nextCursor: "c1" }), "claude-code-sdk");
  check("partial-list-marked", partial.ok && partial.data.complete === false, partial);
}

{
  const claude = summarizeProviderModels(answer([record("claude-opus-5-5", "Claude Opus 5.5", ALL)]), "claude-code-sdk");
  const acp = summarizeProviderModels(answer([record("qwen3.8-27b-defiance", "Qwen", ["default"])]), "acp-stdio");
  const down = summarizeProviderModels({ ok: false, error: { code: "provider_disconnected" } }, "acp-stdio");
  const both = combineProviderModels([claude, acp]);
  const one = combineProviderModels([claude, down]);
  const none = combineProviderModels([down]);
  check("several-providers-in-one-gateway",
    acp.ok && acp.data.provider.profileProvider === "acp" && KNOWN_ADAPTERS.includes("acp-stdio")
      && both.ok && both.data.providers.length === 2 && both.data.provider.profileProvider === "claude"
      && both.data.models.map((item) => `${item.provider}:${item.id}`).join(",")
        === "claude:claude-opus-5-5,acp:qwen3.8-27b-defiance"
      && one.ok && one.data.providers.length === 1
      && !none.ok && none.error.code === "provider_disconnected",
    { both, one, none });
}

check("operation-allowed-to-window-as-read", ALLOWED_OPERATIONS[MODELS_OPERATION] === "read",
  { method: ALLOWED_OPERATIONS[MODELS_OPERATION] ?? null });
check("models-channel-declared", CHANNEL_NAMES.includes("atlas:models"), { channels: CHANNEL_NAMES.length });

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({
  suite: "provider-models",
  status: failed.length === 0 ? "passed" : "failed",
  passedCount: cases.length - failed.length,
  failedCount: failed.length,
  cases,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
