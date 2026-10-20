# AGENTS.md

Guide for coding agents (Claude Code, Codex and others) working in this
repository. Humans: start with [README.md](README.md).

## What this is

Agents Factory is a local-first control room for teams of AI coding agents
(today they run on Claude through the Claude Agent SDK).
Three parts, one repository:

| Path | Part | Language |
| --- | --- | --- |
| `backend/orchestrator/src` | Application Gateway: hosts every agent as a Claude Agent SDK session; memory, write zones, permission modes, per-turn commits, task contracts | Node.js 20+, ES modules, no runtime npm dependencies |
| `backend/orchestrator/test` | Backend test suites | `node --test` |
| `backend/tools` | PowerShell tools (Gateway lifecycle) | PowerShell 5.1+ |
| `controller/` | Controller instance template a user copies; the Gateway works for it | JSON, PowerShell, the built Gateway bundle |
| `frontend/` | Atlas, the Electron desktop app (strategy map, chats, approvals) | Electron, plain JS, no framework |

Guides: `backend/orchestrator/docs/` (start with `architecture.md`,
`claude-code-provider.md`, `project-memory.md`) and `frontend/AGENTS.md` for
the Atlas side.

## Checking your work

```powershell
cd backend/orchestrator
node scripts/run-tests.mjs                                   # all backend suites
node --test test/project-memory-service.test.mjs             # one suite
node scripts/build-application-gateway-runtime.mjs --verify  # the bundle matches src

cd frontend
npm test            # Atlas unit suites
npm run verify:kit  # the pinned frontend kit verifies
npm run test:ui     # UI scenes; opens Electron windows
```

A change to `backend/orchestrator/src` that the Gateway uses also needs
`node scripts/build-application-gateway-runtime.mjs` (the bundle in `dist/`
is checked in and verified), and the controller template's copy at
`controller/.orchestrator/runtime/application-gateway-cli.mjs`.

## Rules

- **No credentials.** Never read, print or copy tokens, `.credentials` files
  or `.project-local/application-gateway/connection.v1.json` (it holds the
  Gateway's bearer token). Check the Claude sign-in only with the read-only
  `claude auth status`.
- **Live turns cost the user's quota.** Tests use fixtures and fake SDKs. Do
  not start Claude sessions, send messages to agents or run "live" scripts
  (`frontend/tools/test-*-live.mjs`) unless the person explicitly asks.
- **Machine-local files stay out of git:** `.project-local/`, `logs/`,
  `frontend/config/local.json`, Electron's `user-data/`.
- **Bytes are exact.** `.gitattributes` is `* -text`: keep each file's line
  endings (CRLF or LF) as they are; check with `git ls-files --eol`. Do not
  run tools that rewrite line endings.
- **Pinned files are pinned.** `frontend/vendor/frontend-kit/**`,
  `frontend/delivery/**` and the hashes in `frontend/src/host/kit.mjs` move
  only together, as a new accepted delivery.
- **Irreversible actions go through the trusted host.** In Atlas, anything
  that archives, binds a folder, writes memory or widens permissions is
  confirmed in the host's own window, never by the page.
- **Interface text:** short, plain English, sentence case; the same word for
  the same thing everywhere (tests look for labels by their text).
