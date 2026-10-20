# Security

Agents Factory runs coding agents on your machine with access to your project
folders. It is built to keep that access visible and bounded, but it is alpha
software: review what you enable, especially the "Bypass permissions" mode.

## What the system does and does not do

- **Everything is local.** No telemetry in v0.1.0 (see [PRIVACY.md](PRIVACY.md)). The Application Gateway listens on loopback only.
  Its bearer token is written to the controller's machine-local folder
  (`.project-local/application-gateway/connection.v1.json`) and never leaves
  the machine. Do not commit `.project-local/`; the template's `.gitignore`
  keeps it out.
- **No credentials are read or stored.** The Anthropic API key reaches the
  agents only through the Gateway's environment (`ANTHROPIC_API_KEY` with
  `keepProviderVariables`); the Gateway does not store it, and Atlas never
  reads it or any other credential.
- **Agents are bounded by write zones.** Each agent has a write zone (glob
  patterns inside its project folder). A pre-tool hook refuses edits outside
  the zone in every permission mode, including "Bypass permissions".
- **Irreversible actions need a confirmation.** Archiving an agent, binding a
  project folder, writing memory, the "Bypass permissions" mode and
  `git init` go through a confirmation window of the trusted Electron host,
  not of the page.
- **Memory needs approval.** Agents propose memory as documents; nothing is
  written to memory unless the person approves the exact text (by SHA-256).
- **Nothing is pushed.** Agents' work is committed to the project's local git
  repository; the system never pushes anywhere.
- **The frontend kit is verified.** Atlas loads only the frontend kit release
  pinned by SHA-256 in `frontend/src/host/kit.mjs` and refuses to start with
  any other bytes.

## Reporting a vulnerability

Please report security issues privately through GitHub's "Report a
vulnerability" (Security → Advisories) on this repository, not in a public
issue. Include the version (`project-version.json`), what you did and what
you saw. You will get an answer within a few days.
