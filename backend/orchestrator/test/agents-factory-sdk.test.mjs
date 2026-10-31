import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { agentsFactoryLayout } from "../src/agents-factory-paths.mjs";
import { PINNED_CLAUDE_SDK_VERSION,
  CLAUDE_SDK_PACKAGE, compareVersions, installClaudeSdk, listInstalledSdks, normalizeRegistry, pickVersion, satisfies,
  sdkPlatformPackage,
} from "../src/agents-factory-sdk.mjs";
import { extractTarGz, safeEntryParts } from "../src/agents-factory-tar.mjs";
import {
  integrityOf, packageTarball, parseJsonOutput, runCliProcess, startFakeRegistry, tarGz, temporaryRoot, testEnvironment,
} from "./fixtures/agents-factory/helpers.mjs";

test("semver ranges cover npm manifest forms", () => {
  const yes = [
    ["1.2.3", "^1.0.0"], ["1.9.0", "^1.2"], ["0.2.5", "^0.2.1"], ["0.0.3", "^0.0.3"], ["1.2.9", "~1.2.3"],
    ["4.1.0", "^3.25.0 || ^4.0.0"], ["2.0.0", "*"], ["1.4.0", "1.x"], ["1.2.3", "1.2.3"], ["1.2.3", "=1.2.3"],
    ["1.5.0", ">=1.2.0 <2.0.0"], ["1.5.0", "1.0.0 - 1.5.0"], ["1.3.0-beta.2", ">=1.3.0-beta.1"], ["3.0.0", ">2"],
    ["1.2.0", "<=1.2"], ["0.9.0", "<1"],
  ];
  const no = [
    ["2.0.0", "^1.0.0"], ["0.3.0", "^0.2.1"], ["0.0.4", "^0.0.3"], ["1.3.0", "~1.2.3"], ["2.0.0-beta.1", "^1.0.0"],
    ["1.3.0-beta.1", "^1.2.0"], ["5.0.0", "^3.25.0 || ^4.0.0"], ["1.0.0", "<1"], ["2.5.0", ">2"], ["1.3.0", "<=1.2"],
    ["not-a-version", "*"],
  ];
  for (const [version, range] of yes) assert.equal(satisfies(version, range), true, `${version} ${range}`);
  for (const [version, range] of no) assert.equal(satisfies(version, range), false, `${version} ${range}`);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10"), -1);
  const metadata = { "dist-tags": { latest: "4.1.0", next: "5.0.0-rc.1" },
    versions: { "3.25.1": {}, "4.1.0": {}, "4.2.0": {}, "5.0.0-rc.1": {} } };
  assert.equal(pickVersion(metadata, "^3.25.0 || ^4.0.0"), "4.1.0");
  assert.equal(pickVersion(metadata, "next"), "5.0.0-rc.1");
  assert.equal(pickVersion(metadata, "^3"), "3.25.1");
  assert.equal(pickVersion(metadata, "^9"), null);
});

test("registry must be HTTPS except on loopback", () => {
  assert.equal(normalizeRegistry("https://registry.npmjs.org/"), "https://registry.npmjs.org");
  assert.equal(normalizeRegistry("http://127.0.0.1:4873"), "http://127.0.0.1:4873");
  assert.throws(() => normalizeRegistry("http://registry.example.com"), { code: "registry_insecure" });
  assert.throws(() => normalizeRegistry("file:///tmp/registry"), { code: "registry_insecure" });
});

