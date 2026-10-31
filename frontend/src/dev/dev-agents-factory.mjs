// DEVELOPMENT ONLY. Puts the fake agents-factory CLI where the host looks for
// the real one in a controller (.orchestrator/runtime/agents-factory.mjs) of
// the fixture's throwaway controller root, and starts it from a clean state:
// no Gateway, no key, no autostart. Loaded only in --dev-fixture and by tests.

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS_FACTORY_CLI } from "../host/agents-factory-cli.mjs";

const DEV_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

// The fake CLI's state file inside its --instance folder (fake-agents-factory-cli.mjs).
export const FAKE_AGENTS_FACTORY_STATE = path.join(".project-local", "atlas-dev-agents-factory.json");

/**
 * @param state the fake's starting state over its defaults. The --dev-fixture
 *              window starts with one failing start, to show how a failure
 *              looks (gateway_start_timeout is a real code of the CLI); tests
 *              pass their own.
 */
export async function prepareDevAgentsFactory(controllerRoot,
  state = { failOnce: { "gateway start": "gateway_start_timeout" } }) {
  const script = path.join(controllerRoot, AGENTS_FACTORY_CLI.controllerRelative);
  await mkdir(path.dirname(script), { recursive: true });
  await copyFile(path.join(DEV_DIRECTORY, "fake-agents-factory-cli.mjs"), script);
  await writeFakeAgentsFactoryState(controllerRoot, state);
  return script;
}

export async function writeFakeAgentsFactoryState(controllerRoot, state = {}) {
  const statePath = path.join(controllerRoot, FAKE_AGENTS_FACTORY_STATE);
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
