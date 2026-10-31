# CLI: install and manage from the terminal

The `agents-factory` CLI is the only install and setup engine. The first-run
wizard in Atlas, the one-line installers and the package managers call the
same commands. Everything the installation does can be repeated, checked and
automated without an LLM.

## How the CLI is installed

| Method | Command | What's inside |
| --- | --- | --- |
| With the app | installer checkbox | a link to the CLI inside the app; runs on Electron's Node |
| One command, Windows | `irm https://github.com/AlexKhutor/agents-factory/releases/latest/download/install.ps1 \| iex` | downloads the release, checks SHA-256, installs per user, adds to `PATH` |
| One command, macOS/Linux | `curl -fsSL https://github.com/AlexKhutor/agents-factory/releases/latest/download/install.sh \| sh` | the same; no `sudo` |
| npm | `npm i -g agents-factory` | for those who already have Node 22.13+ (needs `node:sqlite`) |
| winget / Homebrew / Scoop | `winget install …`, `brew install agents-factory` | after the first signed releases |

The one-line installers work the same way as Claude Code's
(`curl -fsSL https://claude.ai/install.sh | bash`):

- HTTPS only;
- a specific version or `latest` from GitHub Releases;
- verification of `SHA256SUMS` and its signature;
- installation into a user directory (`~/.local/bin`,
  `%LOCALAPPDATA%\Programs`), no system changes;
- flags `--version`, `--headless`, `--no-app`, `--yes`.

### Standalone binary

For servers without Atlas and without Node, the CLI has to be standalone:

- **Option A (recommended to start with):** an archive with the official
  Node binary and the CLI bundle (`node` + `agents-factory.mjs` + a wrapper).
  Simple and transparent; updated by replacing the folder.
- **Option B:** Node SEA (Single Executable Application), one file. Since
  Node 25.5 there is a `--build-sea` flag. Limitation: the SEA main script is
  CommonJS; our bundle is ESM, so SEA needs a separate CJS build through
  esbuild. Move to B once A works.

## Commands

All commands support `--json`, have stable exit codes and ask no questions
with `--yes` / `--non-interactive`.

### Setup and diagnostics

| Command | What it does |
| --- | --- |
| `agents-factory setup [--instance <path>] [--headless]` | Everything the first-run wizard does, idempotently ([product-changes.md](product-changes.md), section 4) |
| `agents-factory doctor` | Checks: runtime, git, SDK, Claude sign-in (only `claude auth status`), instance, Gateway, ports, disk space; an exact hint for each problem |
| `agents-factory migrate [--dry-run]` | Instance migrations after an update, with a backup |
| `agents-factory update [--channel beta]` | Update the CLI (and the app, if it was not installed through a package manager) |
| `agents-factory uninstall [--purge]` | Uninstall; `--purge` also removes the data, after confirmation |
| `agents-factory version` | Versions of the product, Gateway, kit, SDK |

### Claude

| Command | What it does |
| --- | --- |
| `agents-factory claude install [--version <v>]` | Install the pinned Claude Agent SDK version from npm |
| `agents-factory key set` | Take an Anthropic API key (from stdin, not from a command-line argument) and put it in the system credential store |
| `agents-factory key status` | Whether there is a key and where it will come from (environment or store); the key itself is never printed |
| `agents-factory key check` | Check the key without an agent turn (not yet) |
| `agents-factory key remove` | Remove the key from the store |
| `agents-factory claude status` | How the Gateway will sign in to Claude; read-only |

The public product does not offer claude.ai subscription sign-in
(Anthropic's Agent SDK policy: unless previously approved, Anthropic does
not allow third-party developers to offer claude.ai login or rate limits for
their products; see [product-changes.md](product-changes.md), section 5).
For the maintainer's own personal setup, there remain their own Claude Code
and `claude auth login`, without a command of ours.

### Telemetry

| Command | What it does |
| --- | --- |
| `agents-factory telemetry status` | Whether it is on, and why (setting, `DO_NOT_TRACK`, `AGENTS_FACTORY_TELEMETRY`) |
| `agents-factory telemetry on / off` | Change the choice |
| `agents-factory telemetry show` | What was sent and what will be sent next ([telemetry.md](telemetry.md)) |

### Gateway