test("tar extraction writes files and refuses traversal, links and devices", async (t) => {
  const root = await temporaryRoot(t, "af-tar-");
  const good = path.join(root, "good.tgz");
  const longName = `${"deep/".repeat(30)}file.txt`;
  await writeFile(good, tarGz([
    { name: "package/", type: "5" },
    { name: "package/package.json", content: "{\"name\":\"x\",\"version\":\"1.0.0\"}" },
    { name: "package/bin/tool", content: "#!/bin/sh\n", mode: 0o755 },
    { name: "PaxHeader-ignored", content: "long", pax: { path: `package/${longName}` } },
    { name: "package/lib/index.js", content: "export {};\n", prefix: "" },
  ]));
  const out = path.join(root, "good");
  const result = await extractTarGz(good, out);
  assert.equal(result.files, 4);
  assert.equal(await readFile(path.join(out, ...longName.split("/")), "utf8"), "long");
  assert.equal(await readFile(path.join(out, "lib", "index.js"), "utf8"), "export {};\n");

  const cases = [
    [[{ name: "package/../escape.txt", content: "x" }], "parent reference"],
    [[{ name: "/etc/escape.txt", content: "x" }], "absolute name"],
    [[{ name: "package/link", type: "2", linkname: "../../outside" }], "link entry"],
    [[{ name: "package/hard", type: "1", linkname: "package/package.json" }], "link entry"],
    [[{ name: "package/dev", type: "3" }], "entry type \"3\""],
    [[{ name: "package\\..\\escape.txt", content: "x" }], "name characters"],
    [[{ name: "package/C:/escape.txt", content: "x" }], "name characters"],
    [[{ name: "package/con.txt", content: "x" }], "name"],
    [[{ name: "x", content: "pax", pax: { path: "package/../../escape" } }], "parent reference"],
  ];
  for (const [index, [entries, reason]] of cases.entries()) {
    const archive = path.join(root, `bad-${index}.tgz`);
    await writeFile(archive, tarGz(entries));
    await assert.rejects(extractTarGz(archive, path.join(root, `bad-${index}`)),
      (error) => error.code === "archive_unsafe" && error.detail.reason === reason, `case ${index}`);
  }
  assert.deepEqual((await readdir(root)).filter((name) => name.includes("escape")), []);
  const truncated = path.join(root, "truncated.tgz");
  await writeFile(truncated, tarGz([{ name: "package/a.txt", content: "a".repeat(2000) }], { truncate: true }));
  await assert.rejects(extractTarGz(truncated, path.join(root, "truncated")), { code: "archive_unsafe" });
  const notGzip = path.join(root, "plain.tgz");
  await writeFile(notGzip, "not a gzip stream");
  await assert.rejects(extractTarGz(notGzip, path.join(root, "plain")), { code: "archive_unsafe" });
  assert.deepEqual(safeEntryParts("package/./a//b.js"), ["a", "b.js"]);
});

function sdkRegistryPackages({ version = "1.2.3", platforms = [`${process.platform}-${process.arch}`], sdkIntegrity, sdkName } = {}) {
  const program = process.platform === "win32" ? "claude.exe" : "claude";
  const sdkTarball = packageTarball(sdkName ?? CLAUDE_SDK_PACKAGE, version, { "sdk.mjs": "export function query() {}\n" });
  const optionalDependencies = Object.fromEntries(platforms.map((item) => [`${CLAUDE_SDK_PACKAGE}-${item}`, version]));
  const packages = {
    [CLAUDE_SDK_PACKAGE]: {
      distTags: { latest: version },
      versions: { [version]: { tarball: sdkTarball, integrity: sdkIntegrity,
        manifest: { optionalDependencies, peerDependencies: { zod: "^3.25.0 || ^4.0.0" } } } },
    },
    zod: {
      distTags: { latest: "4.1.0" },
      versions: {
        "3.25.1": { tarball: packageTarball("zod", "3.25.1", { "index.js": "module.exports = 3;\n" }), manifest: {} },
        "4.1.0": { tarball: packageTarball("zod", "4.1.0", { "index.js": "module.exports = 4;\n" }), manifest: {} },
      },
    },
  };
  for (const item of platforms) {
    const name = `${CLAUDE_SDK_PACKAGE}-${item}`;
    packages[name] = { distTags: { latest: version },
      versions: { [version]: { tarball: packageTarball(name, version, { [program]: "fixture program, never run\n" }), manifest: {} } } };
  }
  return packages;
}

