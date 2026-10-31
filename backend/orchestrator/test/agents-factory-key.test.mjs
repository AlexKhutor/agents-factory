import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createKeyStore, keyStatus, normalizeApiKey, resolveApiKey } from "../src/agents-factory-key.mjs";
import { agentsFactoryLayout } from "../src/agents-factory-paths.mjs";
import { fakeExecutor, parseJsonOutput, runCliProcess, temporaryRoot, testEnvironment } from "./fixtures/agents-factory/helpers.mjs";

const DUMMY = "sk-ant-dummy-agents-factory-0123456789";

function layoutIn(root) {
  return agentsFactoryLayout({ dataDir: path.join(root, "data"), instanceDir: path.join(root, "instance") });
}

test("key validation refuses non-keys without echoing them", () => {
  assert.equal(normalizeApiKey(`  ${DUMMY}\n`), DUMMY);
  for (const bad of ["", "short", "has space inside the key value", "quote\"inside-the-key-value", "x".repeat(600)]) {
    assert.throws(() => normalizeApiKey(bad), (error) => error.code === "key_invalid" && !error.message.includes(bad.trim() || "\u0000"));
  }
});

test("Windows DPAPI round trip keeps the key out of the file and the output", { skip: process.platform !== "win32" }, async (t) => {
  const root = await temporaryRoot(t, "af-key-dpapi-");
  const env = testEnvironment(root);
  const set = await runCliProcess(["key", "set", "--json"], { env, input: `${DUMMY}\n` });
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(parseJsonOutput(set), { ok: true, command: "key set", stored: true, store: "windows-dpapi" });
  assert.equal(`${set.stdout}${set.stderr}`.includes(DUMMY), false);
  const file = path.join(root, "data", "secrets", "anthropic-api-key.dpapi.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  assert.equal(record.kind, "dpapi-current-user");
  assert.equal(JSON.stringify(record).includes(DUMMY), false);
  assert.equal(JSON.stringify(record).includes(Buffer.from(DUMMY).toString("base64")), false);
  const status = parseJsonOutput(await runCliProcess(["key", "status", "--json"], { env }));
  assert.deepEqual(status, { ok: true, command: "key status", hasKey: true, store: "windows-dpapi", environmentOverride: false });
  const store = createKeyStore({ platform: "win32", layout: layoutIn(root), env });
  assert.equal(await store.get(), DUMMY);
  const resolved = await resolveApiKey({ env, store });
  assert.equal(resolved.source, "key-store");
  const removed = await runCliProcess(["key", "remove", "--json"], { env });
  assert.deepEqual(parseJsonOutput(removed), { ok: true, command: "key remove", removed: true, store: "windows-dpapi" });
  assert.deepEqual(await readdir(path.join(root, "data", "secrets")), []);
  const invalid = await runCliProcess(["key", "set", "--json"], { env, input: "not a key\n" });
  assert.equal(invalid.status, 1);
  assert.equal(parseJsonOutput(invalid).code, "key_invalid");
});

test("macOS Keychain gets the key on stdin of security -i, never in argv", async (t) => {
  const root = await temporaryRoot(t, "af-key-mac-");
  let stored = null;
  const executor = fakeExecutor((file, args, { input }) => {
    assert.equal(file, "/usr/bin/security");
    if (args[0] === "-i") {
      stored = /-w "([^"]+)"/u.exec(input)?.[1] ?? null;
      return { status: 0 };
    }
    if (args[0] === "find-generic-password") {
      if (stored === null) return { status: 44 };
      return { status: 0, stdout: args.includes("-w") ? `${stored}\n` : "keychain: attributes only\n" };
    }
    if (args[0] === "delete-generic-password") {
      const had = stored !== null;
      stored = null;
      return { status: had ? 0 : 44 };
    }
    return { status: 1 };
  });
  const store = createKeyStore({ platform: "darwin", layout: layoutIn(root), executor, env: {} });
  assert.equal(await store.has(), false);
  assert.equal(await store.get(), null);
  await store.set(DUMMY);
  assert.equal(await store.has(), true);
  assert.equal(await store.get(), DUMMY);
  assert.deepEqual(await keyStatus({ env: {}, store }), { hasKey: true, store: "macos-keychain", environmentOverride: false });
  assert.equal(await store.remove(), true);
  assert.equal(await store.remove(), false);
  for (const call of executor.calls) assert.equal(call.args.join(" ").includes(DUMMY), false);
  assert.ok(executor.calls.some((call) => call.args[0] === "-i" && call.input.includes("-s agents-factory -a anthropic-api-key")));
});

test("Linux Secret Service gets the key on stdin of secret-tool store", async (t) => {
  const root = await temporaryRoot(t, "af-key-linux-");
  let stored = null;
  const executor = fakeExecutor((file, args, { input }) => {
    assert.equal(file, "secret-tool");
    if (args[0] === "store") {
      stored = input;
      return { status: 0 };
    }
    if (args[0] === "lookup") return stored === null ? { status: 1 } : { status: 0, stdout: stored };
    if (args[0] === "clear") {
      stored = null;
      return { status: 0 };
    }
    return { status: 2 };
  });
  const store = createKeyStore({ platform: "linux", layout: layoutIn(root), executor, env: {} });
  assert.equal(await store.has(), false);
  await store.set(`${DUMMY}\n`);
  assert.equal(stored, DUMMY);
  assert.equal(await store.get(), DUMMY);
  assert.deepEqual(executor.calls[1].args, ["store", "--label=Agents Factory Anthropic API key", "service", "agents-factory",
    "account", "anthropic-api-key"]);
  assert.equal(await store.remove(), true);
  assert.equal(await store.get(), null);
  for (const call of executor.calls) assert.equal(call.args.join(" ").includes(DUMMY), false);

  const missing = createKeyStore({ platform: "linux", layout: layoutIn(root), env: {},
    executor: fakeExecutor(() => ({ status: null, errorCode: "ENOENT" })) });
  await assert.rejects(missing.has(), { code: "key_store_unavailable" });
  assert.deepEqual(await resolveApiKey({ env: {}, store: missing }), { source: "none", key: null, reasonCode: "key_store_unavailable" });
  assert.deepEqual(await resolveApiKey({ env: { ANTHROPIC_API_KEY: DUMMY }, store: missing }),
    { source: "environment", key: DUMMY, reasonCode: null });
});
