# Claude Code Provider For Desk Agents

Status: source `v0.136.1` (controller patches up to
`serialized-control-v0.30.4`). Stages 1-4 of the port added this provider,
write zones, leads, agents' own memory and memory documents
(`project-memory.md`), agent activity and `agent_idle` (`attention-model.md`)
and controller tasks for desk agents (`claude-code-controller.md`). The live
acceptance of stage 5 ran on 2026-10-02 with real Claude Code turns; what it
covered and what is still open is listed at the end.

Desk agents (the agents of `project-memory.md`: one agent per quarter feature,
with project and quarter memory) run on Claude Code. The Gateway starts with:

```text
node application-gateway-cli.mjs run --repo-root <controller> --project-id <id> --monitor-id <uuid> --provider claude
```

Claude Code is the only provider (`--provider` defaults to `claude`). The
Codex App Server runtime, with the owner chat and the generic provider mutations
(thread create, turn start, interrupt of `application-gateway-provider-mutations.md`),
left with the Codex path on 31.10.2026 (roadmap step 1): `--provider codex` and
`--provider-source-id` are refused. An ACP agent (DeepSeek Harness, and later
Codex through `codex-acp`) runs beside Claude Code (`acp-provider.json`).

The controller's serialized reviewer and report summarizer run on Claude Code
too (`claude-code-service-client.mjs`): `control-cycle.json` without a
`provider` means `claude-code`, and `codex-app-server` is refused.

## Configuration

`--provider claude` reads the controller's machine-local
`.project-local/application-gateway/claude-provider.json`. It is never
committed. Unknown fields are refused.

```json
{
  "schemaVersion": 1,
  "sdkPath": "C:/claude-runtime/node_modules/@anthropic-ai/claude-agent-sdk",
  "claudeConfigDir": null,
  "keepProviderVariables": false,
  "models": [{ "id": "claude-sonnet-5", "displayName": "Claude Sonnet 5" }],
  "settingSources": ["project", "local"],
  "permissionMode": "acceptEdits"
}
```

- `sdkPath`: the installed `@anthropic-ai/claude-agent-sdk` package. It is not
  bundled into the Gateway runtime: it ships the Claude Code program as a native
  executable in a platform package beside it.
- `claudeConfigDir`: an optional Claude Code account folder
  (`CLAUDE_CONFIG_DIR`), to run on an account other than the machine's default.
- `agentCommits`: `false` stops committing each turn's work to the project
  folder's git (see Commits Of The Agents' Work); on by default.
- `keepProviderVariables`: by default the variables that would bill another
  account or route through another provider (`ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`,
  `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`) are removed from the
  environment of a turn. `true` keeps them, for an organization that signs in
  that way.
