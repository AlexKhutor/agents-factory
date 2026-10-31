# 2D Backend Consumer: Initial Contract

## Kit v0.21.0 messages while an agent works, its model, and its trace

Four operations, served by a provider that can steer a running turn and keeps
a trace (Claude Code); the Codex provider does not register them.

- `mutation.memory.agent.steer` `{agentId, operationId, text, mode}`: a
  message while the agent works. `mode: "steer"` hands it to the running turn
  at once (Claude Code reads it when its current tool calls finish);
  `mode: "queue"` holds it for the turn's end, then it goes as the next
  message. When the agent is not working - or its turn ended meanwhile - it is
  an ordinary send under the same operation ID. The output says `delivery`:
  `steered`, `queued` or `started`.
- `mutation.memory.agent.unqueue` `{agentId, operationId}`: takes back a
  queued message; `cancelled: false` when it already went.
- `mutation.memory.agent.profile` `{agentId, profile}`: the model and
  reasoning effort of the agent's next turns, as the model picker of Claude
  Code and Codex. The conversation stays the same session; the new model's
  prompt cache starts cold. The provider cannot change.
- `query.memory.agent.trace` `{agentId, before?, after?, maxBytes?}`:
  everything the agent's turns did, in full - the text the agent was sent (with
  its memory and role), messages steered in or queued, answers, reasoning
  summaries, each tool call with its input and output, diffs of file changes,
  and each turn's model, duration, tokens and cost. Records are oldest first;
  cursors (`"<generation>:<offset>"`) page to older (`before`) or newer
  (`after`) records. Secrets a tool printed are masked. `queued` lists the
  messages still waiting for the turn's end.

Reads gain optional fields: `lastOperation.observedModel` (the model that
actually answered) and, in the conversation, readable tool items - the
command and its output, the changed file with `+added −removed` lines, the
read or searched path - where Kit v0.20.0 showed "Command completed" or "File
change completed". The person's message is shown as typed, without the memory
in front of it; the plan is a checklist headed `План`, reasoning summaries are
headed `Размышление`. Kit v0.20.0 consumers keep working.

## Kit v0.20.0 send receipts through the Gateway

A send receipt names its memory delivery `memorySnapshot` (`full` or
`unchanged`). Kit v0.17.0-v0.19.0 called it `memory`; the Gateway's privacy
check treats a field of that name as a memory body, so every send through the
Gateway was answered `access_denied` although its message ran. Treat such a
send as uncertain, never resend it on your own. Kit v0.19.0 consumers are not
supported.

## Kit v0.19.0 coordinator and controller tasks for desk agents

`settings.role` gains `coordinator`: the controller's main orchestrator as a
desk agent (at most one; its fixed zone is `coordination/drafts/**`). It
dispatches controller tasks to other desk agents and starts them; an agent
works a task with its own task tools (accept, progress, plan confirmation,
report), and the coordinator gets one message when the report arrives. The
person confirms an agent's plan in that agent's chat, as before. A desk agent
takes controller tasks only after the trusted host registered it
(`register-desk-source`, below). An agent that holds a started task is never
`idle`: between messages it is `waiting-for-person` (its plan waits for
confirmation, say), so it is not counted as free. An agent that does not take
a task returns it to the coordinator with its reason. Kit v0.18.0 consumers
reject the new role.

## Kit v0.18.0 agent activity and idle agents

