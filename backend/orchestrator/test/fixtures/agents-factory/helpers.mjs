import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// Fixtures of the agents-factory tests: a controller template built in a
// temporary folder (the real Gateway bundle, a project identity, the
// control-cycle example), a fake Claude Agent SDK that the Gateway cannot run
// (so no Claude process ever starts), npm-style tarballs and a loopback npm
// registry. Nothing here touches the machine outside its temporary folders.

export const orchestratorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const cliSource = path.join(orchestratorRoot, "src", "agents-factory-cli.mjs");
export const cliBundle = path.join(orchestratorRoot, "dist", "agents-factory-cli.bundle.mjs");
const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));

export async function temporaryRoot(t, prefix = "agents-factory-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return root;
}

/** A controller template: what a release would ship as the instance seed. */
export async function buildTemplate(root, { projectId = "agents-factory-fixture" } = {}) {
  const template = path.join(root, "template");
  const runtime = path.join(template, ".orchestrator", "runtime");
  await mkdir(runtime, { recursive: true });
  await copyFile(path.join(orchestratorRoot, "dist", "application-gateway-cli.bundle.mjs"),
    path.join(runtime, "application-gateway-cli.mjs"));
  for (const bridge of ["conversation-archive-store.py", "project-memory-store.py"]) {
    await copyFile(path.join(orchestratorRoot, "dist", bridge), path.join(runtime, bridge));
  }
  const version = JSON.parse(await readFile(path.join(fixtureRoot, "template", "project-version.json"), "utf8"));
  await writeFile(path.join(template, "project-version.json"), `${JSON.stringify({ ...version, projectName: projectId }, null, 2)}\n`);
  await mkdir(path.join(template, "config"), { recursive: true });
  await copyFile(path.join(orchestratorRoot, "examples", "control-cycle.example.json"),
    path.join(template, "config", "control-cycle.example.json"));
  await copyFile(path.join(fixtureRoot, "template", "README.md"), path.join(template, "README.md"));
  return template;
}

/** An SDK folder the Gateway loads and finds unusable: no `query`, no program. */
export async function buildFakeSdk(root) {
  const sdk = path.join(root, "fake-sdk", "node_modules", "@anthropic-ai", "claude-agent-sdk");
  await mkdir(sdk, { recursive: true });
  await writeFile(path.join(sdk, "sdk.mjs"), "export const fixture = \"agents-factory: no query, never runs Claude\";\n");
  await writeFile(path.join(sdk, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0-fixture" }));
  return sdk;
}

/** The environment of a CLI under test: private data folder, no key from the person's shell. */
export function testEnvironment(root, extra = {}) {
  const env = { ...process.env, AGENTS_FACTORY_DATA_DIR: path.join(root, "data"), ...extra };
  delete env.ANTHROPIC_API_KEY;
  delete env.AGENTS_FACTORY_HOME;
  delete env.AGENTS_FACTORY_NPM_REGISTRY;
  return env;
}

export function runCliProcess(args, { env, input = null, cli = cliSource, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [cli, ...args], { env, windowsHide: true, timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr });
    });
    child.stdin.end(input ?? undefined);
  });
}

export function parseJsonOutput(result) {
  const lines = result.stdout.trim().split(/\r?\n/u);
  if (lines.length !== 1) throw new Error(`Expected one JSON line, got: ${result.stdout}\n${result.stderr}`);
  return JSON.parse(lines[0]);
}

// ---- tarballs -----------------------------------------------------------------

function header({ name, size = 0, type = "0", mode = 0o644, linkname = "", prefix = "" }) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, "ascii");
  block.write("0000000\0", 108, "ascii");
  block.write("0000000\0", 116, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  block.write(`${Math.floor(Date.UTC(2026, 0, 1) / 1000).toString(8).padStart(11, "0")}\0`, 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(type, 156, "ascii");
  block.write(linkname, 157, 100, "utf8");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  block.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

function padded(content) {
  const data = Buffer.from(content);
  return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

/** entries: [{ name, content?, type?, mode?, linkname?, pax? }] */
export function tarGz(entries, { truncate = false } = {}) {
  const blocks = [];
  for (const entry of entries) {
    if (entry.pax) {
      const records = Object.entries(entry.pax).map(([key, value]) => {
        const body = ` ${key}=${value}\n`;
        let length = body.length + 1;
        while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
        return `${length}${body}`;
      }).join("");
      blocks.push(header({ name: "PaxHeader", size: Buffer.byteLength(records), type: "x" }), padded(records));
    }
    const content = entry.content ?? "";
    const size = entry.type === "5" || entry.type === "2" || entry.type === "1" ? 0 : Buffer.byteLength(content);
    blocks.push(header({ name: entry.name, size, type: entry.type ?? "0", mode: entry.mode ?? 0o644,
      linkname: entry.linkname ?? "", prefix: entry.prefix ?? "" }));
    if (size > 0) blocks.push(padded(content));
  }
  if (!truncate) blocks.push(Buffer.alloc(1024));
  const tar = Buffer.concat(blocks);
  return gzipSync(truncate ? tar.subarray(0, tar.length - 700) : tar);
}

export function integrityOf(buffer) {
  return `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
}

export function packageTarball(name, version, files = {}, extra = {}) {
  return tarGz([
    { name: "package/package.json", content: JSON.stringify({ name, version, ...extra }) },
    ...Object.entries(files).map(([file, content]) => ({ name: `package/${file}`, content,
      mode: file === "claude" || file === "claude.exe" ? 0o755 : 0o644 })),
  ]);
}

/**
 * A loopback npm registry. packages: { name: { versions: { v: { manifest, tarball } }, distTags } }.
 * Returns { url, requests, close }.
 */
export async function startFakeRegistry(packages) {
  const requests = [];
  const tarballs = new Map();
  const server = createServer((request, response) => {
    const url = decodeURIComponent(request.url);
    requests.push(url);
    if (tarballs.has(url)) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(tarballs.get(url));
      return;
    }
    const name = url.slice(1);
    const entry = packages[name];
    if (!entry) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{\"error\":\"not found\"}");
      return;
    }
    const { port } = server.address();
    const versions = {};
    for (const [version, item] of Object.entries(entry.versions)) {
      const tarballPath = `/tarballs/${name.replace("/", "__")}-${version}.tgz`;
      tarballs.set(tarballPath, item.tarball);
      versions[version] = { name, version, ...item.manifest,
        dist: { tarball: `http://127.0.0.1:${port}${tarballPath}`,
          ...(item.integrity === null ? {} : { integrity: item.integrity ?? integrityOf(item.tarball) }) } };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name, "dist-tags": entry.distTags ?? {}, versions }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A fake executor: records every call and answers from `respond(file, args, options)`. */
export function fakeExecutor(respond = () => ({ status: 0, stdout: "", stderr: "" })) {
  const calls = [];
  return {
    calls,
    async run(file, args, options = {}) {
      calls.push({ file, args: [...args], input: options.input ?? null, env: options.env ?? null });
      const answer = await respond(file, args, options);
      return { status: 0, stdout: "", stderr: "", errorCode: null, ...answer };
    },
  };
}

export function isAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}
