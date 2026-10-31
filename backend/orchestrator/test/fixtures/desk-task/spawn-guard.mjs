import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

// A guard against PowerShell: every way node:child_process starts a program
// is wrapped, and a start of powershell(.exe) or pwsh(.exe) is refused with
// an error and recorded. Loaded with `node --import` into a child process, it
// records into the file named by DESK_TASK_SPAWN_GUARD_LOG; imported by a
// test, `installSpawnGuard()` records into the returned list.

const POWERSHELL = /^(powershell|pwsh)(\.exe)?$/iu;

function isPowerShell(file, args) {
  const program = path.basename(String(file ?? "")).trim();
  if (POWERSHELL.test(program)) return true;
  // A shell line ("cmd /c powershell ...", exec("powershell ...")).
  const line = [file, ...(Array.isArray(args) ? args : [])].map(String).join(" ");
  return /(^|[\s"'\\/])(powershell|pwsh)(\.exe)?([\s"']|$)/iu.test(line) && /^(cmd(\.exe)?|.*sh)$/iu.test(program);
}

let installed = null;

export function installSpawnGuard({ log = process.env.DESK_TASK_SPAWN_GUARD_LOG } = {}) {
  if (installed) return installed;
  const attempts = [];
  const refuse = (name, file, args) => {
    const record = `${name}: ${[file, ...(Array.isArray(args) ? args : [])].join(" ")}`;
    attempts.push(record);
    if (log) appendFileSync(log, `${record}\n`);
    throw Object.assign(new Error(`PowerShell is not allowed here (${record})`), { code: "POWERSHELL_SPAWNED" });
  };
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
    const original = childProcess[name];
    childProcess[name] = function guarded(file, args, ...rest) {
      if (isPowerShell(file, args)) refuse(name, file, args);
      return original.call(this, file, args, ...rest);
    };
  }
  for (const name of ["exec", "execSync"]) {
    const original = childProcess[name];
    childProcess[name] = function guarded(command, ...rest) {
      if (/(^|[\s"'\\/])(powershell|pwsh)(\.exe)?([\s"']|$)/iu.test(String(command))) refuse(name, command, []);
      return original.call(this, command, ...rest);
    };
  }
  // Modules that imported { spawn } from "node:child_process" see the guarded functions.
  syncBuiltinESMExports();
  installed = attempts;
  return attempts;
}

if (process.env.DESK_TASK_SPAWN_GUARD_LOG) installSpawnGuard();