Agent reads carry `activity: {state, sinceUtc}`: `working` (a message runs),
`waiting-for-person` (a running message waits for the person's answer),
`idle` (no message runs: the agent waits for a task), `uncertain`,
`closed` or `unknown`. Count `idle` agents for a "free agents" counter. A
send receipt carries `settledAtUtc` once the backend saw it end; with Claude
Code the Gateway settles a finished message at once. The controller's
attention model raises `agent_idle` (low urgency, below 500, growing with the
idle minutes) for an agent idle longer than its threshold (10 minutes); it is
not a decision the person owes. Kit v0.17.0 consumers reject `activity`.

## Kit v0.17.0 agent memory, roles, zones and memory documents

Memory scopes gain the kind `agent`: an agent's own memory beside its quarter
(`quarterId` set). It is created empty with each agent and named by the
agent's `agentScopeId`; scope lists do not include it. Read it with
`query.memory.agent.context` (new field `agent`, null for agents created
before) and write it like any scope with the trusted `save-user-edit`. A
manifest names it as `agent` when it exists.

Agent reads carry `settings`: `role` (`feature`, `project-lead`,
`quarter-lead`), `writeZone` (paths of the project folder a feature may
change, or null for all of it; leads have the fixed zone `docs/memory/**`),
`revision`. A provider that holds zones (Claude Code) lets agents of one
folder run at once when their zones cannot meet. A send receipt says whether
it carried the memory (`memorySnapshot: "full"` since Kit v0.20.0) or noted it unchanged.

Kit v0.16.1 consumers reject these fields and are not supported by this
backend. New trusted host actions are listed under Trusted Host Actions.

## Kit v0.16.1 safe file refusal detail

`query.project-workspace.list/read` keeps `error.code=source_unavailable`.
Its optional `error.reasonCode` is limited to `workspace_not_bound`,
`workspace_binding_conflict`, or `workspace_path_missing`; an absent reason
means the cause is not publicly determined. Do not infer a missing folder or
permission from generic unavailability. Neither paths nor exception text are
sent. The native host already reads bounded Gateway and monitor status for
connection presentation; Kit v0.16.1 adds no monitor lifecycle authority.

## Kit v0.16.0 additions

`mutation.project-workspace.save` accepts a bounded UTF-8 replacement only with
the exact hash returned by a prior file read. Keep the editor dirty after a
stale/uncertain refusal and never replay a lost write with a new operation ID.
`mutation.memory.project.copy` atomically copies the current project and quarter
memory into new scope identities. Target revisions start at 1. The copy does
not include agents, bindings or provider history; receipt loss is reconciled
only with the same request and operation ID. Both mutations require an
advertised capability and explicit user action; their presence in the Kit does
not itself grant Gateway authority.

## Kit v0.15.0 baseline

Use the agent-conversation, project-workspace, agent-artifacts and agent-events
portable schemas and generated declarations with the generic capability-first
client. Project paths are <=256 characters; artifacts remain read-only.
Artifacts are explicit hash-bound references, not a complete output inventory.
The testing/agent-workspace export supplies fixture DTOs only.

The desktop projection now preserves requested profile and captured attention.
Attention unavailable/null is not zero; sourceSequence/revision and observedAtUtc
belong to this observation, not provider-global history. The recent interactions
page has explicit truncated/omissionCount. Events are observed-only invalidations:
snapshot first, then resume; a gap/restart requires resync, never mutation replay.

Copy mode is explicit: structure-only or structure-and-memory. The structure-only
client path remains a separate workflow. For structure-and-memory, use the
v0.16.0 atomic operation instead of chained scope creates. Automatic delete or
changed-payload retry is not authorized.

This package supplies backend contracts, not a desktop application. The first
prototype targets one machine and Codex. Native process state, user approvals
and workspace access remain backend authorities. VR is outside this delivery.

## Four Levels

World -> Project -> Feature (quarter) -> Agent. World is an aggregate only.
There are exactly two memories: project rules and quarter/feature context.
Creating an agent assigns both, even when empty. An agent cannot be moved or
restored after archival. A new agent receives a new conversation, not history
inherited from another agent.

Use query.memory.scopes.list and query.memory.agents.list for navigation.
The ./desktop export projects their public metadata with projectDesktopMemory.
It also supplies createDesktopMemoryFixture for renderer development. These
are independent catalogs, not one atomic Work Projection snapshot. Missing
parents and truncated lists remain explicit. Never infer task completion from
an agent's presence or manufacture progress percentages. Task/attention data
must come from an exact supported Work Projection join; absent joins stay null.
Do not merge V1 and V2 fragments to fill blanks. Memory bodies are requested
only for the opened editor/context via scope.read or agent.context.

## Connection

The trusted native host supplies the normal descriptor resolver and expected
workspace identity to ApplicationFrontendClient. Do not hardcode a port or
bearer, expose bearer in logs, or read provider history/SQLite directly.
Use connect, discoverCapabilities and operationStatus before offering actions.
HTTP/native host integration is required; a standalone file:// page is not an
authorized origin. The backend is loopback-only, not a remote-PC service.
Gateway restart requires discovery again, never automatic message replay.

The generic client methods return Application result envelopes. Handle their
outcome and error before reading output; do not treat HTTP success as task
completion. Memory request shapes are in application-project-memory.v1.json.

## Supported Memory Path

1. Create an empty project scope, then its quarter scope, via scope.create.
2. Read memory with scope.read. Save with scope.write only after a trusted
   user-command grant exists for the exact scope, revision and new contents.
   Actor labels and model-generated instructions are not permission.
3. Create with agent.create using exact project/quarter IDs and a catalog-
   advertised provider/model/effort profile, with fallback denied.
4. Send with agent.send and a stable operationId. Recover acknowledgement with
   receipt.memory.agent.send. An uncertain response forbids resubmission.
5. Read agent.archive independently of provider availability. Coverage is
   captured-only, not proof of a complete provider-private transcript.
6. Close only terminal work with agent.close. Archive remains readable.

Memory updates affect the next send, not an already-running turn. Display
required versus delivered revisions and empty memory without blocking work.
No external agent may change memory without a user's explicit command.

## Trusted Host Actions

Source v0.126.0 adds two bounded local actions, not HTTP self-grants. The
frontend's native host calls the installed Gateway CLI after a real user
choice. It fixes the controller root and executable; the renderer must not
receive a general filesystem or shell execution API. Pass arguments as an
array, never interpolate user text into a shell command. Store input in a
private, untracked controller directory, not the agent's project folder.

Bind an existing folder once, before creating the first agent:

```text
node .orchestrator/runtime/application-gateway-cli.mjs memory --repo-root ROOT --action bind-workspace --input-file LOCAL.json --confirm-project PROJECT_ID --json
```

Input is exactly `{projectId,workspacePath}`. The path is absolute and must
already be a directory. Binding is immutable; changing it conflicts. The
response contains a workspace fingerprint, not its path. Quarters share that
project folder. Logical IDs alone do not authorize access.

Save an explicit user-confirmed memory edit:

```text
node .orchestrator/runtime/application-gateway-cli.mjs memory --repo-root ROOT --action save-user-edit --input-file LOCAL.json --confirm-user-command COMMAND_ID --json
```

Input is exactly `{scopeId,expectedRevision,entries,operationId,commandId,actorId}`.
Read the schema for entry bounds. Preserve all identifiers for reconciliation;
the same edit returns its original receipt, changed input conflicts. On a stale
revision reread and let the user reconcile. Do not silently overwrite or issue
a fresh operation ID to disguise a conflict. This combined action reuses the
same durable grant/write path as the public scope.write operation.

Set an agent's role and write zone after the person chose them:

```text
node .orchestrator/runtime/application-gateway-cli.mjs memory --repo-root ROOT --action set-agent-settings --input-file LOCAL.json --confirm-user-command COMMAND_ID --json
```

Input is exactly `{commandId,agentId,expectedRevision,role,writeZone}`;
`expectedRevision` is the current `settings.revision`. A lead's `writeZone` is
null. One project lead per project and one quarter lead per quarter
(`conflict` otherwise).

Memory documents: an agent writes notes into a file of its project folder;
the person approves the exact file; the memory takes it as approved. Show the
preview first:

```text
node .orchestrator/runtime/application-gateway-cli.mjs memory --repo-root ROOT --action preview-memory-document --input-file LOCAL.json --json
```

Input `{agentId,path,target}`: the path from the project folder root and the
target `agent`, `project` (project lead only) or `quarter` (quarter lead
only). The answer lists the entries (each `## heading` is one), the
document's SHA-256 and the target's revision. After the person confirmed:

```text
node .orchestrator/runtime/application-gateway-cli.mjs memory --repo-root ROOT --action approve-memory-document --input-file LOCAL.json --confirm-user-command COMMAND_ID --json
```

Input `{commandId,agentId,path,target,expectedSha256,apply}` with the SHA-256
from the preview. `apply: true` writes at once (author `project-owner`);
otherwise the agent writes it with its tool `write_memory_from_document`. A
changed document or memory refuses the write; the person approves again.

Let the controller give tasks to an agent (the person chose it):

```text
node .orchestrator/runtime/application-gateway-cli.mjs memory --repo-root ROOT --action register-desk-source --input-file LOCAL.json --confirm-agent AGENT_ID --json
```

Input is exactly `{agentId}`, and `--confirm-agent` repeats it. The agent
becomes controller source `desk-<agentId>` with its own coordination folder
inside the controller; its project files are not touched. Repeating it is
harmless; an archived agent is refused.

## Per-Agent Control

Check advertised support for each operation independently. Use the generic
client methods; response shapes are in application-agent-control.schema.json
and application-provider-interaction.schema.json:

```js
await client.read('query.agent-control.interactions', {agentId, limit: 16});
await client.approve('approval.agent-control.respond', {agentId, response});
await client.mutate('mutation.agent-control.interrupt', {agentId, operationId});
await client.receipt('receipt.memory.agent.send', {agentId, operationId});
```

Interaction `response` contains interactionId, requestSha256, responseId,
operator, selectedResponse, providerResponse and respondedAtUtc. Copy the exact
record identity and allowed operator/choice from the read result. Collect a
real user decision; do not auto-approve. Stale/expired requests cannot be revived.
Pending interactions become stale after runtime loss; never replay a response
into a replacement session. Owner-chat operations are a different route.

For interrupt, operationId is the original SEND operation ID, not a new stop
ID. Accepted means the stop request was acknowledged, not that the turn ended.
The send receipt must observe completed/failed/interrupted before another
agent can occupy that folder. An uncertain or requested stop is not retried;
the same interrupt input only returns its saved record. Refresh the send
receipt, not the send mutation. Catalog lastOperation is saved state, not a
fresh provider observation; currentOperationId identifies receipts to refresh.

## Prototype Limits And Acceptance

Writer exclusion covers memory agents in this controller catalog, including
aliases of the same canonical folder. It does not lock manually run VS Code,
other controllers or external tools: do not run those writers concurrently.
Busy work is rejected, never queued. Old unbound agents are not silently moved
into project folders. Their histories remain readable; use explicitly created
new agents for this route. Empty memory remains valid.

Navigation uses independent catalogs; taskProgress and attention stay null
without an exact supported operational join. createDesktopMemoryFixture()
supplies an empty project/quarter baseline; {withAgent:true} adds schema-valid
metadata for the fourth level. Hashes/identities are synthetic fixture values,
never authority to send. This is not a simulation of native approvals. The
existing ./testing fake backend exercises client envelopes/lifecycle only.

Frontend development may start against this package. Installed support still
depends on a fresh descriptor. Before freezing the usable prototype, install
the matching runtime and run one supervised scenario: bind a disposable
folder, create project/quarter and two agents, save memory, send, handle an
actual question/approval, interrupt and observe terminal, restart, verify
archive and close. Source/offline success is not live acceptance. No automatic
deployment, live send, Claude/Qwen or VR support is part of this package.