- `models`: the models an agent profile may name. Each may list `efforts`
  (`default`, `low`, `medium`, `high`, `xhigh`, `max`; `default` passes none and
  leaves Claude Code's own) and a `defaultEffort`.
- `permissionMode`: `default`, `acceptEdits`, `auto`, `plan` or `dontAsk`:
  the mode of agents without their own. `bypassPermissions` is not accepted
  here: it is only ever an agent's own mode, chosen by the person for it.
- `webFetchHosts`: host names agents may `WebFetch` from without asking the
  person (each covers its subdomains). Not given: built-in documentation and
  code hosts (`DEFAULT_WEB_FETCH_HOSTS` in `agent-secret-paths.mjs`); `[]`:
  every fetch asks.

An agent profile on this provider is
`{ "provider": "claude", "model": <a configured id>, "reasoningEffort": <an effort of it>, "fallbackPolicy": "deny" }`.

## How It Fits

`claude-code-session-host.mjs` presents Claude Code sessions in the shape of the
Codex App Server client the backend already uses. The interaction bridge
(`application-provider-interactions.md`), the conversation read adapter, the
conversation archive capture and the agent event stream therefore run
unchanged; each of them only accepts the provider identity as a parameter now.

| Backend concept | Claude Code |
| --- | --- |
| thread | one Claude Code session; the thread id is the session id |
| agent creation | a session id is chosen and recorded; no turn runs |
| message | one turn: an SDK query that resumes the session, takes one message and ends with the turn |
| first message | started under the recorded id (`sessionId`); later ones resume it (`resume`) |
| `turn/started`, `item/*`, `turn/completed` | emitted from the SDK message stream |
| items | `userMessage`, `agentMessage`, `reasoning` (hidden), `commandExecution` (Bash, PowerShell), `fileChange` (Write, Edit, MultiEdit, NotebookEdit), `plan` (TodoWrite, rendered as a checklist), `mcpToolCall` (any other tool) |
| server requests | Claude Code's permission callback: shell commands -> `item/commandExecution/requestApproval`; file tools -> `item/fileChange/requestApproval`; `AskUserQuestion` -> `item/tool/requestUserInput` (with `multiSelect` when several options may be chosen; the answers go back joined with ", "); any other tool -> `item/permissions/requestApproval` |
| interrupt | the SDK's interrupt; the process is ended after 10 seconds without an answer |

A request with no registered handler, or one that ends without the person's
decision, is denied: the action is not taken. `cancel` on an approval denies it
and stops the turn.

`claude-code-session-journal.mjs` records each session's turns and items under
`.project-local/orchestration/claude-sessions/<session id>/` (`session.json`
and one file per turn), so live reads stay exact across Gateway restarts. A
turn still running when the Gateway starts belonged to a process that is gone;
it is recorded as `interrupted` with `recovery: "gateway_restarted"` and is
never run again from here. The controller's one-off review and summary turns
keep their own journal, `claude-service-sessions/`, which is not recovered
(`claude-code-controller.md`).

`project-memory-claude.mjs` is the `ProjectMemoryService` provider, the
counterpart of `project-memory-codex.mjs`. `application-gateway-claude-runtime.mjs`
assembles the host, the read adapter, the memory provider and the event bridge
in the shape of the Codex provider runtime.

## Every Turn Gets The Same Options

Claude Code does not restore options on resume, and a different tool list is a
different prompt start: the whole context is written to the cache again at full
price (measured 2026-10-01). Every turn therefore gets the same:
`strictMcpConfig: true` (no MCP servers of the account), `skills: []`, a fixed
built-in tool list (`CLAUDE_AGENT_TOOLS`: Read, Write, Edit, Glob, Grep, Bash,
NotebookEdit, TodoWrite, WebFetch, WebSearch, AskUserQuestion; sub-agents left
out), the configured `settingSources`, the agent's permission mode, the `claude_code`
system prompt preset without its dynamic sections, and adaptive thinking with
summarized display.

## Write Zones And Parallel Agents

Many feature agents share one project folder, each owning its part. An agent's
settings (`project-memory.md`) may give it a write zone: path patterns from the
folder root (`tools/jointsolver/**`, `tools/ui/*.py`, `docs/solver.md`). Every
turn of such an agent carries a PreToolUse hook (`agent-write-zone.mjs`): an
edit outside the zone is refused before it runs, in every permission mode, with
a reason the agent reads; reading stays open. A shell command that only reads
(every part runs a reading program, nothing redirected into a file,
`readOnlyShellCommand`) is left to the permission mode; one that may write
goes to the person in the manual and accept-edits modes, and to the mode in
auto and bypass. Hooks are not part of the prompt, so the prompt cache is
unaffected.

## Secrets Are Not Read

Every turn of every agent, with a zone or without, carries a first PreToolUse
hook (`agent-secret-paths.mjs`, `claudeSecretHook`) that refuses, in every
permission mode, a tool call that would read or change a login, key or token:

- by name wherever it lies: `.credentials.json`, `.claude.json`,
  `connection.v1.json`, `*.dpapi.json`, `.env` (not `.env.example`), SSH keys,
  `.netrc`, `.npmrc`, `.git-credentials`, key stores, and data files named for a
  key (`work-qwen-api-key.txt`, `github-token.json`, `secrets.yaml`);
- by folder: `.project-runtime`, `secrets`, `.ssh`, `.gnupg`, `.aws`, `.azure`,
  `.kube`, `.docker`, and any `.project-local` outside the agent's own folder
  (an instance's: its logins and the Gateway's connection);
- in `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Grep` (`path`,
  `glob`), `Glob` (`path`) and `LS`, and in shell commands that name such a path
  (wildcards like `.cred*` count) or print the environment (`env`, `printenv`,
  `set`, `export -p`, PowerShell's `env:` drive, a variable named for a key
  such as `$ANTHROPIC_API_KEY`).

The refusal tells the agent to say in its answer that the work needs a secret,
so the person does that step. A shell can always hide a name: this stops the
plain and the accidental cases, and secrets still belong outside the agents'
folders. ACP agents get the same check in the host's permission gate (their
desk gate plugin sends reading tools there too; any other read is allowed at
once, without the person).

A second hook (`claudeWebFetchHook`) asks the person before a `WebFetch` to an
address not on `webFetchHosts`: whatever a fetched address carries goes there,
and a prompt injected into what an agent read may try to send out what it
found. MCP: an agent sees only the servers the Gateway passes
(`strictMcpConfig`: the in-process `desk` server); ACP agents only those listed
in their provider config. Trust levels per server come with the MCP catalog
(`docs/distribution/mcp.md`, stage 2).

