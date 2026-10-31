// Which language the window speaks, and its locale file (roadmap step 1, track E).
//
// The person's choice in ui-state.json `language` wins; without one, the
// system's language when a locale file exists for it; else English, the
// language of the code. ATLAS_LANGUAGE overrides both (tests, screenshots).
// Locale files are `locales/<language>.json`: English text -> its translation
// (renderer/i18n-core.js). They are read synchronously: the window asks before
// any of its scripts runs.

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const core = require("../renderer/i18n-core.js");

export const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

/** The languages that have a locale file, English always among them. */
export function availableLanguages(directory) {
  let names = [];
  try { names = readdirSync(directory); } catch { names = []; }
  const found = names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5))
    .filter((name) => LANGUAGE.test(name));
  return [...new Set(["en", ...found])].sort();
}

/** The language to use: the override, the person's choice, the system's, English. */
export function chooseLanguage({ override = null, chosen = null, system = null, available }) {
  for (const candidate of [override, chosen]) {
    if (typeof candidate === "string" && available.includes(candidate)) return candidate;
  }
  if (typeof system === "string" && system !== "") {
    if (available.includes(system)) return system;
    const base = system.split(/[-_]/)[0].toLowerCase();
    if (available.includes(base)) return base;
  }
  return "en";
}

/** A locale file's texts; an unreadable or broken one is empty (the window then shows English). */
export function readLocale(directory, language) {
  if (!LANGUAGE.test(language)) return {};
  try {
    const value = JSON.parse(readFileSync(path.join(directory, `${language}.json`), "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** The person's choice in ui-state.json, read at once (the window waits for it). */
export function chosenLanguage(uiStateFile) {
  try {
    const value = JSON.parse(readFileSync(uiStateFile, "utf8"))?.language;
    return typeof value === "string" && LANGUAGE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The window's locale now: `{ language, available, table }`. The host's own texts follow it too
 * (the core is shared), so a message the host writes is in the window's language.
 */
export function currentLocale({ directory, uiStateFile, system, env = process.env }) {
  const available = availableLanguages(directory);
  const language = chooseLanguage({ override: env.ATLAS_LANGUAGE ?? null, chosen: chosenLanguage(uiStateFile), system, available });
  const table = readLocale(directory, language);
  core.setLocale(language, table);
  return { language, available, table };
}

export const { tx, txn } = core;

// Host modules build some word tables as they load, before Electron is ready: under Electron the
// language is chosen now, with the system's language as Intl knows it (main.mjs asks again with
// Electron's own). Plain Node (the tests) stays English unless it sets the locale itself.
if (process.versions.electron) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  currentLocale({ directory: path.join(root, "locales"), uiStateFile: path.join(root, "user-data", "ui-state.json"),
    system: Intl.DateTimeFormat().resolvedOptions().locale });
}
