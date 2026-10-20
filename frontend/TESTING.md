# How to test Agents Factory Atlas

Two modes. The **fixture** needs nothing but this repository and always works.
The **controller** mode needs a running Gateway; when this plan was written, no
change operation of this client had reached one yet, so the first one there is
a first for the client.

Common to both modes:

- A change opens a confirmation window that belongs to the host, out of the
  page's reach (creating, restoring and the chat actions are the exceptions;
  see `AGENTS.md`). Read it: it states the real consequence, not "are you
  sure?".
- The **Journal** (the button at the bottom) records what the window did: the
  call, the outcome, the operation id. At the end of the session use "Save…"
  and attach that file to your report.
- **Live: on** re-reads everything every 10 seconds. It is the only way to see
  how a turn is going: nothing reaches the client by itself.
- Map controls: wheel — zoom, dragging the background — pan, `1`–`4` and
  `Home` — levels, `F` — fit the selection, `Esc` — back, `Ctrl+Z` / `Ctrl+Y` —
  undo and redo of your layout changes.

## 1. Fixture — the whole interface without a controller

From the repository root:

```powershell
cd frontend
npm run dev
```

The window is marked **FIXTURE**. Nothing in it reaches a provider; all ids are
synthetic.

### The map and its levels

| Step | What to do | What should happen |
|---|---|---|
| 1 | Look at the whole map | A terrain backdrop, six territories with names and counters, quarters inside them, and in the centre of each an HQ labelled "goal · team · decisions". Units are visible here too, as small icons |
| 2 | Zoom in with the wheel to one project | Quarter labels appear, with stats for each, and the HQ label; attention badges move from the project to the quarters |
| 3 | Zoom in further | Agents grow into buildings with a status bar, the ones that need attention get corner brackets; closer still, their names appear under the unit |
| 4 | Fly with the wheel towards a neighbouring project | The active area switches to the project you are flying to: the header on the left and the map path change without a single click |
| 5 | Press `4`, `3`, `2` and `Home` | The levels switch, the camera eases there, the breadcrumb of the current level is highlighted |
| 6 | Click a project on the minimap | You enter that project. A click on an empty spot of the minimap moves the view without changing the zoom |
| 6b | Enter a project and look at the minimap | Project names are always visible, the current one brighter; its name is also in the minimap header. The minimap has no zoom buttons: zoom is the wheel, `+` and `−`, and the level track at the bottom |
| 6a | Hover over an object and select it | Hover and selection are shown with corner brackets. Whatever is under the cursor is selected, at any level: from the overview you can open an HQ, a quarter or a single agent |
| 6c | At quarter level, click the quarter itself, not an agent | The quarter is selected and the inspector shows it. A right click on any unit at any zoom opens the menu of that very unit |
| 6d | Drag objects at different levels | In the world a whole project moves, in a project a quarter, in a quarter an agent; a quarter outside its own level is taken only by its header |

### What the map shows

| Step | What to do | What should happen |
|---|---|---|
| 7 | Look at the "Attention" counter at the bottom | 13 signals. The panel is closed, but the problem is not hidden |
| 8 | Open the "Attention" panel | A list: questions, problem codes, "failure" and "uncertain" states. A click takes the camera to the agent |
| 8a | Hover over an attention badge on the map | The tooltip names what is behind it: by project at world level, by quarter at project level, by agent at quarter level. The reasons themselves are listed, not only their count |
| 8b | Zoom in and out while watching the badges | A badge moves from the project to the quarter, and from the quarter to the agent; the cursor catches the one that leads at that distance |
| 8c | Click an attention badge | The list opens **narrowed** to that project, quarter or agent; its header shows "showing: …" and the way out, "All projects". A right click on the badge gives the same plus the object's own menu |
| 8d | Click an attention badge on the minimap | The list opens for that project |
| 9 | Open "Off the map" | `orphan-agent-1` is there: the backend returned it but did not resolve its membership. It did not vanish silently |
| 10 | Select the agent `core-scheduler-2` | "Task progress — not reported", with an explanation of why the field is empty |
| 11 | Press "Project HQ" on any project | The project's goal, team and decisions. It is not an agent and has no provider operations |

### Changes that need confirmation

