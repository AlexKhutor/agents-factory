# Agents Factory Atlas

> **The program's own UI (since 2026-10-03).** The system no longer works
> through VS Code: there are no isolated VS Code windows or Codex chat panels
> any more. This window is where the chat with agents, project files, memory,
> tasks and everything else the program does are worked. New user-facing
> features go here and into the Gateway (`backend/orchestrator`).

> **Modes (2026-10-03).** This folder is the desktop window of the backend in
> this repository, which runs its agents on Claude Code. Atlas started as an
> earlier prototype (v0.20.0) and was moved to the delivery this backend
> accepted: kit v0.20.0, now v0.21.0. The Paperclip mode
> (`start-atlas-paperclip.bat`, `src/paperclip/`) and the direct Claude Code
> mode (`start-atlas-direct.bat`, `src/direct/`) came along unchanged; they
> belong to that prototype, whose design notes are not in this repository
> (`AGENTS.md` describes both modes). The live mode (`start-atlas.bat`) is the
> one this repository uses.

A desktop client for the Application Gateway of the Agents Factory backend. It
shows one controller's work as four levels - **World -> Project -> Feature
(quarter) -> Agent** - and loads only the Application Frontend Kit the backend
accepted: release `claude-port-backend-20261003`, kit v0.21.0 (the previous
v0.20.0 is kept for a deliberate rollback, never loaded).

**v0.30.0: the agents' history, memory documents, tabs that keep their place.**
The Files tab of an agent opens with "Agent history": the commits the Gateway
made of that agent's turns in the project folder (controller v0.42.0); a folder
not under git offers "Create a git repository…" (confirmed, `git init` only).
The Memory tab of the live mode approves a memory document ("Memory document":
a preview of the entries, then "Approve" or "Approve and write", confirmed for
its exact hash) and opens the agent's own memory for reading and editing. A
refresh of the world no longer rebuilds the tabs that do not show the catalog
(files, trace, memory, tasks, questions): an open file keeps its scroll and the
editor its cursor. The usage menu re-reads every 20 s while open. An archived
agent leaves the map, as archived projects and quarters do: "Archive" lists it
under "Agents" and opens its chat to be read.

**v0.29.0: plan usage, leads on the map, copying from the chat.** The account
in the header opens "Usage", as Claude Code's account menu does: the 5-hour
session, the week and the per-model limits (Fable, for example), each with its
share and reset time, read by the Gateway from running turns (controller
v0.40.0, `claude-usage.v1.json`) and shown with the time of the reading. A
project lead, which lives in the HQ's hidden service quarter, has its attention
badge on the HQ building and its status frame under the HQ label; a quarter's
plaque says what its lead does. The attention list opens a lead's chat in place
and finds a project lead at its HQ. Chat text can be selected and copied:
Ctrl+C copies the selection (the map's blueprint copy only when the map has
focus), and the feed is not repainted under a selection. A question with
several options keeps its choices through a refresh, and its options toggle
("you can choose several"). Steering into a turn that works on after a result
reaches it at once. A project lead may change the whole project folder and a
quarter lead its quarter's zones (controller v0.41.0); their windows say so.

**v0.28.0: thinking, text size and permission modes, as in Claude Code.** In
the chat an agent's thinking is its own block - a dimmed italic "✻ thinking",
folded to its first line - and no longer looks like an action's window; while
a turn runs, a line under it says what the agent is doing now ("✻ Thinking…",
"⏵ Running" with the command, or "Waiting for your answer") and how long the
turn has run. "Aa" in the agent window's header sets its text size (70-150 %)
and the zoom of its content (50-150 %, also Ctrl+wheel over the window); the
panel keeps its width, and both are remembered (ui-state). At the input, next
to the model, each agent has its permission mode: "Manual", "Accept edits",
"Auto" or "Bypass permissions" (the provider's default is marked "default");
Shift+Tab steps through the first three, "Bypass permissions" is chosen from
the list and confirmed. The trusted host sets it (memory CLI
`set-permission-mode`, controller v0.39.0) and it applies from the agent's next
turn. Shell commands that only read are no longer sent to the person under a
write zone.

**v0.27.0: the project folder is visible and changeable until an agent works
in it.** The HQ and the project inspector show the folder the project is bound
to and whether it still exists, read by the trusted host (controller v0.38.1,
memory CLI `read-workspace`). "Bind a folder…" is offered only to a project
without one. The folder is held by agents, not quarters: once an agent of the
project has worked in it, it is for good (they are named); an open agent that
never worked is listed with "Archive…" (nothing is lost); without them the
project has "Change folder…" (both folders shown, confirmed;
`rebind-workspace`). A refused binding says why. The HQ on the map names the
project lead.
Archiving an agent sends the operation identity the contract requires
(`agentOperationInput`; one per agent, so a retry finishes the same close):
before, the real Gateway refused every archive from Atlas with `conflict`, and
the window showed the phase ("precondition") instead of the code. An agent
name is never reused, not even an archived agent's (its history stays under
it): the create form says a name is taken before sending, and a new lead gets
the first free name (`studio-lead-2` after `studio-lead` was archived).

