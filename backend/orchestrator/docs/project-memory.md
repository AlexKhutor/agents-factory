# Project And Quarter Memory

Source v0.133.0 (Claude Code port, stage 2): agent memory, roles, write zones
and memory documents.

- **Agent memory.** Store schema 2 adds the scope kind `agent`: each new agent
  gets its own memory (`agentScopeId`, `agent-memory:<hash of the agent ID>`)
  beside its quarter. It is written like any scope (trusted grant, then write),
  not listed with the project, not copied with it, and pinned for archived
  agents like the others. Manifests name it as `agent`; agents created earlier
  keep the two-scope manifest. Delivery order of authority: project, quarter,
  then the agent's own memory. Opening a schema-1 database rebuilds the scope
  table once; older runtimes then refuse it (`memory_unsupported_schema`).
- **Settings.** `settings: {role, writeZone, revision, updatedAtUtc}` on every
  agent: `feature` (optional write zone), `project-lead` or `quarter-lead`
  (one each per project or quarter). An agent may change what is attached to
  it: a feature agent its zone (none: the whole folder), a project lead the
  whole project folder, a quarter lead the zones of its quarter's feature
  agents plus `docs/memory/**` (the whole folder when one of them has no
  zone; `effectiveWriteZone`). Changed only
  by the trusted CLI action `set-agent-settings` with `--confirm-user-command`.
  A provider that holds zones lets agents of one folder whose zones cannot meet
  run at once; otherwise one writer per folder remains the rule.
- **Memory documents.** The trusted CLI previews (`preview-memory-document`)
  and approves (`approve-memory-document`, `--confirm-user-command`) one exact
  document of the project folder for one memory: the agent's own; the
  project's for the project lead; the quarter's for the quarter lead. Each
  `## heading` is one entry. The approval is the store's own grant for exactly
  those entries at the memory's current revision; the write happens once, only
  while the file and the memory are unchanged, by the agent's tool or at once
  with `apply` (author `project-owner`). Approvals are recorded per agent; a
  newer approval of the same file supersedes an unused one.
- **Activity** (source v0.134.0). Agent reads carry `activity: {state, sinceUtc}`:
  `working`, `waiting-for-person` (a running message waits for an answer),
  `idle` (no message runs), `uncertain`, `closed` or `unknown`. A receipt
  that becomes terminal records `settledAtUtc`; idle time counts from it. The
  Claude runtime settles a finished turn at once. The attention model turns a
  long idle time into `agent_idle` (`attention-model.md`).
- **Delivery.** A lead's snapshot adds an overview by titles (the project's
  quarters, or the quarter's agents with roles and zones). A provider with
  `memoryDeliveryKey` (Claude Code) gets the snapshot only when it may be
  missing; see `claude-code-provider.md`.

Source S1 candidate, 2026-09-24: `mutation.memory.project.copy` is a separate
atomic backend operation for project scope, quarter scopes and their **current**
memory entries. The request supplies new scope identities for every quarter;
missing/extra mapping fails before commit. The durable operationId replays the
same complete receipt or rejects a changed payload. Target revisions begin at
1; prior memory revisions, agents, bindings, sessions and provider history are
not copied. Structure-only UI copy remains a separate consumer choice. This
candidate is not an installed controller capability; see
[S1 backend package](codex-r2-s1-backend-package-20260924.md).

Source v0.130.0 adds captured-inventory attention to agent read/catalog. Unknown
observation remains unavailable/null. Kit projects the requested profile, not
an invented observed profile. Copy uses explicit structure-only or memory-copy
host orchestration with per-step receipts; it never clones sessions/bindings.
See [consolidated package](codex-release-backend-package.md).

Source v0.129.0 adds [workspace resources and artifacts](application-agent-workspace-resources.md),
a trusted confirm-agent registration command, and explicit filtered catalog
completeness. No archive/provider history completeness is inferred from it.


Source v0.128.0 adds separate agent-bound live conversation reads; see
[the conversation boundary](application-agent-conversation.md). Stored profile,
memory delivery, captured archive and live-read availability remain separate
facts. This source addition is not yet an installed controller delivery.

Acceptance update: [2026-09-14 verification](backend-remaining-acceptance-20260914.md)
adds real-storage restart/no-resend coverage and installed empty-agent
creation/archival evidence. Following explicit user confirmation, the
[live disposable test](backend-live-memory-acceptance-20260914.md) passed:
one message, completed action and reply, offline archive, new Gateway
descriptor and unchanged receipt/archive after restart, without resubmission.
This verifies the memory-agent route, not the separate owner-chat bridge,
non-empty memory updates in live turns, or frontend/headset acceptance.