| Step | What to do | What should happen |
|---|---|---|
| 12 | Select a project → "Memory" → change the title → "Save with confirmation" | The confirmation window. Cancel — nothing is saved. Repeat and confirm — a new revision in the journal |
| 12a | Change the project memory and press "Close without saving" | The first press warns, the second closes and discards the edits. The same in quarter memory |
| 13 | Save again without re-reading the memory | A revision conflict: nothing is overwritten, re-reading is offered |
| 14 | Right click on an empty spot → "Create project…" | The project is created by a backend operation and only then appears on the map |
| 15 | Right click on a quarter → "Create agent…" | Profile `claude` / `claude-sonnet-5-5` / `default`; the agent appears with delivery `pending` |
| 16 | Select `data-ingest-2` → "Workspace" → type a text → "Send" | Outcome `accepted` and an operation id; "Operation receipt" shows the state |
| 17 | Select `core-scheduler-2` and send | The outcome is **uncertain**. No retry is offered — only the receipt. This is the main case |
| 18 | Start typing a text and, without sending it, close the workspace | The draft is kept and marked as local; it is never sent by itself |
| 19 | `data-ingest-1` → "Read questions" → answer `accept` | Receipt `response-returned`; a second answer is refused — a decision cannot be brought back |
| 20 | `billing-invoice-1` → "Read questions" | A question of another kind: `submit-text` and `cancel` are allowed, and exactly those are offered |
| 21 | "Stop turn" on an agent with a current operation | `accepted` — that is, accepted, not finished |
| 22 | "Close agent" on an agent with a running turn | Refused: only finished work is closed |
| 23 | Open the workspace of `data-ingest-1`, the "Conversation" tab | The live conversation by the agent's binding: above the feed "live" is highlighted, "updated by events", the mark "incomplete" (hidden reasoning left out). Three turns: the person's messages on the right, the agent's on the left, an action and a change as folded blocks, a "hidden reasoning" gap, the agent's question with a "To questions" button |
| 23-0 | Press "archive" above the feed | The captured archive: the mark "history before recording started was not imported", "Turn 1" and "Turn 2", the command `npm test` as a folded block, gaps with their reasons. "live" brings the live feed back |
| 23-00 | Open the workspace of the archived `data-enrich-1`, then of `core-watch-1` | The archived one shows "live reading unavailable: the agent is archived — showing the captured archive". `core-watch-1` shows "the provider is unavailable now", and the feed shows the archive, not an empty chat |
| 23-1 | Start typing in the input and wait 10–15 seconds with live view on | The feed is updated, the input is not: focus and cursor stay where they were |
| 23-2 | Look at the line above the feed | How the conversation is read ("through agent memory, reading the live conversation by binding"), the time of the last read; on hover — who chooses the thread |
| 23-3a | In an open file, type a text into "Find in file" | "Found: N (in the loaded 64 KB of 130 KB); lines …". "Edit" is disabled: "Load the whole file first" |
| 23-3c | `README.md` → "Edit", change the text | "● not saved". Moving to another folder does not happen: "There is an unsaved edit" |
| 23-3d | "Save with confirmation" → confirm | "Saved: N bytes", operation `atlas-save-…`, "Re-read: the file matches the receipt" |
| 23-3e | "Files" on an agent of the project `platform-core` and of `research-lab` | "project folder binding conflict" and "the bound folder is no longer on disk"; the other unbound ones show "not bound" |
| 29d | Project → `Ctrl+C` → `Ctrl+V`: the field "ID of the new project copy" | `…-copy` is suggested. Enter a taken ID, `bad id!`, the source's ID — the reason appears under the field, "Create" is disabled, nothing is created. Enter a free ID — "Free…", and the summary "Source → new copy → mode" |
| 29c | Project → `Ctrl+C` → `Ctrl+V` → "Structure and memory" → "Create with confirmation" | One confirmation. "Result: complete" and the lines "project/quarter …: … revision N → … revision 1". A new project with the same quarters, without agents |
| 23-3b | "Next 64 KB", if the file has changed in the meantime | Refused: "the file changed after the first page…" — pages of different versions are not stitched together |
| 23-3 | `data-ingest-1` → "Files" → `logs/` → `drain-trace.log` | A folder opens only on a click. The file is shown by its first 64 KB: "showing 64 KB of 130 KB", the file's fingerprint; "Next 64 KB" reads on. `data/export.bin` — "file larger than 1 MB — the backend does not serve it" |
| 23-4 | `data-ingest-1` → "Artifacts" → "Open" on both | The report `reports/drain-analysis.md` is shown marked "matches the registered hash". `src/queue/drain.mjs` — "the file changed after registration… content not shown". At the bottom: these are references, not the whole result of the work |
| 23-5 | `core-storage-2` → "Tasks" | "Catalog attention": "no data" and "the catalog does not report" everywhere — not zeros. "Memory" starts with the requested profile and a caveat that it is not an observation of the provider |
| 23a | The "Tasks" tab of an agent | The running and the last operation, the state, the empty progress with an explanation, catalog attention, pending questions and assignments from the captured conversation. Nothing invented |
| 23b | "Skills" in the workspace header | A panel to the left of the workspace: the list is yours, items are added and removed, it is marked as local. The library will come from the next backend |
| 23c | Open the workspace, zoom out with the wheel to the "world" level and close the panel | The zoom stays the one you set: closing does not pull you back to the quarter. If you did not touch the camera, it takes you back to the quarter |
| 23d | Open the workspace and move the cursor from the map into the agent panel | The tooltip at the cursor disappears as the cursor leaves the map |
| 23e | Quarter level: look under the agent names | Under each, one line: "archived", "failure", "uncertain", "? N questions", "turn running" or "turn finished". The selected agent whose conversation has already been read shows its last message in quotes |
| 23f | The "Readiness" button at the top right | The connection, the 21 Atlas operations with clear names and reasons, the trusted actions and "Expected from the backend": writing to the thread directly, provider questions, several sources. At the bottom — which path the conversation takes now and why |
| 23g | Turn live view on, open "Readiness" or the attention list and select an object on the map, wait 20 seconds | The panel does not close by itself when the data refreshes |

