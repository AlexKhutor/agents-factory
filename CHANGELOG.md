# Changelog

Agents Factory is under active development; each release gets an entry here,
newest first. Versions follow [semantic versioning](https://semver.org/); while
the version is `0.x`, a minor version may change behaviour, a patch version
only fixes.

## v0.1.0 - 2026-10-20

The first versioned release: the system its author has been using daily,
published as source (installers come in later versions, see
[docs/distribution](docs/distribution/README.md)).

- **Built for agents.** The project is now **Agents Factory** (it was
  published as Agents Factorio on 2026-10-06). Agents run on Claude through
  the Claude Agent SDK; Codex CLI and local agent harnesses are on the
  [roadmap](ROADMAP.md).
- **Atlas v0.30.0** - the Electron desktop app: strategy map (World → Project →
  Quarter → Agent), live agent chats with thinking blocks and tool calls,
  steering and queueing, questions with single and multiple choice, permission
  modes per agent, memory documents with approval, agent history (per-turn
  commits), project and quarter leads.
- **Application Gateway v0.146.0** - hosts the agents through the Claude Agent
  SDK with an Anthropic API key: project, quarter and agent memory; write
  zones enforced by a pre-tool hook; permission modes (manual, accept edits,
  auto, bypass); one git commit per agent turn; operation journal with
  receipts.
- **Controller template v0.42.0** - a clean instance to copy: Gateway tools,
  control cycle, desk-agent task kit and contracts.
- **Frontend Kit v0.21.0** - the backend's accepted delivery, pinned by SHA-256.
- **Docs:** the plan for the one-file installer, the CLI, MCP and telemetry
  ([docs/distribution](docs/distribution/README.md)); [PRIVACY.md](PRIVACY.md):
  no telemetry in this version.
