"use strict";

// The words of the interface, in the person's language (roadmap step 1, track E).
//
// The code is written in English: the English text is the key, and a locale
// file (`locales/<language>.json`) gives the same text in another language.
// `tx("Agent {name} is waiting", { name })` fills `{name}`; `txn("{count} agents",
// count)` picks the plural form of the language (Intl.PluralRules: one, few,
// many, other...). A text the locale does not have stays English, so a missing
// translation shows, never breaks. One English word may need several
// translations (Russian has a form per gender for "unknown"): the key then
// carries a context, `tx("account::unknown")`, which English drops.
//
// In the window the host hands the locale over before any script runs
// (preload `atlas.locale`); tests and the host call setLocale themselves.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module !== null && module.exports) {
    module.exports = api;
    // In Node (tests, the host) English starts with its own plural forms.
    try { api.setLocale("en", require("../../locales/en.json")); } catch { /* English keys only */ }
  } else Object.assign(root, api);
  const given = root && root.atlas && root.atlas.locale;
  if (given && typeof given.language === "string") api.setLocale(given.language, given.table);
}(typeof globalThis === "undefined" ? this : globalThis, function () {
  let language = "en";
  let table = {};
  let rules = new Intl.PluralRules("en");

  /** The language and its texts: { "English text": "translation" | { one, few, many, other } }. */
  function setLocale(next, entries) {
    language = typeof next === "string" && next !== "" ? next : "en";
    table = entries && typeof entries === "object" ? entries : {};
    try { rules = new Intl.PluralRules(language); } catch { rules = new Intl.PluralRules("en"); }
  }

  function currentLanguage() {
    return language;
  }

  /** The locale for dates and times: English as en-GB (24-hour clock, day before month), else the language. */
  function dateLocale() {
    return language === "en" ? "en-GB" : language;
  }

  function fill(text, params) {
    if (!params) return text;
    return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) =>
      (Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined && params[name] !== null
        ? String(params[name]) : whole));
  }

  /** The English text of a key: without its context ("account::unknown" -> "unknown"). */
  const english = (key) => String(key).replace(/^[a-z][a-z0-9-]*::/, "");

  /** The text in the current language, `{name}` filled from `params`. */
  function tx(key, params) {
    const value = table[key];
    return fill(typeof value === "string" ? value : english(key), params);
  }

  /**
   * A text with a count: the key is the English text ("{count} agents"); the
   * locale gives a form per plural category, English included ("one": "{count} agent").
   */
  function txn(key, count, params) {
    const value = table[key];
    const filled = Object.assign({ count }, params);
    if (value === null || value === undefined || typeof value !== "object") {
      return fill(typeof value === "string" ? value : english(key), filled);
    }
    const category = rules.select(Number(count));
    const form = value[category] !== undefined ? value[category] : value.other !== undefined ? value.other : value.many;
    return fill(typeof form === "string" ? form : english(key), filled);
  }

  return { setLocale, currentLanguage, dateLocale, tx, txn };
}));
