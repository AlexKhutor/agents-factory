import { createHash } from "node:crypto";

// Python semantics the SQLite stores depend on, for their node:sqlite
// implementations (*-node.mjs). The Python bridges received every payload as
// JSON written by JSON.stringify and parsed by json.loads, so a JS number is a
// Python int exactly when JSON.stringify prints it without ".", "e" or "E";
// everything else here follows from that: json.dumps output (hashes, stored
// text and its byte size), str()/repr() in error messages, truthiness, int(),
// equality, and datetime.isoformat() timestamps.

/** A Python exception: `type` is its class name, `message` is str(error). */
export class PythonError extends Error {
  constructor(type, message) {
    super(message);
    this.name = type;
    this.pythonType = type;
  }
}

const INPUT_ERROR_TYPES = new Set(["KeyError", "TypeError", "ValueError", "JSONDecodeError", "UnicodeEncodeError"]);

/** True for the exceptions the memory bridge reports as memory_invalid_input. */
export function isPythonInputError(error) {
  return error instanceof PythonError && INPUT_ERROR_TYPES.has(error.pythonType);
}

export function pyIsInt(value) {
  return typeof value === "number" && Number.isInteger(value) && Math.abs(value) < 1e21;
}

export function isDict(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function pyTypeName(value) {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "bigint") return "int";
  if (typeof value === "number") return pyIsInt(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (Array.isArray(value)) return "list";
  return "dict";
}

/** float.__repr__: shortest round-trip digits, exponent below 1e-4 and from 1e16. */
export function pyFloatRepr(value) {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  const sign = value < 0 || Object.is(value, -0) ? "-" : "";
  const [mantissa, exponentText] = Math.abs(value).toExponential().split("e");
  const exponent = Number(exponentText);
  const digits = mantissa.replace(".", "");
  if (exponent >= -4 && exponent < 16) {
    if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
    if (digits.length <= exponent + 1) return `${sign}${digits}${"0".repeat(exponent + 1 - digits.length)}.0`;
    return `${sign}${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
  }
  const significand = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${sign}${significand}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
}

/** A JS number as json.dumps writes the value json.loads made of JSON.stringify(number). */
function numberJson(value) {
  const text = JSON.stringify(value);
  if (text === "null") return "null";
  return /[.eE]/u.test(text) ? pyFloatRepr(value) : text;
}

const ESCAPES = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** A string as json.dumps(ensure_ascii=False) writes it: a lone surrogate stays raw. */
function stringJson(value) {
  if (value.isWellFormed()) return JSON.stringify(value);
  let text = '"';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (ESCAPES[character]) text += ESCAPES[character];
    else if (code < 0x20) text += `\\u${code.toString(16).padStart(4, "0")}`;
    else text += character;
  }
  return `${text}"`;
}

/** Python's ordering of str keys: by code point (JS sorts UTF-16 units). */
export function pyKeyCompare(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a === b) continue;
    const surrogateA = a >= 0xd800 && a <= 0xdfff;
    const surrogateB = b >= 0xd800 && b <= 0xdfff;
    if (surrogateA !== surrogateB && (surrogateA ? b : a) >= 0xe000) return surrogateA ? 1 : -1;
    return a - b;
  }
  return left.length - right.length;
}

function prepared(value) {
  return value !== null && typeof value === "object" && typeof value.toJSON === "function"
    ? value.toJSON() : value;
}

/**
 * json.dumps(value, ensure_ascii=False, separators=(",", ":")), with
 * sort_keys=True when `sortKeys`. `value` is what JSON.stringify would send.
 */
export function pythonJson(value, { sortKeys = false } = {}) {
  const input = prepared(value);
  if (input === null || input === undefined || typeof input === "function" || typeof input === "symbol") return "null";
  if (typeof input === "boolean") return input ? "true" : "false";
  if (typeof input === "number") return numberJson(input);
  if (typeof input === "bigint") return input.toString();
  if (typeof input === "string") return stringJson(input);
  if (Array.isArray(input)) return `[${input.map((item) => pythonJson(item, { sortKeys })).join(",")}]`;
  const keys = Object.keys(input).filter((key) => {
    const item = prepared(input[key]);
    return item !== undefined && typeof item !== "function" && typeof item !== "symbol";
  });
  if (sortKeys) keys.sort(pyKeyCompare);
  return `{${keys.map((key) => `${stringJson(key)}:${pythonJson(input[key], { sortKeys })}`).join(",")}}`;
}