Contract: `v0.1.0`. Owner: `orchestrator-development`. Backend only.
Confirmed intent: `docs/review_for_user/5/tech_review_14_09_2026_memory.md`.

## Ownership And Contents

The backend stores two distinct versioned scopes. Project memory contains
shared goals, terminology, constraints and user-approved decisions. Quarter
memory contains the feature goal, acceptance details and local implementation
context. It supplements project memory; it cannot grant exceptions to project
rules. Do not use either scope as a transcript, secret store or automatic
learning sink. Conversation history remains in the independent archive.

An empty project or quarter is valid. Creating an agent assigns both scopes
immediately, even when both are empty. `contentState` reports `empty`, `partial`
or `populated`; emptiness never blocks execution. The frontend may offer to
fill memory from backend information or let the user write it. Neither choice
may fabricate facts or commit generated rules without the user's command.

Only a direct user command authorizes a write, including agent-assisted edits.
The trusted local controller first records an exact grant with command ID,
scope, expected revision and content hash. Public `actorId` is only an audit
label, never proof of human authorization. There is no HTTP self-grant route.
The local grant issuer is a trust boundary, not a cryptographic human detector:
agents with filesystem/tool access must still follow the confirmed user intent.

Conflicting revisions fail closed instead of overwriting. Natural-language
contradictions cannot be decided deterministically: the user reviews and
resolves them before authorization. Backend delivery always labels project
rules as authoritative over quarter details; it does not claim that a model
understands or obeys every sentence.

## Persistence And Delivery

`project-memory-store.mjs` uses the existing SQLite process helper and its own
`project-memory-store.py` bridge. Scope creation, write grants, immutable
revisions and operation receipts are transactional. No vector database,
embedding service, extra daemon or provider-private history reader is added.
Durable identity uses the existing resolver: child `contract.sourceId`, or
top-level `project-version.json.projectName` when no child contract exists.
Gateway source identity is not substituted for that storage identity.
Texts are stored once per revision. Agents receive an atomic project/quarter
pair with scope IDs, revisions, SHA-256 and a manifest hash.

`ProjectMemoryService` keeps immutable membership and a bounded durable agent
catalog in that store. New agents receive fresh provider conversations, never
another agent's chat. A creation whose result is lost stays uncertain; replay
does not create a replacement. Project/quarter transfer and restore are absent.

Every new send resolves the latest pair, persists its manifest and the outgoing
archive record before invoking the provider. Already-running answers retain
their pinned snapshot. List/read/context derive required versus delivered
versions from backend state, including after restart, for every affected agent.
No in-flight text injection or background fan-out copy is necessary.

An operation ID allows only one provider submission. Repeated input reads the
receipt; changed input conflicts. `requested`, `accepted`, `started`, terminal
states and `uncertain` remain distinct. Receipt `observation=unavailable` does
not erase the saved state or authorize retry. A busy/uncertain agent cannot
start another operation. Bounded `problemCode` contains no raw provider error.

Closing waits for confirmed terminal work, captures available public history,
then archives the logical agent. Capture failure leaves `closing`, not a false
success. Archive reads work without the provider. Coverage remains explicitly
`captured-only`; provider-private or omitted content is not invented. Historical
memory context remains pinned. Closing never deletes provider history.

SQLite runs in the process through `node:sqlite` by default (memory, archive
and the control store); the Python bridges remain as a fallback for one
version. `AGENTS_FACTORY_SQLITE=node|python` chooses, and `control-cycle.json`
may name `sqliteBackend`; without `node:sqlite` every store falls back to
Python. Both write the same schema and the same bytes.

## Public Gateway Operations

Schema: `application-project-memory.v1.json`; standard Gateway envelopes,
discovery and bearer handling apply. Do not put endpoints or credentials in
handoff documents. Operation IDs:

