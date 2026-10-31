// What a locale still lacks, to be translated (roadmap step 1, track E: a new language is a new file).
//
//   node tools/locale-missing.mjs <language>            the texts of locales/<language>.json still missing,
//                                                       as { "English text": "" } on stdout
//   node tools/locale-missing.mjs <language> --plurals  the plural texts too, with the language's forms
//
// Fill the values (by hand or with a model), merge them into locales/<language>.json, and
// tools/test-i18n.mjs checks the result: every text, the same {placeholders}, every plural form.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [language] = process.argv.slice(2);
if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(language ?? "") || language === "en") {
  process.stderr.write("usage: node tools/locale-missing.mjs <language other than en> [--plurals]\n");
  process.exit(2);
}
// The reference is Russian: it has every key the code names (tools/test-i18n.mjs keeps it so).
const reference = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "locales", "ru.json"), "utf8"));
const english = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "locales", "en.json"), "utf8"));
const file = path.join(PROJECT_ROOT, "locales", `${language}.json`);
const have = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
const missing = {};
for (const [key, value] of Object.entries(reference)) {
  if (have[key] !== undefined) continue;
  if (typeof value === "object") {
    if (!process.argv.includes("--plurals")) continue;
    missing[key] = Object.fromEntries(categories.map((category) => [category,
      english[key]?.[category] ?? english[key]?.other ?? ""]));
  } else {
    missing[key] = "";
  }
}
process.stdout.write(`${JSON.stringify(missing, null, 2)}\n`);
process.stderr.write(`${language}: ${Object.keys(missing).length} text(s) to translate; plural forms: ${categories.join(", ")}\n`);
