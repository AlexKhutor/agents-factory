# Changelog

Agents Factory is under active development; each release gets an entry here,
newest first. Versions follow [semantic versioning](https://semver.org/); while
the version is `0.x`, a minor version may change behaviour, a patch version
only fixes.

## v0.2.0 - unreleased

Getting ready for the installer: everything the first run needs now works
without Python and without PowerShell scripts, from Atlas or from one CLI.

- **`agents-factory` CLI v0.1.0** - one Node CLI for the Gateway's lifecycle
  (`gateway start | stop | status | recover | logs`), the Gateway as the
  user's own service at logon (Task Scheduler, LaunchAgent, `systemd --user`),
  the Anthropic API key in the system key store (DPAPI, Keychain, Secret
  Service), the Claude Agent SDK installed from npm with its integrity checked
  (pinned 0.3.288), `setup`, `doctor`, `migrate`. Every command has `--json`
  output and stable exit codes. See
  [docs/distribution/cli.md](docs/distribution/cli.md).
- **Atlas v0.31.0** - the readiness panel starts, stops and recovers the
  Gateway and shows the exact code of a refusal; the API key is typed into a
  masked field, kept in the key store and never shown again; "Gateway
  autostart" registers the user service after a confirmation. The world has
  its own HQ with the **world lead** - one coordinator above all projects,
  created in one confirmed step - and its sheet lists every desk task with its
  steps. Any agent can be registered as a desk agent from its inspector; its
  Tasks tab shows the tasks it got from the world lead.
- **Application Gateway v0.147.0** - SQLite through `node:sqlite` in the
  process (memory, conversation archive, control queue; Python stays as a
  fallback for one version, `AGENTS_FACTORY_SQLITE=python`); the desk task
  chain (dispatch, kit install, accept, plan, progress, report, collection)
  in Node, byte for byte the same files as the PowerShell scripts; the world
  lead's memory carries an overview of every open project; memory CLI
  `read-task-board`.
- **Controller template v0.43.0** - carries the CLI as
  `.orchestrator/runtime/agents-factory.mjs` and the new runtime modules.

Since then, in the same release:

- **More than one provider** - an ACP agent (DeepSeek Harness, a local Qwen)
  works beside Claude Code in one Gateway, under the same write zones; Atlas
  checks whether each model server answers, and a turn whose model stays
  silent ends with "model not answering" instead of hanging. The old Codex
  path is gone; a future Codex comes as an ACP provider.
- **A project as a unit** - export and import of a project package, one
  database per project, the world's registry of projects, unmount and mount,
  moving a project or the whole instance to another folder.
- **Between PCs** - `agents-factory sync` takes and hands over the world and
  its projects through git, `sync recover` settles a stuck state; an instance
  is local or synced, and a project may be kept on chosen PCs only.
- **Safety** - no agent reads logins, keys or tokens; a fetch from an unknown
  address asks the person first; every change of agents, quarters, projects,
  memory and saved files goes into a **History** with **Undo** where a change
  can be reversed (a closed agent can be brought back).
- **Names and IDs** - projects, quarters and agents have a fixed readable ID
  made from the first name (`billing-7f3k`) and a name that can be changed at
  any time; agents refer to each other by ID.
- **The map** - a quarter's grid follows its smallest agent and starts at its
  edge, so small agents stand closer and an agent resized by its corner snaps
  to it; an agent stays where it was put; a double-click on an attention badge
  opens what needs attention, and History is a short list with details on click.
- **Languages** - the code and the interface are English; the interface's
  texts are locale files (English and Russian), switched in Atlas.
- **Task mode** - an agent's chat has "Question | Task". A task is planned
  first and changes nothing: the agent answers with how it understood the
  task, what is unclear and its steps, each a short name and what exactly.
  The Plan tab shows the plan as one card - closed, a line of what the task is
  about and its progress; opened, the whole plan. The person answers the
  questions, asks for changes (each revision marks what changed) or approves,
  and the card follows the work step by step. Earlier tasks and revisions open
  from the same tab. A finished task lists its result files, and Atlas
  registers them as the agent's artifacts, with their hash at that time.
- **Agents keep their memory themselves** - the desk tools `read_memory` and
  `change_memory` (Claude Code agents): a change by entry title waits for the
  person's approval card in the chat; an agent may be allowed to change its
  own memory without asking. A lead reaches the agents below it (a quarter
  lead its quarter's, a project lead its project's, the world lead any agent's
  but those of a project kept to some PCs).
- **Memory in a text editor** - a memory opens as a Markdown file of the
  project folder in your editor (each `##` heading is one entry); "Load back"
  marks every entry added, changed, removed or the same before you approve.
- **Attention on the map** - three kinds of badges (something does not work,
  someone waits for you, an answer to read), a mark for free agents, a light
  running along an agent at work and "working" / "free" counts on the plaques;
  badges sit on agents, quarters or projects by the zoom, shrink when the map
  is far, and the minimap always shows them.
- **Files and artifacts** - pictures (PNG, JPEG, GIF, WebP, BMP) open in the
  Files tab; a text file that starts with a UTF-8 byte-order mark opens and
  saves; the artifact list is read again each time its tab opens.
- **Smaller fixes** - agents' names keep one size across the map's levels and
  stay seen close up; Atlas opens at the saved view without a jump; the model
  picker switches back after a change; Readiness counts an operation served by
  each provider as available; a CLI installed in an instance works on that
  instance without `--instance`.

## v0.1.0 - 2026-10-20

The first versioned release: the system its author has been using daily,
published as source (installers come in later versions, see
[docs/distribution](docs/distribution/README.md)).

- **Built for agents.** The project is now **Agents Factory** (it was
  published as Agents Factorio on 2026-10-06). Agents run on Claude through
  the Claude Agent SDK; Codex CLI and local agent harnesses are on the
  [roadmap](ROADMAP.md).
- **Atlas v0.30.0** - the Electron desktop app: strategy map (World → Project →
  Quarter → Agent), live agent chats with thinking blocks and tool calls,
  steering and queueing, questions with single and multiple choice, permission
  modes per agent, memory documents with approval, agent history (per-turn
  commits), project and quarter leads.
- **Application Gateway v0.146.0** - hosts the agents through the Claude Agent
  SDK with an Anthropic API key: project, quarter and agent memory; write
  zones enforced by a pre-tool hook; permission modes (manual, accept edits,
  auto, bypass); one git commit per agent turn; operation journal with
  receipts.
- **Controller template v0.42.0** - a clean instance to copy: Gateway tools,
  control cycle, desk-agent task kit and contracts.
- **Frontend Kit v0.21.0** - the backend's accepted delivery, pinned by SHA-256.
- **Docs:** the plan for the one-file installer, the CLI, MCP and telemetry
  ([docs/distribution](docs/distribution/README.md)); [PRIVACY.md](PRIVACY.md):
  no telemetry in this version.
