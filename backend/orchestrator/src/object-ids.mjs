import { randomBytes } from "node:crypto";

// Readable fixed IDs for new projects, quarters and agents (roadmap step 2,
// docs/personal/plans/01_11_2026_names-and-ids.md): Latin letters from the
// first name, then four random base-36 characters - `billing-7f3k`,
// `kvartal-oplaty-k2m9`. The ID never changes; the name does (object-names.mjs).
// Objects made before keep the IDs the person typed.

export const OBJECT_IDS_VERSION = "v0.1.0";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const STEM_LENGTH = 40;
const SUFFIX_LENGTH = 4;
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
// Russian and Ukrainian lower-case letters to Latin, by code point (the source stays ASCII).
const CYRILLIC = Object.freeze(Object.fromEntries([
  [0x430, "a"], [0x431, "b"], [0x432, "v"], [0x433, "g"], [0x434, "d"], [0x435, "e"], [0x451, "e"], [0x436, "zh"],
  [0x437, "z"], [0x438, "i"], [0x439, "y"], [0x43a, "k"], [0x43b, "l"], [0x43c, "m"], [0x43d, "n"], [0x43e, "o"],
  [0x43f, "p"], [0x440, "r"], [0x441, "s"], [0x442, "t"], [0x443, "u"], [0x444, "f"], [0x445, "kh"], [0x446, "ts"],
  [0x447, "ch"], [0x448, "sh"], [0x449, "shch"], [0x44a, ""], [0x44b, "y"], [0x44c, ""], [0x44d, "e"], [0x44e, "yu"],
  [0x44f, "ya"], [0x456, "i"], [0x457, "yi"], [0x454, "ye"], [0x491, "g"],
].map(([code, latin]) => [String.fromCodePoint(code), latin])));

/** The Latin part of an ID: lower case, letters and digits, words joined by "-". */
export function idStem(name) {
  const latin = [...String(name ?? "").toLowerCase()].map((char) => CYRILLIC[char] ?? char).join("")
    .normalize("NFKD").replace(/[\u0300-\u036f]/gu, "");
  const stem = latin.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, STEM_LENGTH).replace(/-+$/u, "");
  return stem || "item";
}

function suffix(random) {
  const bytes = random(SUFFIX_LENGTH);
  return [...bytes].map((byte) => BASE36[byte % 36]).join("");
}

/** A new ID for a name, not one of `taken`. */
export function newObjectId(name, { taken = [], random = randomBytes } = {}) {
  const used = new Set(taken);
  const stem = idStem(name);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = `${stem}-${suffix(random)}`;
    if (!used.has(candidate) && ID.test(candidate)) return candidate;
  }
  throw Object.assign(new Error("object_id_exhausted"), { code: "object_id_exhausted" });
}