/** What JSON.stringify sent and json.loads received: drops undefined, applies toJSON. */
export function jsonTransport(value) {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new PythonError("JSONDecodeError", "Expecting value: line 1 column 1 (char 0)");
  }
  return JSON.parse(text);
}

/** A result as the bridge's json.dumps(sort_keys=True) answer reached JSON.parse. */
export function sortedTransport(value) {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : sortedTransport(item)));
  if (value === null || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort(pyKeyCompare)) {
    if (value[key] !== undefined) result[key] = sortedTransport(value[key]);
  }
  return result;
}

/** str.encode("utf-8"): a lone surrogate raises UnicodeEncodeError. */
export function utf8(text) {
  if (!text.isWellFormed()) {
    let position = 0;
    for (const character of text) {
      const code = character.codePointAt(0);
      if (code >= 0xd800 && code <= 0xdfff) {
        throw new PythonError("UnicodeEncodeError",
          `'utf-8' codec can't encode character '\\u${code.toString(16)}' in position ${position}: surrogates not allowed`);
      }
      position += 1;
    }
  }
  return Buffer.from(text, "utf8");
}

export function sha256Hex(text) {
  return createHash("sha256").update(utf8(text)).digest("hex");
}

function stringRepr(value) {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let text = quote;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (character === quote || character === "\\") text += `\\${character}`;
    else if (character === "\n") text += "\\n";
    else if (character === "\r") text += "\\r";
    else if (character === "\t") text += "\\t";
    else if (code === 0x20 || !/[\p{C}\p{Z}]/u.test(character)) text += character;
    else if (code < 0x100) text += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code < 0x10000) text += `\\u${code.toString(16).padStart(4, "0")}`;
    else text += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return `${text}${quote}`;
}

/** repr(value) for JSON-shaped values. */
export function pyRepr(value) {
  if (typeof value === "string") return stringRepr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isDict(value)) {
    return `{${Object.keys(value).map((key) => `${stringRepr(key)}: ${pyRepr(value[key])}`).join(", ")}}`;
  }
  return pyStr(value);
}

/** str(value) for JSON-shaped values. */
export function pyStr(value) {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return pyIsInt(value) ? String(value) : pyFloatRepr(value);
  if (typeof value === "string") return value;
  return pyRepr(value);
}

export function pyTruthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/** `left or right`. */
export function pyOr(left, right) {
  return pyTruthy(left) ? left : right;
}

/** dict.get(key, fallback); a key that is present keeps its value, even null. */
export function pyGet(dictionary, key, fallback = null) {
  if (!isDict(dictionary)) {
    throw new PythonError("AttributeError", `'${pyTypeName(dictionary)}' object has no attribute 'get'`);
  }
  return Object.hasOwn(dictionary, key) && dictionary[key] !== undefined ? dictionary[key] : fallback;
}

/** dict[key]. */
export function pyItem(dictionary, key) {
  if (Array.isArray(dictionary)) {
    throw new PythonError("TypeError", "list indices must be integers or slices, not str");
  }
  if (!isDict(dictionary)) {
    throw new PythonError("TypeError", `'${pyTypeName(dictionary)}' object is not subscriptable`);
  }
  if (!Object.hasOwn(dictionary, key) || dictionary[key] === undefined) throw new PythonError("KeyError", pyRepr(key));
  return dictionary[key];
}

/** The elements `for x in value` visits. */
export function pyIter(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [...value];
  if (isDict(value)) return Object.keys(value);
  throw new PythonError("TypeError", `'${pyTypeName(value)}' object is not iterable`);
}

/** A key that makes Python-equal hashable values equal (1 == 1.0 == True). */
export function pyHashKey(value) {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") {
    return `n:${typeof value === "bigint" ? value.toString() : Number(value)}`;
  }
  if (typeof value === "string") return `s:${value}`;
  throw new PythonError("TypeError", `unhashable type: '${pyTypeName(value)}'`);
}

/** Python ==. */
export function pyEquals(left, right) {
  const numeric = (value) => typeof value === "number" || typeof value === "boolean" || typeof value === "bigint";
  if (numeric(left) || numeric(right)) {
    if (!numeric(left) || !numeric(right)) return false;
    const exact = (value) => (typeof value === "boolean" ? BigInt(value) : value);
    // Loose equality compares a BigInt with a number exactly.
    return exact(left) == exact(right);
  }
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left ?? null) === (right ?? null);
  }
  if (typeof left === "string" || typeof right === "string") return left === right;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((item, index) => pyEquals(item, right[index]));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key) && pyEquals(left[key], right[key]));
}

