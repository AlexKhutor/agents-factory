---
name: execute-orchestrated-task
description: Accept, execute, and report a bounded task delivered by Agents_Factory_Control through `.orchestrator/tasks/inbox`. Use when a child-project agent (Claude Code or Codex) is asked to process a pending orchestrator task, enforce the project's responsibility boundary, stop and report an unexpected foreign bug, coordinate task-specific subagents, or submit a completion, blocked, or failed report.
---

# Execute Orchestrated Task

Process one immutable task without taking ownership of another subsystem.

## Workflow

1. Read `.orchestrator/contract.json`, this workspace's `AGENTS.md` and start
   prompt, `.orchestrator/docs/responsibility-boundaries.md`, then the task's
   `task.md` and `task.json`.
   An inbox entry or VS Code startup does not start execution. Continue only
   when the current turn explicitly identifies the task to process. Never
   claim that a manually opened window is controller-managed or accept work
   merely because a packet exists.
2. Read [task-contract.md](references/task-contract.md) and every path in
   `requiredReading`.
   Before acknowledging the task, check the provider's quota gate when this
   workspace has one (a Codex child: `tools\check_codex_quota_reserve.bat`;
   a Claude Code desk agent: the Gateway's plan usage). Continue only on
   `proceed`. `stop` or `unavailable` means no task acceptance or new
   operation; preserve bounded state and report the quota gate to the user.
3. Resolve the task intent and authority model:
   - for v0.3.0, read `intent`, `intentConfirmation`, `desiredOutcomes`,
     `workflowPolicy`, `responsibilityBoundary`, `forbiddenPaths`, and
     `executionAuthority`;
   - for v0.2.0, read `intent`, `desiredOutcomes`,
     `responsibilityBoundary`, `forbiddenPaths`, and `executionAuthority`;
   - for legacy v0.1.0, treat `objective` as intent, `acceptanceCriteria` as
     requested outcomes, and `allowedPaths` only as a maximum safety ceiling.
   If v0.2/v0.3 includes `executionProfile`, verify that its provider is the
   one this workspace's route runs on (`anthropic` for a Claude Code desk
   agent, `openai` for a Codex child) and that `fallbackPolicy=deny`. The
   controller selected that model and effort before this turn; record it as
   task context but never change or reinterpret it from inside the child task.
   A task that repairs an orchestrator incident carries the exact profile the
   controller fixed for incident repair; reject or block a task that requests
   another profile, and never downgrade silently.
   Confirm that the intent belongs to this workspace. Never treat a proposed
   mechanism or example path as mandatory unless it is an explicit owner,
   safety, or compatibility requirement.
4. Acknowledge exactly once:

   ```powershell
   & ".agents\skills\execute-orchestrated-task\scripts\accept_task.ps1" `
     -TaskId <task-id> `
     -Decision accepted
   ```

   Use `rejected` or `blocked` with `-Reason` when the task violates ownership,
   lacks evidence, or depends on unavailable state.
   If the current turn does not identify the task or the operator is only
   inspecting the workspace, do not acknowledge it.
5. Inspect the current repository read-only and choose the implementation
   files, approach, and local validation plan inside this owner's boundary.
   Publish those choices as bounded plan/progress evidence; do not rewrite the
   task packet. For v0.3.0, record the `task_start` rule checkpoint, publish the
   plan in `awaiting_confirmation`, and stop before implementation.
   The start record must identify the incident/task, owner, start time, branch,
   and baseline commit or explicit non-Git snapshot. Use the existing task and
   progress artifacts instead of creating a parallel session diary.

6. After the user explicitly confirms the understood direction and current
   plan, record that approval with `confirm_task_plan.ps1`. Then record the
   `pre_implementation` checkpoint, rerun the quota reserve guard, and enter
   implementation only when it returns `proceed`. Never infer
   confirmation from silence, assistant text, or an unrelated approval. A
   structural plan change closes the gate and requires confirmation again.
   Inspect the returned `task_cancellation_requested` value whenever a phase or
   plan step changes:

   ```powershell
   & ".agents\skills\execute-orchestrated-task\scripts\update_task_progress.ps1" `
     -TaskId <task-id> `
     -TaskState running `
     -Phase implementation `
     -LifecycleStage implementation `
     -RuleCheckpoint pre_implementation `
     -CurrentAction "Implementing the accepted local scope" `
     -StepId implementation `
     -StepTitle "Implement local changes" `
     -StepState running
   ```
7. During active work, publish a heartbeat every 30-60 seconds without
   regenerating semantic summaries:

   ```powershell
   & ".agents\skills\execute-orchestrated-task\scripts\update_task_progress.ps1" `
     -TaskId <task-id> `
     -HeartbeatOnly `
     -HeartbeatIntervalSeconds 60
   ```

