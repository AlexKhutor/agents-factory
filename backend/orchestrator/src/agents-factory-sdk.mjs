import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { fail, nowUtc, pathKind, readJsonFile, renameWithRetry, writeJsonAtomic } from "./agents-factory-common.mjs";
import { extractTarGz } from "./agents-factory-tar.mjs";

// The Claude Agent SDK without npm: registry metadata, the tarballs of the SDK,
// its platform package (the native `claude` program) and its required peers,
// each checked against the registry's sha512 integrity before a byte is
// unpacked, into <data>/runtime/claude-agent-sdk/<version>/node_modules. The
// layout is the one the Gateway expects: sdkPath is
// node_modules/@anthropic-ai/claude-agent-sdk and the program sits in the
// sibling claude-agent-sdk-<os>-<arch> (claude-code-sdk.mjs claudeProgramOf).

export const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
export const SDK_MANIFEST = "agents-factory-sdk.json";
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]{0,100}\/)?[a-z0-9][a-z0-9._-]{0,113}$/u;
const VERSION_DIR = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,64})?$/u;
const MAX_PACKAGES = 64;

// ---- semver: enough of npm's ranges for package manifests -----------------

export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(String(text).trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]),
    pre: match[4] ? match[4].split(".") : [] };
}

export function compareVersions(left, right) {
  const a = typeof left === "string" ? parseVersion(left) : left;
  const b = typeof right === "string" ? parseVersion(right) : right;
  for (const key of ["major", "minor", "patch"]) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : (a.pre.length === 0 ? 1 : -1);
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumber = /^\d+$/u.test(x);
    const yNumber = /^\d+$/u.test(y);
    if (xNumber && yNumber) return Number(x) < Number(y) ? -1 : 1;
    if (xNumber !== yNumber) return xNumber ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function partial(text) {
  const match = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(text);
  if (!match) return null;
  const number = (value) => (value === undefined || /^[xX*]$/u.test(value) ? null : Number(value));
  const major = number(match[1]);
  const minor = major === null ? null : number(match[2]);
  const patch = minor === null ? null : number(match[3]);
  return { major, minor, patch, pre: match[4] && patch !== null ? match[4].split(".") : [] };
}

const version = (major, minor, patch, pre = []) => ({ major, minor, patch, pre });
const ceiling = (major, minor, patch) => version(major, minor, patch, ["0"]);

function comparatorsOf(token) {
  const match = /^(>=|<=|>|<|=|\^|~>?)?(.*)$/u.exec(token);
  const operator = match[1] ?? "";
  const value = partial(match[2]);
  if (value === null) return null;
  const { major, minor, patch, pre } = value;
  if (major === null) return operator === "<" || operator === ">" ? [{ op: "<", v: version(0, 0, 0, ["0"]) }] : [];
  const low = version(major, minor ?? 0, patch ?? 0, pre);
  if (operator === "^") {
    if (major > 0 || minor === null) return [{ op: ">=", v: low }, { op: "<", v: ceiling(major + 1, 0, 0) }];
    if (minor > 0 || patch === null) return [{ op: ">=", v: low }, { op: "<", v: ceiling(0, minor + 1, 0) }];
    return [{ op: ">=", v: low }, { op: "<", v: ceiling(0, 0, patch + 1) }];
  }
  if (operator === "~" || operator === "~>") {
    if (minor === null) return [{ op: ">=", v: low }, { op: "<", v: ceiling(major + 1, 0, 0) }];
    return [{ op: ">=", v: low }, { op: "<", v: ceiling(major, minor + 1, 0) }];
  }
  const upperOfPartial = minor === null ? ceiling(major + 1, 0, 0) : ceiling(major, minor + 1, 0);
  if (operator === "" || operator === "=") {
    if (patch === null) return [{ op: ">=", v: low }, { op: "<", v: upperOfPartial }];
    return [{ op: "=", v: low }];
  }
  if (operator === ">=") return [{ op: ">=", v: low }];
  if (operator === "<") return [{ op: "<", v: patch === null ? version(major, minor ?? 0, 0, ["0"]) : low }];
  if (operator === ">") return patch === null ? [{ op: ">=", v: upperOfPartial }] : [{ op: ">", v: low }];
  if (operator === "<=") return patch === null ? [{ op: "<", v: upperOfPartial }] : [{ op: "<=", v: low }];
  return null;
}

function parseRangeSet(text) {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "*" || /^[xX]$/u.test(trimmed) || trimmed === "latest") return [];
  const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(trimmed);
  if (hyphen) {
    const from = comparatorsOf(`>=${hyphen[1]}`);
    const to = partial(hyphen[2]);
    if (from === null || to === null) return null;
    const upper = to.patch !== null ? [{ op: "<=", v: version(to.major, to.minor, to.patch, to.pre) }]
      : comparatorsOf(`<=${hyphen[2]}`);
    return upper === null ? null : [...from, ...upper];
  }
  const tokens = trimmed.replace(/(>=|<=|>|<|=|\^|~>?)\s+/gu, "$1").split(/\s+/u);
  const result = [];
  for (const token of tokens) {
    const comparators = comparatorsOf(token);
    if (comparators === null) return null;
    result.push(...comparators);
  }
  return result;
}

