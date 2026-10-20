# Roadmap

Agents Factory is under active development: it is the tool its author works
with every day, and it keeps growing with that work. Shipped changes are in
[CHANGELOG.md](CHANGELOG.md); ideas and bug reports are welcome in
[Issues](https://github.com/AlexKhutor/agents-factory/issues).

## Next

- **Codex CLI agents.** Run OpenAI Codex CLI agents next to Claude ones,
  on the same map, with the same memory, write zones, permission modes and
  per-turn commits.
- **Local agents and harnesses.** Connect local and self-hosted agents -
  DeepSeek-based harnesses, Hermes, Qoder and other local solutions - through
  one provider interface, so a team can mix cloud and local agents.
- **One-file installer, CLI and MCP.** One installer per OS (Windows first,
  then macOS and Linux), the `agents-factory` CLI for scripted and headless
  installs, MCP servers for the agents, and Agents Factory itself as an MCP
  server for Claude Code, Claude Desktop, Codex CLI and Cursor. The plan:
  [docs/distribution](docs/distribution/README.md).
- **API key setup in Atlas.** Enter the Anthropic API key in the app; it is
  kept in the system keychain (today: an environment variable).
- **A world lead.** One coordinator above the project leads that hands out
  tasks across projects; desk agents and roles managed from Atlas (today: the
  CLI).
- **First run in minutes.** Fewer manual steps between download and the first
  agent turn, and a step-by-step guide with a demo video.

## Later: VR cockpit

The same projects, quarters and agents, seen from inside a headset. Pick a
quarter, and its task, agent and attention panels open as separate windows you
place around you, next to your own editor, browser and terminal. A thin
attention strip stays at the edge of view, and an agent's chat is one
deliberate step away. Gaze only highlights; sending, stopping and approving
always take an explicit click. The cockpit reads the same facts as Atlas and
never becomes a second source of truth.

Earlier research produced a working prototype on one Windows PC with
PlayStation VR2 and SteamVR; it is not connected to Agents Factory yet.

Research done:

- **App windows in the headset without a virtual monitor.** Linux app windows
  from WSL shown as separate SteamVR panels that keep SteamVR's own move and
  scale controls; controller clicks and drags reach the app. Two windows ran
  side by side with separate input.
- **Layouts that come back.** Two window positions restored exactly in a new
  SteamVR session (same play area).
- **Eye tracking.** Raw gaze read through SteamVR at about 120 Hz, 96.75% valid
  samples over 90 seconds, separate from head movement (today this needs an
  open-source driver add-on).
- **Readable text.** Text drawn by the app itself reads clearly sharper than
  captured desktop windows; an editor at a larger zoom is readable as a window.
- **Live agent data in VR.** A read-only link to an earlier orchestrator showed
  task and agent cards in the headset and marked stale data as stale.
- **Limits found.** PlayStation VR2 passthrough is opaque-only in the official
  runtime, and SteamVR's own panels cannot be curved.
- **Survey.** A review of 14 open-source VR projects: nothing to adopt
  wholesale, a few patterns worth reusing.

Not yet tried in the headset: switching between workspaces, real apps inside
a workspace, the agent chat. Native Linux (Monado) and hand tracking are
plans.

## Later: mobile companion

A phone app to get notifications from the agents (questions, finished turns,
problems) and to send short commands to the coordinator. It needs a secure
way to reach the Gateway from outside the machine; the Gateway is
loopback-only today.

## Under consideration

- macOS and Linux support for the PowerShell tools.
- More languages for Atlas's interface.