| Command | What it does |
| --- | --- |
| `agents-factory gateway start / stop / status` | Replaces `application_gateway.ps1` |
| `agents-factory gateway run` | The Gateway in the foreground: for launchd, systemd and debugging |
| `agents-factory gateway logs [--follow]` | Gateway logs |
| `agents-factory service install / uninstall` | Auto-start as a user service: launchd agent, `systemd --user`, Windows Task Scheduler task |

### Working with the team

Thin wrappers over the existing memory CLI actions and Gateway operations:

| Command | What it does |
| --- | --- |
| `agents-factory open` | Open Atlas |
| `agents-factory project list / create / bind <folder>` | Projects and folder binding (binding needs a confirmation) |
| `agents-factory agent list / create` | Agents |
| `agents-factory agent send <agent> <text> --spend-quota` | Message an agent; it spends quota, so it does not work without the flag |
| `agents-factory attention` | What is waiting for the person |
| `agents-factory memory read / propose` | Memory; writing only by proposing a document, which the person approves |
| `agents-factory mcp serve / add-to <client>` | See [mcp.md](mcp.md) |

Confirmations of irreversible actions work the same way as in Atlas: a
`--confirm-<what>` flag with the exact identifier (as the memory CLI does
today: `--confirm-agent`, `--confirm-project`); without it, the command
refuses and explains why.

## What exists today (CLI v0.1.0)

Shipped in v0.2.0 (`backend/orchestrator/src/agents-factory-*.mjs`, bundle
`dist/agents-factory-cli.bundle.mjs`, in the controller template as
`.orchestrator/runtime/agents-factory.mjs`):

- `gateway start | stop | status | recover | logs [--follow]`;
- `service install | uninstall | status`;
- `key set` (the key from stdin) / `key status` / `key remove`;
- `claude install [--version]` / `claude status` - by default the pinned SDK
  version 0.3.288 (the same as Atlas uses), `--version latest` for the newest;
- `setup`, `doctor`, `migrate [--dry-run]`, `version`, `help`.

Common flags: `--instance <folder>`, `--data-dir <folder>`, `--json`, `--yes`,
`--non-interactive`, `--node <path>` (which Node runs the Gateway).
`--plan-only` on the Gateway and service commands shows the plan and changes
nothing.

Not yet: `gateway run` (foreground), `update`, `uninstall`, `telemetry`, the
team commands (`open`, `project`, `agent`, `attention`, `memory`, `mcp`),
`migrate --restore`, SDK packages for musl, a guard against two `setup` runs
at once.

Run it from a controller: `node .orchestrator/runtime/agents-factory.mjs help`.

### Folders

| OS | Data root | Default instance |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\AgentsFactory` | `…\AgentsFactory\controller` |
| macOS | `~/Library/Application Support/AgentsFactory` | `…/AgentsFactory/controller` |
| Linux | `$XDG_DATA_HOME/agents-factory` (`~/.local/share/agents-factory`) | `…/agents-factory/controller` |

The data root holds the key (on Windows a DPAPI file) and the SDK
(`runtime/claude-agent-sdk/<version>`); the instance is the controller folder.

### Environment variables

| Variable | What it does |
| --- | --- |
| `AGENTS_FACTORY_HOME` | The instance folder (instead of the default one); `--instance` wins |
| `AGENTS_FACTORY_DATA_DIR` | The data root; `--data-dir` wins |
| `AGENTS_FACTORY_SQLITE` | `node` (default) or `python` - what opens memory, the conversation archive and the control queue; `control-cycle.json` may say the same with `sqliteBackend`; without `node:sqlite` everything falls back to Python |
| `AGENTS_FACTORY_NPM_REGISTRY` | The npm registry for `claude install` (default `https://registry.npmjs.org`) |
| `ANTHROPIC_API_KEY` | The API key; when set, it wins over the key store |

## Headless install (Linux server)

```sh
curl -fsSL https://github.com/AlexKhutor/agents-factory/releases/latest/download/install.sh | sh -s -- --headless
agents-factory claude install && agents-factory key set
agents-factory setup --headless
agents-factory service install
```

The Gateway listens only on loopback. To connect Atlas from another machine,
use an SSH tunnel (to be documented); exposing the Gateway to the network by
default is not allowed.

## How the CLI and Atlas relate

- Atlas (the trusted host) calls the CLI for everything related to
  installation, the Gateway and migrations: one implementation, one set of
  tests.
- The Atlas page still cannot call the CLI directly: only through the
  trusted host and its confirmations.
- The `--json` output is a versioned contract (like the project's other
  contracts); Atlas and the tests check it against a schema.
