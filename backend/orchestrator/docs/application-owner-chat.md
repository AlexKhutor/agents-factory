# Application Owner Chat

> **Codex App Server provider only.** The owner chat with one child Codex conversation is kept
> from the project's earlier era (`-Provider codex`). With the Claude Code provider, agents' chats
> go through the Gateway's agent operations - see [claude-code-provider.md](claude-code-provider.md).
> Links to internal reports of that era are not part of this repository.

> **Removed from the product on 31.10.2026 (roadmap step 1).** The owner chat
> ran on the Codex App Server, which left the product with the Codex path: the
> Gateway runs Claude Code only and offers none of the operations below
> (`ownerChatStatus` reports `disabled`). Their ids stay declared in
> `application-owner-chat-contract.mjs` for the Application contract. This page
> is kept as the record of what the route did.

Status: source implementation `v0.3.0`, public/schema contract `v0.2.0`, for
one explicitly selected child Codex conversation. It is renderer-neutral and
does not prescribe SampleApp presentation.

The [confirmed backend completion plan](backend-completion-plan-20260906.md)
requires the [independent conversation archive](conversation-archive.md).
Its current source implementation stores content separately; the command
journal remains body-free evidence, not complete chat recovery.

## Purpose

This route lets a local first-party frontend continue the exact child
conversation already selected by the controller. It does not choose the first
similar chat, create a replacement chat, expose provider storage, or make the
frontend a provider authority.

Three stores have different jobs:

- Codex App Server remains authority for its thread, turns, transcript and
  live turn items;
- the backend records a body-free command journal and single-writer lease so
  submission and uncertain outcomes can be recovered deterministically;
- the independent backend archive retains submitted text and captured public
  messages/activity across Gateway restart and provider unavailability.

Use `query.provider.thread.read` for a live provider read, or the separate
archive operations for already captured content. Archive coverage is explicit
and never implies that all pre-existing history has been imported.

## Exact Runtime Selection

Start the backend with one configured child source:

```bat
tools\start_orchestrator_backend.bat -ProviderSourceId sample-app-development -AsJson
```

Startup resolves that source through the controller source registry,
machine-local source binding and `child-chat-bindings.v3.json`. It verifies the
workspace fingerprint, selected thread UUID, binding state, child workspace
and child `CODEX_HOME`. The Gateway then starts its App Server client in that
child workspace and verifies the exact thread is readable.

`tools\application_gateway.ps1 -Command OwnerChatStatus -AsJson` reports only
availability, source and a thread-reference hash. It does not expose the
bearer, descriptor path or raw thread ID. If an already-running Gateway was
started for another source, bootstrap fails instead of adopting it.

Without `-ProviderSourceId`, these operations are absent and the default
Gateway remains read-only. No VS Code or controller agent is required for the
backend route once the exact child binding already exists.

## Operations

| Operation | Input | Successful output |
| --- | --- | --- |
| `query.provider.owner-thread.resolve` | `{}` | `ApplicationOwnerChatBinding` |
| `mutation.provider.owner-turn.start` | exact `provider`, `threadRef`, `text` | `{ receipt }` |
| `mutation.provider.owner-turn.steer` | exact `provider`, `threadRef`, `turnRef`, `text` | `{ receipt }` |
| `receipt.provider.owner-message.read` | `requestId` | `{ receipt }` |

Resolve returns the current provider identity, trusted thread reference,
selection time, controller binding state, active task/turn, and
`startAvailable`/`steerAvailable`. The frontend must reuse these values
unchanged. It must resolve again after a Gateway generation changes.

Start is accepted only when the provider thread is idle and the controller
binding is known idle, with no active managed task/turn. Unknown/not-started
bindings cannot start work; provider `active` without turn details is not idle.
Steer requires the exact active turn and App Server's expected-turn check.
An archive capture failure disables both send capabilities.

Start input also carries an exact execution profile. The backend requires
`fallbackPolicy=deny`, reads a fresh complete model catalog from the same
provider runtime, and verifies the requested model/reasoning pair before it
acquires writer authority. The same model and effort are supplied to both
thread resume and turn start. A missing or changed catalog fails before
submission; no fallback is selected.

## Submission And Receipt Semantics

Every mutation uses a frontend-created stable `requestId`. Before provider
submission, the backend persists a prepared record and acquires the existing
project-scoped CAS mutation lease. The free-form `text` is held by a one-shot
ephemeral submission object, removed from the request object, consumed once,
and never written to the journal, lease, status or ordinary log. Before the
provider receives it, the archive must commit a separate immutable submission.
Archive failure is a pre-submission failure, not a guessed provider outcome.

Owner chat and the managed child router use the same project-scoped file lease
store and mutation identity. Their requests therefore cannot become parallel
writers for the same provider boundary. Settled lease entries move into an
append-only protected archive when the active ledger reaches its bound; replay
and intent-conflict checks include that archive, so compaction does not discard
the evidence needed to prevent another send.

The durable receipt contains only the input SHA-256, byte/character lengths,
exact provider/thread/turn references and bounded timestamps. It reports:

- `commandState`: `prepared`, `accepted`, `not-applied`, or `uncertain`;
- `deliveryState`: `requested`, `accepted`, `started`, `completed`, `failed`,
  `interrupted`, `uncertain`, or `unknown`;
- `replay` and `automaticRetryAllowed=false`.

`deliveryState` is refreshed from provider-owned turn state when the exact turn
can be observed. A successful Application invocation means the handler ran;
the nested receipt is the authority for message/turn status.

Start sends `clientUserMessageId=requestId`. If acknowledgement is lost, a
receipt lookup with `requestId` alone reconciles that exact marker and returns
the existing receipt without resending text. Absence of a marker remains
uncertain: a delayed in-flight request may still arrive. It never starts a
second turn or releases the writer based only on missing read evidence.

Steer has no equivalent provider idempotency key. An uncertain steer is never
resubmitted automatically. Read its receipt and wait for the provider thread
observation or an explicit operator decision.

## Reads And Activity

`query.provider.thread.read` returns bounded visible message content from the
same selected provider and can also expose safe activity summaries. Command
activity contains status and numeric exit code only; file-change activity
contains status and count only; tool/collaboration activity contains status
only. Raw commands, output, paths, diffs, arguments and hidden reasoning remain
omitted.

These live-read summary limits do not define the independent archive payload.
The archive also stores public command text/output with omissions and bounded
size, using existing exact-thread provider notifications. It does not store
hidden reasoning, and its historical backfill remains explicitly partial.

## Authority And Recovery

The Gateway owns source resolution, provider identity validation, lease,
journal and App Server calls. The frontend owns draft text and presentation;
it must not persist provider credentials or bypass capability discovery.

Journal records survive a Gateway restart under
`.project-local/orchestration/application-owner-chat/<source>/`. A fresh
Gateway receives a new provider runtime identity, so the frontend resolves a
fresh binding before another command. Stable request IDs permit receipt lookup
without retaining or resending text.

The exact provider-interaction bridge is a separate route over the same
configured conversation. It records provider questions/approvals and returns
one real operator response without broadening owner-chat send authority; see
[Application Provider Interactions](application-provider-interactions.md).

No live provider mutation is required by the contract tests. They use an
isolated fake App Server and temporary controller/source fixtures.