export function satisfies(versionText, range) {
  const candidate = parseVersion(versionText);
  if (candidate === null) return false;
  for (const set of String(range).split("||")) {
    const comparators = parseRangeSet(set);
    if (comparators === null) continue;
    const ok = comparators.every(({ op, v }) => {
      const order = compareVersions(candidate, v);
      return op === "=" ? order === 0 : op === ">=" ? order >= 0 : op === ">" ? order > 0
        : op === "<" ? order < 0 : order <= 0;
    });
    if (!ok) continue;
    if (candidate.pre.length === 0) return true;
    // A prerelease matches only a comparator of the same release with a prerelease.
    if (comparators.some(({ v }) => v.pre.length > 0 && v.pre[0] !== "0" && v.major === candidate.major
      && v.minor === candidate.minor && v.patch === candidate.patch)) return true;
  }
  return false;
}

// ---- registry ---------------------------------------------------------------

export function normalizeRegistry(text) {
  let url;
  try { url = new URL(text); } catch { fail("registry_invalid", "The npm registry is not a URL", { exitCode: 2 }); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    fail("registry_insecure", "The npm registry must be HTTPS (plain HTTP only on loopback)", { exitCode: 2 });
  }
  return url.href.replace(/\/+$/u, "");
}

function checkDownloadUrl(text) {
  let url;
  try { url = new URL(text); } catch { fail("claude_sdk_metadata_invalid", "A tarball URL is invalid"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    fail("claude_sdk_download_insecure", "A tarball URL is not HTTPS");
  }
  return url.href;
}

async function fetchMetadata(registry, name, fetchImpl) {
  if (!PACKAGE_NAME.test(name)) fail("claude_sdk_metadata_invalid", `Package name refused: ${name}`);
  const url = `${registry}/${name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" },
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    fail("claude_sdk_registry_unreachable", `The npm registry did not answer for ${name}`);
  }
  if (response.status === 404) fail("claude_sdk_package_not_found", `${name} is not in the registry`);
  if (!response.ok) fail("claude_sdk_registry_failed", `The npm registry answered ${response.status} for ${name}`);
  const text = await response.text();
  if (text.length > 128 * 1024 * 1024) fail("claude_sdk_metadata_invalid", "Registry metadata is too large");
  let metadata;
  try { metadata = JSON.parse(text); } catch { fail("claude_sdk_metadata_invalid", `Registry metadata of ${name} is not JSON`); }
  if (!metadata || typeof metadata.versions !== "object" || metadata.versions === null) {
    fail("claude_sdk_metadata_invalid", `Registry metadata of ${name} lists no versions`);
  }
  return metadata;
}

export function pickVersion(metadata, spec) {
  const tags = metadata["dist-tags"] ?? {};
  if (typeof tags[spec] === "string" && metadata.versions[tags[spec]]) return tags[spec];
  if (metadata.versions[spec]) return spec;
  const candidates = Object.keys(metadata.versions).filter((value) => parseVersion(value) && satisfies(value, spec));
  if (candidates.length === 0) return null;
  if (typeof tags.latest === "string" && candidates.includes(tags.latest)) return tags.latest;
  return candidates.sort((a, b) => compareVersions(b, a))[0];
}

function sha512Of(integrity) {
  const entry = String(integrity ?? "").split(/\s+/u).find((item) => item.startsWith("sha512-"));
  return entry ? entry.slice("sha512-".length) : null;
}

async function download(url, file, integrity, fetchImpl, maxBytes) {
  const expected = sha512Of(integrity);
  if (expected === null) fail("claude_sdk_integrity_missing", "The registry gives no sha512 integrity for a tarball");
  let response;
  try {
    response = await fetchImpl(checkDownloadUrl(url), { signal: AbortSignal.timeout(60 * 60_000) });
  } catch (error) {
    if (error?.code && String(error.code).startsWith("claude_sdk_")) throw error;
    fail("claude_sdk_download_failed", "A tarball download failed");
  }
  if (!response.ok || response.body === null) fail("claude_sdk_download_failed", `A tarball download answered ${response.status}`);
  checkDownloadUrl(response.url || url);
  const digest = createHash("sha512");
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const output = createWriteStream(file, { flags: "wx" });
    output.on("error", reject);
    output.on("finish", resolve);
    (async () => {
      try {
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > maxBytes) throw Object.assign(new Error("too large"), { code: "claude_sdk_download_too_large" });
          digest.update(chunk);
          if (!output.write(chunk)) await new Promise((drain) => output.once("drain", drain));
        }
        output.end();
      } catch (error) {
        output.destroy();
        reject(error);
      }
    })();
  }).catch((error) => {
    if (error?.code === "claude_sdk_download_too_large") fail("claude_sdk_download_too_large", "A tarball is larger than allowed");
    fail("claude_sdk_download_failed", "A tarball download was interrupted");
  });
  if (digest.digest("base64") !== expected) {
    await rm(file, { force: true });
    fail("claude_sdk_integrity_mismatch", "A downloaded tarball does not match its registry integrity");
  }
  return bytes;
}

export function sdkPlatformPackage(platform = process.platform, arch = process.arch) {
  return `${CLAUDE_SDK_PACKAGE}-${platform}-${arch}`;
}

function packageDirectory(root, name) {
  return path.join(root, "node_modules", ...name.split("/"));
}

/** Resolves the SDK, its platform package and required dependencies and peers. */
export async function resolveSdkPackages({ registry, requested, fetchImpl, platform, arch }) {
  const metadataCache = new Map();
  const metadataOf = async (name) => {
    if (!metadataCache.has(name)) metadataCache.set(name, await fetchMetadata(registry, name, fetchImpl));
    return metadataCache.get(name);
  };
  const resolved = new Map();
  const queue = [{ name: CLAUDE_SDK_PACKAGE, range: requested, by: null }];
  let platformPackage = null;
  while (queue.length > 0) {
    const { name, range, by } = queue.shift();
    if (!PACKAGE_NAME.test(name)) fail("claude_sdk_metadata_invalid", `Package name refused: ${name}`);
    const existing = resolved.get(name);
    if (existing) {
      if (existing.version !== range && !satisfies(existing.version, range)) {
        fail("claude_sdk_dependency_conflict", `${name}@${existing.version} does not satisfy ${range} (needed by ${by})`);
      }
      continue;
    }
    const metadata = await metadataOf(name);
    const chosen = pickVersion(metadata, range);
    if (chosen === null) fail(name === CLAUDE_SDK_PACKAGE ? "claude_sdk_version_not_found" : "claude_sdk_dependency_unresolved",
      `No version of ${name} matches ${range}`);
    if (!VERSION_DIR.test(chosen)) fail("claude_sdk_metadata_invalid", `Version refused: ${chosen}`);
    const manifest = metadata.versions[chosen];
    if (!manifest?.dist?.tarball) fail("claude_sdk_metadata_invalid", `${name}@${chosen} has no tarball`);
    resolved.set(name, { name, version: chosen, tarball: manifest.dist.tarball, integrity: manifest.dist.integrity ?? null });
    if (resolved.size > MAX_PACKAGES) fail("claude_sdk_dependency_tree_too_large", "The SDK needs more packages than allowed");
    if (name === CLAUDE_SDK_PACKAGE) {
      const optional = manifest.optionalDependencies ?? {};
      const platformNames = Object.keys(optional).filter((item) => item.startsWith(`${CLAUDE_SDK_PACKAGE}-`));
      const wanted = sdkPlatformPackage(platform, arch);
      if (optional[wanted] !== undefined) {
        platformPackage = wanted;
        queue.push({ name: wanted, range: optional[wanted], by: `${name}@${chosen}` });
      } else if (platformNames.length > 0) {
        fail("claude_sdk_platform_unsupported", `The SDK ships no program for ${platform}-${arch}`);
      }
    }
    for (const [dependency, dependencyRange] of Object.entries(manifest.dependencies ?? {})) {
      queue.push({ name: dependency, range: dependencyRange, by: `${name}@${chosen}` });
    }
    const peerMeta = manifest.peerDependenciesMeta ?? {};
    for (const [peer, peerRange] of Object.entries(manifest.peerDependencies ?? {})) {
      if (peerMeta[peer]?.optional === true) continue;
      queue.push({ name: peer, range: peerRange, by: `${name}@${chosen}` });
    }
  }
  return { packages: [...resolved.values()], platformPackage };
}

async function readManifest(directory) {
  const manifest = await readJsonFile(path.join(directory, SDK_MANIFEST), { invalidCode: "claude_sdk_manifest_invalid" })
    .catch(() => null);
  if (manifest?.schemaVersion !== 1 || manifest.kind !== "claude-agent-sdk" || typeof manifest.version !== "string") return null;
  return manifest;
}

function describeInstall(directory, manifest) {
  const sdkPath = packageDirectory(directory, CLAUDE_SDK_PACKAGE);
  return {
    version: manifest.version,
    directory,
    sdkPath,
    platformPackage: manifest.platformPackage ?? null,
    programPath: manifest.program ? path.join(directory, ...manifest.program.split("/")) : null,
    packages: manifest.packages ?? [],
    installedAtUtc: manifest.installedAtUtc ?? null,
  };
}

export async function listInstalledSdks(layout) {
  const entries = await readdir(layout.sdkRoot, { withFileTypes: true }).catch(() => []);
  const installs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !VERSION_DIR.test(entry.name)) continue;
    const directory = path.join(layout.sdkRoot, entry.name);
    const manifest = await readManifest(directory);
    if (manifest === null || manifest.version !== entry.name) continue;
    const described = describeInstall(directory, manifest);
    installs.push({ ...described,
      sdkPresent: (await pathKind(path.join(described.sdkPath, "sdk.mjs"))) === "file",
      programPresent: described.programPath !== null && (await pathKind(described.programPath)) === "file" });
  }
  return installs.sort((a, b) => compareVersions(b.version, a.version));
}

// The Claude Agent SDK version this release is built and tested with (Atlas's
// frontend/package.json pins the same one). `latest` is only taken when asked for.
export const PINNED_CLAUDE_SDK_VERSION = "0.3.288";

/** Installs one SDK version; idempotent. */
export async function installClaudeSdk({
  layout, requested = PINNED_CLAUDE_SDK_VERSION, registry = DEFAULT_NPM_REGISTRY, fetchImpl = globalThis.fetch,
  platform = process.platform, arch = process.arch, maxDownloadBytes = 1024 * 1024 * 1024,
}) {
  const registryUrl = normalizeRegistry(registry);
  if (typeof requested !== "string" || requested.trim() === "" || requested.length > 128) {
    fail("invalid_arguments", "--version names a version, range or dist-tag", { exitCode: 2 });
  }
  if (VERSION_DIR.test(requested)) {
    const existing = await readManifest(path.join(layout.sdkRoot, requested));
    if (existing?.version === requested) {
      return { state: "already-installed", requested, ...describeInstall(path.join(layout.sdkRoot, requested), existing) };
    }
  }
  const { packages, platformPackage } = await resolveSdkPackages({ registry: registryUrl, requested, fetchImpl, platform, arch });
  const sdkVersion = packages[0].version;
  const target = path.join(layout.sdkRoot, sdkVersion);
  const existing = await readManifest(target);
  if (existing?.version === sdkVersion) return { state: "already-installed", requested, ...describeInstall(target, existing) };
  await mkdir(layout.sdkRoot, { recursive: true });
  const staging = path.join(layout.sdkRoot, `.staging-${randomUUID()}`);
  const downloads = path.join(staging, ".downloads");
  try {
    await mkdir(downloads, { recursive: true });
    let downloadedBytes = 0;
    for (const [index, item] of packages.entries()) {
      const archive = path.join(downloads, `${index}.tgz`);
      downloadedBytes += await download(item.tarball, archive, item.integrity, fetchImpl, maxDownloadBytes);
      const directory = packageDirectory(staging, item.name);
      await extractTarGz(archive, directory, { platform });
      const manifest = await readJsonFile(path.join(directory, "package.json"), { invalidCode: "claude_sdk_package_mismatch" });
      if (manifest?.name !== item.name || manifest.version !== item.version) {
        fail("claude_sdk_package_mismatch", `The tarball of ${item.name}@${item.version} holds another package`);
      }
      await rm(archive, { force: true });
    }
    await rm(downloads, { recursive: true, force: true });
    if ((await pathKind(path.join(packageDirectory(staging, CLAUDE_SDK_PACKAGE), "sdk.mjs"))) !== "file") {
      fail("claude_sdk_package_mismatch", "The SDK package has no sdk.mjs");
    }
    let program = null;
    if (platformPackage !== null) {
      const name = platform === "win32" ? "claude.exe" : "claude";
      const candidate = path.join(packageDirectory(staging, platformPackage), name);
      if ((await pathKind(candidate)) === "file") program = ["node_modules", ...platformPackage.split("/"), name].join("/");
    }
    await writeJsonAtomic(path.join(staging, SDK_MANIFEST), {
      schemaVersion: 1, kind: "claude-agent-sdk", version: sdkVersion, requested,
      registry: new URL(registryUrl).origin, platform: `${platform}-${arch}`, platformPackage, program,
      packages: packages.map(({ name, version: packageVersion, integrity }) => ({ name, version: packageVersion, integrity })),
      downloadedBytes, installedAtUtc: nowUtc(),
    });
    if ((await pathKind(target)) !== null) {
      const trash = path.join(layout.sdkRoot, `.trash-${randomUUID()}`);
      await renameWithRetry(target, trash);
      await rm(trash, { recursive: true, force: true });
    }
    await renameWithRetry(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { state: "installed", requested, ...describeInstall(target, await readManifest(target)) };
}

/** What a configured sdkPath points to, read-only. */
export async function inspectSdkPath(sdkPath, { platform = process.platform, arch = process.arch } = {}) {
  if (typeof sdkPath !== "string" || !path.isAbsolute(sdkPath)) return { sdkPath: sdkPath ?? null, present: false, version: null, programPresent: false };
  const manifest = await readJsonFile(path.join(sdkPath, "package.json")).catch(() => null);
  const program = path.join(path.dirname(sdkPath), `claude-agent-sdk-${platform}-${arch}`, platform === "win32" ? "claude.exe" : "claude");
  return {
    sdkPath,
    present: (await pathKind(path.join(sdkPath, "sdk.mjs"))) === "file",
    version: typeof manifest?.version === "string" ? manifest.version : null,
    programPath: program,
    programPresent: (await pathKind(program)) === "file",
  };
}

export async function readSdkPackageVersion(sdkPath) {
  try {
    return JSON.parse(await readFile(path.join(sdkPath, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}
