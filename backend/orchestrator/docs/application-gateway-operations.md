# Application Gateway Operations

> **Reference contract.** Written while the project ran its agents on the Codex App Server,
> and it keeps that era's internal milestone names (A1-A12, release programs, Frontend Kit
> versions) and links to internal reports that are not part of this repository. The contract
> itself still holds: the Claude Code provider presents its sessions in the same shape, so it
> applies to both providers. Start with [architecture.md](architecture.md) and
> [claude-code-provider.md](claude-code-provider.md).

Status: accepted supervised operations contract for A9. This document does not enable
headless startup or claim that every backend operation is gateway-native.

## Purpose

The Application gateway is one machine-local, project-owned entry point for a
future renderer-neutral frontend. It proves that accepted A1 requests and A8
event reads can cross a real loopback boundary without granting the frontend
provider, filesystem, process or orchestration authority.

The accepted A9.7 baseline exposed only
`discovery.application.capabilities`. The A11 remediation runtime now exposes
only the exact handlers configured for its current instance:

- Work Projection v2 and Backend Consumer reads use their existing clients;
- artifact/project reads use the accepted A3 policy-bound resource service;
- provider model, chat, usage and turn-observation reads use a dedicated Codex
  App Server adapter only after authenticated startup preflight;
- an explicitly configured child source may expose the exact owner-thread
  resolve, start, steer and receipt route documented in
  [Application Owner Chat](application-owner-chat.md);
- the same explicit child source exposes independent conversation archive
  resolve/read operations, even when provider startup is unavailable; see
  [archive coverage and storage](conversation-archive.md). Captured history is
  separate from live provider reads and global operational projections;
- when that exact source also has authenticated provider startup, five native
  provider request families are exposed through bounded read and one-shot
  response operations; see
  [Application Provider Interactions](application-provider-interactions.md);
- review-anchor, proposal, inverse-proposal and receipt checks reuse their
  existing deterministic contracts and require exact hash-bound inputs;
- execution-profile bind creates an expiring hash-bound planning decision from
  Task/profile/plan/return facts and a fresh authenticated provider model
  catalog; later verify requires a new exact turn-start binding and then
  materializes the unchanged writer-compatible planning policy;
- provider operations are omitted from the connection descriptor when that
  preflight is unavailable.

Provider preflight keeps managed Windows child-process denial separate from a
provider outage. A `spawn EPERM` or `spawn EACCES` result is published as
`app_server_spawn_forbidden`; other startup failures remain the bounded
`provider_app_server_unavailable`. This classification does not bypass the
sandbox or retry inside the gateway. An operator or agent may run only the
exact approved unsandboxed read-only retry defined by workspace policy.

The profile bridge retains its legacy start-bound input for compatibility, but
the current domain operation contract is `ProviderExecutionProfileDecision
v0.1.0`. A profile decision alone grants no provider writer authority. Changed
runtime, Task, profile, decision hash or catalog lifetime fails before a turn
planning policy can be materialized.

The descriptor never lists a handler merely because its domain contract
exists. Provider server-request responses are installed only by the exact
owner-source composition above. Generic interaction authority ports,
review-comment writes and Keep/Undo remain unavailable until their separate
authorities are explicitly installed. There is no VS Code UI fallback, direct
SQLite/rollout scan or second backend store.

Generic provider create/start/interrupt have a source-level bridge documented in
[Application Gateway Provider Mutations](application-gateway-provider-mutations.md).
The bridge is capability- and authority-gated per operation. Production
composition supplies no mutation authority, so the normal gateway remains
read-only and does not advertise those handlers.

The separately launched
[supervised change trial](application-gateway-supervised-change-trial.md)
reuses the accepted Keep/Undo contracts against one inert fixed target. Its
writer and exact approvals exist only inside that one-shot source harness.
They are not gateway composition inputs and do not alter the descriptor or
the unavailable production Keep/Undo handlers.

The separately launched
[supervised review-comment trial](application-gateway-supervised-review-comment-trial.md)
likewise installs one append-only authority only for an exact hash-bound
`clock_regressed` target and owner comment. Its accepted record does not add a
normal gateway comment store or advertise the mutation in production
composition.

The separately launched
[supervised provider-interrupt trial](application-gateway-supervised-interrupt-trial.md)
creates one disposable read-only turn and installs only the exact
`mutation.provider.turn.interrupt` authority for that expiring package. Its
accepted terminal receipt does not install an interrupt handler in normal
gateway composition or authorize replay.

## Provider Mutation Composition

Trusted composition may inject native adapter configuration and a matching
authority factory into the long-lived gateway runtime. Both are required. The
authority resolves the existing confirmation, lease, exact adapter request and
receipt path; the bridge validates capability, operation and correlation, and
turn start also revalidates the confirmed planning policy.

A12.3 extends the same trusted composition point to the existing interaction,
review-comment, Keep and receipt authority ports. This adds no authority
implementation or store: an omitted port still omits its handler, and an
unknown or malformed port fails before publication. With explicit fake ports
and all three provider mutation ports, one gateway instance can advertise all
sixteen canonical A11 workflow boundaries without importing or opening VS
Code. Merely publishing that surface invokes no writer.

No public CLI flag, descriptor field or frontend request can install those
generic authority ports. The `-ProviderSourceId` mode, which installed the
fixed Codex owner-chat, archive and provider-interaction routes, left with the
Codex path on 31.10.2026 (roadmap step 1): the Gateway runs Claude Code only.
Enabling one operation does not enable another. An uncertain
post-submit provider result remains non-retryable `uncertain_outcome` until its
operation-specific reconciliation boundary resolves it.

