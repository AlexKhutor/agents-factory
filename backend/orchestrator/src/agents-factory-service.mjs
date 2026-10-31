import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { defaultExecutor, fail, pathKind, quoteWindowsArgument, windowsCommandLine } from "./agents-factory-common.mjs";
import { pathApi } from "./agents-factory-paths.mjs";

// Start the Gateway when the person logs on, without administrator rights:
//
// - Windows: a Task Scheduler task with a logon trigger for this user only,
//   running as this user with the interactive token and least privilege
//   (`schtasks /Create /XML`). Elevation is needed only for tasks of all users,
//   other accounts or highest privileges; a task of one's own logon is not.
//   Where a policy forbids task creation, the HKCU Run key is the fallback: it
//   needs no rights at all but cannot delay or be inspected as a task.
// - macOS: a LaunchAgent in ~/Library/LaunchAgents (loaded at the next login).
// - Linux: a `systemd --user` unit, enabled for default.target.
//
// The service runs `agents-factory gateway start` (detached monitor and
// Gateway, then exits); systemd's ExecStop runs `gateway stop`. Every effect
// goes through `executor.run` and the file functions, so tests and --plan-only
// never touch the machine's registrations.

export const SERVICE_MECHANISMS = Object.freeze(["task-scheduler", "hkcu-run", "launch-agent", "systemd-user"]);
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const UNSAFE_FOR_CMD = /["%^&|<>!\r\n]/u;

export function serviceIdentity(instanceDir, platform = process.platform) {
  const normalized = platform === "win32" ? instanceDir.toLowerCase() : instanceDir;
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 10);
  return {
    hash,
    windowsName: `AgentsFactory-Gateway-${hash}`,
    launchdLabel: `com.agentsfactory.gateway.${hash}`,
    systemdUnit: `agents-factory-gateway-${hash}.service`,
  };
}

function xml(value) {
  return String(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function systemdQuote(value) {
  const text = String(value);
  if (/[\r\n]/u.test(text)) fail("service_path_unsupported", "A path has a line break", { exitCode: 2 });
  return `"${text.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"").replace(/%/gu, "%%").replace(/\$/gu, "$$$$")}"`;
}

/**
 * The command the service runs. `electron` means the Node runtime is Electron's
 * and needs ELECTRON_RUN_AS_NODE=1, which a Task or Run entry cannot set: on
 * Windows it goes through cmd.exe then.
 */
export function serviceCommand({ nodePath, cliPath, instanceDir, provider = "claude", electron = false }) {
  const args = [cliPath, "gateway", "start", "--instance", instanceDir, "--provider", provider, "--json"];
  return { nodePath, args, electron };
}

function windowsAction(command, env) {
  if (!command.electron) return { file: command.nodePath, args: command.args };
  for (const value of [command.nodePath, ...command.args]) {
    if (UNSAFE_FOR_CMD.test(value)) fail("service_path_unsupported", "A path has characters cmd.exe cannot pass safely", { exitCode: 2 });
  }
  const cmd = path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "cmd.exe");
  const inner = [command.nodePath, ...command.args].map((value) => `"${value}"`).join(" ");
  return { file: cmd, args: ["/d", "/c", `set ELECTRON_RUN_AS_NODE=1&& ${inner}`], verbatim: true };
}

export function windowsTaskXml({ name, action, userId, workingDirectory, description }) {
  const argumentsText = action.verbatim ? action.args.join(" ") : action.args.map(quoteWindowsArgument).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(description)}</Description>
    <URI>\\${xml(name)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(userId)}</UserId>
      <Delay>PT15S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(action.file)}</Command>
      <Arguments>${xml(argumentsText)}</Arguments>
      <WorkingDirectory>${xml(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function launchAgentPlist({ label, command, workingDirectory, logFile }) {
  const strings = [command.nodePath, ...command.args].map((value) => `    <string>${xml(value)}</string>`).join("\n");
  const environment = command.electron ? `
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
  </dict>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logFile)}</string>${environment}
</dict>
</plist>
`;
}

export function systemdUnit({ command, workingDirectory, instanceDir }) {
  const start = [command.nodePath, ...command.args].map(systemdQuote).join(" ");
  const stopArgs = [command.args[0], "gateway", "stop", "--instance", instanceDir, "--json"];
  const stop = [command.nodePath, ...stopArgs].map(systemdQuote).join(" ");
  return `[Unit]
Description=Agents Factory Gateway (${instanceDir.replace(/[\r\n]/gu, " ")})

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${systemdQuote(workingDirectory)}
${command.electron ? "Environment=ELECTRON_RUN_AS_NODE=1\n" : ""}ExecStart=${start}
ExecStop=${stop}
TimeoutStartSec=180
TimeoutStopSec=90

[Install]
WantedBy=default.target
`;
}

const realFiles = Object.freeze({
  async write(file, content, encoding) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, encoding === "utf16le" ? { encoding: null } : { encoding: "utf8" });
  },
  async remove(file) { await rm(file, { force: true }); },
  async read(file) { return readFile(file, "utf8").catch(() => null); },
  async exists(file) { return (await pathKind(file)) === "file"; },
});

