# Roadmap

Agents Factory is under active development: it is the tool its author works
with every day, and it keeps growing with that work. Shipped changes are in
[CHANGELOG.md](CHANGELOG.md); ideas and bug reports are welcome in
[Issues](https://github.com/AlexKhutor/agents-factory/issues).

## Next

- **Autonomy with the person in charge.** The "task" mode and the Plan card
  are in (see the [changelog](CHANGELOG.md)), and Claude Code agents keep their
  memory themselves with the person's approval. Next: the same memory tools
  for ACP agents (a local Qwen), the world lead handing tasks out to the
  agents with the person's approval, an agent stopping on someone else's
  failure instead of building on it, and an attention list ranked by what
  matters most.
- **Statistics and budgets.** Turns (done and failed), working time, tokens
  (input, cache, output) and their price at API rates, by model - per agent,
  quarter, project and the whole world, for a day, a week or all time - in an
  Atlas panel and as CSV. The same numbers drive budgets per agent and per
  project and a guard against running out of quota.
- **A task board.** A kanban page next to the map (switch "Map | Board"): the
  same tasks in columns along their chain - handed out, accepted, planned, in
  progress, reported, accepted or rejected - with plan approval and report
  review right on the board. Later, each project's own pipeline of columns and
  rules, as in Jira.
- **A clearer map.** Hover cards for an agent, a quarter or a project: what it
  is doing now, its plan and step, whether it waits for you, its last turn and
  what it spent. A simple mode for newcomers: just projects and their agents.
- **Bring your work in.** Move a project you already run in Claude Code into
  Agents Factory without starting over: the agent writes a hand-over package
  (memory, folders, tools, open tasks), and Atlas creates the project, its
  agent and the memory documents for you to approve; optionally the chat
  itself continues.
- **Routines.** The agents' scheduled work in one list - Claude Code routines
  and the skills they run, and Agents Factory's own schedules: details, run
  now, pause, a new schedule, run history and spend. A routine is created step
  by step, each step confirmed.
- **More providers.** A local Qwen and DeepSeek-based harnesses already run
  next to Claude through the Agent Client Protocol (ACP). Next: Codex (through
  `codex-acp`), Hermes, Qoder and other local and self-hosted agents, under the
  same write zones, memory and permission rules.
- **One-file installer, CLI and MCP.** One installer per OS (Windows and Linux
  first, then macOS) on top of the `agents-factory` CLI, MCP servers for the
  agents, and Agents Factory itself as an MCP server for Claude Code, Claude
  Desktop, Codex CLI and Cursor. The plan:
  [docs/distribution](docs/distribution/README.md).
- **First run in minutes.** Fewer manual steps between download and the first
  agent turn, and a step-by-step guide with a demo video.

## Later: unattended work, in a sandbox

Agents that work with no person at hand do so only inside a sandbox: a
separate user account or a container with one project folder and limited
network access.

## Later: themes

The look only - colours, icons, the map's style; functions and layout stay
the same, and today's theme remains the default.

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

- More languages for Atlas's interface (English and Russian today).
