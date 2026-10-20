// One place that decides what this run is connected to.
//
// live: the controller's own descriptor and the installed Gateway CLI.
// dev-fixture: the local development fixture plus a fixture CLI in a throwaway
// root, loaded only in that mode, so a normal run cannot silently fall back to
// synthetic data or to a fake trusted action.
//
// Before either, the accepted frontend kit is verified (kit.mjs). This is the
// first thing every session does - for the window, the fixture, the probe and
// the tests alike - and a rejected delivery yields a session with no gateway,
// no mutations and no trusted actions, carrying the reason instead.

import { copyFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalConfig, safeConfiguration } from "./config.mjs";
import { createControllerDescriptorSource } from "./descriptor-source.mjs";
import { createAgentWorkspace } from "./agent-workspace.mjs";
import { createClaudeAccountReader } from "./claude-account.mjs";
import { createClaudeUsageReader } from "./claude-usage.mjs";
import { createGateway } from "./gateway.mjs";
import { describeDeliveryFailure, loadAcceptedKit } from "./kit.mjs";
import { environmentKey } from "./layout-store.mjs";
import { createMutations } from "./mutations.mjs";
import { collectRunHeader, createReadJournal } from "./read-journal.mjs";
import { loadSchemaSet } from "./schema-check.mjs";
import { createTrustedActions } from "./trusted-actions.mjs";

const HOST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

// Without a real confirmation surface there are no trusted actions at all: a
// headless caller must not be able to write memory.
function unavailableMutations(reasonCode) {
  const refuse = async () => ({ ok: false, error: { code: "unavailable", reasonCode } });
  return {
    createScope: refuse, createAgent: refuse, send: refuse, sendReceipt: refuse,
    respond: refuse, interrupt: refuse, closeAgent: refuse,
    saveProjectFile: refuse, reconcileProjectFileSave: refuse, resendProjectFileSave: refuse,
    copyProject: refuse, reconcileProjectCopy: refuse,
    steer: refuse, unqueue: refuse, setProfile: refuse,
  };
}

function unavailableActions(reasonCode) {
  return {
    availability: async () => ({ available: false, reasonCode }),
    chooseWorkspace: async () => ({ ok: false, error: { code: "unavailable", reasonCode } }),
    bindWorkspace: async () => ({ ok: false, error: { code: "unavailable", reasonCode } }),
    saveMemoryEdit: async () => ({ ok: false, error: { code: "unavailable", reasonCode } }),
  };
}

async function createDevControllerRoot() {
  const root = path.join(os.tmpdir(), "agents-factory-atlas-dev-controller");
  const runtime = path.join(root, ".orchestrator", "runtime");
  await mkdir(runtime, { recursive: true });
  await mkdir(path.join(root, ".project-local"), { recursive: true });
  await copyFile(
    path.join(HOST_DIRECTORY, "..", "dev", "fake-gateway-cli.mjs"),
    path.join(runtime, "application-gateway-cli.mjs"),
  );
  return root;
}

/**
 * The delivery did not verify: nothing that talks to the gateway exists in this
 * session. The reason is the only thing it carries.
 */
function rejectedDeliverySession(mode, delivery) {
  const reasonCode = `delivery_${delivery.reasonCode}`;
  const fixture = mode === "dev-fixture";
  return {
    mode,
    fixture,
    delivery,
    kit: null,
    configuration: { status: "delivery_rejected", reasonCode },
    environment: environmentKey({ mode }),
    gateway: null,
    agentWorkspace: null,
    mutations: unavailableMutations(reasonCode),
    trusted: unavailableActions(reasonCode),
    readRuntimeSummary: async () => ({ mode, fixture, delivery: delivery.status, reasonCode }),
  };
}

