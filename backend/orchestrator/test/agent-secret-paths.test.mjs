import assert from "node:assert/strict";
import test from "node:test";

import {
  claudeSecretHook, claudeWebFetchHook, knownWebHost, secretCommandReason, secretPathReason,
} from "../src/agent-secret-paths.mjs";

// Roadmap step 1, track B: no agent reads or changes logins, keys or tokens, with or without a write zone.

const win = { root: "C:\\work\\mods", platform: "win32" };
const posix = { root: "/home/p/mods", platform: "linux" };

test("secret files and folders are refused wherever they lie; ordinary files are not", () => {
  for (const file of ["C:\\Users\\p\\.claude\\.credentials.json", "W:\\af\\instance\\.project-local\\claude-account\\.claude.json",
    "D:\\x\\application-gateway\\connection.v1.json", "E:\\models\\secrets\\model-api-key.txt", "~\\.ssh\\id_ed25519",
    "C:\\data\\secrets\\anything.md", "W:\\af-dev\\.project-runtime\\claude-accounts\\account1\\settings.json",
    "C:\\data\\anthropic-api-key.dpapi.json", ".env", "config\\.env.local", "deploy\\github-token.txt", "keys\\db_password.yaml",
    "C:\\Users\\p\\.aws\\config", "cert.pfx", "..\\other\\.project-local\\sync.json"]) {
    assert.notEqual(secretPathReason(file, win), null, file);
  }
  for (const file of ["src\\index.mjs", ".env.example", "design\\tokens.json", "src\\auth\\password-reset.mjs",
    "docs\\secret-sharing.md", ".claude\\settings.json", ".project-local\\notes.md", "C:\\work\\mods\\.project-local\\kit\\a.json",
    "README.md", "C:\\Users\\p\\Documents\\keyboard.txt"]) {
    assert.equal(secretPathReason(file, win), null, file);
  }
  assert.notEqual(secretPathReason("/home/p/.ssh/config", posix), null);
  assert.notEqual(secretPathReason("~/.netrc", posix), null);
  assert.equal(secretPathReason("lib/tokenizer.js", posix), null);
});

test("shell commands that name a secret or print the environment are refused", () => {
  for (const [command, powershell] of [
    ["cat ~/.claude/.credentials.json", false], ["type C:\\x\\.project-local\\application-gateway\\connection.v1.json", false],
    ["Get-Content \"E:\\models\\secrets\\model-api-key.txt\"", true], ["cat .cred*", false], ["ls ~/.ssh", false],
    ["grep -r sk- --include=*.dpapi.json .", false], ["env", false], ["env | grep KEY", false], ["printenv", false],
    ["printenv ANTHROPIC_API_KEY", false], ["echo $WORK_QWEN_API_KEY", false], ["echo ${GITHUB_TOKEN}", false],
    ["set", false], ["export -p", false], ["cat /proc/self/environ", false], ["Get-ChildItem env:", true],
    ["dir Env:\\", true], ["$env:WORK_QWEN_API_KEY", true], ["Get-Item env:ANTHROPIC_API_KEY", true],
    ["[Environment]::GetEnvironmentVariables()", true], ["[Environment]::GetEnvironmentVariable('DB_PASSWORD')", true],
  ]) {
    assert.notEqual(secretCommandReason(command, { ...win, powershell }), null, command);
  }
  for (const [command, powershell] of [
    ["git status", false], ["npm test", false], ["env NODE_ENV=test node build.mjs", false], ["echo $HOME $PATH", false],
    ["grep -rn password src/", false], ["set -e", false], ["$env:PATH", true], ["echo $MONKEY $KEYBOARD_LAYOUT", false],
    ["curl https://example.com/api/secrets", false], ["cat .env.example", false], ["ls .project-local", false],
    ["node scripts/tokens.mjs", false], ["Get-ChildItem src", true],
  ]) {
    assert.equal(secretCommandReason(command, { ...win, powershell }), null, command);
  }
});

test("the Claude Code hook refuses in every tool that names a path, and says what to do instead", async () => {
  const hook = claudeSecretHook(win);
  const refused = async (tool_name, tool_input) => (await hook({ tool_name, tool_input }))?.hookSpecificOutput?.permissionDecision === "deny";
  assert.equal(await refused("Read", { file_path: "C:\\Users\\p\\.claude\\.credentials.json" }), true);
  assert.equal(await refused("Write", { file_path: ".env" }), true);
  assert.equal(await refused("Grep", { pattern: "sk-ant", path: "C:\\Users\\p\\.ssh" }), true);
  assert.equal(await refused("Grep", { pattern: "x", glob: ".credentials.json" }), true);
  assert.equal(await refused("Glob", { pattern: "**/*", path: "W:\\af-dev\\.project-runtime" }), true);
  assert.equal(await refused("Bash", { command: "printenv" }), true);
  assert.equal(await refused("PowerShell", { command: "Get-ChildItem env:" }), true);
  assert.equal(await refused("Read", { file_path: "src\\app.js" }), false);
  assert.equal(await refused("Glob", { pattern: "**/*.json" }), false);
  assert.equal(await refused("WebSearch", { query: "api key rotation" }), false);
  const answer = await hook({ tool_name: "Read", tool_input: { file_path: "E:\\models\\secrets\\k.txt" } });
  assert.match(answer.hookSpecificOutput.permissionDecisionReason, /inside secrets.*say so in your answer/u);
});

test("a fetch from an address not on the list asks the person; known hosts and their subdomains do not", async () => {
  assert.equal(knownWebHost("https://docs.python.org/3/library/os.html"), true);
  assert.equal(knownWebHost("https://www.npmjs.com/package/x"), true);
  assert.equal(knownWebHost("https://github.com.evil.example/x"), false);
  assert.equal(knownWebHost("file:///C:/Users/p/.ssh/id_rsa"), false);
  assert.equal(knownWebHost("not a url"), false);
  const hook = claudeWebFetchHook();
  const decision = async (url) => (await hook({ tool_name: "WebFetch", tool_input: { url } }))?.hookSpecificOutput?.permissionDecision ?? "pass";
  assert.equal(await decision("https://nodejs.org/api/fs.html"), "pass");
  assert.equal(await decision("https://collect.example.net/?d=sk-ant-123"), "ask");
  assert.equal(await decision("http://127.0.0.1:8787/"), "ask");
  assert.deepEqual(await hook({ tool_name: "Read", tool_input: { file_path: "x" } }), {});
  // The instance's own list replaces the built-in one; an empty list asks every time.
  assert.equal(await (async () => (await claudeWebFetchHook({ hosts: ["intranet.example.com"] })({ tool_name: "WebFetch",
    tool_input: { url: "https://wiki.intranet.example.com/a" } })).hookSpecificOutput?.permissionDecision ?? "pass")(), "pass");
  assert.equal((await claudeWebFetchHook({ hosts: [] })({ tool_name: "WebFetch",
    tool_input: { url: "https://nodejs.org/" } })).hookSpecificOutput.permissionDecision, "ask");
});
