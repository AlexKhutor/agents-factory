// The window's ID proposal (src/renderer/id-core.js) makes the IDs the backend
// makes (backend/orchestrator/src/object-ids.mjs): the same examples, run
// through the renderer's own file in a vm.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [];
const check = (caseId, condition, detail) => cases.push({ caseId, status: condition ? "passed" : "failed",
  ...(condition ? {} : { detail }) });

const context = vm.createContext({ crypto: globalThis.crypto, Uint8Array });
vm.runInContext(await readFile(path.join(PROJECT_ROOT, "src", "renderer", "id-core.js"), "utf8"), context);
const { idStemOf, newObjectIdOf } = context;

const stems = [["Billing", "billing"], ["\u041a\u0432\u0430\u0440\u0442\u0430\u043b \u043e\u043f\u043b\u0430\u0442\u044b", "kvartal-oplaty"],
  ["\u0401\u043b\u043a\u0430 \u0438 \u0449\u0443\u043a\u0430", "elka-i-shchuka"], ["Caf\u00e9 cr\u00e8me \u2014 v2", "cafe-creme-v2"],
  ["  !!!  ", "item"], ["\u65e5\u672c\u8a9e", "item"], ["a".repeat(60), "a".repeat(40)]];
const wrong = stems.filter(([name, stem]) => idStemOf(name) !== stem).map(([name, stem]) => ({ name, stem, got: idStemOf(name) }));
check("stems-match-the-backend", wrong.length === 0, wrong);

const fixed = (values) => { let call = 0; return () => Uint8Array.from(values[call++]); };
const made = newObjectIdOf("Billing", { random: fixed([[7, 15, 3, 20]]) });
const again = newObjectIdOf("Billing", { taken: (id) => id === "billing-7f3k", random: fixed([[7, 15, 3, 20], [0, 1, 2, 3]]) });
check("suffix-and-taken-ids", made === "billing-7f3k" && again === "billing-0123", { made, again });
const random = Array.from({ length: 20 }, () => newObjectIdOf("\u041f\u043b\u0430\u0442\u0451\u0436\u043d\u044b\u0439 \u0448\u043b\u044e\u0437"));
check("random-ids-are-valid", random.every((id) => /^platezhnyy-shlyuz-[0-9a-z]{4}$/u.test(id)), random.slice(0, 3));

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, suite: "object-ids", status: failed.length ? "failed" : "passed",
  failedCount: failed.length, cases }, null, 2)}\n`);
process.exitCode = failed.length ? 1 : 0;