**v0.26.0: resize by the corner, lead chats in place.** A selected quarter or
agent has handles on its four corners, the HQ of a selected project one on its
bottom-right corner (its top-left is the project's corner): dragging one
resizes only that element - the HQ and an agent in their own proportions
(40-150 %, `hqScale` of the project and `scale` of the agent in the layout) -
and one Ctrl+Z undoes the gesture. Inside a quarter are snap crosshairs every
30 units (points, not a backing): an agent is dragged under the cursor and,
dropped, snaps its centre onto the nearest crosshair where its icon keeps 6 off
its neighbours and 16 off the quarter's edge - a small agent takes the next
crosshair, a standard one every other.
Its name shows at every level in one size (cut to the map's row step), its
state sits in a frame under it sized to the text; the old stand and the corner
squares are gone. A quarter never gets smaller than its agents need (agents
the map placed stand in its rows of 60 for the new width, the ones the person
placed keep their place); an edge does not enter the HQ. Any click on the map
that is not the open agent closes its window, and the level buttons below
close it and go to their level; the level shown follows the camera while it
moves. A lead's chat opens where the camera is and stays open at any level.
Layout writes are queued, so quick undo and redo no longer fail with ENOENT. An
archive refusal names its reason (controller v0.37.2): a project or quarter
with open agents lists them, each with its own "Archive…".

**v0.25.0: the agent chat as in Claude Code and Codex.** Enter sends; a message
typed while the agent works is steered into its turn (the Steer box ticked) or
waits for the turn's end, where it can be taken back; the model and reasoning
effort are picked next to the input; the chat shows the person's text and what
the agent did (commands with output, files with `+added −removed`, the plan),
and the Trace tab everything else in full (the text with memory, tool inputs
and outputs, diffs, each turn's model, tokens and cost). The panel is resized
by its left edge or opened over the whole window. A finished turn nobody has
seen is attention ("answer waiting for you") until its chat is opened; live
view is on by default. The header shows the Claude account of the agents and a
connection dot. Projects and quarters have leads: "Enter project" / "Enter
quarter" (or a double click) open the lead's chat (or offer to create one)
where the camera is - only an ordinary agent's chat brings the camera to the
agent; the project lead lives in the HQ's hidden service quarter `hq`. On the
map whatever is under the cursor is dragged at every level, names sit on
plaques outside their frames, and the hover card appears once the mouse rests
for 150 ms. An agent's question is answered in a card under the chat (its
options a numbered list with their descriptions, or one's own answer), and once
answered it stays in the turn as Claude Code keeps it ("· question → answer",
controller v0.37.1). Archived projects and quarters come back to the map from
the "Archive" button.

**Status: v0.30.0, work in progress.** It connects, discovers capabilities,
projects the four levels, reads memory, agent context, conversation archive and
pending questions - and, since Kit v0.15.0, the agent's bound live
conversation, its project's files, its registered artifacts, its observed
events and the catalog's captured attention, checked against the kit's schemas
- and performs the confirmed actions, now including a hash-guarded save of a
project text file and an atomic copy of a project with its quarters and memory
(Kit v0.16.1): create a project, a feature or an agent, edit memory, bind a
project folder, send, answer a question, stop a turn and close an agent.
Sending is offered only to an agent the catalog reports as `active`; an
archived, closing or unread agent shows why not.

Every read, change and trusted action the host makes is journalled per run,
with the ids the kit returned, the descriptor it ran against and a bounded
result. The journal can be exported as an evidence package into a new folder
per run ("Evidence..." in the log, or `--evidence-dir <folder>`). It never
holds secrets or memory and conversation text. The journal is
`src/host/read-journal.mjs`; the export is `src/host/evidence-export.mjs`.

The window **is** a map: projects are regions, features sit inside them, agents
are points. Four levels - world, project, feature, agent workspace - with a
camera that eases between them, labels that fade with distance, attention that
rolls up into project and feature badges, a minimap, breadcrumbs, an off-map
tray for what cannot be placed, and undo for your own arrangement. There is no
tree and no permanent side panel.

That geometry, together with your notes and roles, is this machine's own: it is
stored per environment in `user-data/layouts/`, can be exported and imported as
JSON, and means nothing the backend reported.

Every confirmed action opens a confirmation window that belongs to the trusted
host process (`src/host/confirm-window.mjs`; it replaced the operating system's
dialog and keeps its guarantee), which keeps the decision out of the page:
renderer code cannot press that button. It is not a defence against automation
of the desktop itself. On 2026-10-02 the window was connected live to the
backend's Gateway running on Claude Code: delivery verified, every window
operation available, the backend's agents on the map. Sends were then made
through the same Gateway operation with the Kit client; a send clicked in the
window itself was still ahead at that point.

## Accepted delivery

The kit is not trusted because it sits in `vendor/`. `delivery/` holds the
backend's lock and verifier, copied byte for byte and pinned by SHA-256, and
`src/host/kit.mjs` - the only module that touches the kit - runs that verifier
over `vendor/frontend-kit/<version from the lock>/` before any kit file is
imported. That happens on every start: the window, the fixture, the probe and
the tests.

If the check fails, the window opens with a red delivery banner naming the
failed check, and there is no connection and no mutation. Nothing is repaired,
downloaded or swapped for another kit version: the fix is the accepted delivery
itself. See `delivery/README.md`.

A passing check says the kit files are the accepted ones. It says nothing about
the Gateway: discovery, the expected workspace and the capabilities are still
checked separately after it, and an unavailable Gateway still shows
*unavailable*.

## Versions

The application version is `projectVersion` in `project-version.json` (now
v0.30.0), mirrored without the leading `v` in `package.json` `version`. It is
this application's own number. The kit version, the release id and the contract
versions under `consumes` in `project-version.json` are what the application
accepted from the backend; they change only with a new accepted delivery, and
`npm test` fails if they disagree with the lock.

## What it is not

- It is not a controller. It never starts, stops or "recovers" the Gateway;
  when discovery is absent or expired it shows *unavailable* and waits for the
  controller operator.
- It does not read provider history, SQLite or any file of the backend directly.
- It invents nothing. `taskProgress` and `attention` are `null` in the contract,
  so no progress bars and no percentages are displayed anywhere.

## Run it

```powershell
npm install
npm run verify:kit
npm test
```

`npm test` verifies the vendored kit against the accepted delivery, proves on
disposable copies that a changed, missing, older or substituted kit blocks
start-up before import, runs the kit's own conformance suite against its fake
transport, and exercises the local development fixture. None of it touches a
controller.

Against a real controller, after `config/local.json` exists (copy
`config/local.example.json` and fill in the values for this machine):

```powershell
npm run probe
npm start
```

`npm run probe` is a read-only connection check that prints a bounded report -
no bearer, no endpoint, no memory bodies. `npm start` opens the window.

With no controller available, develop against the fixture:

```powershell
npm run dev
```

That window is permanently marked **FIXTURE DATA**. The fixture is synthetic, it
opens no listener, and it is not authority to send anything.

## Layout

- `src/host/` - the trusted host: discovery, the kit client, the operation
  allowlist and the IPC channel list. `src/host/kit.mjs` verifies and loads the
  kit; nothing else imports it.
- `delivery/` - the backend's accepted-delivery lock and verifier. Never edited
  here.
- `src/preload/bridge.cjs` - the only opening into the window.
- `src/renderer/` - the interface. No Node, no filesystem, no Gateway
  credentials. `scene-core.js` holds the pure map logic, `scene.js` draws it,
  `workspace.js` is the agent overlay, `app.js` drives data and panels.
- `user-data/` - this machine's layouts (one file per environment), your notes
  and roles, and which panels were open. Never committed.
- `src/dev/` - the development fixture, loaded only under `--dev-fixture`.
- `src/paperclip/`, `src/direct/` - the two prototype modes (see `AGENTS.md`).
- `vendor/frontend-kit/v0.21.0/` - the delivered contract, verified against the
  accepted delivery before import. Never edited here. `v0.20.0/` next to it is
  the retained previous delivery; `v0.16.1/`, `v0.15.0/` and `v0.14.0/` are
  history.
- `shots/` - pictures of the window on a live Gateway (`--capture`), with the
  facts each scene checked.

## Read order

1. `vendor/frontend-kit/v0.21.0/docs/desktop-integration.md` - the contract.
2. `AGENTS.md` - the rules this shell works under.
3. `delivery/README.md` and `src/host/kit.mjs` - how the accepted kit is
   verified before anything is imported.
4. `TESTING.md` - the manual test plan.
