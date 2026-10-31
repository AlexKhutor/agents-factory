import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTOMATION_NULL, decodeText, isNullOrWhiteSpace, netTrim, nlsCompare, psCustomObject, psEquals, psJson, psSort,
  serializableData,
} from "../src/desk-task-common.mjs";

// The byte rules the desk task modules share with Windows PowerShell 5.1:
// ConvertTo-Json, the culture-aware order of Sort-Object and -eq, .NET text.
// The expected values were written by PowerShell 5.1 (en-US); on Windows the
// last test compares against a live powershell.exe on random data as well.

const BACKSLASH = String.fromCharCode(92);
const escaped = (hex) => `${BACKSLASH}u${hex}`;

test("ConvertTo-Json: escapes, CRLF, two spaces after a colon, nested values under their key", () => {
  const value = { a: "it's <b> & é", n: 1, e: [], one: ["x"], nested: { k: [1, 2], z: null, t: true }, emptyObj: {},
    d: 1.5, big: 5_000_000_000, ctl: `a\tb\nc${String.fromCharCode(1)}` };
  const expected = [
    "{",
    `    "a":  "it${escaped("0027")}s ${escaped("003c")}b${escaped("003e")} ${escaped("0026")} é",`,
    "    \"n\":  1,",
    "    \"e\":  [",
    "",
    "          ],",
    "    \"one\":  [",
    "                \"x\"",
    "            ],",
    "    \"nested\":  {",
    "                   \"k\":  [",
    "                             1,",
    "                             2",
    "                         ],",
    "                   \"z\":  null,",
    "                   \"t\":  true",
    "               },",
    "    \"emptyObj\":  {",
    "",
    "                 },",
    "    \"d\":  1.5,",
    "    \"big\":  5000000000,",
    `    "ctl":  "a${BACKSLASH}tb${BACKSLASH}nc${escaped("0001")}"`,
    "}",
  ].join("\r\n");
  assert.equal(psJson(value), expected);
  assert.equal(psJson(value, { compress: true }), `{"a":"it${escaped("0027")}s ${escaped("003c")}b${escaped("003e")} `
    + `${escaped("0026")} é","n":1,"e":[],"one":["x"],"nested":{"k":[1,2],"z":null,"t":true},"emptyObj":{},"d":1.5,`
    + `"big":5000000000,"ctl":"a${BACKSLASH}tb${BACKSLASH}nc${escaped("0001")}"}`);
  // A function's empty output (an empty task list of dispatch_child_task.ps1) is written as an empty object.
  assert.equal(psJson({ requiredReading: AUTOMATION_NULL }, { compress: true }), "{\"requiredReading\":{}}");
  assert.equal(psJson([{ a: [] }]), "[\r\n    {\r\n        \"a\":  [\r\n\r\n              ]\r\n    }\r\n]");
  for (const code of [0x85, 0x2028, 0x2029]) {
    assert.equal(psJson(String.fromCharCode(code)), `"${escaped(code.toString(16).padStart(4, "0"))}"`);
  }
});

test("Sort-Object and -eq: the word sort of the current culture, ignoring case", () => {
  const sorted = ["1", "10", "2", "a", "a-", "a b", "a.b", "a.corrected-progress.json", "a.correction.json",
    "a.execution-summary.json", "a.md", "a.md.meta.json", "a.meta.json", "a.progress.json", "a_b", "a01", "a1", "a10",
    "a2", "ab", "a'b", "a-b", "a--b", "ab.md", "a-b.md", "abb", "a-bb", "abc", "ab-c", "a-bc", "a-b-c", "ac", "a-c",
    `x.a${BACKSLASH}b`, `x${BACKSLASH}a`, `x${BACKSLASH}a-b`, `x${BACKSLASH}b`, `x_a${BACKSLASH}b`, `xa${BACKSLASH}b`,
    `x-a${BACKSLASH}b`];
  assert.deepEqual(psSort([...sorted].reverse()), sorted);
  const words = ["abc", "abc'", "abc-", "abc--", "ab'c", "ab'c-", "ab-c", "ab-c'", "ab-c-", "ab--c", "a'bc", "a'-bc",
    "a-bc", "a-b-c", "a-'bc", "a--bc", "-abc", "-a-bc"];
  assert.deepEqual(psSort([...words].sort()), words);
  assert.ok(psEquals("Desk-Solver", "desk-solver"));
  assert.ok(!psEquals("desk-solver", "desksolver"));
  assert.ok(nlsCompare("Заметка", "заметка") === 0 && nlsCompare("ab", "Заметка") < 0);
});