export async function createSession({ projectRoot, mode, confirm = null, chooseDirectory = null }) {
  const hasConfirmationSurface = typeof confirm === "function" && typeof chooseDirectory === "function";

  // The application's own root holds its accepted delivery and its kit.
  let kit;
  try {
    kit = await loadAcceptedKit({ applicationRoot: projectRoot });
  } catch (error) {
    return rejectedDeliverySession(mode, describeDeliveryFailure(error));
  }
  const delivery = { status: "verified", ...kit.summary };
  // The kit's schemas for the agent-workspace reads, from the verified kit.
  const schemas = await loadSchemaSet(kit);

  // PROTOTYPE: the same session parts over Claude Code driven directly (src/direct/).
  if (mode === "direct") {
    const { createDirectSession } = await import("../direct/session.mjs");
    return createDirectSession({ projectRoot, mode, kit, delivery, schemas, confirm, chooseDirectory });
  }

  // PROTOTYPE: the same session parts over a Paperclip server (src/paperclip/).
  if (mode === "paperclip") {
    const { createPaperclipSession } = await import("../paperclip/session.mjs");
    return createPaperclipSession({ projectRoot, mode, kit, delivery, schemas, confirm, chooseDirectory });
  }

  if (mode === "dev-fixture") {
    const { createDevGateway } = await import("../dev/dev-gateway.mjs");
    const fixture = createDevGateway({ kit });
    const controllerRoot = await createDevControllerRoot();
    // Every read of this run is journalled from the start, fixture included.
    const journal = createReadJournal({
      header: await collectRunHeader({ projectRoot, mode, delivery, expectedWorkspace: fixture.workspace }),
    });
    const gateway = createGateway({
      kit,
      resolveDescriptor: fixture.resolveDescriptor,
      expectedWorkspace: fixture.workspace,
      fetchImpl: fixture.fetchImpl,
      journal,
    });
    return {
      mode,
      fixture: true,
      delivery,
      kit,
      environment: environmentKey({ mode }),
      gateway,
      journal,
      agentWorkspace: createAgentWorkspace({ gateway, schemas, journal }),
      mutations: hasConfirmationSurface
        ? createMutations({ gateway, confirm, journal, schemas })
        : unavailableMutations("confirmation_surface_unavailable"),
      trusted: hasConfirmationSurface
        ? createTrustedActions({
          journal,
          config: {
            controllerRoot,
            gatewayCli: {
              nodeExecutable: "node",
              scriptRelativePath: ".orchestrator/runtime/application-gateway-cli.mjs",
            },
          },
          confirm,
          chooseDirectory,
        })
        : unavailableActions("confirmation_surface_unavailable"),
      readRuntimeSummary: async () => ({
        mode,
        fixture: true,
        lifecycle: "ready",
        health: "fixture",
        projectId: fixture.workspace.projectId,
        descriptorPresent: true,
      }),
    };
  }

  const loaded = await loadLocalConfig(projectRoot);
  if (loaded.status !== "loaded") {
    return {
      mode,
      fixture: false,
      delivery,
      kit,
      // Only what the window may show: status and reason, never a path.
      configuration: safeConfiguration(loaded),
      environment: environmentKey({ mode }),
      gateway: null,
      agentWorkspace: null,
      mutations: unavailableMutations(loaded.reasonCode),
      trusted: unavailableActions(loaded.reasonCode),
      readRuntimeSummary: async () => ({
        mode,
        fixture: false,
        controllerRootConfigured: false,
        reasonCode: loaded.reasonCode,
      }),
    };
  }

  const source = createControllerDescriptorSource(loaded.config);
  const journal = createReadJournal({
    header: await collectRunHeader({
      projectRoot, mode, delivery, expectedWorkspace: loaded.config.expectedWorkspace,
    }),
  });
  const gateway = createGateway({
    kit,
    resolveDescriptor: source.resolveDescriptor,
    expectedWorkspace: loaded.config.expectedWorkspace,
    journal,
  });
  return {
    mode,
    fixture: false,
    delivery,
    kit,
    configuration: safeConfiguration(loaded),
    // Layouts and the notes inside them are kept per environment: a fixture
    // agent and a live agent may share an identifier and must never share a desk.
    environment: environmentKey({
      mode, workspaceRootSha256: loaded.config.expectedWorkspace.workspaceRootSha256,
    }),
    gateway,
    journal,
    agentWorkspace: createAgentWorkspace({ gateway, schemas, journal }),
    mutations: hasConfirmationSurface
      ? createMutations({ gateway, confirm, journal, schemas })
      : unavailableMutations("confirmation_surface_unavailable"),
    trusted: hasConfirmationSurface
      ? createTrustedActions({ config: loaded.config, confirm, chooseDirectory, journal })
      : unavailableActions("confirmation_surface_unavailable"),
    readRuntimeSummary: async () => ({ mode, fixture: false, ...(await source.readRuntimeSummary()) }),
    claudeAccount: createClaudeAccountReader({ controllerRoot: loaded.config.controllerRoot }),
    claudeUsage: createClaudeUsageReader({ controllerRoot: loaded.config.controllerRoot }),
  };
}