- `query.memory.scopes.list`, `query.memory.scope.read`
- `mutation.memory.scope.create`, `mutation.memory.scope.write`
- `query.memory.agents.list`, `query.memory.agent.read`
- `query.memory.agent.context`, `query.memory.agent.archive`
- `mutation.memory.agent.create`, `mutation.memory.agent.close`
- `mutation.memory.agent.send`, `receipt.memory.agent.send`
- `mutation.memory.agent.steer`, `mutation.memory.agent.unqueue` (a message
  while the agent works: steered into its turn or queued for the turn's end)
- `mutation.memory.agent.profile` (model and effort of the next turns)
- `query.memory.agent.trace` (everything the agent's turns did, in full)

The last four are served by a provider that can steer a running turn and keeps
a trace (Claude Code); see `claude-code-port-package-20261002.md`, correction
v0.30.8.

Scope records contain `scopeId`, `kind`, `projectId`, nullable `quarterId`, title,
revision, hash, author, time and `entries: [{id,title,text}]`. Create starts empty.
Writes require `scopeId`, `expectedRevision`, complete replacement `entries`,
`operationId`, preauthorized `commandId` and `actorId`. Historical reads accept
`revision`; no public caller-selected filesystem path is used.

Agent create takes `agentId`, `projectId`, `quarterId`, `operationId`, and exact
`profile: {provider,model,reasoningEffort,fallbackPolicy:"deny"}`. Send takes
`agentId`, `operationId`, `text`; receipt takes the first two. Context returns
both documents and required/delivered manifests. List/read return metadata,
not memory bodies. Close takes `agentId`, `operationId`; archive supports cursor
and limit. Frontend Kit v0.14.0 packages these contracts; product UI and VR
remain separate owners. Agent metadata additionally exposes lastOperation
(operationId/state or null), never the private operation ledger.

Source v0.126.0 adds independent per-agent controls, without changing owner-chat
routes: query.agent-control.interactions, approval.agent-control.respond and
mutation.agent-control.interrupt. See application-agent-control.schema.json
and the packaged docs/desktop-integration.md. Interaction DTOs are reused;
one native method handler routes by exact thread instead of overwriting other
agents' approval handlers. Interrupt uses the original send operation ID and
persists its one-shot record before the provider call. Acknowledgement does not
prove termination or free a workspace writer; only the send receipt's observed
terminal state does. Uncertain stops are not automatically retried.

## Local Operator Entry Point

The deterministic CLI works without an agent or a running Gateway:

```text
node .orchestrator/runtime/application-gateway-cli.mjs memory --repo-root ROOT --action list-scopes --json
node .orchestrator/runtime/application-gateway-cli.mjs memory --repo-root ROOT --action read-scope --input-file RELATIVE.json --json
node .orchestrator/runtime/application-gateway-cli.mjs memory --repo-root ROOT --action authorize-write --input-file GRANT.json --confirm-user-command COMMAND_ID --json
node .orchestrator/runtime/application-gateway-cli.mjs memory --repo-root ROOT --action write --input-file WRITE.json --json
```

Input files must be regular files inside the controller root, at most 256 KiB.
Keep operational input in a local untracked directory. Grant input contains
`commandId`, `scopeId`, `expectedRevision`, `entries`, `requestedBy`; the command
confirmation must match. Write input uses the public write shape above.
Do not record a grant merely because generated text says it was approved.

For a frontend's trusted native host, action save-user-edit combines grant
issuance and the normal idempotent write. Its input is the public write shape;
--confirm-user-command must match commandId. A renderer/model cannot assert
its own approval. The host fixes the executable/controller root and invokes
only this bounded action after real user confirmation, not arbitrary commands.

Action bind-workspace takes {projectId,workspacePath} and requires
--confirm-project PROJECT_ID. The absolute directory must exist. The private
binding is immutable and canonicalized; the receipt exposes only projectId,
workspaceKey and configured. This is not a public path-taking HTTP operation.
Use the same local input restrictions as above. No new service is required.

Action read-workspace takes {projectId} and is read-only (no confirmation): it
returns {projectId, configured:false} for an unbound project, or {projectId,
configured:true, workspacePath, available} - the bound folder and whether it
still exists - so the trusted host can show the person which folder a project
works in. Like binding, it belongs to the trusted local host only; the Gateway
never exposes the path. A binding to another folder is refused with
memory_workspace_conflict, and the CLI's failure record keeps that code (every
memory_* refusal keeps its own code).

Action rebind-workspace takes {projectId,workspacePath} and requires
--confirm-project PROJECT_ID: it moves a project to another folder, but only
while nothing depends on the folder yet, else memory_workspace_in_use: no open
agent of the project (its session is pinned to the old folder; one that never
worked can be closed first) and no closed agent that ever worked (its history
was made in the old folder). Quarters do not count. An unbound project is
simply bound; the same folder again changes nothing ({changed:false}).
bind-workspace never does this.

Action set-permission-mode takes {agentId,permissionMode} and requires
--confirm-agent AGENT_ID: how the agent's tool calls are approved, as Claude
Code's permission modes - default (manual: edits and changing commands are
asked), acceptEdits, auto (Claude Code's classifier decides, asking when it
cannot) or bypassPermissions (nothing is asked); null goes back to the
provider's mode (claude-provider.json). It is the person's decision, like the
role, and applies from the agent's next turn. An archived agent refuses
(memory_agent_closed). The mode is kept in the catalog but is not part of the
public agent; action read-permission-modes (no input) returns
{defaultMode, agents:[{agentId, permissionMode}]} for the trusted host.