function utf16(content) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]);
}

export function createServiceManager({
  platform = process.platform, env = process.env, homeDir = os.homedir(), executor = defaultExecutor,
  files = realFiles, layout, userId = null, uid = null,
}) {
  const api = pathApi(platform);
  const identity = serviceIdentity(layout.instanceDir, platform);
  const windowsUser = userId ?? `${env.USERDOMAIN ? `${env.USERDOMAIN}\\` : ""}${env.USERNAME ?? os.userInfo().username}`;
  const launchdUid = uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const plistPath = api.join(homeDir, "Library", "LaunchAgents", `${identity.launchdLabel}.plist`);
  const configHome = env.XDG_CONFIG_HOME && api.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : api.join(homeDir, ".config");
  const unitPath = api.join(configHome, "systemd", "user", identity.systemdUnit);
  const schtasks = api.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "schtasks.exe");
  const reg = api.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "reg.exe");

  function windowsTaskPlan(command) {
    const action = windowsAction(command, env);
    const content = windowsTaskXml({ name: identity.windowsName, action, userId: windowsUser, workingDirectory: layout.instanceDir,
      description: `${identity.windowsName} starts the Agents Factory Gateway of ${layout.instanceDir} at logon` });
    const xmlFile = api.join(layout.serviceDir, `${identity.windowsName}.xml`);
    return {
      mechanism: "task-scheduler", name: identity.windowsName, userId: windowsUser,
      actions: [
        { kind: "write-file", path: xmlFile, encoding: "utf16le", content },
        { kind: "run", file: schtasks, args: ["/Create", "/TN", identity.windowsName, "/XML", xmlFile, "/F"] },
        { kind: "remove-file", path: xmlFile },
      ],
    };
  }

  function runKeyPlan(command) {
    const action = windowsAction(command, env);
    const value = action.verbatim ? `${quoteWindowsArgument(action.file)} ${action.args.join(" ")}`
      : windowsCommandLine(action.file, action.args);
    return {
      mechanism: "hkcu-run", name: identity.windowsName, commandLine: value,
      ...(value.length > 260 ? { warning: "run_command_long" } : {}),
      actions: [{ kind: "run", file: reg, args: ["add", RUN_KEY, "/v", identity.windowsName, "/t", "REG_SZ", "/d", value, "/f"] }],
    };
  }

  function launchAgentPlan(command) {
    const content = launchAgentPlist({ label: identity.launchdLabel, command, workingDirectory: layout.instanceDir,
      logFile: api.join(layout.instanceDir, "logs", "agents-factory-service.log") });
    return { mechanism: "launch-agent", name: identity.launchdLabel, path: plistPath,
      actions: [{ kind: "write-file", path: plistPath, encoding: "utf8", content }] };
  }

  function systemdPlan(command) {
    const content = systemdUnit({ command, workingDirectory: layout.instanceDir, instanceDir: layout.instanceDir });
    return { mechanism: "systemd-user", name: identity.systemdUnit, path: unitPath,
      actions: [
        { kind: "write-file", path: unitPath, encoding: "utf8", content },
        { kind: "run", file: "systemctl", args: ["--user", "daemon-reload"] },
        { kind: "run", file: "systemctl", args: ["--user", "enable", identity.systemdUnit] },
      ] };
  }

  async function perform(plan) {
    const cleanup = plan.actions.filter((action) => action.kind === "remove-file");
    try {
      for (const action of plan.actions) {
        if (action.kind === "write-file") {
          await files.write(action.path, action.encoding === "utf16le" ? utf16(action.content) : action.content, action.encoding);
        } else if (action.kind === "run") {
          const result = await executor.run(action.file, action.args, { env, timeoutMs: 60_000 });
          if (result.status !== 0) {
            return { ok: false, status: result.status, errorCode: result.errorCode ?? null,
              accessDenied: /access is denied|0x80070005|denied/iu.test(`${result.stdout}
${result.stderr}`) };
          }
        }
      }
      return { ok: true };
    } finally {
      for (const action of cleanup) await files.remove(action.path).catch(() => {});
    }
  }

  function plansFor(command, mechanism) {
    if (platform === "win32") {
      if (mechanism === "hkcu-run") return [runKeyPlan(command)];
      if (mechanism === "task-scheduler") return [windowsTaskPlan(command)];
      return [windowsTaskPlan(command), runKeyPlan(command)];
    }
    if (platform === "darwin") return [launchAgentPlan(command)];
    if (platform === "linux") return [systemdPlan(command)];
    return fail("service_platform_unsupported", `No user service for ${platform}`);
  }

  async function status() {
    if (platform === "win32") {
      const task = await executor.run(schtasks, ["/Query", "/TN", identity.windowsName, "/XML"], { env, timeoutMs: 30_000 });
      const run = await executor.run(reg, ["query", RUN_KEY, "/v", identity.windowsName], { env, timeoutMs: 30_000 });
      const mechanisms = [];
      if (task.status === 0) mechanisms.push("task-scheduler");
      if (run.status === 0) mechanisms.push("hkcu-run");
      return { installed: mechanisms.length > 0, mechanism: mechanisms[0] ?? null, mechanisms, name: identity.windowsName };
    }
    if (platform === "darwin") {
      const present = await files.exists(plistPath);
      const loaded = await executor.run("/bin/launchctl", ["print", `gui/${launchdUid}/${identity.launchdLabel}`], { env, timeoutMs: 30_000 });
      return { installed: present, mechanism: present ? "launch-agent" : null, mechanisms: present ? ["launch-agent"] : [],
        name: identity.launchdLabel, path: plistPath, loaded: loaded.status === 0 };
    }
    const present = await files.exists(unitPath);
    const enabled = await executor.run("systemctl", ["--user", "is-enabled", identity.systemdUnit], { env, timeoutMs: 30_000 });
    return { installed: present, mechanism: present ? "systemd-user" : null, mechanisms: present ? ["systemd-user"] : [],
      name: identity.systemdUnit, path: unitPath, enabled: enabled.status === 0 && enabled.stdout.trim() === "enabled" };
  }

  return Object.freeze({
    identity,
    plan(command, { mechanism = "auto" } = {}) {
      const plans = plansFor(command, mechanism);
      return { command: "service install", planOnly: true, platform, primary: plans[0],
        fallback: plans[1] ?? null, activatesAt: "next-logon" };
    },
    async install(command, { mechanism = "auto" } = {}) {
      const plans = plansFor(command, mechanism);
      let fallbackFrom = null;
      for (const [index, plan] of plans.entries()) {
        const outcome = await perform(plan);
        if (outcome.ok) {
          return { command: "service install", platform, installed: true, mechanism: plan.mechanism, name: plan.name,
            path: plan.path ?? null, activatesAt: "next-logon", fallbackFrom,
            commandLine: [command.nodePath, ...command.args] };
        }
        // Only a refusal of the task registration falls back to the Run key.
        if (index + 1 < plans.length && plan.mechanism === "task-scheduler") {
          fallbackFrom = { mechanism: plan.mechanism, status: outcome.status, accessDenied: outcome.accessDenied };
          continue;
        }
        fail("service_install_failed", `${plan.mechanism} registration failed`,
          { detail: { mechanism: plan.mechanism, status: outcome.status, errorCode: outcome.errorCode } });
      }
      return fail("service_install_failed", "No registration succeeded");
    },
    async uninstall({ planOnly = false } = {}) {
      const actions = [];
      if (platform === "win32") {
        actions.push({ kind: "run", file: schtasks, args: ["/Delete", "/TN", identity.windowsName, "/F"], present: "task-scheduler" });
        actions.push({ kind: "run", file: reg, args: ["delete", RUN_KEY, "/v", identity.windowsName, "/f"], present: "hkcu-run" });
      } else if (platform === "darwin") {
        actions.push({ kind: "run", file: "/bin/launchctl", args: ["bootout", `gui/${launchdUid}/${identity.launchdLabel}`], optional: true });
        actions.push({ kind: "remove-file", path: plistPath });
      } else {
        actions.push({ kind: "run", file: "systemctl", args: ["--user", "disable", identity.systemdUnit], present: "systemd-user" });
        actions.push({ kind: "remove-file", path: unitPath });
        actions.push({ kind: "run", file: "systemctl", args: ["--user", "daemon-reload"], optional: true });
      }
      if (planOnly) return { command: "service uninstall", planOnly: true, platform, actions };
      const before = await status();
      for (const action of actions) {
        if (action.kind === "remove-file") {
          await files.remove(action.path);
          continue;
        }
        if (action.present && !before.mechanisms.includes(action.present)) continue;
        const result = await executor.run(action.file, action.args, { env, timeoutMs: 60_000 });
        if (result.status !== 0 && !action.optional) {
          fail("service_uninstall_failed", `${path.basename(action.file)} could not remove the registration`,
            { detail: { status: result.status } });
        }
      }
      return { command: "service uninstall", platform, removed: before.installed, mechanisms: before.mechanisms, name: before.name };
    },
    async status() {
      return { command: "service status", platform, ...(await status()) };
    },
  });
}
