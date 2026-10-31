// PROTOTYPE. A bridge that lets the desk work with Claude Code directly.
//
// It follows the desk path of the owner's own backend
// (isolateVsCode-orchestrator: project-memory-service.mjs, project-memory-codex.mjs):
//
// - an agent is one lasting conversation with the provider - here one Claude
//   Code session, resumed for every message;
// - the agent is told nothing about a backend. It gets the person's text, and
//   the two memories when it does not have their current version;
// - everything else is done by this code and costs no tokens: recording what
//   was said and done, the state of a turn, questions to the person, stopping.
//
// One thing differs from that backend on purpose: it sent both memories with
// every message, here they travel only when they changed (or the agent's
// session is new, or was compacted).
//
// The four levels and the memories live in plain files (direct-store.mjs); the
// conversation itself lives in Claude Code's own session and is mirrored into
// a transcript as it happens.

import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { plainFromEntries } from "../paperclip/memory-format.mjs";
import { AGENT_TOOLS, claudeProgramOf, loadClaudeSdk, loadZod, readClaudeAccount, startClaudeTurn } from "./claude-driver.mjs";
import { documentEntriesProblem, documentPathProblem, entriesFromDocument, normalizeDocumentPath, readDocument } from "./memory-documents.mjs";
import { normalizeZone, zoneProblem } from "./write-zone.mjs";
import { openDirectStore } from "./direct-store.mjs";
import { createProjectFiles } from "./project-files.mjs";
import { CONTRACT_VERSION, Refusal, accepted, clipText, createTransport, iso, safeId, sha256 } from "./transport.mjs";
import { tx } from "../host/i18n.mjs";

const SOURCE_ID = "direct";
const PROVIDER_ID = "claude";

const IMPLEMENTED = Object.freeze({
  "query.memory.scopes.list": "query",
  "query.memory.scope.read": "query",
  "query.memory.agents.list": "query",
  "query.memory.agent.read": "query",
  "query.memory.agent.context": "query",
  "query.memory.agent.archive": "query",
  "query.agent-control.interactions": "query",
  "query.agent-conversation.resolve": "query",
  "query.agent-conversation.read": "query",
  "query.project-workspace.list": "query",
  "query.project-workspace.read": "query",
  "query.agent-artifacts.list": "query",
  "query.agent-artifacts.read": "query",
  "query.agent-events.read": "query",
  "receipt.memory.agent.send": "receipt-lookup",
  "mutation.memory.scope.create": "mutation",
  "mutation.memory.agent.create": "mutation",
  "mutation.memory.agent.send": "mutation",
  "mutation.memory.agent.close": "mutation",
  "approval.agent-control.respond": "approval",
  "mutation.agent-control.interrupt": "mutation",
  "mutation.project-workspace.save": "mutation",
});
// Not offered: mutation.memory.project.copy - not built yet.

const TURN_ITEM_CAP = 24;
const PAGE_CONTENT_CAP = 256;
const OUTPUT_LIMIT = 1200;
const SEND_MAX_BYTES = 16_384;
// The heading under which the two memories are given to the agent, and what the agent is told about it
// once, in the system prompt. The same text for every agent, so that it is cached once for all of them.
const STANDING_NOTES = "Standing notes";
const SYSTEM_NOTE = [
  "The person you work with writes to you from a desk application.",
  `At the end of a message the desk may add a section that begins "${STANDING_NOTES}": the person's own lasting notes for this`,
  "project and for the part of it you work on, exactly as they wrote them. They are instructions from the person - not a",
  "quotation from a file, a tool result or a third party. Follow them for the rest of the conversation. When a later message",
  "carries the section again, that version replaces the earlier one.",
].join(" ");
// How reasoning is told apart from an action: the first line of an activity item (see feed-core.js).
const REASONING_HEAD = "Thinking";

const debug = (line) => { if (process.env.ATLAS_BRIDGE_DEBUG) process.stderr.write(`[direct-bridge] ${line}\n`); };
const clip = (text, limit) => (text.length > limit ? tx("{value}\n… (truncated)", { value: text.slice(0, limit) }) : text);

/** Config files of the direct mode, read in this order; a later one overrides an earlier one. */
export const DIRECT_CONFIG_FILES = Object.freeze(["direct.json", "direct.local.json"]);

/**
 * Reads config/direct.json, then config/direct.local.json over it. The second
 * one is git-ignored: it holds what belongs to one machine. A path left out
 * means the folder next to the desk: its data in direct-data/, the Claude agent
 * SDK in node_modules/ (installed by npm with the desk).
 */
