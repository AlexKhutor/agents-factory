import { execFile } from "node:child_process";

// Which processes hold a file open on Windows, from the Restart Manager
// (RmGetList): what the Gateway records when it cannot replace its status file
// (EPERM/EBUSY on rename), so the reader that blocks it can be named. A
// diagnostic only: it never changes what the Gateway does, and any failure
// gives an empty answer.

export const WINDOWS_FILE_LOCKERS_VERSION = "v0.1.0";

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AfLockers {
  [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)] public struct RM_UNIQUE_PROCESS { public int Pid; public FILETIME Start; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceShortName;
    public int AppType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool Restartable; }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int f, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nf, string[] files, uint na, IntPtr a, uint ns, string[] s);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
  public static int[] Pids(string file) {
    uint h; if (RmStartSession(out h, 0, Guid.NewGuid().ToString()) != 0) return new int[0];
    try {
      if (RmRegisterResources(h, 1, new string[] { file }, 0, IntPtr.Zero, 0, null) != 0) return new int[0];
      uint needed = 0, count = 0, reasons = 0;
      int r = RmGetList(h, out needed, ref count, null, ref reasons);
      if (r != 234 || needed == 0) return new int[0];
      var info = new RM_PROCESS_INFO[needed]; count = needed;
      if (RmGetList(h, out needed, ref count, info, ref reasons) != 0) return new int[0];
      var pids = new int[count]; for (int i = 0; i < count; i++) pids[i] = info[i].Process.Pid; return pids;
    } finally { RmEndSession(h); }
  }
}
'@
$out = @()
foreach ($procId in [AfLockers]::Pids($env:AF_LOCK_FILE)) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
  $cmd = if ($p -and $p.CommandLine) { $p.CommandLine.Substring(0, [Math]::Min(200, $p.CommandLine.Length)) } else { '' }
  $out += [pscustomobject]@{ pid = $procId; name = if ($p) { $p.Name } else { '' }; parentPid = if ($p) { $p.ParentProcessId } else { 0 }; commandLine = $cmd }
}
ConvertTo-Json -InputObject @($out) -Compress
`;

/** The processes holding `file` open: [{ pid, name, parentPid, commandLine }], or [] when unknown. */
export function listWindowsFileLockers(file, { timeoutMs = 15_000 } = {}) {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
      { windowsHide: true, timeout: timeoutMs, encoding: "utf8", env: { ...process.env, AF_LOCK_FILE: String(file) } },
      (error, stdout) => {
        if (error) { resolve([]); return; }
        try {
          const parsed = JSON.parse(String(stdout).trim() || "[]");
          resolve((Array.isArray(parsed) ? parsed : [parsed]).slice(0, 16));
        } catch { resolve([]); }
      });
  });
}