test(".NET text: byte order marks, white space, and the tool log's sorted hashtables", () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x54]);
  assert.equal(decodeText(bom), "# T");
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x41, 0x00])), "A");
  assert.ok(isNullOrWhiteSpace(` \t${String.fromCharCode(0xa0, 0x3000, 0x85)}`));
  assert.ok(!isNullOrWhiteSpace(String.fromCharCode(0xfeff)));
  assert.equal(netTrim(`${String.fromCharCode(0x85)} x ${String.fromCharCode(0x2003)}`), "x");
  assert.deepEqual(Object.keys(serializableData({ TaskId: "t", AckPath: "p", action: "a" })), ["AckPath", "action", "TaskId"]);
  assert.deepEqual(Object.keys(serializableData(psCustomObject({ TaskId: "t", AckPath: "p" }))), ["TaskId", "AckPath"]);
  assert.equal(serializableData("x".repeat(20_000)).length, 16_384 + "\n...<truncated 3616 chars>...\n".length);
});

test("ConvertTo-Json and the sort keys match a live Windows PowerShell 5.1 on random data",
  { skip: process.platform !== "win32" && "needs Windows PowerShell" }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desk-task-common-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const alphabet = ["a", "b", "-", "'", "_", ".", " ", BACKSLASH, "/", ":", "\"", "<", ">", "&", "\t", "0", "9", "Z",
      "é", "Ё", "ж", "№", "«", String.fromCharCode(0x85), String.fromCharCode(0x2028), String.fromCharCode(1)];
    const text = () => Array.from({ length: Math.floor(random() * 9) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    const value = (depth) => {
      const roll = random();
      if (depth > 3 || roll < 0.3) return [text(), Math.floor(random() * 2000) - 1000, random() < 0.5, null][Math.floor(random() * 4)];
      if (roll < 0.6) return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(random() * 4) }, (_, index) => [`k${index}${text().replace(/[^a-z]/gu, "")}`,
        value(depth + 1)]));
    };
    const values = Array.from({ length: 40 }, () => ({ v: value(0) }));
    const strings = Array.from({ length: 200 }, () => `${text()}${text()}`);
    await writeFile(path.join(root, "values.json"), JSON.stringify(values));
    await writeFile(path.join(root, "strings.json"), JSON.stringify(strings));
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$utf8 = New-Object System.Text.UTF8Encoding $false",
      "$items = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'values.json')) | ConvertFrom-Json",
      "$pretty = @(); $compact = @()",
      "foreach ($i in $items) { $pretty += ($i | ConvertTo-Json -Depth 30); $compact += ($i | ConvertTo-Json -Depth 30 -Compress) }",
      "[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'pretty.txt'), ($pretty -join \"`n=====`n\"), $utf8)",
      "[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'compact.txt'), ($compact -join \"`n=====`n\"), $utf8)",
      "$ci = [System.Globalization.CultureInfo]::GetCultureInfo('en-US').CompareInfo",
      "$strings = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'strings.json')) | ConvertFrom-Json",
      "$keys = foreach ($s in $strings) { (($ci.GetSortKey([string]$s, [System.Globalization.CompareOptions]::IgnoreCase).KeyData"
        + " | ForEach-Object { $_.ToString('x2') }) -join '') }",
      "[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'keys.txt'), ($keys -join \"`n\"), $utf8)",
    ].join("\r\n");
    await writeFile(path.join(root, "probe.ps1"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(script)]));
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(root, "probe.ps1")], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const pretty = (await readFile(path.join(root, "pretty.txt"), "utf8")).split("\n=====\n");
    const compact = (await readFile(path.join(root, "compact.txt"), "utf8")).split("\n=====\n");
    values.forEach((item, index) => {
      assert.equal(psJson(item), pretty[index], `pretty ${index}`);
      assert.equal(psJson(item, { compress: true }), compact[index], `compact ${index}`);
    });
    const keys = (await readFile(path.join(root, "keys.txt"), "utf8")).split("\n");
    const { nlsSortKey } = await import("../src/desk-task-common.mjs");
    strings.forEach((item, index) => assert.equal(nlsSortKey(item).toString("hex"), keys[index], JSON.stringify(item)));
  });