test("claude install resolves, verifies and unpacks the SDK, its platform package and zod", async (t) => {
  const root = await temporaryRoot(t, "af-sdk-");
  const registry = await startFakeRegistry(sdkRegistryPackages());
  t.after(() => registry.close());
  const layout = agentsFactoryLayout({ dataDir: path.join(root, "data"), instanceDir: path.join(root, "instance") });
  const installed = await installClaudeSdk({ layout, registry: registry.url, requested: "latest" });
  assert.equal(installed.state, "installed");
  assert.equal(installed.version, "1.2.3");
  assert.equal(installed.platformPackage, sdkPlatformPackage());
  assert.equal(installed.sdkPath, path.join(layout.sdkRoot, "1.2.3", "node_modules", "@anthropic-ai", "claude-agent-sdk"));
  assert.match(await readFile(path.join(installed.sdkPath, "sdk.mjs"), "utf8"), /query/u);
  const zod = JSON.parse(await readFile(path.join(layout.sdkRoot, "1.2.3", "node_modules", "zod", "package.json"), "utf8"));
  assert.equal(zod.version, "4.1.0");
  assert.equal(path.basename(installed.programPath), process.platform === "win32" ? "claude.exe" : "claude");
  assert.deepEqual(installed.packages.map((item) => item.name).sort(),
    [CLAUDE_SDK_PACKAGE, sdkPlatformPackage(), "zod"].sort());
  assert.ok(installed.packages.every((item) => item.integrity.startsWith("sha512-")));
  assert.deepEqual((await readdir(layout.sdkRoot)).sort(), ["1.2.3"]);
  const listed = await listInstalledSdks(layout);
  assert.equal(listed[0].programPresent, true);
  assert.equal(listed[0].sdkPresent, true);

  const before = registry.requests.length;
  const again = await installClaudeSdk({ layout, registry: registry.url, requested: "1.2.3" });
  assert.equal(again.state, "already-installed");
  assert.equal(registry.requests.length, before, "an exact installed version needs no network");
  const latest = await installClaudeSdk({ layout, registry: registry.url, requested: "latest" });
  assert.equal(latest.state, "already-installed");
});

test("claude install refuses tarballs that fail integrity, lack it, or hold another package", async (t) => {
  const root = await temporaryRoot(t, "af-sdk-bad-");
  const layout = agentsFactoryLayout({ dataDir: path.join(root, "data"), instanceDir: path.join(root, "instance") });
  const cases = [
    [sdkRegistryPackages({ sdkIntegrity: integrityOf(Buffer.from("other bytes")) }), "claude_sdk_integrity_mismatch"],
    [sdkRegistryPackages({ sdkIntegrity: null }), "claude_sdk_integrity_missing"],
    [sdkRegistryPackages({ sdkName: "left-pad" }), "claude_sdk_package_mismatch"],
    [sdkRegistryPackages({ platforms: ["plan9-mips"] }), "claude_sdk_platform_unsupported"],
  ];
  for (const [packages, code] of cases) {
    const registry = await startFakeRegistry(packages);
    try {
      await assert.rejects(installClaudeSdk({ layout, registry: registry.url, requested: "latest" }), { code });
    } finally {
      await registry.close();
    }
    const left = await readdir(layout.sdkRoot).catch(() => []);
    assert.deepEqual(left, [], `${code} leaves nothing behind`);
  }
  const registry = await startFakeRegistry(sdkRegistryPackages());
  t.after(() => registry.close());
  await assert.rejects(installClaudeSdk({ layout, registry: registry.url, requested: "9.9.9" }), { code: "claude_sdk_version_not_found" });
});

test("claude install and claude status through the CLI", async (t) => {
  const root = await temporaryRoot(t, "af-sdk-cli-");
  const registry = await startFakeRegistry(sdkRegistryPackages({ version: "2.0.1" }));
  t.after(() => registry.close());
  const env = testEnvironment(root);
  const install = await runCliProcess(["claude", "install", "--registry", registry.url, "--version", "^2", "--json"], { env });
  assert.equal(install.status, 0, install.stderr);
  const installed = parseJsonOutput(install);
  assert.equal(installed.ok, true);
  assert.equal(installed.command, "claude install");
  assert.equal(installed.state, "installed");
  assert.equal(installed.version, "2.0.1");
  const status = parseJsonOutput(await runCliProcess(["claude", "status", "--json"], { env }));
  assert.equal(status.ok, true);
  assert.deepEqual(status.sdk.installed.map((item) => item.version), ["2.0.1"]);
  assert.equal(status.provider.present, false);
  assert.deepEqual(status.auth, { method: "claude-code-login", apiKeySource: "none" });
  const insecure = await runCliProcess(["claude", "install", "--registry", "http://registry.example.com", "--json"], { env });
  assert.equal(insecure.status, 2);
  assert.equal(parseJsonOutput(insecure).code, "registry_insecure");
});

test("claude install without a version asks for the pinned SDK version, not latest", () => {
  assert.match(PINNED_CLAUDE_SDK_VERSION, /^\d+\.\d+\.\d+$/u);
  // Atlas's package.json pins the same SDK the release is tested with.
  const frontend = JSON.parse(readFileSync(new URL("../../../frontend/package.json", import.meta.url), "utf8"));
  const pinned = { ...frontend.dependencies, ...frontend.devDependencies }["@anthropic-ai/claude-agent-sdk"];
  assert.equal(pinned, PINNED_CLAUDE_SDK_VERSION);
});
