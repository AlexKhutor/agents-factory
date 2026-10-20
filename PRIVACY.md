# Privacy

Agents Factory is local-first. Your code, your agents' conversations, their
memory and your keys stay on your machine.

## v0.1.0: no telemetry

This version sends nothing to the Agents Factory authors. The only network
traffic is the agents' own work: requests to the model provider you configure
(Anthropic, with your API key) and whatever tools your agents run.

## Telemetry, when it comes

Telemetry is planned to help improve the product. It will follow these rules,
and this file will be updated in the release that adds it:

- **Only with your consent.** On the first run you choose, with two equal
  buttons and nothing pre-selected. Until you choose, nothing is sent. If you
  say no, nothing is ever sent.
- **You can turn it off at any time:** in Atlas's settings or with
  `agents-factory telemetry off`. `DO_NOT_TRACK=1` and
  `AGENTS_FACTORY_TELEMETRY=0` always turn it off.
- **Anonymous.** A random installation ID created on your machine, not linked
  to any account (you can reset it); product and component versions; OS and
  architecture; counts of features used; error codes and stack traces with
  paths and names removed; durations of key steps.
- **Only to improve the product.** Never sold, never used for advertising.
- **Never collected:** conversations, prompts, model answers, reasoning, code,
  file names and paths, project, quarter and agent names, memory, notes,
  documents, tokens, keys, credentials, e-mail addresses, user or computer
  names. IP addresses are not stored.
- **Transparent.** Atlas shows the exact payload of the next send and keeps a
  local log of what was sent (`agents-factory telemetry show`).

The full plan is in [docs/distribution/telemetry.md](docs/distribution/telemetry.md).
