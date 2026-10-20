# MCP in Agents Factory

MCP (Model Context Protocol) is needed in three places:

| | What | For whom |
| --- | --- | --- |
| **A** | External MCP servers for our agents (databases, browser, issue tracker, Figma, custom tools) | agents in Agents Factory |
| **B** | Agents Factory as an MCP server | Claude Code, Claude Desktop, Codex CLI, Cursor and other clients that want to manage the agent team |
| **C** | Team tools (tasks, memory, questions to other agents) over MCP | agents from any provider: Claude Code, Codex CLI, local agents from the roadmap |

## Today

- Every agent turn runs in the Claude Agent SDK with `strictMcpConfig: true`,
  `skills: []` and `settingSources` from `claude-provider.json`
  (`claude-code-session-host.mjs`). The agent sees only the MCP servers that
  the Gateway passed; `.mcp.json` in the project folder is not picked up.
- The Gateway already passes one in-process MCP server, `desk`
  (`createSdkMcpServer`): the desk agent's task tools. The tool list does not
  change from turn to turn, so that prompt caching works.
- The SDK supports all the needed server types: `stdio`, Streamable HTTP,
  SSE (deprecated) and in-process (`McpServerConfig` in `sdk.d.ts`), as well
  as `allowedTools`.
- The current MCP specification version is **2026-07-28**:
  - no protocol sessions and no `initialize` handshake; every request carries
    the version and capabilities in `_meta`;
  - `server/discover` was added;
  - instead of server-to-client requests (elicitation, sampling), there is
    the Multi Round-Trip Requests pattern (`resultType: "input_required"`);
  - tasks are an official extension;
  - subscriptions go through `subscriptions/listen`;
  - Roots, Sampling and Logging are deprecated.

  Many clients are still on 2025-11-25, so we build on the official MCP
  TypeScript SDK, which supports both versions, and verify this during
  implementation.

## A. MCP servers for agents

### Catalog by level

The instance file `config/mcp-servers.json` (no secrets; it can be kept in
git):

```json
{
  "schemaVersion": 1,
  "servers": {
    "postgres-dev": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@example/postgres-mcp"],
      "env": { "DATABASE_URL": { "secret": "postgres-dev/url" } },
      "trust": "ask",
      "tools": { "allow": ["query", "schema"], "deny": ["execute"] }
    },
    "tracker": {
      "transport": "http",
      "url": "https://tracker.example.com/mcp",
      "auth": { "secret": "tracker/token" },
      "trust": "ask"
    }
  },
  "attach": {
    "instance": [],
    "projects": { "billing": ["postgres-dev"] },
    "quarters": { "billing/api": ["tracker"] },
    "agents": { "billing-api-1": { "add": [], "remove": ["tracker"] } }
  }
}
```

- **Levels inherit** the same way memory does: instance → project → quarter
  → agent; a server can be added to or removed from an agent.
- **Secrets** (`{"secret": "..."}`) are stored only in the system credential
  store: Windows Credential Manager, macOS Keychain, libsecret on Linux. The
  Atlas trusted host writes them from the person's input. The Gateway passes
  a secret only into the environment of the MCP server's process. Secrets
  never reach memory, logs, receipts, conversations or exports.
- **Changes apply from the next turn.** An agent's tool set is stable within
  a turn, so the prompt cache is not broken needlessly.
- **A project's `.mcp.json`** (as in Claude Code) can be imported into the
  catalog. Import is explicit only, showing each command and asking for
  confirmation: it runs someone else's code.

### Development tools as MCP servers

The catalog is the natural place for MCP servers of development
environments, so that agents build, test and debug projects the same way a
person does:

- **Visual Studio**: [VS MCP Server](https://marketplace.visualstudio.com/items?itemName=CodingWithCalvin.VS-MCPServer)
  (MIT): 75 tools (solution, editor, build, debugger, tests, terminal),
  Streamable HTTP on `localhost:5050`. Connected as `transport: "http"`.
- **xtool** (iOS apps from SwiftPM on Linux, WSL and macOS, MIT) has no MCP
  of its own. When iOS development starts (the phone companion app), build a
  wrapper MCP server over the xtool CLI (`build`, `install`, `launch`,
  `devices`, logs): quick, no dependency on the xtool authors, and it can be
  published to the MCP Registry as a separate project.
- **Native macOS apps**: the `macos-spm-app-packaging` skill from
  `Dimillian/Skills` (MIT) as a tool for agents that write Swift apps.

### Permissions and confirmations

- MCP tools follow the agent's permission mode. In `default` mode, a tool
  call goes through a question to the person (as Bash does today); in
  `acceptEdits`, the same, unless the server is marked `trust: "auto"`; in
  `auto` and `bypassPermissions`, as Claude Code decides.
- `tools.allow` / `tools.deny` narrow the list before the mode applies (in
  the SDK: `allowedTools` / `disallowedTools`).
- **The write zone does not protect against MCP.** The zone hook checks file
  edits in the project folder; an MCP server can change anything outside it
  (a database, tickets). So `trust` defaults to `ask`, and this is visible in
  the UI.
- **MCP responses are untrusted text** (prompt injection, "poisoned" tool
  descriptions). Tool descriptions are shown to the person when the server is
  connected; a description that changes after confirmation needs a new
  confirmation.

### Atlas UI

- A "Tools" tab on the HQ, the quarter and the agent: connected servers,
  where they are inherited from, status (the SDK reports server state), the
  tool list, and "connect", "remove" and "check" buttons.
- In the chat, an MCP tool call is shown as an action, with the server name.
- Adding a server is a wizard: type, command or URL, secrets (into the
  store), trust, and whom to attach it to.

## B. Agents Factory as an MCP server

So that a person, or their main agent in Claude Code, Claude Desktop, Codex
CLI or Cursor, can work with the agent team without opening Atlas.

### Transports

- **stdio:** `agents-factory mcp serve`. The client starts the process
  itself; this is the simplest and safest option for local clients.
- **Streamable HTTP on loopback:** for clients that do not start processes.
  A separate token per client, `127.0.0.1` only.
- The MCP server is a client of the Gateway API, like Atlas: it has no direct
  access to databases or processes.

### Tools

We start with read-only: it is safe and already useful.

| Tool | What | Type |
| --- | --- | --- |
| `list_projects`, `list_agents` | The world, projects, quarters, agents, their status | read |
| `get_attention` | What is waiting for the person: questions, finished turns, problems | read |
| `read_conversation` | An agent's conversation, size-limited | read |
| `read_memory` | Project, quarter and agent memory | read |
| `get_agent_history` | An agent's commits by turn | read |
| `get_usage` | Plan quotas | read |
| `send_message` | A message to an agent (spends quota) | write, confirmed |
| `answer_question` | An answer to an agent's question | write, confirmed |
| `propose_memory` | Propose a memory document; the person approves it in Atlas | proposal |
| `create_task` | Give a desk agent a task under the contract | write, confirmed |
| `steer`, `interrupt` | Steer a turn or stop it | write, confirmed |

Resources: memory documents, conversations (size-limited), and the attention
feed with change subscriptions (`subscriptions/listen`).

### Confirming writes

- An external write is never performed silently. The server replies
  `input_required` (the Multi Round-Trip Requests pattern). The person sees
  the request in Atlas, with the client name and the exact text of the
  action, and confirms it in a trusted host window. The client repeats the
  request and gets the result. Long actions, such as an agent turn, are
  modeled as a task (the tasks extension).
- **Client permissions** are granted in Atlas: read-only (the default), read
  and propose, write with confirmation. Permissions can be revoked.
- Every action that came through MCP goes into the operation journal with
  the client's identifier. Receipts work as for other operations.
- Memory can only be proposed through MCP. Approval always happens in Atlas,
  by the SHA-256 of the text, as today.

### Connecting a client

`agents-factory mcp add-to <client>` writes the client's configuration itself
and shows exactly what it wrote:

| Client | What is done |
| --- | --- |
| Claude Code | `claude mcp add agents-factory -- agents-factory mcp serve` |
| Claude Desktop | a `.mcpb` extension (MCP Bundle, formerly DXT): one-click install from the Extensions settings |
| Codex CLI | a `[mcp_servers.agents-factory]` section in `~/.codex/config.toml` |
| Cursor | `.cursor/mcp.json` |

### Publishing

- **Official MCP Registry:** `server.json` at the root of the public
  repository, name `io.github.alexkhutor/agents-factory`, published with
  `mcp-publisher` using GitHub sign-in. The registry stores only metadata and
  is still in preview.
- **A `.mcpb` bundle** in every GitHub release.
- This is part of the project's visibility to agents and LLMs: they search
  the MCP registry.

## C. Team tools for any provider

Today the task tools (`desk`) work only for agents on the Claude Agent SDK:
they are an in-process SDK server. The roadmap has Codex CLI agents and local
agents (DeepSeek, Hermes, Qoder). They do not have our SDK, but they support
MCP.

- Move the team tools into a Gateway MCP server shared by all providers:
  - tasks: accept, plan, progress, report;
  - memory: read, propose;
  - a question to the person;
  - a question to another agent, with confirmation.
- Claude agents get it as today, in-process. The others get it through the
  stdio command `agents-factory mcp serve --agent <id>` with that agent's own
  token: the server knows whose turn it is and is limited to that agent's
  zone and role.
- Then adding a new provider means running its agent with our MCP server, not
  porting the tools to its API.

## Stages

1. **B, read-only** + `mcp add-to` for Claude Code and Codex CLI + an entry
   in the MCP Registry. Little code, immediate value and visibility.
2. **A:** catalog, levels, secrets in the system credential store, the
   "Tools" tab, `.mcp.json` import.
3. **B, writes** with confirmation in Atlas and client permissions; `.mcpb`
   for Claude Desktop.
4. **C:** team tools as a shared MCP server, the first non-Claude provider
   (Codex CLI).

## Risks

| Risk | What we do |
| --- | --- |
| Prompt injection through MCP responses | responses are untrusted text; writes go only through permissions and confirmations; tool descriptions pinned by hash |
| Secret leaks | system credential store only; masking in logs (as tokens in command output are already masked); never in memory or conversations |
| Someone else's code in stdio servers | connect only explicitly, showing the command; `.mcp.json` import needs confirmation |
| Quota | sending through MCP is a separate permission and confirmation; quotas visible in `get_usage` |
| Network access | HTTP only on loopback, with a client token; never on the network by default |
| Specification changes | official MCP SDK, tests for both protocol versions |