8. If subagents are useful, record the `delegation` checkpoint and rerun the
   quota reserve guard. Only when the result is `proceed`, give each one a
   bounded text-only subtask and project-relative references. Do not pass the
   full parent history, raw logs, or media bytes. The primary child agent
   remains accountable for the task.
9. Before the report, record the `pre_completion` checkpoint and publish the
   terminal progress state (`completed`, `blocked`, or `failed`). Every primary
   agent and task-specific subagent must have a compact final state.
   Acknowledge any pending cancellation before continuing.
   For every durable code, contract, tool, or documented-behavior change,
   update the owning project version, `CHANGELOG.md`, and only the canonical
   documentation whose truth changed. State-only recovery uses its normal
   receipt/log and does not create a source changelog entry or version bump.
10. Draft the report from `.orchestrator/templates/report.md`. Read
   [report-contract.md](references/report-contract.md) before submission.
11. Submit the immutable report:

   ```powershell
   & ".agents\skills\execute-orchestrated-task\scripts\submit_report.ps1" `
     -TaskId <task-id> `
     -Status completed `
     -SourceRevision <commit-or-explicit-uncommitted-marker> `
     -ReportPath <project-relative-report.md> `
     -Summary "<compact outcome>"
   ```

   The submitter invokes `$signal-orchestrator` after immutable publication.
   A verified `completed`, `blocked`, or `failed` signal wakes the controller's
   detached observer; progress heartbeats do not. If signaling fails, preserve
   the valid report, record the signal problem, and stop rather than attempting
   to write into the controller workspace directly.

   Never edit an immutable report package after submission. If deterministic
   acceptance later proves that an otherwise completed package contains
   exactly one plan step left in `running` by bookkeeping error, stop until the
   project owner explicitly authorizes correction. Then use
   `submit_report_correction.ps1`; it publishes a separate hash-bound correction
   and cannot change the original report, progress, summary, or wake event.
   Controller import and queue/observer recovery remain explicit later actions.

## Responsibility Incident Stop

- This agent may implement only the confirmed task inside this workspace's
  documented owner boundary. Filesystem access or technical familiarity does
  not authorize a change in another subsystem.
- If an unexpected bug is outside the confirmed task or this owner boundary,
  do not fix it, work around it, patch an imported copy, or delegate the fix.
  Follow `.orchestrator/docs/responsibility-boundaries.md`.
- Publish the current task as `blocked`, write the bounded bug facts into the
  task report, submit it with `-Status blocked`, and stop until a new explicit
  instruction is delivered to the correct owner.
- If there is no active orchestrated task, give the user the same structured
  bug report in the current chat and make no source change.
- A subagent that finds such a bug returns the report to the primary agent and
  stops. The primary agent must not absorb the foreign work into its task.
- A bug may be fixed here only when fixing it is the explicit confirmed intent
  and this workspace is its documented owner.

## Guardrails

- Never edit a delivered task packet.
- For v0.3.0, never modify implementation files or run behavior-changing
  commands before the current plan is explicitly confirmed.
- Do not ask the user to approve routine technical choices inside an already
  confirmed intent and plan. Stop for material intent, scope, behavior,
  ownership, constraint, outcome, or plan-structure changes.
- Reread and record the workflow rules at task start, context recovery,
  pre-implementation, material plan change, delegation, and pre-completion.
- At those checkpoints, before every new long-running operation, and before
  every controlled compaction, check the quota gate again (a Codex child:
  `tools\check_codex_quota_reserve.bat`, stop fail-closed on exit `20`, `21`
  or `22`). After provider-controlled automatic compaction, make this the
  first check before continuing.
- Never report tests that were not run.
- Never make cross-project acceptance decisions; request them in the report.
- Never repair another workspace, application layer, or imported tool because
  it blocks the current task. Report the boundary incident and stop.
- Never let coordinator wording take ownership of local file selection,
  architecture, implementation, or technical test design away from this
  project.
- Judge local completion with tests and evidence selected by this owner; report
  separately whether the coordinator's observable outcomes were met.
- Never embed media, base64, data URIs, provider rollouts, or complete chat
  transcripts.
- Do not let a subagent acknowledge the parent task or submit the final report.
- Do not keep the controller chat waiting while this task runs. The controller
  confirms provider start and ends its turn; this owner may work for hours as
  long as bounded heartbeats remain fresh and the final report signal is
  published once.
- Do not invent a percentage. Use explicit plan steps or indeterminate
  progress, and keep `currentAction`, `lastCompleted`, and `nextAction` brief.
- A file-handoff cancellation is cooperative. Stop at the next bounded check
  and publish confirmation; never describe a requested stop as confirmed until
  execution has actually ceased.
