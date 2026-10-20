# Rules for this folder

This folder is **Atlas**, the desktop app of Agents Factory (package
`agents-factory-atlas`). These rules apply to anyone who changes it: human
contributors and coding agents alike.

> Atlas is the program's own UI. The chat with agents, project files, memory,
> tasks and everything else are worked in this window, over the live mode
> (`start-atlas.bat`, the backend's Gateway on Claude Code). Build new
> user-facing features here and in the Gateway (`backend/orchestrator`), never
> as VS Code windows or extensions. The Paperclip and direct modes below are
> prototype history kept working; the design notes they were written from are
> not part of this repository.

Read `README.md` first (what Atlas is and how the accepted kit is verified),
then `vendor/frontend-kit/v0.21.0/docs/desktop-integration.md` (the contract).

## Modes

| Mode | Start | Works against |
| --- | --- | --- |
| live (default) | `npm start`, `start-atlas.bat` | the backend's Application Gateway, through the verified frontend kit; needs `config/local.json` |
| fixture | `npm run dev`, `start-atlas-fixture.bat` | synthetic data from `src/dev/`; nothing reaches a provider |
| Paperclip | `npm run paperclip`, `start-atlas-paperclip.bat` | a local Paperclip server (not part of this repository), through `src/paperclip/` |
| direct | `npm run direct`, `start-atlas-direct.bat` | Claude Code itself, through the Claude Agent SDK, with no server: `src/direct/` |

## The Paperclip mode

The Paperclip mode runs Atlas on a local **Paperclip** server instead of the
Application Gateway. What it adds to the live mode:

- A third mode, `--paperclip` (`npm run paperclip`, `start-atlas-paperclip.bat`).
  `src/host/config.mjs` resolves it, `src/host/session.mjs` hands it to
  `src/paperclip/session.mjs`.
- `src/paperclip/` is the bridge. `paperclip-gateway.mjs` has the same shape as
  the development fixture (`src/dev/dev-gateway.mjs`): it answers the kit's
  operations, but from Paperclip's REST API. `memory-format.mjs` converts memory
  entries to and from markdown documents and embeds memory into a task.
  `transcript.mjs` turns a run log into chat items.
- `config/paperclip.json` names the Paperclip API address and the company that
  is the world, plus the adapter settings a new agent starts with. Set them for
  your own server.
- Small renderer edits, all conditional on `info.mode === "paperclip"` or a null
  value: the mode badge, the workspace footer, a question without a deadline,
  the defaults of the create-agent sheet.
- `tools/probe-paperclip.mjs` (read-only, needs the server),
  `tools/test-paperclip-bridge.mjs` (offline, in `npm test`),
  `tools/test-paperclip-live.mjs` (**starts real agent turns**).

The renderer, the preload bridge, the host gateway, the mutations and the kit
are otherwise the same as in the live mode. `vendor/` and `delivery/` are
byte-for-byte copies of the backend's delivery and the kit is still verified on
every start; do not edit them.

## How the four levels map to Paperclip

| Atlas | Paperclip |
| --- | --- |
| World | one company |
| Project | a project; the bound folder is its primary workspace (`cwd`) |
| Quarter | a root issue labelled `atlas-quarter` |
| Agent | an agent whose `metadata.atlas` names its project and quarter |
| Project memory | the `memory` document of the root issue labelled `atlas-project-memory` |
| Quarter memory | the `memory` document of the quarter's issue |
| An agent's conversation | ONE child issue of the quarter, assigned to the agent, marked `<!-- atlas:conversation -->`; its description is a short fixed text (`conversationDescription`) |
| Every message, the first one too | a comment on that issue: the message, then - in the first one and whenever the memory has changed - both memories in an `atlas:memory` block |
| A turn | a heartbeat run of that issue |
| A question | an issue-thread interaction |

Ids chosen in Atlas are kept in the description as `<!-- atlas:id ... -->`;
the id of a send as `<!-- atlas:operation ... -->`, in the description or in
the comment. That is how a receipt finds its message after a restart. A run
belongs to the last message said before it was made.

A person's comment wakes the agent and reopens the issue if it was closed;
Paperclip keeps a provider session per agent and issue, which is what makes the
agent remember the conversation. Issues from before this scheme (one per
message, or a conversation whose description is its first message) stay
readable and answer by their own ids.

Why the conversation is shaped this way - each point was measured in Paperclip
run logs, by where the tokens went:

- The issue is created in `backlog` (no wake on assignment), closed, and woken
  only by comments. For a comment-driven run Paperclip demands neither a
  comment by the agent nor a "next step" run; after an assignment-driven run it
  demands both, each with a whole extra run.
- Paperclip sends the issue's description to the agent again at every wake.
  So the description is short and fixed, and the memory travels in comments.
- The agent answers in its final message and sets the status to done in one
  quiet call. A reply posted as a comment is one more model call over the whole
  context; an issue left in progress makes Paperclip start further runs.

## The direct mode

`--direct` (`npm run direct`, `start-atlas-direct.bat`) runs Atlas on Claude
Code itself, with no Paperclip and no Gateway: `src/direct/`. It follows the
path the backend takes with its own agents - the agent is told nothing about a
backend, and recording, turn state, questions and stopping are all done by this
code. Read `src/direct/` and run its offline suite before changing it.

- `direct-gateway.mjs` answers the same operations as the Paperclip bridge;
  `claude-driver.mjs` runs one turn through `@anthropic-ai/claude-agent-sdk`
  (one process per turn, the session resumed); `direct-store.mjs` keeps the
  world in JSON files under `dataDir`.
- Config: `config/direct.json` (committed: how agents are started), then the
  git-ignored `config/direct.local.json` over it (this machine's folders). A
  path left out means the folder next to Atlas: `direct-data/` and the SDK
  in `node_modules` (a dependency in `package.json`, pinned).
- Which Claude account the agents use: the sign-in `claude` sees, or the
  folder `claudeConfigDir` of the config (passed as `CLAUDE_CONFIG_DIR`).
  Atlas shows it (header, readiness panel; `npm run account` without a
  window) by running Claude Code's own `auth status --json` from the SDK's
  platform package (`claudeProgramOf`). **Never start a session and stop it
  just to ask something**: the first account check did that, and afterwards
  Claude Code on that machine was signed out (most likely stopped while it
  renewed its sign-in).
- The agent's own memory and write zone (decided 2026-10-01): a third memory
  only that agent receives (`agent.notes`: entries + `writeZone`), written by
  the person through the trusted action `saveAgentNotes` (confirmed; IPC
  `atlas:agent-notes` / `atlas:save-agent-notes`), sent with a message only
  when it changed (`deliveredNotesKey`). It lives outside the kit: the kit's
  scope kinds are only project and quarter. The zone is held by a PreToolUse
  hook (`write-zone.mjs`): an edit outside it is denied before it runs, reading
  is free, and a shell command is sent to the person ("ask").
- Roles and memory documents (2026-10-01): an agent is a feature agent, the
  quarter lead or the project lead (`setAgentRole`); a lead also receives what
  it oversees (`ownSectionsOf`). A memory document is approved by the person
  (`approveMemoryDocument`: which memory, its revision, the SHA-256 of exactly
  the text shown - single use, as `authorize-write` in the backend's memory
  store) and written by code: the person's button, or Atlas's tool
  `write_memory_from_document` (an in-process MCP server "desk" given to every
  agent, `DESK_TOOL`). `memory-documents.mjs` reads and splits documents.
- Every turn gets the fixed tool set `AGENT_TOOLS` (claude-driver.mjs): the
  account's own tools change between process starts and broke the cache
  (measured live). Live checks: `tools/test-direct-zone-live.mjs`,
  `tools/test-direct-leads-live.mjs` (**start real turns**).
- `transport.mjs` and `project-files.mjs` are copies of the same parts of
  `paperclip-gateway.mjs`, kept until it is decided which bridge stays.
- Three things keep a turn cheap, each measured live; do not undo them without
  measuring again: `strictMcpConfig` and `skills: []` keep the start of the
  prompt identical from one process to the next (otherwise the whole context is
  written to the cache again at full price), and the memory travels only when
  it changed.
- The memory is worded as the person's own "Standing notes", with one fixed
  sentence about them in the system prompt. Worded as a backend's memory
  snapshot it was taken by Claude for an injected text and ignored.
- `node tools/test-direct-bridge.mjs` is the offline suite (in `npm test`);
  `node tools/test-direct-chat-live.mjs` **starts real turns** and prints what
  each cost.

## The chat view

`src/renderer/markdown-core.js` parses an agent's text into a small tree;
`workspace.js` turns it into nodes through `textContent` only. `feed-core.js`
splits a turn into message - folded work - answer (`liveTurnSegments`). The kit
contract has no content class for reasoning or for the backend's own
bookkeeping: the bridge sends both as `tool-summary` items whose first line is
`Thinking` or starts with `Internal · `, and the window shows them by that
line (the two constants exist in `paperclip-gateway.mjs` and `feed-core.js`).
`transcript.mjs` names a call to Paperclip's own API (`describeServiceCall`)
instead of showing the command. Offline suite: `tools/test-chat-view.mjs`.
Sample scenes for a screenshot without any agent turn: `chat-sample`,
`chat-sample-open`.

## Rules

- **Never invent data.** No progress that the backend (or Paperclip) did not
  report, no deadline on a question that has none, "no data" is not zero.
- **An unknown outcome is never retried.** A change whose answer was lost is
  reported as uncertain and reconciled through its receipt.
- **A change needs the person's confirmation.** Without a confirmation surface
  the host refuses every change. The exceptions (decided 2026-10-03, as in a
  strategy game): a project, a feature and an agent are created at once, and an
  archived project or feature is restored at once - nothing is lost by any of
  it. In the chat, as in Codex and Claude Code, sending (steered or queued),
  answering an agent's question, stopping a turn, changing the model and making
  an agent a lead do not ask either: the button the person pressed is the
  decision. Archiving a project, a feature or an agent, binding a folder,
  saving files or memory and copying a project still confirm. The confirmation
  is Atlas's own window (`src/host/confirm-window.mjs`), owned by the host
  process: the main window's page cannot reach or press it.
- **Anything that starts an agent turn spends real provider quota** (the
  account the agents run on) and needs explicit permission for that run from
  the person whose account it is. `npm test` and the probes start none; the
  live tools marked below do.
- **No credentials anywhere in this folder.** The Gateway's connection
  descriptor (with its bearer token) is read only by the host process and never
  copied here; the renderer has no Node, no filesystem and no Gateway
  credentials; the journal and evidence exports hold no secrets and no memory or
  conversation text. Claude's sign-in is only read through `auth status`.
  `config/local.json`, `config/*.local.json`, `user-data/` and `direct-data/`
  are git-ignored and stay on the machine.
- **Interface text** is plain and short: sentence case for labels and buttons,
  no exclamation marks, the same words everywhere (Gateway, quarter, lead,
  turn, receipt, write zone). The tests look for interface texts, so a changed
  label is changed in its tests too. Code, comments and docs are in English.
- **No push** anywhere without explicit permission for that push from the
  person you work for.

## The live mode and the prototype modes

In the live mode the rules of the original shell hold: Atlas never starts,
stops or recovers the Gateway, starts provider turns only through Gateway
operations, and never works around the kit contract (it reads no provider
history, SQLite or backend file directly). A feature the contract lacks is
added to the backend and reaches Atlas with a new accepted delivery; it is
never patched into `vendor/` or `delivery/`.

The Paperclip and direct modes exist to start agent turns themselves, so there
those prohibitions are replaced by the rules above, and their bridges
(`src/paperclip/`, `src/direct/`) belong to this folder.

## Checking your work

- `npm test` - every offline suite: the accepted kit delivery, the kit's
  conformance suite, trusted actions, mutations, layout, scene, chat view,
  `paperclip-bridge` (84 cases against an in-memory stand-in for Paperclip),
  `direct-bridge` and the rest. No server, no controller, no quota.
- `npm run verify:kit` - the vendored kit against the accepted delivery alone.
- `npm run test:ui` - the UI scenes on the fixture. It opens windows on the
  screen, so it is not part of `npm test`; see `TESTING.md`.
- `npm run probe` - a read-only check of the live connection (needs
  `config/local.json` and a running Gateway).
- Paperclip returns an existing open issue instead of creating one with the
  same title and parent (48 hours). Every issue the bridge creates goes through
  `createIssue` in `paperclip-gateway.mjs`, which sets `allowDuplicate` and an
  idempotency key; do not call the issues route any other way.
- Paperclip's list of issues cuts a description at 1200 characters
  (`descriptionTruncated`), and Atlas's markers are at its end. The snapshot
  reads a cut description whole (`wholeDescriptions`); never parse markers out
  of a list row yourself. The stand-in in the offline suite cuts at 80.
- A run that ends without a final issue status makes Paperclip start one more
  run just to get it. The description of a conversation tells the agent to
  mark the issue done after each answer.
- `node tools/probe-paperclip.mjs` - read-only, against the running server.
- `node tools/test-paperclip-chat-live.mjs [agentId]` - the short live check of
  a conversation: **two small agent turns**, no files written.
- A screenshot without a person:
  `node_modules\electron\dist\electron.exe . --paperclip --capture shots\x.png --capture-scene <name>`;
  scenes are the fixed list `CAPTURE_SCENES` in `src/host/main.mjs` (generic
  ones: `world`, `project`, `quarter`, `agent`, `chat`, `chat-second`). Check
  first that no other Atlas window is running (`Get-Process electron`).
- Atlas does not start the Paperclip server. Start it yourself, for example
  with `<paperclip-runtime>\start-paperclip.bat`.

## Files

- Line endings differ by file: `README.md`, `TESTING.md`,
  `src/host/main.mjs`, `src/host/session.mjs`, `src/renderer/app.js`,
  `src/renderer/workspace.js` and some others are CRLF, the rest LF. Keep what
  a file has (`git ls-files --eol` shows it). `.gitattributes` sets `* -text`:
  git stores bytes exactly and converts nothing, because `vendor/` and
  `delivery/` are verified by SHA-256 and a converted line ending would make
  Atlas refuse its connection.
- `vendor/` and `delivery/` are never edited here.
- `user-data/` holds the local person's map layouts, notes and panel state; do
  not read, edit or commit it.