### Your own layout

| Step | What to do | What should happen |
|---|---|---|
| 24 | Drag a quarter past the project's border | The project grows to hold it |
| 25 | Drag the quarter back towards the centre | The project does **not** shrink by itself. The dashed outline at the node disappears: now you placed it, not the app |
| 26 | Press "Fit the project" | The borders shrink to the content — on your command, not by themselves |
| 27 | Press `Ctrl+Z` | The whole action is undone, including the growth of the borders. Redo is `Ctrl+Y` |
| 28 | Give a project a symbol and a colour, an agent a role and a note | They appear at once; all of it is marked as your local data, not the backend's |
| 29 | Close the window and open it again | Everything is in place: the layout, the notes, the camera view and the open panels |
| 29a | Select a quarter, `Ctrl+C`, then `Ctrl+V` | The paste sheet: from where and to where, "Agents in the blueprint: N. They are not copied". No mode is chosen, the button is disabled, the steps say "Choose what to copy". Once a mode is chosen — a new quarter `…-copy` (and its memory carried over in the "Structure and memory" mode). Nothing is created until you press "Create with confirmation" — and each step is confirmed separately |
| 29a-1 | Select an agent, `Ctrl+C`, `Ctrl+V` | "Agents are not copied…" — there is nothing to paste |
| 29b | Press "Create with confirmation" and decline the confirmation | Nothing is created, the other steps did not run, under the sheet are receipts by step, and the reason is written to the journal |
| 30 | "Export…", then "Import…" of that file | The same arrangement comes back; the import is undone with one `Ctrl+Z`. A foreign file is refused with a reason, not half loaded |

## 2. Controller

### The Gateway first

The frontend does not start or repair the Gateway. The operator does that, from
the controller root (`<controller-root>`, an instance copied from
`controller/`):

```powershell
tools\stop_application_gateway.bat -AsJson
tools\close_application_gateway_monitor.bat -AsJson
tools\start_application_gateway.bat
tools\application_gateway_status.bat -AsJson
```

`start_application_gateway.bat` starts the Gateway with the Claude Code
provider.

Keep the monitor open. A session lives for **one hour** and is not extended:
plan the check so that it fits, otherwise the window will honestly show
"unavailable".

Check the connection without opening the window (from `frontend/`, with
`config/local.json` filled in):

