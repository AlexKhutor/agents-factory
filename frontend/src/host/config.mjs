// Machine-local configuration for the host process.
//
// Nothing here has a default that points at a real machine: a fresh clone must
// be configured by the person who owns that machine (config/local.example.json).

import { readFile } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;

export const MODES = Object.freeze(["live", "dev-fixture", "paperclip", "direct"]);

export function resolveMode(argv = process.argv) {
  if (argv.includes("--dev-fixture")) return "dev-fixture";
  // PROTOTYPE: the desk works with Claude Code directly (src/direct/).
  if (argv.includes("--direct")) return "direct";
  // PROTOTYPE: the desk runs on a local Paperclip server (src/paperclip/).
  return argv.includes("--paperclip") ? "paperclip" : "live";
}

function placeholder(value) {
  return typeof value === "string" && value.trim().startsWith("<");
}

// A setting that may be left out: a non-empty string that is not a placeholder, or null.
const optionalText = (value) => (typeof value === "string" && value.trim() !== "" && !placeholder(value)
  ? value.trim() : null);

function validate(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "config_not_an_object";
  }
  const { controllerRoot, expectedWorkspace } = value;
  if (typeof controllerRoot !== "string" || controllerRoot.trim() === ""
      || placeholder(controllerRoot)) {
    return "controller_root_missing";
  }
  if (!path.isAbsolute(controllerRoot)) return "controller_root_not_absolute";
  if (expectedWorkspace === null || typeof expectedWorkspace !== "object") {
    return "expected_workspace_missing";
  }
  if (typeof expectedWorkspace.projectId !== "string"
      || expectedWorkspace.projectId.trim() === ""
      || placeholder(expectedWorkspace.projectId)) {
    return "expected_project_id_missing";
  }
  if (!SHA256.test(expectedWorkspace.workspaceRootSha256 ?? "")) {
    return "expected_workspace_hash_invalid";
  }
  return null;
}

/**
 * What the window may learn about the one configured controller: whether the
 * configuration loaded, why not, and the expected workspace identity. The
 * controller root and the path of the configuration file stay in the host.
 */
export function safeConfiguration(loaded) {
  if (loaded === null || typeof loaded !== "object") return { status: "unknown", reasonCode: "config_unread" };
  if (loaded.status === "loaded") {
    return {
      status: "loaded",
      reasonCode: null,
      expectedWorkspace: {
        projectId: loaded.config.expectedWorkspace.projectId,
        workspaceRootSha256: loaded.config.expectedWorkspace.workspaceRootSha256,
      },
    };
  }
  return { status: loaded.status, reasonCode: loaded.reasonCode ?? null };
}

/**
 * Reads config/local.json. Returns a bounded result; the caller decides how to
 * present it. A missing file is a normal first-run state, not an error.
 */
export async function loadLocalConfig(projectRoot) {
  const configPath = path.join(projectRoot, "config", "local.json");
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return { status: "missing", reasonCode: "local_config_missing", configPath };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "invalid", reasonCode: "local_config_unparsable", configPath };
  }
  const reasonCode = validate(parsed);
  if (reasonCode !== null) return { status: "invalid", reasonCode, configPath };

  return {
    status: "loaded",
    configPath,
    config: Object.freeze({
      controllerRoot: path.resolve(parsed.controllerRoot),
      expectedWorkspace: Object.freeze({
        projectId: parsed.expectedWorkspace.projectId,
        workspaceRootSha256: parsed.expectedWorkspace.workspaceRootSha256,
      }),
      gatewayCli: Object.freeze({
        nodeExecutable: parsed.gatewayCli?.nodeExecutable ?? "node",
        scriptRelativePath: parsed.gatewayCli?.scriptRelativePath
          ?? ".orchestrator/runtime/application-gateway-cli.mjs",
      }),
      // The agents-factory CLI (gateway-control.mjs). Both optional: without a
      // script the controller's own .orchestrator/runtime/agents-factory.mjs is
      // used (then, in a source checkout, the backend's build); without a Node
      // executable this Electron binary runs it as Node.
      agentsFactoryCli: Object.freeze({
        script: optionalText(parsed.agentsFactoryCli?.script),
        nodeExecutable: optionalText(parsed.agentsFactoryCli?.nodeExecutable),
      }),
    }),
  };
}
