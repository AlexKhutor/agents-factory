import path from "node:path";

// What no agent reads or changes: logins, keys, tokens, the Gateway's connection and the folders that keep
// them (roadmap step 1, track B). Checked before every tool call of every agent, with or without a write
// zone: claudeSecretHook for Claude Code, the ACP host's permission gate for ACP agents.
//
// It goes by names, not by places: these files are secrets wherever they lie. A project's own
// `.project-local` is its own; any other is an instance's (logins, the Gateway's connection). A shell
// command is checked by the paths it names and by whether it prints the environment (where a provider's
// key may be): a command can always hide a name, so this stops the plain and the accidental cases, and
// secrets still belong outside the agents' folders.

export const AGENT_SECRET_PATHS_VERSION = "v0.1.0";

/** File names that hold a login, a key or a token. */
const SECRET_FILES = new Set([".credentials.json", ".claude.json", "connection.v1.json", ".git-credentials", ".netrc",
  "_netrc", ".npmrc", ".pypirc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const SECRET_SUFFIXES = [".dpapi.json", ".pfx", ".p12", ".kdbx"];
/** Folders that keep them: the toolkit's runtime, secret stores, SSH and cloud logins. */
const SECRET_FOLDERS = new Set([".project-runtime", "secrets", ".secrets", ".ssh", ".gnupg", ".aws", ".azure", ".kube",
  ".docker", ".password-store"]);
const INSTANCE_LOCAL = ".project-local";
// `.env`, `.env.local`; not `.env.example` and its kin.
const ENV_FILE = /^\.env(?:\.(?!example$|sample$|template$|dist$)[^.]+)?$/u;
// A data file named for what it keeps: work-qwen-api-key.txt, github-token.json, secrets.yaml (not tokens.json,
// the design tokens of a UI, and not source code such as password-reset.mjs).
const KEPT_WORD = /(?:^|[-_.])(?:api[-_]?keys?|secrets?|passwords?|credentials?)(?=[-_.]|$)|[-_](?:access[-_]?|auth[-_]?)?tokens?(?=[-_.]|$)/u;
const DATA_FILE = /\.(?:txt|json|ya?ml|toml|ini|cfg|conf|key|env)$|^[^.]+$/u;
const WILDCARD = /[*?[]/u;

/** Why a file name is a secret, or null. */
function secretName(name) {
  if (SECRET_FILES.has(name)) return "a login or key file";
  if (SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix))) return "a key file";
  if (ENV_FILE.test(name)) return "an environment file with keys";
  if (KEPT_WORD.test(name) && DATA_FILE.test(name)) return "a file named for a key or password";
  return null;
}

/** A name with wildcards that would match a secret file or folder: `.cred*`, `id_*`, `*.dpapi.json`, `.ss?`. */
function wildcardSecret(segment) {
  const first = segment.search(WILDCARD);
  if (first === -1) return null;
  const prefix = segment.slice(0, first);
  const suffix = segment.slice(Math.max(segment.lastIndexOf("*"), segment.lastIndexOf("?"), segment.lastIndexOf("]")) + 1);
  const names = [...SECRET_FILES, ".env", ...SECRET_FOLDERS, INSTANCE_LOCAL];
  if (prefix.length >= 2 && names.some((name) => name.startsWith(prefix))) return "a pattern that names secret files";
  if (SECRET_SUFFIXES.some((known) => suffix.endsWith(known))
      || (suffix.length >= 8 && [...SECRET_FILES].some((name) => name.endsWith(suffix)))) return "a pattern that names secret files";
  return null;
}

const segmentsOf = (text) => text.split(/[\\/]+/u).filter(Boolean).map((segment) => segment.toLowerCase());

/**
 * Why `file` is a secret (a few words), or null. `root`: the agent's folder - a relative path is taken from
 * it, and a `.project-local` inside it is the project's own.
 */
export function secretPathReason(file, { root = null, platform = process.platform } = {}) {
  if (typeof file !== "string" || file.trim() === "") return null;
  const api = platform === "win32" ? path.win32 : path.posix;
  const text = file.trim();
  const segments = segmentsOf(root === null || text.startsWith("~") ? text : api.resolve(root, text));
  const own = root === null ? null : `${segmentsOf(api.resolve(root)).join("/")}/`;
  for (const [index, segment] of segments.entries()) {
    if (SECRET_FOLDERS.has(segment)) return `inside ${segment}`;
    if (segment === INSTANCE_LOCAL && (own === null || !segments.slice(0, index + 1).join("/").startsWith(own))) {
      return "inside an instance's .project-local";
    }
    const named = index === segments.length - 1 ? secretName(segment) ?? wildcardSecret(segment) : wildcardSecret(segment);
    if (named !== null) return named;
  }
  return null;
}

// --- shell commands ---------------------------------------------------------------------------

// A variable named for a key: ANTHROPIC_API_KEY, GITHUB_TOKEN, DB_PASSWORD (not MONKEY or KEYBOARD_LAYOUT).
const SECRET_VARIABLE = /(?:^|_)(?:KEYS?|TOKENS?|SECRETS?|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)/iu;
const VARIABLE_READ = /(?:\$\{?(?:env:)?|(?<![\w$])env:)([A-Za-z_][A-Za-z0-9_]*)/giu;

/** The words of a command, quotes taken off, split where a shell or an option would split a path. */
function wordsOf(command) {
  const words = [];
  for (const match of command.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|([^\s'"]+)/gu)) {
    const word = match[1] ?? match[2] ?? match[3];
    for (const part of word.split(/[=,;|&<>()]+/u)) if (part !== "") words.push(part);
  }
  return words;
}

/** A word meant as a path: a separator, a dot, a home or a wildcard - and not a web address. */
const pathLike = (word) => !word.includes("://") && (/[\\/.~*?]/u.test(word) || SECRET_FILES.has(word.toLowerCase()));

/** Whether one part of a command (no `|`, `;`, `&&`) prints the environment. */
function printsEnvironment(words, powershell) {
  const program = words[0].replace(/\.exe$/iu, "").toLowerCase();
  const rest = words.slice(1);
  // env with a program after its options and assignments runs that program; alone it prints.
  if (program === "env") return rest.every((word) => word.startsWith("-") || word.includes("="));
  if (program === "printenv") return rest.length === 0 || rest.some((word) => SECRET_VARIABLE.test(word));
  if (powershell) return false;
  if (["set", "declare", "typeset"].includes(program) && rest.length === 0) return true;
  return ["export", "declare", "typeset"].includes(program) && rest.some((word) => /^-[a-z]*[px]/u.test(word));
}

/**
 * Why a shell command would read a secret, or null: it names a secret path, or prints the environment
 * (`env`, `printenv`, `set`, `export -p`, PowerShell's `env:` drive) or a variable named for a key.
 */
export function secretCommandReason(command, { root = null, platform = process.platform, powershell = false } = {}) {
  if (typeof command !== "string" || command.trim() === "") return null;
  if (/\/proc\/[^\s/]+\/environ/u.test(command) || /GetEnvironmentVariables\b/iu.test(command)
      || /(?:^|[\s'"(])env:[\\/]?\*?(?=$|[\s'")|;])/imu.test(command)) return "it prints the environment";
  for (const variable of command.matchAll(VARIABLE_READ)) {
    if (SECRET_VARIABLE.test(variable[1])) return `it reads the variable ${variable[1]}`;
  }
  for (const call of command.matchAll(/GetEnvironmentVariable\s*\(\s*['"]([^'"]+)['"]/giu)) {
    if (SECRET_VARIABLE.test(call[1])) return `it reads the variable ${call[1]}`;
  }
  for (const part of command.split(/&&|\|\||;|\||\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
    if (printsEnvironment(part.split(/\s+/u), powershell)) return "it prints the environment";
  }
  for (const word of wordsOf(command)) {
    if (!pathLike(word)) continue;
    const reason = secretPathReason(word, { root, platform });
    if (reason !== null) return `it names "${word}" (${reason})`;
  }
  return null;
}

// --- tool calls -------------------------------------------------------------------------------

/** Claude Code's tools that name a path, and the input fields that do. */
export const CLAUDE_PATH_FIELDS = Object.freeze(new Map([
  ["Read", ["file_path"]], ["Edit", ["file_path"]], ["MultiEdit", ["file_path"]], ["Write", ["file_path"]],
  ["NotebookRead", ["notebook_path"]], ["NotebookEdit", ["notebook_path"]], ["Grep", ["path", "glob"]],
  ["Glob", ["path"]], ["LS", ["path"]],
]));
/** Claude Code's shell tools, and whether each is PowerShell. */
export const CLAUDE_SHELLS = Object.freeze(new Map([["Bash", false], ["PowerShell", true]]));

/**
 * Why a tool call would reach a secret, or null. `fields`: tool name -> the input fields naming paths;
 * `shells`: tool name -> whether it is PowerShell.
 */
export function secretToolReason({ tool, input, root = null, platform = process.platform, fields, shells }) {
  const args = input && typeof input === "object" ? input : {};
  if (shells.has(tool)) return secretCommandReason(args.command, { root, platform, powershell: shells.get(tool) });
  for (const field of fields.get(tool) ?? []) {
    const reason = secretPathReason(args[field], { root, platform });
    if (reason !== null) return `"${args[field]}" is ${reason}`;
  }
  return null;
}

// --- web fetches ------------------------------------------------------------------------------

/**
 * Addresses an agent may fetch without asking when the provider config names none (`webFetchHosts`):
 * documentation and code hosts. A listed host covers its subdomains. Anything else may be where a
 * prompt injected into what the agent read sends the data it found, so the person decides.
 */
export const DEFAULT_WEB_FETCH_HOSTS = Object.freeze(["docs.anthropic.com", "docs.claude.com", "code.claude.com",
  "github.com", "raw.githubusercontent.com", "developer.mozilla.org", "nodejs.org", "npmjs.com", "pypi.org",
  "docs.python.org", "learn.microsoft.com", "stackoverflow.com"]);

/** Whether `url` is an http(s) address on one of `hosts` (or a subdomain of one). */
export function knownWebHost(url, hosts = DEFAULT_WEB_FETCH_HOSTS) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return false; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  return hosts.some((known) => host === known || host.endsWith(`.${known}`));
}

/** Claude Code's PreToolUse hook that asks the person before a WebFetch to an address not on the list. */
export function claudeWebFetchHook({ hosts = DEFAULT_WEB_FETCH_HOSTS } = {}) {
  return async (input) => {
    if (input?.tool_name !== "WebFetch") return {};
    const url = input?.tool_input?.url;
    if (knownWebHost(url, hosts)) return {};
    let shown = String(url ?? "").slice(0, 200);
    try { shown = new URL(String(url)).origin; } catch { /* shown as written */ }
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask",
      permissionDecisionReason: `The agent wants to fetch ${shown}, an address not on this instance's list (claude-provider.json webFetchHosts). Whatever the address carries goes there: allow it only if you expect it.` } };
  };
}

/**
 * Claude Code's PreToolUse hook that keeps every agent off secrets, in every permission mode (a mode hands
 * over the person's questions, not the secrets). Its refusal is what the agent reads.
 */
export function claudeSecretHook({ root, platform = process.platform }) {
  return async (input) => {
    const reason = secretToolReason({ tool: input?.tool_name, input: input?.tool_input, root, platform,
      fields: CLAUDE_PATH_FIELDS, shells: CLAUDE_SHELLS });
    if (reason === null) return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: `Refused: ${reason}. Agents do not read or change logins, keys or tokens. If the work needs one, say so in your answer and the person will do that step.` } };
  };
}
