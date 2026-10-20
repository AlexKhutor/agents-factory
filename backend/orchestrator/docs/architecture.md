# Architecture

Agents Factory has three parts. Each one owns a clear piece of the system,
and they talk only through versioned contracts.

```text
 Atlas (Electron)                        project folders (git, write zones)
   trusted host ── confirmations             ▲
   renderer: map · chats · memory            │ Claude Code tools (Read, Edit, Bash, ...)
        │ loopback HTTP + events             │
        ▼                                    │
 Application Gateway (one Node.js process) ──┘
   Claude Agent SDK sessions · operations · receipts · journal
   memory service · attention · usage meter · per-turn commits
        │
        ▼
 Controller instance (a folder)
   .project-local/  memory and archive databases (SQLite), sessions, token
   coordination/    immutable task packets, acceptances, reviews
   knowledge/       imported reports and their catalog
   tools/           Gateway lifecycle, task dispatch, report collection
```

## Application Gateway

`backend/orchestrator/src`, built into one bundle
(`dist/application-gateway-cli.bundle.mjs`, installed as
`controller/.orchestrator/runtime/application-gateway-cli.mjs`). It has no
runtime npm dependencies; the Claude Agent SDK is loaded from the path in the
controller's `claude-provider.json`.

- **Agents as Claude Code sessions.** Every agent is one Claude Code session
  hosted through the Claude Agent SDK (`claude-code-session-host.mjs`): a turn
  per message, steering a running turn, interrupting, questions with options,
  thinking and tool calls in the conversation. See
  [claude-code-provider.md](claude-code-provider.md).
- **Memory.** Project, quarter and per-agent memory live in a SQLite store
  (`project-memory-store.py`), are delivered with a turn only when they
  changed, and are written only after the person approves the exact text. See
  [project-memory.md](project-memory.md).
- **Rights.** Each agent has a write zone (glob patterns in its project
  folder), enforced by a pre-tool hook in every permission mode (manual,
  accept edits, auto, bypass). A project lead may change the whole folder, a
  quarter lead the zones of its quarter.
- **History.** A turn that changed files becomes one git commit by that agent,
  with only that turn's files.
- **Operations.** Reads and writes are typed operations over a loopback-only
  HTTP API with a bearer token. Every write has an identity and a receipt; an
  uncertain outcome is reconciled, never resent blindly. See
  [application-gateway-operations.md](application-gateway-operations.md) and
  [application-gateway-security.md](application-gateway-security.md).
- **Attention.** Turns that finished unseen, questions waiting for an answer
  and problems are folded per agent, quarter, project and world. See
  [attention-model.md](attention-model.md).
- **Lifecycle.** `tools/application_gateway.ps1` starts, inspects and stops
  the Gateway and keeps a small monitor window open while it runs. See
  [application-gateway-lifecycle.md](application-gateway-lifecycle.md).

The Gateway also keeps a provider for the Codex App Server from earlier
versions (`-Provider codex`); Claude Code is the default and the one Atlas is
built for.

## Controller

A folder the Gateway works for, copied from the `controller/` template. It
holds everything that belongs to one installation: the memory and archive
databases, Claude Code sessions, the Gateway's descriptor and token (all under
the machine-local `.project-local/`), and the task workflow.

**Tasks that can be checked.** A coordinator agent hands work to desk agents
as immutable task packets (`tools/dispatch_child_task.ps1`). The desk agent
accepts the packet, publishes a plan, reports progress and submits a report
through tools of its task kit; the control cycle (`control-cli.mjs`) imports
the report and accepts it deterministically, by code, before any model reads
it. A delivered packet is not an accepted task, and a submitted report is not
accepted work.

## Atlas

`frontend/`, an Electron app with no UI framework.

- **Trusted host** (`src/host`): reads the Gateway's descriptor, runs the
  Gateway CLI for trusted actions, and shows its own confirmation window for
  anything irreversible (archiving, binding a folder, writing memory, the
  bypass permission mode, `git init`). The page cannot confirm for the person.
- **Renderer** (`src/renderer`): the strategy map (World → Project → Quarter →
  Agent), the agent workspace (conversation, trace, files, memory, skills),
  attention lists and the plan usage menu.
- **Frontend kit** (`vendor/frontend-kit`): the backend's contract for the
  frontend - schemas, client, fixtures - accepted as a delivery and verified
  by SHA-256 before anything is loaded. See
  [application-frontend-kit.md](application-frontend-kit.md) and
  [application-contract.md](application-contract.md).

Atlas never reads Claude credentials and never starts the Gateway itself.