The first concrete authority adapter covers only supervised provider-thread
creation. It reuses the accepted A5/A6 action preview, exact owner response,
single-writer lease and trial receipt, then writes one bounded Application
receipt through an injected sink. Changed or denied approval reaches no
writer; provider or receipt persistence uncertainty cannot enable replay.
Normal production composition still does not install this authority.

## Supervised Lifecycle

Run commands from the repository root under the same Windows user and security
context:

```bat
tools\start_application_gateway.bat -AsJson
tools\application_gateway_status.bat -AsJson
tools\stop_application_gateway.bat -AsJson
tools\recover_application_gateway.bat -AsJson
tools\open_application_gateway_monitor.bat -AsJson
tools\close_application_gateway_monitor.bat -AsJson
```

For one deterministic backend entry point, use:

```bat
tools\start_orchestrator_backend.bat -AsJson
```

The bootstrap (contract `v0.4.0`) starts the supervised Gateway on Claude Code
through the same `Start` contract, then independently verifies its exact ready
descriptor. It returns only a bounded descriptor identity and capability count;
the bearer, session, endpoint and descriptor path remain protected. It does not
open VS Code, start the wake observer, submit a prompt or start an agent turn.

The Codex-era modes left with the Codex path on 31.10.2026 (roadmap step 1):
`-ProviderSourceId` (the Gateway bound to one child's Codex conversation,
checked by `OwnerChatStatus`) and `-Compatibility` (the isolated VS Code
window with the controller wake observer). Both switches, and `-Provider codex`,
are refused before anything starts; `application_gateway.ps1` no longer has the
`OwnerChatStatus` command, nor the CLI its `owner-chat-status`.

The bootstrap is a user-started supervised operation. They install no service,
Task Scheduler entry, startup hook or unattended restart. `-PlanOnly` reports
the selected sequence without starting any process.

`Start` performs this bounded sequence:

1. open a separate visible foreground status monitor;
2. verify a fresh monitor readiness record;
3. inspect the exact project gateway identity;
4. terminalize an exact dead and stale instance when recovery is required;
5. start a hidden gateway host only when state is absent or terminal;
6. wait for the gateway to become ready;
7. verify that the visible monitor is bound to that exact instance.

The listener binds only to `127.0.0.1` on an OS-assigned port. Its protected
ready-only connection descriptor is project-local and contains the temporary
bearer. Public status, monitor output, logs and reports contain neither the
bearer nor its path.

`Status` is bounded and read-only. It reports availability, reason, exact
instance/process identity, lifecycle and heartbeat plus monitor identity and
freshness when a monitor is live. It does not recover, restart or adopt a
foreign process.

`Stop` writes one exact project/instance stop request and waits for the gateway
to remove its ready descriptor and publish a terminal status. It never scans
for or broadly terminates Node, VS Code, Codex or another project process.

`Recover` is not a kill or retry command. It terminalizes only the exact
project status whose PID is no longer alive and whose heartbeat is more than
30 seconds stale. Instance, process ID, process start time and workspace hash
must still match. It removes only that instance's descriptor/publish claim and
records `uncertain/process_terminated`; the next supervised Start creates a new
instance and generation. A live, fresh, foreign or ambiguous process fails
closed.

The monitor and gateway have separate lifecycles:

- closing the monitor does not stop the gateway;
- stopping the gateway leaves the monitor available to display the terminal
  result;
- `OpenMonitor` may restore presentation for an existing exact instance;
- `CloseMonitor` stops only the fresh, project-matching monitor PID.

`Q`, `Escape` or `Ctrl+C` inside the visible monitor closes presentation only.
Use the project `Stop` command to stop the gateway.

## Runtime Records

Operational files live under `.project-local/application-gateway/`:

- bounded gateway status;
- bounded monitor status;
- exact stop request;
- short exclusive descriptor publish claim;
- protected ready-only connection descriptor.

When exact owner chat is configured, body-free request receipts live under
`.project-local/orchestration/application-owner-chat/<source>/` and its
project-scoped writer lease uses the existing provider-mutation lease store.
Neither location contains free-form message text or a copied transcript.

Runtime logs live under `logs/`. These records are operational state, not
canonical backend truth. Missing, malformed, stale, foreign or mixed identity
fails closed. A terminal instance is not silently reused.

The App Server read adapter is owned by the gateway instance and is closed
with that instance. It uses the project-local Codex home, returns only the A4
privacy-bounded provider projections and does not copy credentials or history
into gateway records. Its availability is advertised separately from core
Work/resource reads.

Gateway stderr uses fixed allowlisted reason codes. Dynamic argument names or
values are reduced to `invalid_argument` or `missing_argument`; unknown error
text becomes `application_gateway_failed`. Exception text, arguments, paths,
credentials and request/provider content are never ordinary log fields.

## Operator And Privacy Boundary

Every user-started gateway launch is supervised. The visible monitor must be
ready before the hidden host starts, and its heartbeat must remain bound to the
current gateway instance. Raw provider history, prompts, account credentials,
OpenAI session data and filesystem paths are not part of the public status.

There is no scheduled task, service registration, startup entry or unattended
restart. A9.8 proves the supervised failure matrix, but headless startup stays
gated until a validated user-facing consumer exists.

## Verification

The focused contract tests cover runtime records, identity/freshness checks,
real loopback A1/A8 transport, authorization before body parsing, ready-only
descriptor removal and exact Stop. A supervised smoke additionally verifies:

- visible monitor readiness before host startup;
- exact monitor-to-gateway binding;
- bounded status while ready;
- project-scoped gateway Stop;
- separate monitor close;
- no remaining gateway or monitor process after completion.

A9.8 additionally proves 24 concurrent requests across two independent
workspaces, OS-assigned port isolation, same-workspace collision rejection,
stale bearer denial, foreign-workspace rejection, exact dead-process recovery
and new lifecycle identity for upgrade and rollback generations.