## Permission Modes

Each agent may have its own permission mode, as in Claude Code: `default`
(manual: Claude Code asks for edits and for commands that change things),
`acceptEdits` (file edits in the folder pass), `auto` (Claude Code's
classifier approves or refuses each call and asks when it cannot decide) or
`bypassPermissions` (nothing is asked; the turn also passes the SDK's
`allowDangerouslySkipPermissions`). The person sets it in the trusted host
(memory CLI `set-permission-mode`, `project-memory.md`); an agent without one
runs in the configured `permissionMode`. A turn takes the mode it starts with:
a change applies from the agent's next turn. Asks of every mode still reach
the person through the permission callback (`canUseTool`).

Because this provider holds zones (`enforcesWriteZones`), two agents of one
folder may run at the same time when both have zones that cannot meet. The
check is conservative: patterns meet when the folder of one contains the folder
of the other. An agent without a zone still runs alone in its folder. A lead
may change what it leads: a project lead the whole project folder (so it runs
alone in it, like an agent without a zone), a quarter lead the zones of its
quarter's feature agents and `docs/memory/**` (so it waits for those agents
and runs beside the other quarters'). The role's text tells the agent what it
may change; it is part of the memory delivery key, so a changed rule reaches
an agent that already had its memory.

## Messages While A Turn Runs

A turn takes the person's messages while Claude Code works (`steer`), and
holds queued ones for its end. Its input closes when Claude Code says it is
idle - the authoritative end of its work, background tasks included. A result
alone does not close it: when Claude Code works on after a result (a background
task finished, say) or reports itself running again, the turn waits for idle,
so a message steered in meanwhile still reaches it instead of waiting for the
whole turn to end.

## Plan Usage

The window's header shows the Claude plan's usage as Claude Code's /usage does:
the 5-hour session, the week and the per-model weekly limits, each with its
share and reset time. The session host asks the process of a running turn
(the SDK's usage request, `skipBehaviors`; no session is started for it and
no model is called) when the turn starts, after each result and once a minute
while it runs (a long turn spends the plan too), and passes the turns' rate-limit
events on. The Gateway keeps the last reading in the machine-local
`.project-local/application-gateway/claude-usage.v1.json` (percentages and
times only, `claude-usage.mjs`); Atlas reads that file, again every 20 s
while its menu is open. Between turns the window shows the last reading with
its time.

## Commits Of The Agents' Work

Each turn's work becomes a commit in the git of its project folder
(`agent-turn-commits.mjs`), so the history of what the agents changed can be
read in git and in Atlas. Before a turn the provider snapshots the folder's
uncommitted files (path and content hash); after it, again. The paths that
changed between the two, inside the project folder and the agent's write zone
(never `.git` or `.project-local`), are staged and committed with
`git commit -- <paths>`: what the person or another agent left uncommitted,
staged or not, is not taken along. The author is the agent
(`<agentId>@agents.atlas.local`), the committer `Atlas Gateway`; the message
names the agent and the first line of the person's message, then
`Atlas-Agent`, `Atlas-Operation` and `Atlas-Turn` trailers. Hooks run; nothing
is pushed. A folder that is not under git is reported, never initialised here:
Atlas offers `init-project-git` (memory CLI, the person confirms; `git init`
only, nothing committed). `agentCommits: false` in `claude-provider.json` turns
the commits off. A Gateway restarted during a turn does not commit that turn.

## Memory Only When It May Be Missing

The memory snapshot (project, quarter and the agent's own memory, plus a lead's
overview) goes with a message only when it may be missing from the
conversation: the manifest, the agent's settings or a lead's overview changed,
Claude Code compacted the session since (the journal counts `compact_boundary`
messages), or the last message did not complete. Otherwise the message says the
memory is unchanged and names the manifest. The send receipt records which
(`memory: "full"` or `"unchanged"`).

## The Desk's Tool

Every turn carries one in-process MCP tool, `write_memory_from_document`
(`mcp__desk__write_memory_from_document`), always, so the tool list stays the
same. It writes a memory document into memory exactly as the person approved it
in the desk (`project-memory.md`, Memory Documents) and answers the agent what
was written, or why nothing was. It needs `zod` from beside the SDK
(`loadClaudeZod`); without it the tool and its instructions are left out.

## The World Lead, Desk Tasks And The Lifecycle In Node

