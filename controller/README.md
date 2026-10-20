# Agents Factory Controller

This is the controller that Agents Factory Atlas connects to. It runs the
Application Gateway, which handles desk agents on Claude Code, project
memory and the attention model. It also runs the controller's task workflow:
it dispatches a task to a desk agent, collects the agent's report, and has a
model review or summarize it.

This folder is a template. Copy it to a folder of your own, outside the
repository. That copy is your instance, and it holds your data: the memory
database, task packets, reports and agent sessions.

## Requirements

- Windows with Windows PowerShell 5.1
- Node.js 20 or newer
- Python 3 with its `sqlite3` module
- An Anthropic API key. The agents run through the Claude Agent SDK, which
  Atlas installs under `frontend/node_modules/@anthropic-ai/claude-agent-sdk`;
  `"keepProviderVariables": true` in `claude-provider.json` lets them use
  `ANTHROPIC_API_KEY` from the Gateway's environment.

## Set up an instance

```powershell
Copy-Item -Recurse <repo>\controller <instance>
cd <instance>
New-Item -ItemType Directory -Force .project-local\application-gateway, .project-local\orchestration
Copy-Item config\claude-provider.example.json .project-local\application-gateway\claude-provider.json
Copy-Item config\control-cycle.example.json .project-local\orchestration\control-cycle.json
```

Then edit the two copies:

- `claude-provider.json`
  - `sdkPath`: the absolute path of the Claude Agent SDK, with forward slashes.
  - `keepProviderVariables`: keep `true`, so the agents use the
    `ANTHROPIC_API_KEY` of the Gateway's environment.
  - `models`: the models and effort levels Atlas offers when you create an
    agent.
- `control-cycle.json`
  - `controllerRoot`: keep `"."` if every command runs from the instance
    folder (the Gateway does). Otherwise, set the absolute path.
  - `provider` and `reportOperations.summary`: the model that reviews and
    summarizes reports.

Check the setup offline. These commands start no model turn:

```powershell
node .orchestrator\runtime\control-cli.mjs status --config .project-local\orchestration\control-cycle.json --json
node .orchestrator\runtime\control-cli.mjs report-models --config .project-local\orchestration\control-cycle.json
```

## Run the Gateway

```powershell
$env:ANTHROPIC_API_KEY = Read-Host "Anthropic API key"   # this session only
powershell -NoProfile -ExecutionPolicy Bypass -File tools\application_gateway.ps1 -Command Start -RepoRoot <instance> -Provider claude -AsJson > logs\gateway-start.json
```

You can also run `tools\start_application_gateway.bat` from a console where
`ANTHROPIC_API_KEY` is set. The Gateway does not store the key; it only
passes it on to the agents' Claude processes.

- Redirect Start's output to a file. If you pipe it into another program, the
  command waits for its child processes.
- A small monitor window opens. Agent turns run only while it shows the
  Gateway as ready.
- Status: `-Command Status -AsJson`. Stop: `-Command Stop`. The `.bat` files
  in `tools\` wrap the same commands.

The Gateway writes `.project-local\application-gateway\status.v1.json`. Atlas
uses `identity.workspace` from that file (`projectId` and
`workspaceRootSha256`) as its expected workspace.

`connection.v1.json` in the same folder holds the Gateway's bearer token.
Never share or commit it.

## Desk agents and tasks

1. Create projects, quarters and agents in Atlas.
2. Register each agent that should take controller tasks. Write
   `{"agentId": "<agent id>"}` to a file inside the instance, then run:

   ```powershell
   node .orchestrator\runtime\application-gateway-cli.mjs memory --repo-root <instance> --action register-desk-source --input-file .project-local\register.json --confirm-agent <agent id> --json
   ```

   Registration does three things:

   - It adds source `desk-<agent id>` to `config\source-registry.json`.
   - It binds that source in `.project-local\source-bindings.json`.
   - It installs the task kit (`coordination\child-agent-kit`) into the
     agent's own folder under `.project-local\desk-agents\`. The agent's
     project folder is not touched.
3. Set up a coordinator. In Atlas, create a project bound to the instance
   folder itself and add an agent to it. Atlas does not offer the
   `coordinator` role, so set it with the CLI. Write this input file:

   ```json
   {"agentId": "<agent id>", "expectedRevision": 0, "role": "coordinator", "writeZone": null, "commandId": "<any new id>"}
   ```

   Then run:

   ```powershell
   node .orchestrator\runtime\application-gateway-cli.mjs memory --repo-root <instance> --action set-agent-settings --input-file <file> --confirm-user-command <the same id> --json
   ```

   Once you confirm a task with the coordinator, it dispatches the task
   (`tools\dispatch_child_task.ps1`), starts it, follows its progress and
   reads the report.
4. When a report arrives, the control cycle collects it
   (`tools\collect_child_reports_v2.ps1`). Collection copies the report into
   `knowledge\reports\inbox\` and rebuilds `knowledge\catalog.json`.

## Layout

| Path | What it is |
| --- | --- |
| `.orchestrator/runtime/` | The Gateway bundle, the control-cycle CLI and its modules, and the SQLite bridges |
| `tools/` | Gateway start, status and stop; task dispatch; report collection; kit installer |
| `config/` | `source-registry.json` (registered agents) and example configs |
| `coordination/child-agent-kit/` | The task kit installed for each registered agent |
| `coordination/tasks/dispatched/` | Immutable task packets |
| `coordination/reviews/`, `coordination/acceptances/` | Review decisions and report acceptances |
| `coordination/drafts/` | The coordinator's working drafts (not committed) |
| `knowledge/` | Imported reports and their catalog |
| `.project-local/` | Machine-local state and secrets (never committed) |
| `logs/` | Tool logs and reports (never committed) |

Agent rules for this folder are in [AGENTS.md](AGENTS.md).