/** int(value); a string beyond 2^53 gives an exact BigInt, as Python keeps it. */
export function pyInt(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (Number.isNaN(value)) throw new PythonError("ValueError", "cannot convert float NaN to integer");
    if (!Number.isFinite(value)) throw new PythonError("OverflowError", "cannot convert float infinity to integer");
    return Math.trunc(value) + 0;
  }
  if (typeof value === "string") {
    const match = /^\s*([+-]?)(\d+(?:_\d+)*)\s*$/u.exec(value);
    if (match) {
      const digits = `${match[1]}${match[2].replaceAll("_", "")}`;
      const number = Number(digits) + 0;
      return Number.isSafeInteger(number) ? number : BigInt(digits);
    }
    throw new PythonError("ValueError", `invalid literal for int() with base 10: ${pyRepr(value)}`);
  }
  throw new PythonError("TypeError",
    `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(value)}'`);
}

/** max(low, min(int(value), high)) as a number. */
export function pyClampInt(value, low, high) {
  const number = pyInt(value);
  if (number < low) return low;
  if (number > high) return high;
  return Number(number);
}

/** max(low, int(value)): a BigInt stays exact. */
export function pyAtLeast(value, low) {
  const number = pyInt(value);
  return number < low ? low : number;
}

/** len(text): code points, as Python counts them. */
export function pyLength(text) {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

/** text[:end] by code points. */
export function pySlice(text, end) {
  let result = "";
  let count = 0;
  for (const character of text) {
    if (count >= end) break;
    result += character;
    count += 1;
  }
  return result;
}

const MICROSECONDS_PER_MILLISECOND = 1000;
let lastMicroseconds = 0;

/** Microseconds since the epoch, increasing within this process. */
export function nowMicroseconds() {
  const sub = Number((process.hrtime.bigint() / 1000n) % 1000n);
  let value = Date.now() * MICROSECONDS_PER_MILLISECOND + sub;
  if (value <= lastMicroseconds) value = lastMicroseconds + 1;
  lastMicroseconds = value;
  return value;
}

/** datetime.isoformat() of a UTC time with "+00:00" written as "Z". */
export function isoFromMicroseconds(microseconds) {
  const seconds = Math.floor(microseconds / 1_000_000);
  const fraction = microseconds - seconds * 1_000_000;
  const whole = new Date(seconds * 1000).toISOString().slice(0, 19);
  return fraction === 0 ? `${whole}Z` : `${whole}.${String(fraction).padStart(6, "0")}Z`;
}

/** dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"). */
export function utcNow() {
  return isoFromMicroseconds(nowMicroseconds());
}

const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?)?(?:(Z)|([+-])(\d{2}):?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?$/u;

/**
 * parse_utc: datetime.fromisoformat(value.replace("Z", "+00:00")) as UTC
 * microseconds since the epoch; a naive time is local time, as astimezone()
 * reads it. null for an empty value.
 */
export function parseUtcMicroseconds(value) {
  if (!pyTruthy(value)) return null;
  if (typeof value !== "string") {
    throw new PythonError("AttributeError", `'${pyTypeName(value)}' object has no attribute 'replace'`);
  }
  const text = value.replaceAll("Z", "+00:00");
  const match = ISO_DATE_TIME.exec(text);
  const invalid = () => new PythonError("ValueError", `Invalid isoformat string: ${pyRepr(text)}`);
  if (!match) throw invalid();
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "", zulu, sign, offsetHour, offsetMinute,
    offsetSecond = "0"] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  if (parts[1] < 1 || parts[1] > 12 || parts[2] < 1 || parts[3] > 23 || parts[4] > 59 || parts[5] > 59) throw invalid();
  const daysInMonth = new Date(Date.UTC(parts[0], parts[1], 0)).getUTCDate();
  if (parts[2] > daysInMonth) throw invalid();
  const micro = Number(fraction.slice(0, 6).padEnd(6, "0"));
  let milliseconds;
  if (zulu === undefined && sign === undefined) {
    milliseconds = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]).getTime();
  } else {
    milliseconds = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
    if (sign !== undefined) {
      const offset = (Number(offsetHour) * 3600 + Number(offsetMinute) * 60 + Number(offsetSecond)) * 1000;
      if (Number(offsetHour) > 23 || Number(offsetMinute) > 59) throw invalid();
      milliseconds += sign === "+" ? -offset : offset;
    }
  }
  return milliseconds * MICROSECONDS_PER_MILLISECOND + micro;
}