- **The world lead.** The role `coordinator` is shown in Atlas as the world
  lead: an agent in the reserved project `world`, bound to the controller root,
  in its HQ quarter `hq`. Atlas sets it up in one confirmed flow (the trusted
  host binds `world` to the controller root, creates the agent, then gives it
  the role). Its memory also carries an overview of every other open project:
  its lead and agents. Its write zone and the one-coordinator rule are
  unchanged.
- **Desk tasks without PowerShell.** For the route `claude-desk-agent` the desk
  tools (accept, plan, progress, report, signal), the coordinator's dispatch and
  the kit install at registration run in the Gateway's process
  (`desk-task-*.mjs`); they write the same files, byte for byte, as the
  PowerShell scripts. `control-cli report` collects and imports desk reports
  in-process. PowerShell remains for the Codex-era routes.
- **The lifecycle in Node.** `agents-factory gateway start | stop | status |
  recover | logs` (`.orchestrator/runtime/agents-factory.mjs`) does what
  `tools/application_gateway.ps1` does: a headless monitor (`watch`), then
  `run`, then waits for ready. Atlas starts and stops the Gateway from its
  readiness panel through it. The Anthropic API key comes from
  `ANTHROPIC_API_KEY` or from the key store (`agents-factory key set`: DPAPI,
  Keychain or Secret Service) and reaches only the Gateway's process; with
  `keepProviderVariables: true` the agents use it.

## What Is Checked

- The account, before every agent creation and send, from Claude Code's own
  read-only `claude auth status --json`, kept for a minute. A session is never
  started just to ask: stopping Claude Code while it renews its sign-in can leave
  it signed out (seen 2026-10-01). A signed-out Claude Code refuses with
  `memory_provider_unavailable`; the provider stays configured, so signing in
  needs no Gateway restart.
- The model must be one the config offers, with an effort it lists
  (`memory_profile_conflict` otherwise).
- The session: a turn whose process reports another session id fails with
  `claude_session_identity_mismatch`.
- The Gateway's visible monitor, exactly as for Codex.
- One writer per session: a second start while a turn runs is refused
  (`claude_session_busy`); `ProjectMemoryService` already allows one operation
  per agent and per workspace.
- A delivery that may have happened is never repeated (mutation lease). An
  interrupted Claude Code turn continues by itself when the session is next
  resumed, so resending would run it twice.

Recorded with each turn, not enforced: the model the session started with
(`system/init`) and the models the turn used (`result.modelUsage`). Claude Code
may use another model for its own small tasks, so a strict single-model rule
would refuse correct turns until a live run shows what it reports. The effort
cannot be read back at all; it is only requested.

## Verified Live (stage 5, 2026-10-02)

On a separate test controller, Claude Sonnet 5.5, 17 turns in all:

- The first turn of a session under the `sessionId` chosen at agent creation,
  later turns by `resume`; `system/init` and `modelUsage` name the model.
- Memory on change: later messages carried only the "memory unchanged" note.
- Desk tools on every turn: the controller task tools of a desk agent and the
  coordinator's tools, through the owner's kit scripts.
- A desk agent's file edits inside its write zone (`acceptEdits`).
- Agent activity in reads: `working`, `idle`, and `waiting-for-person` while
  the agent holds a task between messages.
- A usage limit ends the turn as failed (`claude_error_result`) with its text
  in the conversation.
- The Gateway started with `application_gateway.ps1 -Provider claude`: sends,
  receipts and reads through the Gateway's own operations with the Kit client,
  and the Atlas window connected with every operation available.
- The controller's review and report summary as Claude Code service turns.

## Still Open

- Not seen live: a permission request answered from the desk, an
  `AskUserQuestion` answer, an interrupt from the window, a Gateway restart
  during a turn, a compaction followed by a full memory message.
- Write zones: a refusal outside the zone and a shell command under a zone
  were not provoked live; nor were two agents of one folder at once.
- The plan usage request is an experimental SDK call
  (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`): an SDK that
  drops it leaves only the rate-limit events.
- Permission modes: `auto` and `bypassPermissions` were not run live (a
  live turn spends the owner's quota); `auto` needs an account where Claude
  Code offers auto mode.
- The desk's `write_memory_from_document` tool after an approval, live.
- `agent_idle` raised by a running control cycle (needs 10 minutes of idle).
- The Atlas window shows the desk agents but has no interface yet for roles,
  zones, memory documents, agent memory or activity (Kit v0.17.0-v0.20.0
  fields), and a send has not been clicked in the window itself.
- Use the Claude Agent SDK 0.3.288 or newer: 0.3.257 did not know the model id
  `claude-sonnet-5-5` and logged `unrecognized_model` (the turn still ran on
  it). Since the update a turn through the Gateway runs without the warning.
- Each live run spends the owner's quota and needs the owner's go.
