# What to change in the product before the installer (stage 0)

An installer cannot do what today depends on manual steps, Windows-only tools
and external runtimes. These changes are needed for any installation method,
and on their own they make the product easier to maintain.

## 1. Python → `node:sqlite`

**Today.** Project memory, the conversation archive and the control queue are
stored in SQLite through Python bridges that the Gateway runs as `python`:
`project-memory-store.py`, `conversation-archive-store.py`,
`sqlite-control-store.py` (`sqlite-bridge-server.mjs`,
`sqlite-control-store.mjs`, `control-cli.mjs`). The user has to install
Python 3, and an installer cannot guarantee it on macOS and Linux.

**Decision.** Stores on `node:sqlite` (`DatabaseSync`) in the same Gateway
process.

- Verified: Electron 41.7.1 includes Node 24.15.0, and `node:sqlite` works
  (SQLite 3.51.3). The system Node 22 has it too, but with an
  `ExperimentalWarning`.
- The same database files and the same schema: the switch needs no data
  migration.
- The Python bridge stays as a fallback for one version (a configuration
  flag), with tests that run both implementations on the same fixtures.
- Bonus: fewer processes and less latency (today every memory request is JSON
  over a child process's stdin/stdout).

## 2. Separate Node → Electron's Node

The Gateway and the CLI run with the app executable and
`ELECTRON_RUN_AS_NODE=1`: the same Node 24 as Atlas, with no separate
install. For a headless install without Atlas (a Linux server), the CLI ships
as a standalone binary (see [cli.md](cli.md)) with its own Node.

To verify and lock in with a test: the Gateway bundle (`format: "esm"`,
`target: "node20"`) runs under Electron's Node unchanged; `process.execPath`
in the code that starts child Node processes points to the right binary with
the right environment.

## 3. PowerShell → a Node CLI

**Today** these are written in PowerShell:

| What | Files |
| --- | --- |
| Gateway lifecycle and monitor | `application_gateway.ps1` (`Start`, `Stop`, `Status`, `Recover`, `OpenMonitor`, `CloseMonitor`, `Watch`), `.bat` wrappers |
| Desk agent tasks | `install_child_coordination_kit.ps1`, `dispatch_child_task.ps1`, `collect_child_reports_v2.ps1` → `collect_child_reports.ps1` → `import_agent_report.ps1`, `rebuild_knowledge_catalog.ps1` |
| Agent kit scripts | `accept_task.ps1`, `confirm_task_plan.ps1`, `update_task_progress.ps1`, `submit_report.ps1`, `submit_report_correction.ps1`, `signal_orchestrator.ps1` (called by the `desk` tools in the Gateway) |
| Shared functions | `project_tooling_common.ps1`, `orchestration_common.ps1` |

**Decision.** Move them to Node, inside the Gateway bundle and the CLI:

- `agents-factory gateway start|stop|status|run|logs` instead of
  `application_gateway.ps1`. The monitor, a console window without which
  turns do not run, is replaced by a status in Atlas and a system tray icon.
- The `desk` tools perform task operations inside the Gateway process, not
  through `powershell.exe`. The contracts (immutable task packets, hashes,
  receipts, deterministic acceptance) do not change.
- Step-by-step transition: first a Node implementation next to PowerShell,
  with comparison tests on the same fixtures; then PowerShell stays a thin
  wrapper on Windows for one version; then it is removed from the public
  product.
- PowerShell 7 (`pwsh`) on macOS/Linux is not a solution: it is one more
  dependency, and some scripts rely on Windows-specific things (processes,
  windows).

## 4. A `setup` engine instead of manual configuration

One idempotent command that does everything that is done by hand today, and
that both the Atlas wizard and the one-line installers call:

1. Checks the environment (`doctor`): git, disk space, directory permissions.
2. Creates a controller instance from the template in the user data
   directory (see below), if there is none yet.
3. Installs or finds the Claude Agent SDK (section 5) and writes
   `claude-provider.json` (SDK path, models).
4. Writes `control-cycle.json` from the example.
5. Starts the Gateway and waits for `ready`.
6. Writes the Atlas configuration: the controller path and
   `expectedWorkspace` from `status.v1.json`. This is trust on first use,
   pinned by the engine, not by the Atlas page. Switching to another instance
   is an explicit command.
7. Returns JSON with the result of each step; running it again breaks
   nothing.

Data directories (not synced by a cloud service, so SQLite is not damaged):

| OS | Application | Data and controller instance |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\Programs\AgentsFactory` | `%LOCALAPPDATA%\AgentsFactory\` (not `Documents`: it may be under OneDrive) |
| macOS | `/Applications/Agents Factory.app` | `~/Library/Application Support/AgentsFactory/` |
| Linux | `/opt/agents-factory` (`.deb`/`.rpm`) or the `.AppImage` file | `$XDG_DATA_HOME/agents-factory` (`~/.local/share/agents-factory`) |

## 5. Claude Agent SDK manager

- The SDK is a proprietary Anthropic package (`LICENSE.md`: "All rights
  reserved", Anthropic's terms). The `claude` binary is about 238 MB per
  platform (packages `@anthropic-ai/claude-agent-sdk-<os>-<arch>`, including
  `darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`).
  We cannot embed it in our installer, neither because of the license (until
  the terms are checked) nor because of its size.
- `agents-factory claude install` installs the pinned SDK version from npm
  into `<data>/runtime/claude-agent-sdk/<version>/` with an integrity check
  (the integrity value from our lock file). Without npm on the machine, the
  same code downloads the tarball from the npm registry.
- If the person already has Claude Code, its binary can be used
  (`pathToClaudeCodeExecutable` in the SDK): less to download, but the
  version is not ours.
- **Sign-in is by API key.** The Claude Agent SDK documentation says:
  "Unless previously approved, Anthropic does not allow third party
  developers to offer claude.ai login or rate limits for their products,
  including agents built on the Claude Agent SDK." So the public product
  works with an Anthropic API key (`ANTHROPIC_API_KEY`). Today this already
  works through configuration: `"keepProviderVariables": true` in
  `claude-provider.json` and the key in the Gateway's environment. In the
  product, the wizard takes the key, the trusted host stores it in the system
  credential store (Windows Credential Manager, macOS Keychain, libsecret),
  and the Gateway passes it only into the environment of Claude processes.
  The key is never written to configs, logs or memory.
- The product does not offer claude.ai subscription sign-in. It remains
  available for the maintainer's own personal setup: their own Claude Code,
  sign-in with `claude auth login`, without `keepProviderVariables`. The plan
  quota menu is shown only in this mode.
- We never read credentials; the sign-in state comes only from
  `claude auth status --json`.
- The SDK is updated together with the app (the version is pinned in the
  release); rollback goes to the previously installed version.

## 6. The Gateway managed by Atlas

Today Atlas deliberately does not start the Gateway. The product needs:

- Atlas (the trusted host, not the page) starts and stops the Gateway through
  the CLI: a "Start" button in the readiness panel; starting the Gateway
  automatically when Atlas starts is a setting.
- The Gateway outlives the Atlas window while turns are running; it stops
  explicitly or at sign-out.
- From the start (the maintainer decided), also as a user service:
  `agents-factory service install` registers a launchd agent (macOS), a
  `systemd --user` unit (Linux), or a Task Scheduler task at sign-in
  (Windows; a real Windows service needs administrator rights, and our
  installation runs without them). This is also needed for a headless
  server.
- The trust boundary stays: the Atlas page still does not touch processes or
  the token; everything goes through the trusted host.

## 7. Portability audit

Before macOS and Linux, go through the code and the tests:

- paths: `path.win32` vs `path.posix`, case of names, separators in write
  zones (`agent-write-zone.mjs` already has a `platform` parameter);
- starting processes: `.bat`/`.ps1`, `windowsHide`, argument quoting;
- encodings and line endings (`* -text` in `.gitattributes` stays);
- tests that fail with a short TEMP path (an 8.3 short name that ends in a
  tilde and a number): the same will happen with symbolic links under `/var/folders` on
  macOS, so compare paths through `realpath`;
- code from the Codex and VS Code era, which is not part of the public
  product.

## 8. Instance migrations instead of a patch chain

The maintainers' own controller instance is updated with immutable patches
with receipts. That is too heavy for public users. In the product:

- the instance has a schema version (`instance.json`);
- an app update runs `agents-factory migrate`: backup of databases and
  configs → idempotent migrations in order → verification;
- rollback restores the backup with the same command.

## 9. One controller and the world lead

- One installation, one controller, one "world" on the map. Projects and
  quarters already divide the work; several controllers are not needed. A
  second computer is simply a second installation (a link between them comes
  later, through MCP).
- The main coordinator, which distributes tasks across projects, is the
  **world lead**: a role one level above project and quarter leads. It sees
  all projects and hands out tasks to project leads and desk agents under the
  existing contract: immutable task packet → plan → progress → report →
  acceptance by code.
- Already in the code: the `coordinator` role, desk agents
  (`register-desk-source`), the `desk` task tools, report import and
  acceptance (`control-cli`). Since the move to Claude, this has not been
  used live yet.
- Needed: the world lead role in Atlas (a world HQ on the map, a tasks tab),
  registering desk agents and assigning roles from Atlas instead of the CLI.
