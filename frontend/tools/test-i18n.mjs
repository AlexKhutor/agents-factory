// The locale files against the code (roadmap step 1, track E).
//
// The code is English and each text is its own key (renderer/i18n-core.js). Every key the code names -
// tx("...") / txn("...") and data-i18n / data-i18n-title in the pages - must be in every locale but
// English, with the same {placeholders}; a plural text has every plural form of its language; a locale
// keeps no key the code no longer names (a text that changed must be translated again). Keys built at
// run time are listed below, each with where it comes from.

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const i18n = require("../src/renderer/i18n-core.js");
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = ["src/renderer", "src/host", "src/direct", "src/paperclip", "src/preload"];

// Keys named at run time, not as a literal: where each comes from.
const RUNTIME_KEYS = Object.freeze({
  "You answered the agent's questions": "feed-core.js questionEntries: the backend's question heading",
  "The agent's question was left unanswered": "feed-core.js questionEntries: the backend's question heading",
  "The agent asks": "feed-core.js questionEntries: the backend's question heading",
  "Session (5 h)": "the Claude usage window labels (backend claude-usage.mjs)",
  "Week (7 days)": "the Claude usage window labels (backend claude-usage.mjs)",
  "Opus · week": "the Claude usage window labels (backend claude-usage.mjs)",
  "Sonnet · week": "the Claude usage window labels (backend claude-usage.mjs)",
  "{name} · limit": "the Claude usage window labels (backend claude-usage.mjs)",
});

const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

/** The JSON string literal at `text[at]` ("..."), decoded, and where it ends. */
function stringAt(text, at) {
  let end = at + 1;
  while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1;
  // A key inside a template the host runs in the window has its backticks escaped (\`).
  try { return { value: JSON.parse(text.slice(at, end + 1).replace(/\\`/gu, "`")), end }; } catch { return null; }
}

// i18n-core.js names keys only in its own comments, as examples.
function filesUnder(relative) {
  const directory = path.join(PROJECT_ROOT, relative);
  return readdirSync(directory).filter((name) => /\.(?:m?js|cjs|html)$/u.test(name) && name !== "i18n-core.js")
    .map((name) => path.join(directory, name));
}

const used = new Map();
const plural = new Set();
for (const file of SOURCES.flatMap(filesUnder)) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\btx(n?)\("/gu)) {
    const found = stringAt(text, match.index + match[0].length - 1);
    if (found === null) continue;
    used.set(found.value, path.relative(PROJECT_ROOT, file));
    if (match[1] === "n") plural.add(found.value);
  }
  for (const match of text.matchAll(/data-i18n(?:-title)?="([^"]*)"/gu)) {
    used.set(match[1].replace(/&quot;/gu, "\""), path.relative(PROJECT_ROOT, file));
  }
}
// feed-core.js names its plural keys as constants passed to txn (countWords).
for (const match of readFileSync(path.join(PROJECT_ROOT, "src/renderer/feed-core.js"), "utf8").matchAll(/_FORMS = "([^"]+)"/gu)) {
  used.set(match[1], "src/renderer/feed-core.js");
  plural.add(match[1]);
}
for (const key of Object.keys(RUNTIME_KEYS)) used.set(key, "run time");

const placeholders = (text) => [...String(text).matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)].map((match) => match[1]).sort();
const english = (key) => key.replace(/^[a-z][a-z0-9-]*::/u, "");
const locales = readdirSync(path.join(PROJECT_ROOT, "locales")).filter((name) => name.endsWith(".json"));
const tables = Object.fromEntries(locales.map((name) => [name.slice(0, -5),
  JSON.parse(readFileSync(path.join(PROJECT_ROOT, "locales", name), "utf8"))]));

check("locales-include-english-and-russian", tables.en !== undefined && tables.ru !== undefined, Object.keys(tables));

for (const [language, table] of Object.entries(tables)) {
  const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
  const keys = Object.keys(table);
  // English needs only its plural forms: any other text is its own key.
  // A key with no words of its own ("{label} — {value}") reads the same in every language.
  const words = (key) => /\p{L}/u.test(english(key).replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/gu, ""));
  const needed = language === "en" ? [...plural] : [...used.keys()].filter(words);
  const missing = needed.filter((key) => table[key] === undefined);
  check(`${language}-has-every-text-the-code-names`, missing.length === 0, missing.slice(0, 40));
  const unused = keys.filter((key) => !used.has(key));
  check(`${language}-keeps-no-text-the-code-no-longer-names`, unused.length === 0, unused.slice(0, 40));
  const wrongPlaceholders = keys.filter((key) => {
    const value = table[key];
    const forms = typeof value === "string" ? [value] : Object.values(value ?? {});
    const expected = JSON.stringify(placeholders(english(key)).filter((name) => !(plural.has(key) && name === "count")));
    return forms.some((form) => JSON.stringify(placeholders(form).filter((name) => !(plural.has(key) && name === "count"))) !== expected);
  });
  check(`${language}-keeps-the-placeholders`, wrongPlaceholders.length === 0, wrongPlaceholders.slice(0, 20));
  const incomplete = [...plural].filter((key) => table[key] !== undefined
    && (typeof table[key] !== "object" || categories.some((category) => typeof table[key][category] !== "string")));
  check(`${language}-plurals-have-every-form`, incomplete.length === 0, { categories, incomplete });
}

// The runtime itself: a missing text stays English, a context is dropped, plural forms follow the language.
i18n.setLocale("ru", tables.ru);
const sample = { missing: i18n.tx("no such text {x}", { x: 1 }), context: i18n.tx("zz-test::Archive"),
  five: i18n.txn("{count} agents", 5), twentyOne: i18n.txn("{count} agents", 21) };
i18n.setLocale("en", tables.en);
check("runtime-falls-back-to-english-and-picks-plural-forms",
  sample.missing === "no such text 1" && sample.context === "Archive"
    && sample.five === "5 агентов" && sample.twentyOne === "21 агент" && i18n.txn("{count} agents", 1) === "1 agent",
  sample);

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, suite: "i18n", status: failed.length === 0 ? "passed" : "failed",
  failedCount: failed.length, keysUsed: used.size, cases }, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
