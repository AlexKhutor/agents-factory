# Agents Factory: LLM-free installation, CLI and MCP

Design documents (2026-10-20). How to turn Agents Factory from a repository
that an LLM agent sets up today by following an onboarding prompt into a
product with a normal installer on Windows, macOS and Linux, installation
through a CLI, and MCP inside the app.

| Document | About |
| --- | --- |
| [product-changes.md](product-changes.md) | What must change in the product itself before an installer can install it at all |
| [installer.md](installer.md) | One file per platform: technology, Windows, macOS, Linux, first run, signing, updates, uninstall |
| [cli.md](cli.md) | Installing and managing through the CLI: commands, install channels, headless mode |
| [mcp.md](mcp.md) | MCP in the app: tools for agents, Agents Factory as an MCP server, security |
| [telemetry.md](telemetry.md) | Opt-in anonymous telemetry: what we collect, what we never collect, how to opt out |

## Today

Installation is about ten manual steps. Today an LLM agent performs them by
following an onboarding prompt (steps 2-9 of that prompt), or a person
performs them by following the README:

1. Install Node.js 20+, Python 3 (`sqlite3`), Git and Claude Code.
2. `npm install` in `frontend/` (this also installs the Claude Agent SDK and
   its `claude` binary, 238 MB per platform).
3. Copy the `controller/` template into your own folder, create
   `.project-local\...`, copy two example configs and enter the SDK path.
4. Start the Gateway with `tools\application_gateway.ps1` (PowerShell 5.1;
   output strictly to a file, otherwise the command hangs).
5. Copy `frontend\config\local.example.json`, enter the controller path and
   `expectedWorkspace` from the Gateway's `status.v1.json`.
6. Run `start-atlas.bat`.

All of this works only on Windows: the Gateway lifecycle, the monitor and all
task tools are written in PowerShell.

## Goal

| How a person installs | What they get |
| --- | --- |
| Downloads **one file** for their OS and runs it | Atlas, the Gateway, the CLI and a first-run wizard that creates the controller, installs the Claude Agent SDK, takes an API key and opens the map |
| One terminal command (`irm …/install.ps1 \| iex`, `curl -fsSL …/install.sh \| sh`) or a package manager (winget, Homebrew, npm) | The same, with or without the window; on a server, only the Gateway as a service |
| Adds Agents Factory to Claude Code, Claude Desktop, Codex CLI or Cursor as an MCP server | Manages the agent team from their own client |

"One file" means **one file per platform** (`.exe`, `.dmg`,
`.AppImage`/`.deb`). A single binary for all OSes at once is impossible. The
equivalent of "one action for everyone" is a one-line install command.

## Decisions

| Topic | Decision |
| --- | --- |
| Name | **Agents Factory** (formerly Agents Factorio; Factorio is a trademark of Wube Software). Repository `AlexKhutor/agents-factory`, CLI `agents-factory` |
| Positioning | **"Built for agents"**: a tool not only for Claude but for any agents and harnesses (Claude now; Codex CLI and local agents are on the roadmap). The product name does not use "Claude Code" (Agent SDK branding rules) |
| Claude sign-in | **Public product: API key** (`ANTHROPIC_API_KEY`; already works through `keepProviderVariables: true` in `claude-provider.json`). Unless previously approved, Anthropic does not allow third-party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK (Claude Agent SDK documentation). Subscription sign-in remains only for the maintainer's own personal setup. Convenient key entry in Atlas (stored in the system credential store) is in development |
| Claude Agent SDK | Not in the installer: installed from npm on the user's machine, pinned version ([product-changes.md](product-changes.md)) |
| One install engine | All installation lives in the CLI (`agents-factory setup`); the Atlas wizard and the one-line installers call it. No logic that only an LLM knows |
| One runtime | Gateway on Electron's Node; `node:sqlite` instead of Python; a Node CLI instead of PowerShell |
| Packaging | electron-builder: NSIS (Windows), `.dmg` (macOS), `.deb`/`.rpm`/`.AppImage` (Linux); auto-update from GitHub Releases |
| Signing | First releases unsigned, with `SHA256SUMS` and launch instructions. Before a wide release: publisher **Aleksandr Khutornoi**; Windows: SignPath Foundation (free for open source) or Azure Trusted Signing; macOS: Apple Developer Program (Developer ID, notarization) |
| Gateway | Started and stopped from Atlas; a user service is planned from the start: a Task Scheduler task (Windows), launchd (macOS), `systemd --user` (Linux) |
| Controller | One per installation: projects and quarters already divide the work. The main coordinator is the **world lead** inside the same controller; it hands out tasks to project leads and desk agents under the task contract |
| CLI | `agents-factory` |
| MCP | External clients get read-only access first; writes confirmed in Atlas are planned for later |
| Codex | The PowerShell tools from the Codex (VS Code) era go away; Codex CLI connects through a Node adapter for `codex app-server` and MCP, which works on all OSes |
| Telemetry | Anonymous only, only to improve the product, with explicit consent; opt out at any time ([telemetry.md](telemetry.md)) |
| One-line install | Direct links to GitHub release files (`…/releases/latest/download/install.sh`), no domain of our own |
| Test platforms | The maintainer has Windows and WSL: Windows manually and in CI; Linux in WSL (WSLg for the window) and in CI; macOS only in CI (GitHub Actions macOS runners) |
| macOS without Xcode | Neither xtool (iOS only) nor Swift templates (for native Swift apps) are needed: electron-builder runs the same pipeline: `.app`, `codesign`, `notarytool`, DMG, updates |
| Phone | An iOS companion app (notifications, commands to the orchestrator) is for the future; xtool will be useful then. It needs a secure channel to the Gateway from outside, and APNs |

## Versions and releases

- **One product version**, semver: `vMAJOR.MINOR.PATCH`. Components keep
  their internal versions (Atlas, Gateway, controller, kit); they are listed
  in the release notes and in `agents-factory version`.
- **v0.1.0** is the currently published state, the first version (source
  code, no installers).
- While on `0.x`: the second number means new features (compatibility may
  change), the third means fixes. `v1.0.0` means installers for all three
  OSes and stable contracts.
- Betas: `v0.2.0-beta.1`, update channel `beta`.
- A `vX.Y.Z` tag in the public repository → GitHub Release → a section in
  `CHANGELOG.md` → the version in the installer file names.
- The version comes from the `VERSION` file in the public repository (the
  export that generates this repository copies it from the maintainers'
  development repository).

## Stages

| Stage | What | Depends on |
| --- | --- | --- |
| 0 | Product preparation: `node:sqlite` instead of Python, a Node CLI instead of PowerShell, the `setup` engine, the SDK manager, API key sign-in in Atlas, data directories, the Gateway managed by Atlas and as a service ([product-changes.md](product-changes.md)) | - |
| 1 | Windows: NSIS installer, first-run wizard, CLI (npm, `install.ps1`, winget), auto-update | 0 |
| 2 | MCP for agents: catalog, levels, secrets, Atlas UI | 0 |
| 3 | Agents Factory as an MCP server: read, then write with confirmation; MCP Registry, MCPB for Claude Desktop | 0 (read can come earlier) |
| 4 | macOS: `.dmg`, notarization, launchd, Homebrew | 0, 1 |
| 5 | Linux: `.deb`/`.rpm`/`.AppImage`, systemd --user, headless server | 0, 1 |

## Open questions

1. **Where telemetry goes:** a minimal server of our own, or self-hosted
   PostHog/Sentry; retention period; a contact for data requests. We will
   decide when we get to telemetry.