```powershell
npm run probe
```

`"available": true` means you can work. Otherwise the exact reason is printed:
`lifecycle_uncertain` (the Gateway went down), `status_missing` (it was not
started), `workspace_mismatch` (the wrong workspace).

### Then the window

```powershell
npm start
```

Reading only, at first: the map, the HQs, memory, conversations, questions.
None of it touches the provider's state.

The first live operations go in this order, because the contract requires it:

1. **Bind a disposable folder** to a project — an empty one created for the
   check, not a real repository. Once an agent has worked in it, the binding is
   permanent.
2. **Create a project and a quarter**, if the ones you need are not there. Both
   memories are created empty.
3. **Create an agent** with a profile from the catalog. An unknown profile is
   refused.
4. **Send.** This is a real Claude Code turn and it spends your plan's quota. If the quota reserve is running out, the
   send is refused — that is the correct behaviour, not a client error.
5. Turn **live view** on and watch the last operation and its receipt. While
   the turn is running, do not send a second time.
6. Answer the question, if one appears. The options offered are the ones the
   entry itself allows.
7. **Stop**, then **close** once the work is finished, and read the archive.

### If something went wrong

- **An uncertain outcome.** Do not retry. Read the receipt of that operation —
  its id is in the journal.
- **The Gateway went down during the check** (`lifecycle_uncertain`). The window
  says "unavailable". The operator restarts it; the client re-reads everything
  and replays nothing. Text you typed stays a draft and is not sent by itself.
- **A button is disabled.** Its tooltip has the reason code from discovery: the
  Gateway does not declare that operation.
- **The layout was not saved.** A warning appears at the bottom. The previous
  version lies next to it as a backup and is picked up at the next start.

## 3. What is proven and what is not

Checked automatically (`npm test`): accepted kit delivery 73/73, delivery suite
21/21, kit conformance 10/10, trusted actions 9/9, mutations 13/13, layout
10/10, scene logic 24/24, fixture shape 9/9, world assembly 9/9, conversation
feed 20/20, evidence 17/17, contract 3/3, outcomes 18/18, agent workspace 49/49,
UI suite status 6/6.

A visible status surface for the UI suite: the launcher writes a status file
itself (`--status-file <file> --run-id <id>`), and `node tools/ui-status-server.mjs
--status-file <file> --port <port>` shows it as a page on 127.0.0.1: the run,
the command, the commit and version, the phase, the current scene and attempt,
when it was updated and how many seconds ago (in red if a running run has been
silent for more than 5 s), the elapsed time, the scene totals and the exit
code. Every poll of the page reports its visibility and focus (`/surface`): the
surface is shown to be ready by fresh polls with the status `visible`, not by
assuming the window is on screen.

The Electron window on the fixture (`npm run test:ui`, separate from `npm test`
because it opens windows on the screen): the regression set of scenes 18/18 —
Fit and pushing apart at level 4, "Whole world", entering a quarter from the
menu, the id format, closing the workspace when zooming out, switching agents,
the memory sheet and the inspector, sending to an archived agent, the live
conversation by binding, the archive and unavailable live reading, project
files, artifacts with a hash check, attention and the requested profile, the
explicit paste mode, search in an open file, the window without a controller
configuration, a file edit with a conflict and a save by receipt, a project copy
with its memory in one operation. Scenes A17–A18 confirm changes by themselves —
only on the fixture, in capture mode. The scenes wait until the world has been
read and check facts, not the picture; the set runs on a copy of the app with
its own layout and is skipped if an Atlas window is already open.

A passing kit check means one thing only: the kit files are the ones the backend
accepted. It is not an end-to-end acceptance of the app and says nothing about
whether the Gateway is ready.

If the window opened with the red banner "The kit delivery failed
verification", there will be no connection and no changes, and that is correct.
Do not fix anything in `vendor/` or `delivery/`: report the code from the banner
to the maintainers of the backend's delivery.

Not proven by any of this: the behaviour of a live provider. When this plan was
written, no send, no answer and no stop from this client had reached a real
provider. Until the controlled scenario from
`vendor/frontend-kit/v0.16.1/docs/desktop-integration.md` has been passed, any
live result is an observation that needs checking, not acceptance.