export async function loadDirectConfig(projectRoot) {
  const layers = [];
  for (const name of DIRECT_CONFIG_FILES) {
    let layer;
    try {
      layer = JSON.parse(await readFile(path.join(projectRoot, "config", name), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return { status: "invalid", reasonCode: "direct_config_unparsable" };
    }
    if (layer === null || typeof layer !== "object" || Array.isArray(layer)) {
      return { status: "invalid", reasonCode: "direct_config_unparsable" };
    }
    layers.push(layer);
  }
  if (layers.length === 0) return { status: "missing", reasonCode: "direct_config_missing" };
  const parsed = Object.assign({}, ...layers);
  const nearby = {
    dataDir: path.join(projectRoot, "direct-data"),
    claudeSdkPath: path.join(projectRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk"),
  };
  if (parsed.claudeConfigDir !== undefined && parsed.claudeConfigDir !== null
    && (typeof parsed.claudeConfigDir !== "string" || !path.isAbsolute(parsed.claudeConfigDir))) {
    return { status: "invalid", reasonCode: "direct_claude_config_dir_invalid" };
  }
  for (const key of ["dataDir", "claudeSdkPath"]) {
    if (parsed[key] === undefined || parsed[key] === null) {
      parsed[key] = nearby[key];
    } else if (typeof parsed[key] !== "string" || !path.isAbsolute(parsed[key])) {
      return { status: "invalid", reasonCode: `direct_${key === "dataDir" ? "data_dir" : "sdk_path"}_invalid` };
    }
  }
  // agentDefaults merge field by field, so a machine can change one of them.
  const defaults = Object.assign({}, ...layers.map((layer) => (
    layer.agentDefaults !== null && typeof layer.agentDefaults === "object" ? layer.agentDefaults : {})));
  return {
    status: "loaded",
    config: Object.freeze({
      dataDir: path.resolve(parsed.dataDir), claudeSdkPath: path.resolve(parsed.claudeSdkPath),
      // Which sign-in of Claude Code the agents use: its folder (CLAUDE_CONFIG_DIR), or null for
      // the machine's default one - the same as `claude` in a terminal.
      claudeConfigDir: typeof parsed.claudeConfigDir === "string" ? path.resolve(parsed.claudeConfigDir) : null,
      // How every turn is started: which settings of the machine Claude Code loads, and what it may do without asking.
      agentDefaults: Object.freeze({
        settingSources: Array.isArray(defaults.settingSources) ? [...defaults.settingSources] : ["project", "local"],
        permissionMode: typeof defaults.permissionMode === "string" ? defaults.permissionMode : "acceptEdits",
        // Which skills Claude Code lists to the model: none, "all", or names (see claude-driver.mjs).
        skills: defaults.skills === "all" || Array.isArray(defaults.skills) ? defaults.skills : [],
        // The built-in tools of every agent: a fixed list (see AGENT_TOOLS in claude-driver.mjs).
        tools: Array.isArray(defaults.tools) && defaults.tools.every((name) => typeof name === "string") ? [...defaults.tools] : [...AGENT_TOOLS],
      }),
    }),
  };
}

/**
 * `startTurn` is what runs a turn: by default Claude Code through the SDK
 * named in the config; a test passes its own and needs no SDK.
 */
export async function createDirectGateway({ kit, config, startTurn = null } = {}) {
  const store = await openDirectStore(config.dataDir);
  const { world } = store;
  const now = () => new Date().toISOString();

  // --- the world -----------------------------------------------------------------------

  let catalogRevision = 1;
  let attentionSequence = 1;
  const changed = () => { catalogRevision += 1; };

  const projectScopeId = (projectId) => `${projectId}-memory`;
  const quarterScopeId = (projectId, quarterId) => `${projectId}-${quarterId}-memory`;
  const emptyMemory = () => ({ revision: 1, entries: [], updatedAtUtc: now(), author: SOURCE_ID });

  function scopeOf({ scopeId, kind, projectId, quarterId, title, memory }) {
    return {
      schemaVersion: 1, scopeId, kind, projectId, quarterId,
      title: clipText(String(title).trim() === "" ? scopeId : String(title), 512),
      revision: memory.revision, sha256: sha256(JSON.stringify(memory.entries)),
      author: safeId(memory.author) ?? SOURCE_ID, updatedAtUtc: memory.updatedAtUtc, entries: memory.entries,
    };
  }
  const projectScope = (project) => scopeOf({ scopeId: projectScopeId(project.projectId), kind: "project",
    projectId: project.projectId, quarterId: null, title: project.title, memory: project.memory });
  const quarterScope = (quarter) => scopeOf({ scopeId: quarterScopeId(quarter.projectId, quarter.quarterId), kind: "quarter",
    projectId: quarter.projectId, quarterId: quarter.quarterId, title: quarter.title, memory: quarter.memory });
  const allScopes = () => [...world.projects.map(projectScope), ...world.quarters.map(quarterScope)];

  const manifestPart = (scope) => ({ scopeId: scope.scopeId, revision: scope.revision, sha256: scope.sha256 });
  function manifestOf(project, quarter) {
    return {
      project: manifestPart(project), quarter: manifestPart(quarter),
      manifestHash: sha256(`${project.scopeId}:${project.revision}:${quarter.scopeId}:${quarter.revision}`),
    };
  }
  const NO_SCOPE = Object.freeze({ scopeId: "unassigned", revision: 1, sha256: sha256("[]"), entries: [] });

  /**
   * The agent's own memory: notes only this agent receives, and its write zone.
   * Written by the person (a trusted action, after confirmation), like the
   * other two; it travels with a message only when it changed.
   */
  const NO_NOTES = Object.freeze({ revision: 0, entries: Object.freeze([]), writeZone: Object.freeze([]), updatedAtUtc: null });
  const notesOf = (agent) => agent.notes ?? NO_NOTES;

  /**
   * An agent's role. A feature agent works on its part; a lead keeps notes up to
   * date - of the whole project, or of one quarter and its agents - and gets
   * those notes with its own. One lead per project and one per quarter.
   */
  const ROLES = Object.freeze(["feature", "project-lead", "quarter-lead"]);
  const roleOf = (agent) => (ROLES.includes(agent.role) ? agent.role : "feature");
  const LEAD_ZONE = Object.freeze(["docs/memory/**"]);
  const ROLE_TEXT = Object.freeze({
    "project-lead": "You lead the whole project: you know how its parts fit together and keep the project's notes up to date. "
      + "You do not change code. The notes of every part of the project are below.",
    "quarter-lead": "You lead this part of the project: you know which agent owns what and keep the notes of this part and of its agents up to date. "
      + "You do not change code. The agents of this part, their write zones and notes are below.",
  });
  const DOCUMENT_TEXT = "When the person asks you to put notes into memory, write them as a markdown document in the project folder "
    + "(every `## heading` becomes a separate entry) and give the person its path. The person reads and approves it in the desk; "
    + "after that, write it with the tool write_memory_from_document. You cannot approve a document yourself.";

  const projectOf = (projectId) => world.projects.find((item) => item.projectId === projectId) ?? null;
  const quarterOf = (projectId, quarterId) => world.quarters.find((item) => item.projectId === projectId && item.quarterId === quarterId) ?? null;

  /** The agent with its project and quarter, or a refusal when there is no such agent. */
  function agentOf(agentId) {
    const agent = world.agents.find((item) => item.agentId === agentId);
    if (agent === undefined) throw new Refusal("source_unavailable", "Unknown agent");
    const project = projectOf(agent.projectId);
    const quarter = quarterOf(agent.projectId, agent.quarterId);
    return { agent, project, quarter, member: project !== null && quarter !== null };
  }

  const running = new Map();
  const conversationIdOf = (agent) => `conversation:${sha256(`direct-conversation:${agent.uid}`)}`;

  function recordOf(agent) {
    const project = projectOf(agent.projectId);
    const quarter = quarterOf(agent.projectId, agent.quarterId);
    const member = project !== null && quarter !== null;
    const scopes = member ? [projectScope(project), quarterScope(quarter)] : [NO_SCOPE, NO_SCOPE];
    const required = manifestOf(scopes[0], scopes[1]);
    const last = agent.operations.at(-1) ?? null;
    const filled = scopes.filter((scope) => scope.entries.length > 0).length;
    const waiting = [...(running.get(agent.agentId)?.asks.values() ?? [])];
    return {
      agentId: agent.agentId,
      projectId: member ? agent.projectId : "unassigned", quarterId: member ? agent.quarterId : "unassigned",
      operationId: agent.createOperationId,
      profile: { ...agent.profile },
      binding: { projectId: transport.workspace.projectId, sourceId: SOURCE_ID, providerId: PROVIDER_ID, threadId: agent.uid },
      assignedManifest: required, requiredManifest: required, deliveredManifest: agent.deliveredManifest,
      currentOperationId: agent.currentOperationId,
      lastOperation: last === null ? null : {
        schemaVersion: 1, operationId: last.operationId, kind: "send", state: last.state,
        requestedAtUtc: last.requestedAtUtc, updatedAtUtc: last.updatedAtUtc,
      },
      problemCode: null,
      contentState: filled === 0 ? "empty" : filled === 2 ? "populated" : "partial",
      deliveryState: agent.state === "archived" ? "archived" : agent.deliveredManifest === null ? "pending" : "delivered",
      state: agent.state, createdAtUtc: agent.createdAtUtc, archivedAtUtc: agent.archivedAtUtc,
      coverage: "captured-only",
      attention: {
        availability: "available", coverage: "captured-only",
        sourceSequence: attentionSequence, sourceRevision: catalogRevision,
        pendingQuestions: waiting.filter((ask) => ask.interaction.kind === "question").length,
        pendingApprovals: waiting.filter((ask) => ask.interaction.kind !== "question").length,
        recoveryRequired: 0, observedAtUtc: now(),
      },
    };
  }

  // --- events: the bridge itself knows when something happened ---------------------------

  const logs = new Map();
  const logOf = (agentId) => {
    if (!logs.has(agentId)) logs.set(agentId, []);
    return logs.get(agentId);
  };
  function note(agentId, kind, turnId = null) {
    const log = logOf(agentId);
    log.push({ sequence: log.length + 1, turnId: safeId(turnId), itemId: null, kind, observedAtUtc: now() });
  }
  const eventCursor = (agentId, sequence) => `direct-events:${transport.instanceId}:${agentId}:${sequence}`;

  function eventsPage(agent, input) {
    const log = logOf(agent.agentId);
    const head = eventCursor(agent.agentId, log.length);
    const page = (mode, reasonCode, events, hasMore, nextCursor) => ({
      schemaVersion: 1, contractVersion: CONTRACT_VERSION, agentId: agent.agentId, conversationId: conversationIdOf(agent),
      mode, reasonCode, coverage: "observed-only", events, hasMore, nextCursor, observedAtUtc: now(),
    });
    if (input.cursor === undefined || input.cursor === null) return page("snapshot-required", "initial_snapshot_required", [], false, head);
    const parts = /^direct-events:([^:]+):(.+):(\d+)$/u.exec(input.cursor);
    if (parts === null || parts[1] !== transport.instanceId || parts[2] !== agent.agentId || Number(parts[3]) > log.length) {
      return page("resync-required", "cursor_invalid", [], false, head);
    }
    const limit = Math.min(input.limit ?? 64, 64);
    const after = log.slice(Number(parts[3]));
    const events = after.slice(0, limit);
    return page("resumed", null, events, after.length > limit, eventCursor(agent.agentId, Number(parts[3]) + events.length));
  }

  // --- conversation --------------------------------------------------------------------

  const ref = (kind, externalId) => ({
    schemaVersion: 1, kind, relationship: SOURCE_ID,
    authority: { schemaVersion: 1, authorityType: "provider", sourceId: SOURCE_ID, externalId, contractVersion: CONTRACT_VERSION },
  });
  const TURN_STATE = Object.freeze({ active: "active", completed: "completed", failed: "failed", interrupted: "interrupted" });

  function questionText(interaction) {
    if (interaction.kind !== "question") return interaction.prompt;
    return interaction.questions.map((question) => {
      const options = question.options.map((option) => option.label).join(" / ");
      return options === "" ? question.prompt : tx("{prompt}\nOptions: {options}", { prompt: question.prompt, options });
    }).join("\n\n");
  }

  /** One turn as chat items, oldest first: what the person said, what the agent did and said, what it asked. */
  function itemsOfTurn(turn, interactions) {
    const memory = turn.said.memory;
    const memoryNote = memory === null ? ""
      : tx("\n\n({value}memory sent with the message: project — revision {revision}, quarter — revision {revision2}{value2})", { value: memory.update ? tx("updated ") : "", revision: memory.project.revision, revision2: memory.quarter.revision, value2: memory.notes ? tx(", agent — revision {revision}", { revision: memory.notes.revision }) : "" });
    const items = [{ kind: "user", at: turn.startedAtUtc, text: `${turn.said.text}${memoryNote}` }];
    const done = turn.items.map((item) => {
      if (item.kind !== "tool" && item.kind !== "change") return item;
      const output = String(item.output ?? "").trim();
      return { kind: item.kind, at: item.at, text: output === "" ? item.title : `${item.title}\n\n${clip(output, OUTPUT_LIMIT)}` };
    });
    const asked = interactions.filter((interaction) => interaction.turnId === turn.turnId).flatMap((interaction) => [
      { kind: "question", at: interaction.createdAtUtc, text: tx("Question: {value}", { value: questionText(interaction) }) },
      ...(interaction.answerText === null ? [] : [{ kind: "user", at: interaction.updatedAtUtc, text: interaction.answerText }]),
    ]);
    // Questions and their answers take their place among the agent's items by time.
    items.push(...[...done, ...asked].sort((a, b) => String(a.at).localeCompare(String(b.at))));
    if (turn.state === "failed" && turn.error) items.push({ kind: "tool", at: turn.completedAtUtc ?? turn.startedAtUtc, text: tx("The turn ended with an error: {error}", { error: turn.error }) });
    return items;
  }

  async function buildConversation(agent) {
    const transcript = await store.transcriptOf(agent.agentId);
    const turns = transcript.turns;
    const active = turns.find((turn) => turn.state === "active") ?? null;
    const newest = turns.reduce((latest, turn) => {
      const at = turn.completedAtUtc ?? turn.startedAtUtc;
      return String(at) > String(latest) ? at : latest;
    }, agent.createdAtUtc);
    // While a turn is going its items keep coming; each rebuild is then a new revision.
    const revision = active === null ? newest : now();
    const threadRef = ref("provider-thread", agent.uid);

    const shaped = turns.map((turn) => {
      let items = itemsOfTurn(turn, transcript.interactions)
        .filter((item) => item.kind === "thinking" || (typeof item.text === "string" && item.text.trim() !== ""));
      let cut = false;
      if (items.length > TURN_ITEM_CAP) {
        items = [...items.slice(0, 6), { kind: "cut", at: items[6].at }, ...items.slice(items.length - (TURN_ITEM_CAP - 7))];
        cut = true;
      }
      const turnRef = ref("provider-turn", turn.turnId);
      const content = items.map((item, index) => {
        const base = {
          schemaVersion: 1, contractVersion: CONTRACT_VERSION, provider: { ...transport.provider },
          itemRef: ref("provider-item", `${turn.turnId}:${index}`), turnRef,
          observedAtUtc: iso(item.at ?? turn.startedAtUtc),
        };
        if ((item.kind === "thinking" && item.text === null) || item.kind === "cut") {
          return { ...base, contentClass: "omitted", role: null, visibility: "omitted", text: null, contentSha256: null,
            omissionReason: item.kind === "thinking" ? "hidden_reasoning" : "oversized_content" };
        }
        // The contract has no class for reasoning: it travels as activity whose first line says what it is.
        const text = clipText(item.kind === "thinking" ? `${REASONING_HEAD}\n\n${item.text}` : item.text);
        const shape = {
          user: ["user-message", "user"], assistant: ["assistant-message", "assistant"],
          tool: ["tool-summary", "tool"], change: ["change-summary", "tool"], question: ["interaction-summary", "assistant"],
          thinking: ["tool-summary", "tool"],
        }[item.kind];
        return { ...base, contentClass: shape[0], role: shape[1], visibility: "user-visible", text,
          contentSha256: sha256(text), omissionReason: null };
      });
      return {
        turn: { turnRef, threadRef, state: TURN_STATE[turn.state] ?? "unknown", startedAtUtc: iso(turn.startedAtUtc),
          completedAtUtc: turn.completedAtUtc === null ? null : iso(turn.completedAtUtc), itemCount: content.length },
        content, cut,
      };
    });

    return {
      revision, shaped,
      thread: {
        threadRef, parentThreadRef: null,
        activeTurnRef: active === null ? null : ref("provider-turn", active.turnId),
        title: clipText(agent.agentId, 256),
        state: turns.length === 0 ? "empty" : active === null ? "idle" : "active",
        archived: agent.state === "archived", updatedAtUtc: revision,
      },
    };
  }

  function bindingOf(agent, member) {
    const base = { schemaVersion: 1, contractVersion: CONTRACT_VERSION, agentId: agent.agentId, archiveCoverage: "captured-only" };
    if (!member) return { ...base, conversationId: null, liveRead: { status: "unavailable", reasonCode: "agent_unbound" } };
    const conversationId = conversationIdOf(agent);
    if (agent.state === "archived") return { ...base, conversationId, liveRead: { status: "unavailable", reasonCode: "agent_archived" } };
    return { ...base, conversationId, liveRead: { status: "available", reasonCode: "available" } };
  }

  async function conversationPage({ agent, member }, input) {
    const binding = bindingOf(agent, member);
    if (binding.liveRead.status !== "available") {
      throw new Refusal("source_unavailable", "Live read unavailable", binding.liveRead.reasonCode);
    }
    const limit = input.limit ?? 32;
    const built = await buildConversation(agent);
    let offset = 0;
    if (input.cursor !== undefined && input.cursor !== null) {
      const parts = /^direct-conv:(\d+):(\d+):(.+)$/u.exec(input.cursor);
      if (parts === null) throw new Refusal("stale_revision", "Unknown conversation cursor", "cursor_invalid");
      if (Number(parts[2]) !== limit) throw new Refusal("conflict", "Continue with the same limit", "limit_changed");
      if (parts[3] !== built.revision) throw new Refusal("stale_revision", "The conversation moved on", "stale_revision");
      offset = Number(parts[1]);
    }
    // A page holds whole turns, at most `limit` of them and at most 256 content items.
    const chosen = [];
    let count = 0;
    for (const entry of built.shaped.slice(offset, offset + limit)) {
      if (chosen.length > 0 && count + entry.content.length > PAGE_CONTENT_CAP) break;
      chosen.push(entry);
      count += entry.content.length;
    }
    const next = offset + chosen.length;
    const content = chosen.flatMap((entry) => entry.content).slice(0, PAGE_CONTENT_CAP);
    const reasons = [
      chosen.some((entry) => entry.cut) ? "turn_items_cut" : null,
      content.some((item) => item.omissionReason === "hidden_reasoning") ? "hidden_reasoning_omitted" : null,
    ].filter((reason) => reason !== null);
    return {
      schemaVersion: 1, contractVersion: CONTRACT_VERSION, agentId: agent.agentId,
      conversationId: binding.conversationId, mode: "provider-read", revision: built.revision,
      nextCursor: next < built.shaped.length ? `direct-conv:${next}:${limit}:${built.revision}` : null,
      observedAtUtc: now(), thread: built.thread,
      turns: chosen.map((entry) => entry.turn), content,
      completeness: reasons.length === 0 ? { status: "complete", reasonCode: null } : { status: "partial", reasonCode: reasons[0] },
    };
  }

  /** The same conversation as captured archive records, for an agent that can no longer be read live. */
  async function archivePage(agent, input) {
    const built = await buildConversation(agent);
    const KIND = Object.freeze({
      "user-message": "submission", "assistant-message": "message", "tool-summary": "activity",
      "change-summary": "activity", "interaction-summary": "interaction", omitted: "omission",
    });
    const all = built.shaped.flatMap((entry) => entry.content.map((item) => ({ item, turn: entry.turn })));
    const limit = Math.min(input.limit ?? 32, 100);
    const offset = input.cursor === undefined || input.cursor === null ? 0 : Number(/^direct-arch:(\d+)$/u.exec(input.cursor)?.[1] ?? NaN);
    if (!Number.isSafeInteger(offset)) throw new Refusal("conflict", "Unknown archive cursor");
    const items = all.slice(offset, offset + limit).map(({ item, turn }, index) => {
      const sequence = offset + index + 1;
      return {
        firstSequence: sequence, sequence, contentSha256: item.contentSha256 ?? sha256(`omitted:${sequence}`),
        observedAtUtc: item.observedAtUtc,
        record: {
          recordId: `direct-archive-${sequence}`, kind: KIND[item.contentClass], role: item.role,
          state: turn.state === "active" ? "started" : "completed", text: item.text,
          providerTurnId: safeId(item.turnRef.authority.externalId), providerItemId: null, requestId: null,
          occurredAtUtc: item.observedAtUtc, omissions: item.omissionReason === null ? [] : [item.omissionReason],
        },
      };
    });
    return {
      schemaVersion: 1, agentId: agent.agentId, revision: all.length, coverage: "captured-only", items,
      nextCursor: offset + limit < all.length ? `direct-arch:${offset + limit}` : null,
    };
  }

  // --- questions -------------------------------------------------------------------------
  //
  // Claude Code asks the person in two ways: it wants to do something it may not
  // do without asking (a shell command, say), or it has a question of its own
  // (its AskUserQuestion tool). Both stop the turn until the person decides; the
  // turn's process waits, and the desk shows the request under "Questions".

  const INTERACTION_STATE = Object.freeze({ pending: "awaiting-owner", expired: "expired" });

  function interactionRecord(agent, interaction, sequence) {
    const question = interaction.kind === "question";
    const requestSha256 = sha256(`${interaction.id}:${JSON.stringify(question ? interaction.questions : interaction.prompt)}`);
    const record = {
      schemaVersion: 1, contractVersion: CONTRACT_VERSION,
      interactionId: interaction.id, conversationId: conversationIdOf(agent),
      provider: { adapterId: SOURCE_ID, adapterVersion: "v0.1.0", sourceId: SOURCE_ID, runtimeInstanceId: transport.instanceId },
      providerRequest: {
        // The method names the form of answer the host builds: text answers for
        // questions, accept or decline for everything else.
        method: question ? "item/tool/requestUserInput" : "item/claude/requestPermission",
        requestId: interaction.id, requestIdType: "string", generation: 1, threadId: agent.uid,
        turnId: interaction.turnId, itemId: interaction.id, requestSha256,
      },
      interactionRequest: {
        requestId: interaction.id, requestSha256, sourceSequence: sequence,
        owner: { schemaVersion: 1, actorType: "local-operator", actorId: "local-board" },
        allowedResponses: question ? ["submit-text", "cancel"] : ["accept", "decline"],
      },
      display: question
        ? { kind: "user-input", title: clipText(interaction.title, 4096),
          fields: { questions: interaction.questions.map((item) => ({
            id: item.id,
            prompt: tx("{prompt}{value}", { prompt: item.prompt, value: item.options.length === 0 ? "" : tx(" Options: {value}", { value: item.options.map((option) => option.label).join(" / ") }) }),
          })) } }
        : { kind: "permission-approval", title: clipText(interaction.title, 4096),
          fields: { prompt: interaction.prompt, tool: interaction.toolName } },
      state: INTERACTION_STATE[interaction.status] ?? "resolved",
      response: null, providerResponseSha256: null,
      requestedAtUtc: interaction.createdAtUtc,
      // Claude Code sets no deadline on a question; none is invented here.
      deadlineAtUtc: null,
      updatedAtUtc: interaction.updatedAtUtc,
      automaticRetryAllowed: false,
    };
    return { ...record, recordSha256: sha256(JSON.stringify(record)) };
  }

  async function interactionRecords(agent, limit) {
    const transcript = await store.transcriptOf(agent.agentId);
    const records = transcript.interactions.map((interaction, index) => interactionRecord(agent, interaction, index + 1));
    return {
      schemaVersion: 1, contractVersion: CONTRACT_VERSION, agentId: agent.agentId, sourceSequence: attentionSequence,
      records: records.slice(-limit), truncated: records.length > limit, omissionCount: Math.max(0, records.length - limit),
    };
  }

  /** What Claude Code wants to do, in a line a person can decide on. */
  function permissionPrompt(toolName, input, details) {
    if (typeof details?.title === "string" && details.title.trim() !== "") return details.title;
    if (toolName === "Bash" && typeof input?.command === "string") return tx("Run command: {command}", { command: input.command });
    if (typeof input?.file_path === "string") return `${toolName}: ${input.file_path}`;
    return `${toolName} ${clip(JSON.stringify(input ?? {}), 300)}`;
  }

  /** Puts a request before the person and waits for the decision; the turn's process waits with it. */
  async function askPerson(agent, turn, entry, toolName, input, details) {
    const transcript = await store.transcriptOf(agent.agentId);
    const at = now();
    const asked = toolName === "AskUserQuestion" && Array.isArray(input?.questions);
    const interaction = {
      id: `ask-${randomUUID()}`, turnId: turn.turnId, status: "pending", createdAtUtc: at, updatedAtUtc: at, answerText: null,
      ...(asked
        ? { kind: "question", title: tx("Agent question"), questions: input.questions.map((question, index) => ({
          id: `q${index + 1}`, prompt: String(question.question ?? ""), key: String(question.question ?? ""),
          options: (question.options ?? []).map((option, position) => ({ id: `o${position + 1}`, label: String(option.label ?? "") })),
        })) }
        : { kind: "permission", title: tx("Permission for an action"), toolName, prompt: permissionPrompt(toolName, input, details) }),
    };
    transcript.interactions.push(interaction);
    attentionSequence += 1;
    note(agent.agentId, "interaction-changed", turn.turnId);
    await store.saveTranscript(agent.agentId);
    return new Promise((resolve) => {
      entry.asks.set(interaction.id, { interaction, input, resolve });
      details?.signal?.addEventListener("abort", () => {
        // The turn ended without an answer: the request is over, nobody decided it.
        if (!entry.asks.delete(interaction.id)) return;
        Object.assign(interaction, { status: "expired", updatedAtUtc: now() });
        attentionSequence += 1;
        resolve({ behavior: "deny", message: "The turn ended before the person decided." });
      }, { once: true });
    });
  }

  /** The option a typed answer names: its label, its id or its number in the list. */
  function optionFor(question, text) {
    const wanted = text.trim().toLowerCase();
    return question.options.find((option) => option.label.toLowerCase() === wanted || option.id.toLowerCase() === wanted)
      ?? (/^\d+$/.test(wanted) ? question.options[Number(wanted) - 1] : undefined) ?? null;
  }

  async function respond({ agent }, input) {
    const response = input.response ?? {};
    const transcript = await store.transcriptOf(agent.agentId);
    const interaction = transcript.interactions.find((item) => item.id === response.interactionId);
    if (interaction === undefined) throw new Refusal("source_unavailable", "Unknown interaction");
    if (interaction.status !== "pending") throw new Refusal("conflict", "The request already has a decision");
    const before = interactionRecord(agent, interaction, 0);
    if (response.requestSha256 !== before.providerRequest.requestSha256) throw new Refusal("conflict", "Request identity does not match");
    if (!before.interactionRequest.allowedResponses.includes(response.selectedResponse)) {
      throw new Refusal("conflict", "Choice is not allowed for this request");
    }
    const entry = running.get(agent.agentId);
    const ask = entry?.asks.get(interaction.id);
    if (ask === undefined) throw new Refusal("conflict", "The turn that asked is no longer waiting", "request_not_waiting");

    let decision;
    if (response.selectedResponse === "submit-text") {
      const typed = response.providerResponse?.answers ?? {};
      const answers = {};
      const said = [];
      for (const question of interaction.questions) {
        const text = String(typed[question.id]?.answers?.[0] ?? "");
        const chosen = optionFor(question, text)?.label ?? text;
        answers[question.key] = chosen;
        said.push(chosen);
      }
      decision = { behavior: "allow", updatedInput: { ...ask.input, answers } };
      Object.assign(interaction, { status: "answered", answerText: tx("Answer to the question: {value}", { value: said.join("; ") }) });
    } else if (response.selectedResponse === "accept") {
      decision = { behavior: "allow", updatedInput: ask.input };
      Object.assign(interaction, { status: "accepted", answerText: tx("Allowed.") });
    } else if (response.selectedResponse === "decline") {
      decision = { behavior: "deny", message: "The person declined this action." };
      Object.assign(interaction, { status: "rejected", answerText: tx("Declined.") });
    } else {
      // "cancel" on a question: the person chose not to answer it.
      decision = { behavior: "deny", message: "The person chose not to answer." };
      Object.assign(interaction, { status: "expired", answerText: tx("The question was left unanswered.") });
    }
    interaction.updatedAtUtc = now();
    entry.asks.delete(interaction.id);
    attentionSequence += 1;
    note(agent.agentId, "interaction-changed", interaction.turnId);
    await store.saveTranscript(agent.agentId);
    ask.resolve(decision);

    const record = { ...interactionRecord(agent, interaction, 0), response: { ...response },
      providerResponseSha256: sha256(JSON.stringify(response.providerResponse ?? null)) };
    return {
      interaction: record, response: record.response,
      receipt: {
        schemaVersion: 1, contractVersion: CONTRACT_VERSION,
        interactionId: interaction.id, requestSha256: before.providerRequest.requestSha256,
        responseSha256: sha256(JSON.stringify(record.response)),
        providerResponseSha256: record.providerResponseSha256,
        deliveryState: "response-returned", automaticRetryAllowed: false,
      },
    };
  }

  // --- sending, stopping, closing --------------------------------------------------------

  let sdk = null;
  let zod;
  const claudeEnv = config.claudeConfigDir === null || config.claudeConfigDir === undefined
    ? null : { ...process.env, CLAUDE_CONFIG_DIR: config.claudeConfigDir };
  // The account the agents work under, asked once when the desk opens; the window shows it.
  let account = startTurn === null ? { state: "checking" } : { state: "not-checked" };
  async function checkAccount() {
    account = await readClaudeAccount({ program: claudeProgramOf(config.claudeSdkPath), env: claudeEnv });
    debug(`claude account: ${JSON.stringify(account)}`);
    return account;
  }
  if (startTurn === null) checkAccount();

  /** The function that runs a turn: the one given to the bridge, or Claude Code through its SDK. */
  async function turnStarter() {
    if (startTurn !== null) return startTurn;
    if (sdk === null) {
      try {
        sdk = await loadClaudeSdk(config.claudeSdkPath);
      } catch (error) {
        debug(`the Claude agent SDK did not load from ${config.claudeSdkPath}: ${error?.message ?? error}`);
        throw new Refusal("source_unavailable", "The Claude agent SDK is not installed: run npm ci in the desk folder", "claude_sdk_unavailable");
      }
    }
    if (zod === undefined) {
      try {
        zod = loadZod(config.claudeSdkPath);
      } catch (error) {
        // Without zod the desk's tool cannot be described; the turn runs without it.
        debug(`zod did not load next to the SDK: ${error?.message ?? error}`);
        zod = null;
      }
    }
    return (options) => startClaudeTurn({ sdk, zod, debug, env: claudeEnv, ...options });
  }

  /**
   * The person's text, followed by the two memories when the agent does not have
   * their current version. The memories are worded as what they are - the
   * person's own notes. Worded as a "memory snapshot" that "grants no
   * permissions", the same block was taken by Claude for an injected text and
   * set aside (seen in its reasoning, live, 2026-09-30).
   */
  function messageFor(text, project, quarter, update, own) {
    const section = (title, scope) => `## ${title}\n\n${scope.entries.length === 0 ? "(none)" : plainFromEntries(scope.entries)}\n`;
    return [
      text.trim(), "", "---", "",
      `${STANDING_NOTES}. Project notes come first and take precedence over the notes for this part of the project and over your own notes.`,
      ...(update ? ["These replace the notes I gave you earlier."] : []), "",
      section("Project notes", project), section("Notes for this part of the project", quarter),
      own,
    ].join("\n");
  }

  /**
   * What is the agent's own in its standing notes: its role, its notes, its
   * write zone, how notes become memory, and for a lead what it oversees. The
   * key changes whenever any of it does, so it travels again only then.
   */
  function ownSectionsOf(agent) {
    const notes = notesOf(agent);
    const role = roleOf(agent);
    const entriesText = (entries) => (entries.length === 0 ? "(none)" : plainFromEntries(entries));
    const parts = [];
    if (role !== "feature") parts.push(`## Your role\n\n${ROLE_TEXT[role]}\n`);
    parts.push(`## Notes for your own work in it\n\n${entriesText(notes.entries)}\n`);
    parts.push(notes.writeZone.length === 0
      ? "## Where you may change files\n\nAnywhere in the project folder.\n"
      : `## Where you may change files\n\nOnly here (paths from the root of the project folder):\n\n${notes.writeZone.map((pattern) => `- ${pattern}`).join("\n")}\n\nEverything else in the folder belongs to other agents: read it, do not change it. A change outside these paths is refused.\n`);
    parts.push(`## Putting notes into memory\n\n${DOCUMENT_TEXT}\n`);
    if (role === "project-lead") {
      const quarters = world.quarters.filter((quarter) => quarter.projectId === agent.projectId);
      parts.push(`## Notes of each part of the project\n\n${quarters.length === 0 ? "(none)\n"
        : quarters.map((quarter) => `### ${quarter.title} (${quarter.quarterId})\n\n${entriesText(quarter.memory.entries)}\n`).join("\n")}`);
    }
    if (role === "quarter-lead") {
      const others = world.agents.filter((other) => other.agentId !== agent.agentId && other.state !== "archived"
        && other.projectId === agent.projectId && other.quarterId === agent.quarterId);
      parts.push(`## The agents of this part\n\n${others.length === 0 ? "(none)\n" : others.map((other) => {
        const theirs = notesOf(other);
        const zone = theirs.writeZone.length === 0 ? "the whole folder" : theirs.writeZone.join(", ");
        return `### ${other.agentId}${roleOf(other) === "feature" ? "" : ` (${roleOf(other)})`}\n\nWrite zone: ${zone}\n\n${entriesText(theirs.entries)}\n`;
      }).join("\n")}`);
    }
    const text = parts.join("\n");
    return { text, key: sha256(JSON.stringify({ revision: notes.revision, text })) };
  }

  /** Which memories an agent may fill from an approved document. */
  function targetsOf(agent) {
    const targets = [{ kind: "agent", id: agent.agentId, title: tx("memory of agent {agentId}", { agentId: agent.agentId }) }];
    const role = roleOf(agent);
    const project = projectOf(agent.projectId);
    const quarter = quarterOf(agent.projectId, agent.quarterId);
    if (role === "project-lead" && project !== null) {
      targets.unshift({ kind: "project", id: projectScopeId(project.projectId), title: tx("memory of project {title}", { title: project.title }) });
    }
    if (role === "quarter-lead" && quarter !== null) {
      targets.unshift({ kind: "quarter", id: quarterScopeId(quarter.projectId, quarter.quarterId), title: tx("memory of quarter {title}", { title: quarter.title }) });
      for (const other of world.agents) {
        if (other.agentId === agent.agentId || other.state === "archived" || other.projectId !== agent.projectId || other.quarterId !== agent.quarterId) continue;
        targets.push({ kind: "agent", id: other.agentId, title: tx("memory of agent {agentId}", { agentId: other.agentId }) });
      }
    }
    return targets;
  }

  /** The memory a target names, with its revision and a writer; null when it is gone. */
  function memoryOf(target) {
    if (target.kind === "project") {
      const home = world.projects.find((project) => projectScopeId(project.projectId) === target.id);
      return home === undefined ? null : { revision: home.memory.revision, write: (entries, author) => {
        home.memory = { revision: home.memory.revision + 1, updatedAtUtc: now(), author, entries };
        return home.memory.revision;
      } };
    }
    if (target.kind === "quarter") {
      const home = world.quarters.find((quarter) => quarterScopeId(quarter.projectId, quarter.quarterId) === target.id);
      return home === undefined ? null : { revision: home.memory.revision, write: (entries, author) => {
        home.memory = { revision: home.memory.revision + 1, updatedAtUtc: now(), author, entries };
        return home.memory.revision;
      } };
    }
    const owner = world.agents.find((agent) => agent.agentId === target.id && agent.state !== "archived");
    return owner === undefined ? null : { revision: notesOf(owner).revision, write: (entries) => {
      const before = notesOf(owner);
      owner.notes = { revision: before.revision + 1, updatedAtUtc: now(), writeZone: [...before.writeZone], entries };
      return owner.notes.revision;
    } };
  }

  const operationView = (agent, operation) => ({
    schemaVersion: 1, operationId: operation.operationId, agentId: agent.agentId, kind: "send", state: operation.state,
    turnId: operation.turnId, intentHash: operation.intentHash, manifest: operation.manifest,
    requestedAtUtc: operation.requestedAtUtc, updatedAtUtc: operation.updatedAtUtc,
  });

  async function send({ agent, project, quarter, member }, input) {
    const text = String(input.text ?? "");
    const intentHash = sha256(JSON.stringify({ agentId: agent.agentId, operationId: input.operationId, text }));
    const previous = agent.operations.find((operation) => operation.operationId === input.operationId);
    if (previous !== undefined) {
      // The same operation id returns the send it already made; with another text it is a mistake, not a resend.
      if (previous.intentHash !== intentHash) throw new Refusal("conflict", "This operation id was used for another message", "operation_identity_conflict");
      return accepted(operationView(agent, previous));
    }
    if (!member) throw new Refusal("conflict", "The agent has no project and quarter", "agent_unbound");
    if (agent.state !== "active") throw new Refusal("conflict", "The agent is not active", `agent_${agent.state}`);
    // One piece of work at a time: busy work is refused, never queued behind the person's back.
    if (agent.currentOperationId !== null) throw new Refusal("conflict", "The agent is busy", "agent_busy");
    if (text.trim() === "" || Buffer.byteLength(text, "utf8") > SEND_MAX_BYTES) throw new Refusal("conflict", "The message is empty or too long", "message_invalid");
    if (project.workspacePath === null) throw new Refusal("conflict", "Bind the project folder first", "workspace_not_bound");
    try {
      if (!(await lstat(project.workspacePath)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Refusal("source_unavailable", "Project folder is gone", "workspace_path_missing");
    }
    const run = await turnStarter();

    const scopes = [projectScope(project), quarterScope(quarter)];
    const required = manifestOf(scopes[0], scopes[1]);
    const notes = notesOf(agent);
    const own = ownSectionsOf(agent);
    const notesKey = own.key;
    const notesGiven = (agent.deliveredNotesKey ?? null) !== null;
    // The memory travels when the agent does not have this version - and not at all while there is nothing in it yet.
    const stale = agent.deliveredManifest?.manifestHash !== required.manifestHash || (agent.deliveredNotesKey ?? null) !== notesKey;
    const anything = scopes.some((scope) => scope.entries.length > 0) || notes.entries.length > 0 || notes.writeZone.length > 0;
    const carried = stale && (anything || agent.deliveredManifest !== null || notesGiven);
    const update = carried && (agent.deliveredManifest !== null || notesGiven);

    const at = now();
    const turn = {
      turnId: `turn-${randomUUID()}`, operationId: input.operationId, state: "active", startedAtUtc: at, completedAtUtc: null,
      said: { text: text.trim(), memory: carried ? { project: required.project, quarter: required.quarter, update, notes: { revision: notes.revision } } : null },
      items: [], usage: null, error: null,
    };
    const operation = { operationId: input.operationId, intentHash, state: "accepted", turnId: turn.turnId, manifest: required,
      requestedAtUtc: at, updatedAtUtc: at, usage: null };
    const transcript = await store.transcriptOf(agent.agentId);
    transcript.turns.push(turn);
    agent.operations.push(operation);
    agent.currentOperationId = operation.operationId;
    changed();
    await Promise.all([store.saveWorld(), store.saveTranscript(agent.agentId)]);

    const entry = { operationId: operation.operationId, turn, asks: new Map(), control: null, settled: null };
    running.set(agent.agentId, entry);
    const seen = new Set();
    let saving = null;
    const saveSoon = () => {
      if (saving !== null) return;
      saving = setTimeout(() => { saving = null; store.saveTranscript(agent.agentId).catch(() => {}); }, 400);
    };
    note(agent.agentId, "turn-started", turn.turnId);
    entry.control = run({
      cwd: project.workspacePath, sessionId: agent.sessionId,
      text: carried ? messageFor(text, scopes[0], scopes[1], update, own.text) : text.trim(),
      deskTools: { writeMemoryFromDocument: (documentPath) => writeMemoryFromDocument(agent.agentId, documentPath) },
      writeZone: notes.writeZone.length === 0 ? null : [...notes.writeZone],
      model: agent.profile.model === "default" ? null : agent.profile.model,
      effort: agent.profile.reasoningEffort === "default" ? null : agent.profile.reasoningEffort,
      settingSources: config.agentDefaults.settingSources, permissionMode: config.agentDefaults.permissionMode,
      skills: config.agentDefaults.skills, tools: config.agentDefaults.tools ?? AGENT_TOOLS, systemNote: SYSTEM_NOTE,
      onSession: (sessionId) => {
        // The message is in the session now: the agent has this memory, and the turn has begun.
        Object.assign(agent, { sessionId, deliveredManifest: required, deliveredNotesKey: notesKey });
        Object.assign(operation, { state: "started", updatedAtUtc: now() });
        changed();
        store.saveWorld().catch(() => {});
      },
      // A compacted session keeps a summary, not the text: the memory is given again with the next message.
      onCompacted: () => { Object.assign(agent, { deliveredManifest: null, deliveredNotesKey: null }); },
      onItem: (item) => {
        if (!seen.has(item)) {
          seen.add(item);
          turn.items.push(item);
        }
        note(agent.agentId, "item-completed", turn.turnId);
        saveSoon();
      },
      askPerson: (toolName, toolInput, details) => askPerson(agent, turn, entry, toolName, toolInput, details),
    });
    entry.settled = entry.control.finished.then(async (outcome) => {
      if (saving !== null) clearTimeout(saving);
      const ended = now();
      for (const ask of entry.asks.values()) Object.assign(ask.interaction, { status: "expired", updatedAtUtc: ended });
      entry.asks.clear();
      running.delete(agent.agentId);
      Object.assign(turn, { state: outcome.state, completedAtUtc: ended, usage: outcome.usage, error: outcome.error });
      Object.assign(operation, { state: outcome.state, updatedAtUtc: ended, usage: outcome.usage });
      if (outcome.sessionId !== null) agent.sessionId = outcome.sessionId;
      agent.currentOperationId = null;
      changed();
      attentionSequence += 1;
      note(agent.agentId, "turn-completed", turn.turnId);
      await Promise.all([store.saveWorld(), store.saveTranscript(agent.agentId)]).catch(() => {});
    });
    return accepted(operationView(agent, operation));
  }

  function receipt({ agent }, input) {
    const operation = agent.operations.find((item) => item.operationId === input.operationId);
    if (operation === undefined) throw new Refusal("source_unavailable", "Unknown operation");
    const going = operation.state === "accepted" || operation.state === "started";
    return { ...operationView(agent, operation), observation: going ? "available" : "terminal", automaticRetryAllowed: false };
  }

  async function interrupt({ agent }, input) {
    const entry = running.get(agent.agentId);
    if (entry === undefined || entry.operationId !== input.operationId) {
      throw new Refusal("conflict", "There is no running turn to stop", "no_active_turn");
    }
    await entry.control.interrupt();
    return accepted({ operationId: input.operationId, turnId: entry.turn.turnId, state: "accepted", automaticRetryAllowed: false });
  }

  async function closeAgent({ agent }) {
    if (agent.currentOperationId !== null) throw new Refusal("conflict", "The current turn is not terminal", "agent_busy");
    Object.assign(agent, { state: "archived", archivedAtUtc: now() });
    changed();
    await store.saveWorld();
    return recordOf(agent);
  }

  // --- creating --------------------------------------------------------------------------

  async function createScope(input) {
    if (input.kind === "project") {
      if (projectOf(input.projectId) !== null) throw new Refusal("conflict", "Project already exists");
      world.projects.push({ projectId: input.projectId, title: String(input.title ?? input.projectId), workspacePath: null,
        createdAtUtc: now(), memory: emptyMemory() });
    } else {
      if (projectOf(input.projectId) === null) throw new Refusal("source_unavailable", "Unknown project");
      if (quarterOf(input.projectId, input.quarterId) !== null) throw new Refusal("conflict", "Quarter already exists");
      world.quarters.push({ projectId: input.projectId, quarterId: input.quarterId, title: String(input.title ?? input.quarterId),
        createdAtUtc: now(), memory: emptyMemory() });
    }
    changed();
    await store.saveWorld();
    return allScopes().find((scope) => scope.scopeId === input.scopeId);
  }

  async function createAgent(input) {
    if (world.agents.some((agent) => agent.agentId === input.agentId)) throw new Refusal("conflict", "Agent already exists");
    const project = projectOf(input.projectId);
    if (project === null || quarterOf(input.projectId, input.quarterId) === null) {
      throw new Refusal("source_unavailable", "Both the project and the quarter must exist first");
    }
    // Claude Code works in a folder: without one there is nowhere to start it.
    if (project.workspacePath === null) throw new Refusal("conflict", "Bind the project folder first", "workspace_not_bound");
    if (input.profile.provider !== PROVIDER_ID) throw new Refusal("conflict", "Only Claude Code is connected", "profile_provider_unknown");
    const agent = {
      uid: randomUUID(), agentId: input.agentId, projectId: input.projectId, quarterId: input.quarterId,
      profile: { provider: PROVIDER_ID, model: input.profile.model, reasoningEffort: input.profile.reasoningEffort, fallbackPolicy: "deny" },
      state: "active", createdAtUtc: now(), archivedAtUtc: null, createOperationId: input.operationId,
      sessionId: null, deliveredManifest: null, currentOperationId: null, operations: [],
      notes: { ...NO_NOTES, entries: [], writeZone: [] }, deliveredNotesKey: null,
    };
    world.agents.push(agent);
    changed();
    await store.saveWorld();
    return recordOf(agent);
  }

  // --- memory writes and the folder (called by the host's trusted actions) ----------------

  async function saveMemory({ scopeId, expectedRevision, entries }) {
    const home = world.projects.find((project) => projectScopeId(project.projectId) === scopeId)
      ?? world.quarters.find((quarter) => quarterScopeId(quarter.projectId, quarter.quarterId) === scopeId) ?? null;
    if (home === null) return { ok: false, error: { code: "source_unavailable", reasonCode: "scope_unknown" } };
    if (home.memory.revision !== expectedRevision) return { ok: false, error: { code: "stale_revision", reasonCode: "stale_revision" } };
    home.memory = { revision: home.memory.revision + 1, updatedAtUtc: now(), author: "local-board",
      entries: entries.map((entry) => ({ id: entry.id, title: entry.title, text: entry.text })) };
    changed();
    await store.saveWorld();
    return { ok: true, receipt: {
      status: "written", scopeId, revision: home.memory.revision, sha256: sha256(JSON.stringify(home.memory.entries)),
      entryCount: entries.length, replay: false,
    } };
  }

  /** The agent's own notes and write zone, and whether the agent already has this version. */
  async function agentNotes({ agentId }) {
    const agent = world.agents.find((item) => item.agentId === agentId);
    if (agent === undefined) return { ok: false, error: { code: "source_unavailable", reasonCode: "agent_unknown" } };
    const notes = notesOf(agent);
    return { ok: true, data: {
      agentId, revision: notes.revision, entries: notes.entries.map((entry) => ({ ...entry })), writeZone: [...notes.writeZone],
      updatedAtUtc: notes.updatedAtUtc, delivered: (agent.deliveredNotesKey ?? null) === ownSectionsOf(agent).key,
      role: roleOf(agent), targets: targetsOf(agent),
      grants: grants().filter((grant) => grant.agentId === agentId).slice(-10).map((grant) => ({ ...grant, target: { ...grant.target } })),
    } };
  }

  // --- roles and memory documents --------------------------------------------------------

  const grants = () => {
    if (!Array.isArray(world.memoryGrants)) world.memoryGrants = [];
    return world.memoryGrants;
  };

  /** Makes an agent a feature agent or a lead. A new lead with no zone gets docs/memory/**. */
  async function setAgentRole({ agentId, role }) {
    const agent = world.agents.find((item) => item.agentId === agentId);
    if (agent === undefined) return { ok: false, error: { code: "source_unavailable", reasonCode: "agent_unknown" } };
    if (agent.state === "archived") return { ok: false, error: { code: "conflict", reasonCode: "agent_archived" } };
    if (!ROLES.includes(role)) return { ok: false, error: { code: "invalid_input", reasonCode: "role_unknown" } };
    const taken = world.agents.find((other) => other.agentId !== agentId && other.state !== "archived" && roleOf(other) === role
      && other.projectId === agent.projectId && (role === "project-lead" || other.quarterId === agent.quarterId));
    if (role !== "feature" && taken !== undefined) {
      return { ok: false, error: { code: "conflict", reasonCode: "lead_taken", message: `${taken.agentId} already leads it` } };
    }
    agent.role = role;
    const notes = notesOf(agent);
    if (role !== "feature" && notes.writeZone.length === 0) {
      agent.notes = { ...notes, entries: notes.entries.map((entry) => ({ ...entry })), writeZone: [...LEAD_ZONE], revision: notes.revision + 1, updatedAtUtc: now() };
    }
    changed();
    await store.saveWorld();
    return { ok: true, data: { agentId, role, writeZone: [...notesOf(agent).writeZone] } };
  }

  /** Reads a memory document for the person's confirmation: what would be written where. */
  async function previewMemoryDocument({ agentId, path: documentPath, target }) {
    const agent = world.agents.find((item) => item.agentId === agentId);
    if (agent === undefined || agent.state === "archived") return { ok: false, error: { code: "source_unavailable", reasonCode: "agent_unknown" } };
    const chosen = targetsOf(agent).find((item) => item.kind === target?.kind && item.id === target?.id);
    if (chosen === undefined) return { ok: false, error: { code: "conflict", reasonCode: "memory_target_not_allowed" } };
    const project = projectOf(agent.projectId);
    if (project?.workspacePath === null || project === null) return { ok: false, error: { code: "conflict", reasonCode: "workspace_not_bound" } };
    const relative = normalizeDocumentPath(documentPath);
    const read = await readDocument(project.workspacePath, relative);
    if (!read.ok) return { ok: false, error: { code: "invalid_input", reasonCode: read.reasonCode } };
    const entries = entriesFromDocument(read.text, relative.split("/").at(-1));
    const problem = documentEntriesProblem(entries);
    if (problem !== null) return { ok: false, error: { code: "invalid_input", reasonCode: problem } };
    return { ok: true, data: { path: relative, target: { kind: chosen.kind, id: chosen.id }, targetTitle: chosen.title,
      contentSha256: read.sha256, entryCount: entries.length, excerpt: clip(read.text.trim(), 600) } };
  }

  /** Writes what a grant names, if the document and the memory are still what was approved. */
  async function applyGrant(grant, project) {
    const read = await readDocument(project.workspacePath, grant.path);
    if (!read.ok) return { ok: false, reasonCode: read.reasonCode };
    if (read.sha256 !== grant.contentSha256) return { ok: false, reasonCode: "document_changed" };
    const memory = memoryOf(grant.target);
    if (memory === null) return { ok: false, reasonCode: "memory_target_gone" };
    if (memory.revision !== grant.expectedRevision) return { ok: false, reasonCode: "memory_changed" };
    const entries = entriesFromDocument(read.text, grant.path.split("/").at(-1));
    const revision = memory.write(entries, safeId(grant.agentId) ?? "local-board");
    Object.assign(grant, { consumedAtUtc: now(), writtenRevision: revision, entryCount: entries.length });
    changed();
    await store.saveWorld();
    return { ok: true, revision, entryCount: entries.length };
  }

  /**
   * The person's approval of one document for one memory - the grant. With
   * `apply` the memory is written at once; without it the agent writes it with
   * its tool. `expectedSha256` is the document the person was shown.
   */
  async function approveMemoryDocument({ agentId, path: documentPath, target, expectedSha256, apply = false }) {
    const preview = await previewMemoryDocument({ agentId, path: documentPath, target });
    if (!preview.ok) return preview;
    if (preview.data.contentSha256 !== expectedSha256) return { ok: false, error: { code: "conflict", reasonCode: "document_changed" } };
    const memory = memoryOf(preview.data.target);
    if (memory === null) return { ok: false, error: { code: "source_unavailable", reasonCode: "memory_target_gone" } };
    // A newer approval of the same document replaces an older one that was not used.
    for (const old of grants()) {
      if (old.agentId === agentId && old.path === preview.data.path && old.consumedAtUtc === null && old.supersededAtUtc === null) old.supersededAtUtc = now();
    }
    const grant = {
      grantId: randomUUID(), agentId, path: preview.data.path, target: preview.data.target, targetTitle: preview.data.targetTitle,
      expectedRevision: memory.revision, contentSha256: preview.data.contentSha256, approvedAtUtc: now(),
      consumedAtUtc: null, supersededAtUtc: null, writtenRevision: null, entryCount: preview.data.entryCount,
    };
    grants().push(grant);
    changed();
    await store.saveWorld();
    if (!apply) return { ok: true, data: { grantId: grant.grantId, applied: false } };
    const project = projectOf(world.agents.find((item) => item.agentId === agentId).projectId);
    const written = await applyGrant(grant, project);
    return written.ok
      ? { ok: true, data: { grantId: grant.grantId, applied: true, revision: written.revision, entryCount: written.entryCount } }
      : { ok: false, error: { code: "conflict", reasonCode: written.reasonCode } };
  }

  /** The desk's tool, called by the agent: writes the approved document; the answer is what the agent reads. */
  async function writeMemoryFromDocument(agentId, documentPath) {
    const agent = world.agents.find((item) => item.agentId === agentId);
    const project = agent === undefined ? null : projectOf(agent.projectId);
    if (project === null || project.workspacePath === null) return "Nothing written: the project folder is not available.";
    const relative = normalizeDocumentPath(documentPath);
    if (documentPathProblem(relative) !== null) return `Nothing written: "${documentPath}" is not a path inside the project folder.`;
    const grant = grants().filter((item) => item.agentId === agentId && item.path === relative && item.consumedAtUtc === null && item.supersededAtUtc === null).at(-1);
    if (grant === undefined) {
      return `Nothing written: the person has not approved "${relative}" in the desk (or its approval was already used). Tell the person the document is ready for approval.`;
    }
    const written = await applyGrant(grant, project);
    if (written.ok) return `Written into ${grant.targetTitle}: revision ${written.revision}, ${written.entryCount} entries. It reaches the agents with their next message.`;
    const why = {
      document_changed: "the document changed after the person approved it - ask the person to approve it again",
      memory_changed: "that memory changed after the approval - ask the person to approve the document again",
      memory_target_gone: "that memory no longer exists",
    }[written.reasonCode] ?? `the document cannot be read (${written.reasonCode})`;
    return `Nothing written: ${why}.`;
  }

  async function saveAgentNotes({ agentId, expectedRevision, entries, writeZone }) {
    const agent = world.agents.find((item) => item.agentId === agentId);
    if (agent === undefined) return { ok: false, error: { code: "source_unavailable", reasonCode: "agent_unknown" } };
    if (agent.state === "archived") return { ok: false, error: { code: "conflict", reasonCode: "agent_archived" } };
    const zone = normalizeZone(Array.isArray(writeZone) ? writeZone : []);
    const problem = Array.isArray(writeZone) ? zoneProblem(zone) : "zone_not_a_list";
    if (problem !== null) return { ok: false, error: { code: "invalid_input", reasonCode: problem } };
    const current = notesOf(agent);
    if (current.revision !== expectedRevision) return { ok: false, error: { code: "stale_revision", reasonCode: "stale_revision" } };
    agent.notes = { revision: current.revision + 1, updatedAtUtc: now(), writeZone: zone,
      entries: entries.map((entry) => ({ id: entry.id, title: entry.title, text: entry.text })) };
    changed();
    await store.saveWorld();
    return { ok: true, data: { agentId, revision: agent.notes.revision, writeZone: [...zone], entryCount: entries.length } };
  }

  async function bindWorkspace({ projectId, workspacePath }) {
    const project = projectOf(projectId);
    if (project === null) return { ok: false, error: { code: "source_unavailable", reasonCode: "project_unknown" } };
    const fingerprint = sha256(path.resolve(workspacePath).toLowerCase());
    if (project.workspacePath !== null) {
      return sha256(path.resolve(project.workspacePath).toLowerCase()) === fingerprint
        ? { ok: true, response: { status: "bound", projectId, workspaceFingerprint: fingerprint, replay: true } }
        : { ok: false, error: { code: "conflict", reasonCode: "workspace_binding_conflict" } };
    }
    project.workspacePath = path.resolve(workspacePath);
    changed();
    await store.saveWorld();
    return { ok: true, response: { status: "bound", projectId, workspaceFingerprint: fingerprint, replay: false } };
  }

  // --- operations ------------------------------------------------------------------------

  const files = createProjectFiles({ folderOf: (projectId) => projectOf(projectId)?.workspacePath ?? null });

  async function answer(operationId, input) {
    switch (operationId) {
      case "query.memory.scopes.list":
        return { schemaVersion: 1, truncated: false, scopes: allScopes().map(({ entries, ...metadata }) => metadata) };
      case "query.memory.scope.read": {
        const found = allScopes().find((scope) => scope.scopeId === input.scopeId);
        if (found === undefined) throw new Refusal("source_unavailable", "Unknown scope");
        return found;
      }
      case "query.memory.agents.list":
        return { schemaVersion: 1, revision: catalogRevision, agents: world.agents.map(recordOf) };
      case "query.memory.agent.read":
        return recordOf(agentOf(input.agentId).agent);
      case "query.memory.agent.context": {
        const { agent, project, quarter, member } = agentOf(input.agentId);
        const record = recordOf(agent);
        return {
          schemaVersion: 1, agentId: agent.agentId,
          contentState: record.contentState, deliveryState: record.deliveryState,
          startBlockedByEmptyMemory: false,
          project: member ? projectScope(project) : null, quarter: member ? quarterScope(quarter) : null,
          manifestHash: record.requiredManifest.manifestHash,
          deliveredManifest: record.deliveredManifest, requiredManifest: record.requiredManifest,
        };
      }
      case "query.memory.agent.archive":
        return archivePage(agentOf(input.agentId).agent, input);
      case "query.agent-control.interactions":
        return interactionRecords(agentOf(input.agentId).agent, input.limit ?? 16);
      case "query.agent-conversation.resolve": {
        const { agent, member } = agentOf(input.agentId);
        return bindingOf(agent, member);
      }
      case "query.agent-conversation.read":
        return conversationPage(agentOf(input.agentId), input);
      case "query.project-workspace.list":
        return files.listFiles(input);
      case "query.project-workspace.read":
        return files.readFilePage(input);
      case "query.agent-artifacts.list": {
        const { agent } = agentOf(input.agentId);
        // Nothing registers artifacts through this bridge yet: the list is empty, not unknown.
        return { schemaVersion: 1, contractVersion: CONTRACT_VERSION, agentId: agent.agentId, revision: 0,
          coverage: "registered-only", records: [], truncated: false };
      }
      case "query.agent-artifacts.read":
        throw new Refusal("source_unavailable", "Unknown artifact", "artifact_not_registered");
      case "query.agent-events.read": {
        const { agent, member } = agentOf(input.agentId);
        if (!member) throw new Refusal("source_unavailable", "Agent has no conversation", "agent_unbound");
        return eventsPage(agent, input);
      }
      case "receipt.memory.agent.send":
        return receipt(agentOf(input.agentId), input);
      case "mutation.memory.agent.send":
        return send(agentOf(input.agentId), input);
      case "mutation.agent-control.interrupt":
        return interrupt(agentOf(input.agentId), input);
      case "approval.agent-control.respond":
        return respond(agentOf(input.agentId), input);
      case "mutation.memory.agent.close":
        return closeAgent(agentOf(input.agentId));
      case "mutation.memory.scope.create":
        return createScope(input);
      case "mutation.memory.agent.create":
        return createAgent(input);
      case "mutation.project-workspace.save":
        return files.saveFile(input);
      default:
        throw new Refusal("unsupported_capability", "The direct bridge does not implement it");
    }
  }

  const transport = createTransport({ kit, sourceId: SOURCE_ID, worldKey: `direct|${world.worldId}`, implemented: IMPLEMENTED, answer, debug });

  // A turn runs as a child process of the desk. If the desk was closed while one
  // was going, that turn ended with it: say so instead of showing it as running.
  for (const agent of world.agents) {
    if (agent.currentOperationId === null) continue;
    const at = now();
    const operation = agent.operations.find((item) => item.operationId === agent.currentOperationId);
    if (operation !== undefined) Object.assign(operation, { state: "interrupted", updatedAtUtc: at });
    const transcript = await store.transcriptOf(agent.agentId);
    for (const turn of transcript.turns) {
      if (turn.state === "active") Object.assign(turn, { state: "interrupted", completedAtUtc: at });
    }
    for (const interaction of transcript.interactions) {
      if (interaction.status === "pending") Object.assign(interaction, { status: "expired", updatedAtUtc: at });
    }
    agent.currentOperationId = null;
    await store.saveTranscript(agent.agentId);
    await store.saveWorld();
  }

  return {
    workspace: transport.workspace,
    resolveDescriptor: transport.resolveDescriptor,
    fetchImpl: transport.fetchImpl,
    readRuntimeSummary: async () => ({ ...(await transport.readRuntimeSummary()), claudeAccount: account }),
    checkAccount,
    saveMemory, bindWorkspace, agentNotes, saveAgentNotes, setAgentRole, previewMemoryDocument, approveMemoryDocument,
    /** The desk's tool as the agent calls it - for a script; the window does not use it. */
    writeMemoryFromDocument,
    /** What each turn of an agent cost, oldest first - for measuring, not part of the desk's contract. */
    usageOf: (agentId) => agentOf(agentId).agent.operations.map((operation) => ({ operationId: operation.operationId, state: operation.state, usage: operation.usage })),
    /** Waits until no turn is running; for a script that must not exit while a process is still writing. */
    idle: async () => { await Promise.all([...running.values()].map((entry) => entry.settled)); },
  };
}
