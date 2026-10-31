import path from "node:path";

import { createWriteZone, readOnlyShellCommand } from "./agent-write-zone.mjs";
import { ACP_FILE_TOOLS, ACP_SHELL_TOOLS } from "./acp-session-host.mjs";

// What the desk decides itself when an ACP agent (DeepSeek Harness with
// dsh-desk-gate-plugin.mjs) asks before writing a file or running a command
// (plan A2b). The answer is the policy acp-session-host.mjs startTurn takes:
//   - a file write inside the agent's write zone is allowed, outside it refused;
//     an agent without a zone may write inside its project folder, and a write
//     elsewhere goes to the person;
//   - a command that only reads (readOnlyShellCommand) is allowed; one that
//     names a port in `forbiddenPorts` is refused; any other goes to the person;
//   - anything else goes to the person.
// Reading is never asked about: the gate asks only for writing tools.

export const ACP_DESK_POLICY_VERSION = "v0.1.0";

const PORT = (port) => new RegExp(`(?:^|[^0-9])${port}(?:[^0-9]|$)`, "u");

/**
 * `forbiddenPorts`: ports a command must not name (the inZOI game and ModKit
 * MCP servers, which agents reach only through the tier gateway).
 */
export function createAcpDeskPolicy({ forbiddenPorts = [], platform = process.platform } = {}) {
  const ports = forbiddenPorts.map((port) => PORT(String(Number(port))));
  return ({ root, zone }) => {
    const zoneCheck = Array.isArray(zone) && zone.length > 0 ? createWriteZone({ root, patterns: zone, platform }) : null;
    const folderCheck = createWriteZone({ root, patterns: ["**"], platform });
    return async ({ tool, input, cwd }) => {
      if (ACP_FILE_TOOLS.has(tool)) {
        const target = input?.[ACP_FILE_TOOLS.get(tool)];
        if (typeof target !== "string" || target.trim() === "") return "deny";
        // A relative path is the agent's: from its working directory, which is the project folder.
        const file = path.resolve(cwd ?? root, target);
        if (zoneCheck !== null) return zoneCheck.check(file).allowed ? "allow" : "deny";
        return folderCheck.check(file).allowed ? "allow" : "ask";
      }
      if (ACP_SHELL_TOOLS.has(tool)) {
        const command = typeof input?.command === "string" ? input.command : "";
        if (ports.some((port) => port.test(command))) return "deny";
        return readOnlyShellCommand(command, { powershell: tool === "pwsh" }) ? "allow" : "ask";
      }
      return "ask";
    };
  };
}
