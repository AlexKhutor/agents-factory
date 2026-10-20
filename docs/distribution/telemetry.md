# Telemetry

The maintainer decided: telemetry is needed, but **only anonymous, only to
improve the product, and only with explicit consent**. Declining means no
telemetry at all. v0.1.0 has no telemetry at all; this document describes
how it will work.

## Consent

- On first run: a separate screen with two equal buttons ("Help improve the
  product" / "Don't send") and no preselected option. Nothing is sent before
  the choice.
- The screen says briefly and honestly what we collect, what we never
  collect, why, and where to see what was sent.
- The choice can be changed at any time: Atlas settings,
  `agents-factory telemetry on|off`.
- The variables `DO_NOT_TRACK=1` and `AGENTS_FACTORY_TELEMETRY=0` always turn
  telemetry off, whatever the settings say.
- Opt-out is covered by a test: with telemetry off, the sending code is never
  called.

## What we collect

- A random installation ID (a UUID created locally, not linked to an
  account; it can be reset).
- Product and component versions, OS and architecture.
- Feature usage counters (for example: chat opened, agent created, memory
  document approved), without content.
- Errors: the error code and the stack trace, with paths and names removed.
- Durations of key steps (Gateway start, SDK installation).

## What we never collect

- Conversation text, prompts, model responses, thinking.
- Code, file names and paths, names of projects, quarters and agents.
- Memory, notes, documents.
- Tokens, keys, credentials, e-mail, user name, computer name.
- The server does not store IP addresses.

## Transparency

- "Show what is sent": the exact JSON of the next send.
- A local log of what was sent (`agents-factory telemetry show`).
- `PRIVACY.md` in the public repository: the same information for those who
  have not installed the product yet.
- The README and SECURITY.md wording ("everything runs locally") is updated
  in the release that adds telemetry: everything runs locally except
  anonymous telemetry, if the person agreed to it.

## Open questions

- Where to send: a minimal server of our own, or self-hosted PostHog/Sentry;
  retention period (proposed: 90 days); a contact for data requests.
