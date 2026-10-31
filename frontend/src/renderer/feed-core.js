"use strict";

// Pure logic of the conversation and of the context line of an agent: no DOM and no backend,
// so every rule is checked by tests without a window.
//
// The main rule of the feed: the contract does not set the order of archive pages, but
// every entry has an identifier and sequence numbers. An entry is kept once,
// in its freshest state (the largest `sequence`), and is shown in the
// order of its first appearance (`firstSequence`). So the feed is the same in whatever
// order the backend returns the pages.

(function (root, factory) {
  const node = typeof module === "object" && module !== null && module.exports;
  const api = factory(node ? require("./i18n-core.js") : root);
  if (node) module.exports = api;
  else Object.assign(root, api);
}(typeof globalThis === "undefined" ? this : globalThis, function (i18n) {
  const { tx, txn } = i18n;
  /** Merge entries into the `recordId → entry` map, keeping the freshest state. */
  function mergeFeedEntries(records, entries) {
    for (const entry of entries) {
      const id = entry.record.recordId;
      const known = records.get(id);
      if (known === undefined || entry.sequence >= known.sequence) records.set(id, entry);
    }
    return records;
  }

  const orderedFeedEntries = (records) => [...records.values()]
    .sort((a, b) => a.firstSequence - b.firstSequence || a.sequence - b.sequence);

  /** Consecutive entries of one turn form one group; turns are numbered in order of appearance. */
  function groupFeedByTurn(entries) {
    const groups = [];
    let turnNumber = 0;
    for (const entry of entries) {
      const turn = entry.record.providerTurnId ?? null;
      const last = groups[groups.length - 1];
      if (last && last.turn === turn) {
        last.entries.push(entry);
        continue;
      }
      if (turn !== null) turnNumber += 1;
      groups.push({ turn, number: turn === null ? null : turnNumber, entries: [entry] });
    }
    return groups;
  }

  /** The last captured message of the agent, or null. */
  function lastAgentMessage(entries) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const record = entries[index].record;
      if (record.kind === "message" && record.role === "assistant" && typeof record.text === "string") {
        return { text: record.text, state: record.state, at: record.occurredAtUtc ?? null };
      }
    }
    return null;
  }

  const OPERATION_STATE_WORDS = Object.freeze({
    requested: tx("requested"), accepted: tx("feed-core::accepted"), started: tx("started"), completed: tx("finished"),
    failed: tx("failed"), interrupted: tx("interrupted"), uncertain: tx("uncertain"),
  });

  /** "3 questions": the count with its word, in the language's plural form. */
  const questionsCount = (count) => txn("{count} questions", count);

  /**
   * One line about the state of an agent for the map, from the catalog and the question count.
   * The order is by importance to the person: archive, failure, uncertain delivery,
   * waiting questions, a running turn, the outcome of the last turn. “Turn running” is the life
   * cycle of the operation, not the progress of the task: the backend does not report that.
   */
  function agentContextLine(agent, questions = 0) {
    if (agent.state === "archived") return { text: tx("feed-core::archived"), tone: "quiet" };
    if (agent.problemCode !== null || agent.state === "failed") return { text: tx("failed"), tone: "bad" };
    if (agent.deliveryState === "uncertain" || agent.state === "uncertain") {
      return { text: tx("feed-core::uncertain"), tone: "warn" };
    }
    if (questions > 0) return { text: `? ${questionsCount(questions)}`, tone: "ask" };
    if (agent.currentOperationId !== null) return { text: tx("turn running"), tone: "busy" };
    if (agent.lastOperation) {
      const word = OPERATION_STATE_WORDS[agent.lastOperation.state] ?? agent.lastOperation.state;
      return { text: tx("turn {word}", { word }), tone: "plain" };
    }
    return { text: tx("no turns yet"), tone: "quiet" };
  }

  const SEND_OPERATION = "mutation.memory.agent.send";

  // Why sending to this agent is closed. Backend codes are not made up here:
  // the reason names the state from the catalog in its own words.
  const SEND_BLOCKED_BY_STATE = Object.freeze({
    creating: tx("The agent is still being created — sending opens when it becomes active."),
    failed: tx("The agent has failed — sending is unavailable."),
    uncertain: tx("The agent state is uncertain — sending is unavailable."),
    closing: tx("The agent is closing — you cannot send to it."),
    archived: tx("The agent is archived — you cannot send to it."),
  });

  /**
   * Whether this agent can be sent to. A declared operation is a necessary but not
   * sufficient condition: a read agent in the `active` state is needed as well.
   * An unread, empty or unknown state gives no permission.
   */
  function sendAvailability(agent, operation) {
    if (operation === null || operation === undefined) {
      return { allowed: false, reason: tx("{SEND_OPERATION}: not checked", { SEND_OPERATION }) };
    }
    if (operation.status !== "available") {
      return { allowed: false, reason: `${SEND_OPERATION}: ${operation.status} (${operation.reasonCode})` };
    }
    const state = agent === null || agent === undefined ? null : agent.state;
    if (typeof state !== "string" || state === "") {
      return { allowed: false, reason: tx("The agent state has not been read yet — sending is unavailable.") };
    }
    if (state === "active") return { allowed: true, reason: null };
    return {
      allowed: false,
      reason: SEND_BLOCKED_BY_STATE[state] ?? tx("Unknown agent state “{state}” — sending is unavailable.", { state }),
    };
  }

  /**
   * The send handler: calls the client only if `sendAvailability` allows it.
   * So the refusal holds even when the handler is called around the button.
   */
  async function guardedSend({ agent, operation, send }) {
    const verdict = sendAvailability(agent, operation);
    if (!verdict.allowed) return { sent: false, reason: verdict.reason };
    return { sent: true, response: await send(agent) };
  }

  /**
   * The captured attention of an agent from the catalog (Kit v0.15.0) in the window's words.
   * Unavailable or not reported is “no data”, never 0: zero means
   * “the backend looked and found none”, and null means “the backend did not say”.
   */
  function attentionFacts(attention) {
    const word = (value) => (Number.isSafeInteger(value) ? String(value) : tx("no data"));
    const available = attention !== null && attention !== undefined && attention.availability === "available";
    return {
      available,
      questions: word(available ? attention.pendingQuestions : null),
      approvals: word(available ? attention.pendingApprovals : null),
      recovery: word(available ? attention.recoveryRequired : null),
      observedAtUtc: available ? attention.observedAtUtc : null,
      summary: available ? tx("captured by the backend, not the whole provider history") : tx("not reported by the catalog"),
    };
  }

  /**
   * The order of opening a conversation. First only the binding is read (the caller
   * does that), and it alone decides the route: an archived or unbound agent
   * goes to the archive and reads neither events nor pages. On the live branch the cursor
   * of the events head is taken before the snapshot - the conversation pages.
   */
  function chatOpenPlan({ liveReadAvailable, eventsAvailable, route }) {
    if (!liveReadAvailable || route !== "live") return ["archive"];
    return eventsAvailable ? ["events-head", "conversation"] : ["conversation"];
  }

  /**
   * What changed in the connection between two reads. A new descriptor of the same
   * instance and generation is a renewal, not a restart: the workspace is not
   * closed and nothing is reread as after a restart.
   */
  function connectionChange(previous, current) {
    const up = (value) => value !== null && value !== undefined && value.available === true;
    if (!up(current)) return up(previous) ? "lost" : "unavailable";
    if (!up(previous)) return "connected";
    if (previous.instanceId !== current.instanceId || previous.generation !== current.generation) return "restarted";
    return previous.descriptorId === current.descriptorId ? "same" : "renewed";
  }

  /**
   * A case-insensitive search in the open text. No more than `limit` matches;
   * if there are more, `truncated`. An empty query searches for nothing.
   */
  function findInText(text, query, { limit = 200 } = {}) {
    const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
    const matches = [];
    if (needle === "" || typeof text !== "string") return { count: 0, matches, truncated: false };
    const haystack = text.toLowerCase();
    let from = 0;
    let truncated = false;
    let line = 1;
    let counted = 0;
    for (;;) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) break;
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
      for (let at = text.indexOf("\n", counted); at >= 0 && at < index; at = text.indexOf("\n", at + 1)) line += 1;
      counted = index;
      matches.push({ index, line });
      from = index + needle.length;
    }
    return { count: matches.length, matches, truncated };
  }

  /** The world counter in the map header. An unread world is not empty: there is no zero. */
  function worldCountLine(world) {
    if (world === null || world === undefined || world.status !== "ready" || !world.projection) return tx("world not read");
    const projects = world.projection.projects;
    const agents = projects.reduce((sum, project) => sum
      + project.quarters.reduce((inner, quarter) => inner + quarter.agents.length, 0), 0);
    return `${countWords(projects.length, PROJECT_FORMS)} · ${countWords(agents, AGENT_FORMS)}`;
  }

  /**
   * The Gateway state only from the host summary and the connection result:
   * ready, expired (the descriptor has expired), stale (a descriptor from another
   * instance, or none while ready), uncertain, stopped/starting, unknown.
   */
  function gatewayState({ runtime, connection, now = Date.now() }) {
    const lifecycle = runtime?.lifecycle ?? null;
    const reason = connection?.error?.reasonCode ?? connection?.error?.code ?? null;
    if (lifecycle === "uncertain" || reason === "lifecycle_uncertain") return "uncertain";
    if (connection?.available === true) {
      const until = Date.parse(connection.validUntilUtc ?? "");
      return Number.isFinite(until) && until <= now ? "expired" : "ready";
    }
    if (lifecycle === "stopped" || reason === "lifecycle_stopped") return "stopped";
    if (lifecycle === "starting" || reason === "lifecycle_starting") return "starting";
    if (reason === "instance_mismatch" || (lifecycle === "ready" && /^descriptor_/.test(reason ?? ""))) return "stale";
    return "unknown";
  }

  // --- the live conversation as a chat -------------------------------------------------
  //
  // A turn of the agent is shown the way Codex and Claude Code show it:
  // the person's message, then the folded “work” (actions, thinking,
  // intermediate remarks), then the answer — the last message of the agent in the turn.
  // While the turn is running there is no answer yet: everything the agent said is part of the work.

  // The backend contract has no separate kind for thinking or for the backend's own
  // internal calls: they come as actions, and the first line says what they are. These
  // heads are data, English whatever the window's language (shown through the locale).
  const REASONING_HEAD = "Thinking";
  const SERVICE_HEAD = "Internal · ";

  // The plan of the agent (TodoWrite in Claude Code): lines “[x] done”, “[~] doing”,
  // “[ ] ahead”. The backend sends it as a separate entry headed “Plan”;
  // older entries came as an interaction summary — they are recognized by their lines.
  const PLAN_HEAD = "Plan";
  const PLAN_LINE = /^\[[ x~]\] /u;
  const isPlanText = (text) => {
    const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== "");
    return lines.length > 0 && lines.every((line) => PLAN_LINE.test(line));
  };

  /** What an entry of the live conversation is, for display. */
  function liveItemKind(item) {
    if (item.visibility === "omitted") return item.omissionReason === "hidden_reasoning" ? "hidden-reasoning" : "omission";
    if (item.contentClass === "user-message") return "user";
    if (item.contentClass === "assistant-message") return "agent";
    const text = String(item.text ?? "");
    if (item.contentClass === "interaction-summary") return isPlanText(text) ? "plan" : "question";
    if (item.contentClass === "change-summary") return "change";
    if (text.startsWith(`${PLAN_HEAD}\n`)) return "plan";
    if (text === REASONING_HEAD || text.startsWith(`${REASONING_HEAD}\n`)) return "reasoning";
    if (text.startsWith(SERVICE_HEAD)) return "service";
    return "action";
  }

  /** The text of thinking, a plan or an internal line without its first, header, line. */
  function liveItemBody(item) {
    const kind = liveItemKind(item);
    const text = String(item.text ?? "");
    if (kind === "reasoning") return text.slice(REASONING_HEAD.length).trim();
    if (kind === "plan") return text.startsWith(`${PLAN_HEAD}\n`) ? text.slice(PLAN_HEAD.length).trim() : text;
    if (kind === "service") return text.slice(SERVICE_HEAD.length).trim();
    return text;
  }

  // The questions of the agent to the person (AskUserQuestion in Claude Code) and the answers to them:
  // the backend sends them as an interaction summary - a heading, then “· question” and,
  // if the person answered, “  → answer”. Claude Code keeps them the same way.
  const QUESTION_HEADS = Object.freeze({
    "You answered the agent's questions:": "answered",
    "The agent asks:": "asking",
    "The agent's question was left unanswered:": "unanswered",
  });

  /** The questions and answers of an entry: `{ state, head, entries: [{ question, answer }] }`; null - not such an entry. */
  function questionEntries(text) {
    const lines = String(text ?? "").split(/\r?\n/u);
    const state = QUESTION_HEADS[lines[0]];
    if (state === undefined) return null;
    const entries = [];
    for (const line of lines.slice(1)) {
      if (line.startsWith("· ")) entries.push({ question: line.slice(2), answer: null });
      else if (line.startsWith("  → ") && entries.length > 0) entries[entries.length - 1].answer = line.slice(4);
    }
    return entries.length === 0 ? null : { state, head: tx(lines[0].slice(0, -1)), entries };
  }

  /** Plan items: `{ state: "done" | "doing" | "todo", text }`. */
  function planItems(body) {
    return body.split(/\r?\n/u).filter((line) => PLAN_LINE.test(line)).map((line) => ({
      state: line[1] === "x" ? "done" : line[1] === "~" ? "doing" : "todo",
      text: line.slice(4).trim(),
    }));
  }

  /**
   * Entries of one turn → display segments: `{ kind: "user" | "question" | "answer", item }`
   * and `{ kind: "work", items }`. Only a turn that has finished has an answer.
   */
  function liveTurnSegments(items, turnState) {
    const going = turnState === "active" || turnState === "pending";
    // One turn can hold several messages of the person (added during
    // the work or queued until its end): each has its own answer — the last
    // message of the agent before the next message of the person. The last segment
    // has no answer while the turn is running.
    const answers = new Set();
    const lookBack = (end) => {
      for (let index = end; index >= 0; index -= 1) {
        const kind = liveItemKind(items[index]);
        if (kind === "agent") {
          answers.add(index);
          return;
        }
        // The answer is the message after which the agent did nothing more.
        if (kind === "action" || kind === "change" || kind === "plan" || kind === "user" || kind === "question") return;
      }
    };
    items.forEach((item, index) => {
      if (index > 0 && liveItemKind(item) === "user") lookBack(index - 1);
    });
    if (!going) lookBack(items.length - 1);
    const segments = [];
    let work = [];
    const flush = () => {
      if (work.length > 0) segments.push({ kind: "work", items: work });
      work = [];
    };
    items.forEach((item, index) => {
      const kind = liveItemKind(item);
      if (kind === "user" || kind === "question" || answers.has(index)) {
        flush();
        segments.push({ kind: answers.has(index) ? "answer" : kind, item });
      } else {
        work.push(item);
      }
    });
    flush();
    return segments;
  }

  /** "1 quarter", "3 agents", "5 projects": the forms are the locale's (i18n-core.js txn). */
  const countWords = (count, forms) => txn(forms, count);
  const PROJECT_FORMS = "{count} projects";
  const QUARTER_FORMS = "{count} quarters";
  const AGENT_FORMS = "{count} agents";

  /** The line of folded work: “3 actions · 1 change · thinking”. Internal backend calls are not counted. */
  function workSummary(items) {
    const count = (kind) => items.filter((item) => liveItemKind(item) === kind).length;
    const actions = count("action");
    const changes = count("change");
    const parts = [];
    if (actions > 0) parts.push(txn("{count} actions", actions));
    if (changes > 0) parts.push(txn("{count} changes", changes));
    if (count("reasoning") + count("hidden-reasoning") > 0) parts.push(tx("thinking"));
    if (parts.length === 0 && count("agent") > 0) parts.push(tx("agent notes"));
    if (parts.length === 0 && count("service") > 0) parts.push(tx("internal calls"));
    return parts.join(" · ");
  }

  /** “12 s”, “1 min 11 s” — how long the turn took; null when the time is unknown. */
  function durationWords(startedAtUtc, completedAtUtc) {
    const from = Date.parse(startedAtUtc ?? "");
    const to = Date.parse(completedAtUtc ?? "");
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
    const seconds = Math.round((to - from) / 1000);
    if (seconds < 60) return tx("{seconds} s", { seconds });
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? tx("{minutes} min {value} s", { minutes, value: seconds % 60 }) : tx("{value} h {value2} min", { value: Math.floor(minutes / 60), value2: minutes % 60 });
  }

  return {
    liveItemKind,
    liveItemBody,
    planItems,
    questionEntries,
    liveTurnSegments,
    workSummary,
    durationWords,
    countWords,
    PROJECT_FORMS,
    QUARTER_FORMS,
    AGENT_FORMS,
    gatewayState,
    worldCountLine,
    chatOpenPlan,
    connectionChange,
    findInText,
    attentionFacts,
    sendAvailability,
    guardedSend,
    mergeFeedEntries,
    orderedFeedEntries,
    groupFeedByTurn,
    lastAgentMessage,
    questionsCount,
    agentContextLine,
    OPERATION_STATE_WORDS,
  };
}));