Action read-agent-commits takes {agentId}: the commits the Gateway made of the
agent's turns in its project folder (author `<agentId>@agents.atlas.local`),
newest first, {versioned, commits:[{sha, atUtc, subject, files}]}; versioned
is false when the folder is not under git. Action init-project-git takes
{projectId} and requires --confirm-project PROJECT_ID: `git init` of the
project folder, nothing committed ({initialised:false} when it already was).

Action read-task-board (no input, or {agentId}) is read-only and does not open
the store: the registered desk agents {sources:[{agentId, sourceId, valid}]}
and the controller's desk tasks, each with its stage - dispatched, started,
accepted, planned, in-progress, reported, accepted-by-code or declined - and
the details of its start, acknowledgement, progress, report and acceptance; no
paths. With {agentId}, only that agent's tasks.

## Bounds And Runtime Limits

- Each scope: at most 64 entries and 64 KiB of canonical entry JSON.
- Catalog: at most 128 agents, 128 sends per agent, 256 KiB catalog document;
  the byte cap can be reached first. No records are silently evicted.
- Send text: at most 16 KiB; inline media and secret material are rejected by
  the existing privacy policy. No media bytes are stored in memory.
- Historical versions remain readable. Export/retention is deliberate, not
  automatic pruning of working context or chat history.

The built-in execution adapter uses the Gateway's existing Codex runtime,
its shared mutation lease and independent public-content archive. Since source
v0.126.0, creation requires a trusted project workspace binding; create/resume
uses that folder, not the controller root. Quarters share the project's folder.
The durable catalog allows only one active memory-agent send per canonical
folder, including two project IDs bound to that same folder. Busy work is
rejected, not queued. Requested/uncertain sends retain the claim after restart.
This gate does not lock external/manual VS Code writers or other controllers;
the single-controller prototype must not run those concurrently. Legacy agents
without a stored workspace key are not silently adopted into a new directory.
It requires the exact advertised model/effort, denied fallback and a fresh
visible Gateway monitor. It does not launch VS Code or acquire arbitrary
workspaces. Logical project IDs do not grant filesystem access. Other model
providers implement the same service adapter boundary; Claude/Qwen execution
is not claimed by this release.

A newly created empty Codex thread is used in the same runtime for its first
turn. If the provider cannot resume it after restart, the operation remains
uncertain without replacement or fake history. Existing owner-chat approval
routes remain exact-thread-bound. New per-agent interaction routes are
implemented and fixture-tested, but do not themselves provide an approval UI.
Connect a compatible frontend consumer before interactive work. After runtime
loss pending questions become stale; never answer them in a replacement turn.

Source/fixture verification is not a live-provider or frontend acceptance.
Since source v0.127.19 (controller patch v0.29.7), trusted memory CLI failures
retain closed memory error codes, a fixed execution stage and selected OS error
codes. Each failure attempts an exclusive new diagnostic file at
`.project-local/memory-cli-diagnostics/<diagnosticId>.json`. Stderr reports the
same diagnosticId and diagnosticPersisted boolean; a failure to log preserves
the original refusal and never permits retry. Root-resolution failures may
have no file. Records contain no input body, scope content, paths or stack.
This is failure telemetry, not proof of non-delivery or a write receipt.
Reconcile an ambiguous write using its original operation/command identity.

The service and agent schema already expose the requested `profile` through
listAgents/readAgent. It is not proof of the provider's observed live profile;
exact-profile preflight remains mandatory. Missing consumer data alone does
not establish a missing backend field.

The installation report records which package is on disk. An already-running
Gateway keeps its loaded version until a normal controlled Stop/Start. The
fresh descriptor, not this document or installed files alone, determines
which operations a consumer can use.
