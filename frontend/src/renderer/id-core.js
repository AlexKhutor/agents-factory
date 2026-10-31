// A readable fixed ID from a name, as the backend makes it (object-ids.mjs):
// the name's Latin letters (Russian and Ukrainian letters transliterated), then
// four random base-36 characters - "billing-7f3k". The window proposes it in
// the create forms; the person may change it before creating. Plain script:
// the renderer and the Node tests (vm) load the same file.
(function (root) {
  const STEM_LENGTH = 40;
  const SUFFIX_LENGTH = 4;
  const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
  const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
  // Lower-case Cyrillic letters to Latin, by code point (the source stays ASCII).
  const CYRILLIC = Object.freeze(Object.fromEntries([
    [0x430, "a"], [0x431, "b"], [0x432, "v"], [0x433, "g"], [0x434, "d"], [0x435, "e"], [0x451, "e"], [0x436, "zh"],
    [0x437, "z"], [0x438, "i"], [0x439, "y"], [0x43a, "k"], [0x43b, "l"], [0x43c, "m"], [0x43d, "n"], [0x43e, "o"],
    [0x43f, "p"], [0x440, "r"], [0x441, "s"], [0x442, "t"], [0x443, "u"], [0x444, "f"], [0x445, "kh"], [0x446, "ts"],
    [0x447, "ch"], [0x448, "sh"], [0x449, "shch"], [0x44a, ""], [0x44b, "y"], [0x44c, ""], [0x44d, "e"], [0x44e, "yu"],
    [0x44f, "ya"], [0x456, "i"], [0x457, "yi"], [0x454, "ye"], [0x491, "g"],
  ].map(([code, latin]) => [String.fromCodePoint(code), latin])));

  /** The Latin part of an ID: lower case, letters and digits, words joined by "-". */
  function idStemOf(name) {
    const latin = [...String(name ?? "").toLowerCase()].map((char) => CYRILLIC[char] ?? char).join("")
      .normalize("NFKD").replace(/[\u0300-\u036f]/gu, "");
    const stem = latin.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, STEM_LENGTH).replace(/-+$/u, "");
    return stem || "item";
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    root.crypto.getRandomValues(bytes);
    return bytes;
  }

  /** A new ID for a name, not one that `taken(id)` says is used. */
  function newObjectIdOf(name, { taken = () => false, random = randomBytes } = {}) {
    const stem = idStemOf(name);
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const suffix = [...random(SUFFIX_LENGTH)].map((byte) => BASE36[byte % 36]).join("");
      const candidate = `${stem}-${suffix}`;
      if (ID.test(candidate) && !taken(candidate)) return candidate;
    }
    return null;
  }

  root.idStemOf = idStemOf;
  root.newObjectIdOf = newObjectIdOf;
})(globalThis);
