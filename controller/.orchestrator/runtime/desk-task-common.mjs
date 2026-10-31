import { createHash } from "node:crypto";
import { appendFile, copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { renameOver } from "./rename-over.mjs";

// What the desk task modules (desk-task-kit, desk-task-controller,
// desk-task-collect) share: the byte formats the PowerShell tools of the task
// chain write, so that a file written here is the file PowerShell 5.1 would
// have written. That means Windows PowerShell's ConvertTo-Json (the
// JavaScriptSerializer escapes and its own pretty printer, CRLF line ends),
// [System.IO.File] text rules, the culture-aware ordering of Sort-Object, the
// case-insensitive comparisons of PowerShell, and the tool logs of
// project_tooling_common.ps1. The PowerShell scripts remain the reference;
// test/desk-task-parity-*.test.mjs runs both on the same fixtures.

export const DESK_TASK_COMMON_VERSION = "v0.1.0";
export const CRLF = "\r\n";

export class DeskTaskError extends Error {
  constructor(message, code = "desk_task_refused") {
    super(message);
    this.code = code;
  }
}

/** A PowerShell `throw "message"`: the message is what the agent and the logs see. */
export function refuse(message, code) { throw new DeskTaskError(message, code); }

// ---------------------------------------------------------------------------
// Values with PowerShell's shape

const PS_CUSTOM_OBJECT = Symbol.for("agents-factory.desk-task.ps-custom-object");

/**
 * Marks an object as a PSCustomObject: its properties keep their order when
 * the tool log serializes it (a hashtable's keys are sorted there).
 */
export function psCustomObject(value) {
  Object.defineProperty(value, PS_CUSTOM_OBJECT, { value: true, enumerable: false });
  return value;
}

/**
 * The empty output of a PowerShell function (AutomationNull): a function that
 * returns an empty array to a variable leaves this, ConvertTo-Json writes it
 * as an empty object, and @() of it is empty. dispatch_child_task.ps1 writes
 * an empty task list this way.
 */
export const AUTOMATION_NULL = Object.freeze({ [Symbol.for("agents-factory.desk-task.automation-null")]: true });

/** A function's output as PowerShell assigns it: nothing, the one item, or the array. */
export function functionOutput(items) {
  if (items.length === 0) return AUTOMATION_NULL;
  return items.length === 1 ? items[0] : [...items];
}

/** @() of a value: an array of its items (AutomationNull and nothing give none, $null one). */
export function psArray(value) {
  if (value === AUTOMATION_NULL || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** [string]$value of the values these tools convert. */
export function psString(value) {
  if (value === null || value === undefined || value === AUTOMATION_NULL) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return formatNumber(value);
  if (Array.isArray(value)) return value.map(psString).join(" ");
  if (typeof value === "object") {
    const entries = Object.entries(value);
    // An empty PSCustomObject converts to "", any other to its "@{name=value; ...}" text.
    return entries.length === 0 ? "" : `@{${entries.map(([key, item]) => `${key}=${psString(item)}`).join("; ")}}`;
  }
  return String(value);
}

/** [bool]$value. */
export function psBool(value) {
  if (value === null || value === undefined || value === AUTOMATION_NULL) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length === 0 ? false : value.length === 1 ? psBool(value[0]) : true;
  return true;
}

/** A PowerShell condition ("if ($value)"): the same truth as [bool]. */
export const truthy = psBool;

/** A property of a parsed JSON object, found the way PowerShell finds it (any case). */
export function property(object, name) {
  if (object === null || typeof object !== "object" || Array.isArray(object)) return undefined;
  if (Object.prototype.hasOwnProperty.call(object, name)) return object[name];
  const lower = name.toLowerCase();
  const key = Object.keys(object).find((item) => item.toLowerCase() === lower);
  return key === undefined ? undefined : object[key];
}

export function hasProperty(object, name) {
  if (object === null || typeof object !== "object" || Array.isArray(object)) return false;
  const lower = name.toLowerCase();
  return Object.keys(object).some((item) => item.toLowerCase() === lower);
}

// ---------------------------------------------------------------------------
// Culture-aware string order (Sort-Object, -eq): Windows NLS sort keys

// Sort key parts of Latin-1, Cyrillic and general punctuation, taken from
// CompareInfo.GetSortKey(c, IgnoreCase) of Windows PowerShell 5.1 (en-US):
// code point (hex): primary weights [/ diacritic weights] [| case weights]
// [! special weight]. Hyphen and apostrophe have only a special weight: the
// "word sort" that orders "ab" < "a-b" < "abc". Other characters fall back to
// an order by code point after all of these.
const NLS_TABLE = "0:,1:!0312,2:!0412,3:!0512,4:!0612,5:!0712,6:!0812,7:!0912,8:!0a12,9:0705,a:0706,b:0707,c:0708,d:0709,"
  + "e:!0b12,f:!0c12,10:!0d12,11:!0e12,12:!0f12,13:!1012,14:!1112,15:!1212,16:!1312,17:!1412,18:!1512,"
  + "19:!1612,1a:!1712,1b:!1812,1c:!1912,1d:!1a12,1e:!1b12,1f:!1c12,20:0702,21:071c,22:071d,23:071f,24:0721,"
  + "25:0723,26:0725,27:!8012,28:0727,29:072a,2a:072d,2b:0803,2c:072f,2d:!8212,2e:0733,2f:0735,30:0d03,"
  + "31:0d1a,32:0d1c,33:0d1e,34:0d20,35:0d22,36:0d24,37:0d26,38:0d28,39:0d2a,3a:0737,3b:073a,3c:080e,3d:0812,"
  + "3e:0814,3f:073c,40:073e,41:0e02,42:0e09,43:0e0a,44:0e1a,45:0e21,46:0e23,47:0e25,48:0e2c,49:0e32,4a:0e35,"
  + "4b:0e36,4c:0e48,4d:0e51,4e:0e70,4f:0e7c,50:0e7e,51:0e89,52:0e8a,53:0e91,54:0e99,55:0e9f,56:0ea2,57:0ea4,"
  + "58:0ea6,59:0ea7,5a:0ea9,5b:073f,5c:0741,5d:0742,5e:0743,5f:0744,60:0748,61:0e02,62:0e09,63:0e0a,64:0e1a,"
  + "65:0e21,66:0e23,67:0e25,68:0e2c,69:0e32,6a:0e35,6b:0e36,6c:0e48,6d:0e51,6e:0e70,6f:0e7c,70:0e7e,71:0e89,"
  + "72:0e8a,73:0e91,74:0e99,75:0e9f,76:0ea2,77:0ea4,78:0ea6,79:0ea7,7a:0ea9,7b:074a,7c:074c,7d:074e,7e:0750,"
  + "7f:!1d12,80:0cfa/1d,81:0cfa/1e,82:0cfa/1f,83:0cfa/20,84:0cfa/21,85:0cfa/22,86:0cfa/23,87:0cfa/24,"
  + "88:0cfa/25,89:0cfa/26,8a:0cfa/27,8b:0cfa/28,8c:0cfa/29,8d:0cfa/2a,8e:0cfa/2b,8f:0cfa/2c,90:0cfa/2d,"
  + "91:0cfa/2e,92:0cfa/2f,93:0cfa/30,94:0cfa/31,95:0cfa/32,96:0cfa/33,97:0cfa/34,98:0cfa/35,99:0cfa/36,"
  + "9a:0cfa/37,9b:0cfa/38,9c:0cfa/39,9d:0cfa/3a,9e:0cfa/3b,9f:0cfa/3c,a0:0704,a1:0751,a2:0797,a3:0798,"
  + "a4:0799,a5:079a,a6:0752,a7:0a06,a8:0753,a9:0a07,aa:0e02/03|06,ab:0818,ac:0a08,ad:,ae:0a09,af:0754,"
  + "b0:0a0a,b1:0817,b2:0d1c|06,b3:0d1e|06,b4:0755,b5:0a0b,b6:0a0c,b7:0a0d,b8:0756,b9:0d1a|06,ba:0e7c/03|06,"
  + "bb:081a,bc:0d0d,bd:0d11,be:0d15,bf:0757,c0:0e02/0f,c1:0e02/0e,c2:0e02/12,c3:0e02/19,c4:0e02/13,"
  + "c5:0e02/1a,c6:0e020e21,c7:0e0a/1c,c8:0e21/0f,c9:0e21/0e,ca:0e21/12,cb:0e21/13,cc:0e32/0f,cd:0e32/0e,"
  + "ce:0e32/12,cf:0e32/13,d0:0e1a/68,d1:0e70/19,d2:0e7c/0f,d3:0e7c/0e,d4:0e7c/12,d5:0e7c/19,d6:0e7c/13,"
  + "d7:081c,d8:0e7c/21,d9:0e9f/0f,da:0e9f/0e,db:0e9f/12,dc:0e9f/13,dd:0ea7/0e,de:0e990e2c,df:0e910e91,"
  + "e0:0e02/0f,e1:0e02/0e,e2:0e02/12,e3:0e02/19,e4:0e02/13,e5:0e02/1a,e6:0e020e21,e7:0e0a/1c,e8:0e21/0f,"
  + "e9:0e21/0e,ea:0e21/12,eb:0e21/13,ec:0e32/0f,ed:0e32/0e,ee:0e32/12,ef:0e32/13,f0:0e1a/68,f1:0e70/19,"
  + "f2:0e7c/0f,f3:0e7c/0e,f4:0e7c/12,f5:0e7c/19,f6:0e7c/13,f7:081d,f8:0e7c/21,f9:0e9f/0f,fa:0e9f/0e,"
  + "fb:0e9f/12,fc:0e9f/13,fd:0ea7/0e,fe:0e990e2c,ff:0ea7/13,400:1014/0f,401:1014/13,402:1011,403:100a/0e,"
  + "404:1019,405:1020,406:1026,407:1026/13,408:102c,409:1034,40a:1044,40b:105d,40c:102e/0e,40d:1022/0f,"
  + "40e:1063/15,40f:1081,410:1002,411:1006,412:1008,413:100a,414:100f,415:1014,416:101b,417:101e,418:1022,"
  + "419:1022/15,41a:102e,41b:1032,41c:1038,41d:103a,41e:1048,41f:104f,420:1051,421:1053,422:1057,423:1063,"
  + "424:106c,425:106f,426:1075,427:1078,428:1084,429:1087,42a:108a,42b:108d,42c:1096,42d:109c,42e:10a2,"
  + "42f:10a5,430:1002,431:1006,432:1008,433:100a,434:100f,435:1014,436:101b,437:101e,438:1022,439:1022/15,"
  + "43a:102e,43b:1032,43c:1038,43d:103a,43e:1048,43f:104f,440:1051,441:1053,442:1057,443:1063,444:106c,"
  + "445:106f,446:1075,447:1078,448:1084,449:1087,44a:108a,44b:108d,44c:1096,44d:109c,44e:10a2,44f:10a5,"
  + "450:1014/0f,451:1014/13,452:1011,453:100a/0e,454:1019,455:1020,456:1026,457:1026/13,458:102c,459:1034,"
  + "45a:1044,45b:105d,45c:102e/0e,45d:1022/0f,45e:1063/15,45f:1081,2000:070c,2001:070d,2002:070c,2003:070d,"
  + "2004:070e,2005:070f,2006:0710,2007:0711,2008:0712,2009:0713,200a:0714,200b:0715,200c:,200d:,200e:,200f:,"
  + "2010:!8412,2011:!8512,2012:!8812,2013:!8912,2014:!9012,2015:!9212,2016:0777,2017:0778,2018:0779,"
  + "2019:077a,201a:077b,201b:077c,201c:077d,201d:077e,201e:077f,201f:0780,2020:0b25,2021:0b26,2022:0b27,"
  + "2023:0b28,2024:0733,2025:0a0f,2026:0a10,2027:!8612,2028:0717,2029:0718,202a:,202b:,202c:,202d:,202e:,"
  + "202f:0702/0a,2030:0b2c/0c,2031:0b2c/0e,2032:0781,2033:0781/14,2034:0781/28,2035:0784,2036:0781/19,"
  + "2037:0781/2d,2038:0787,2039:0788,203a:0789,203b:0b2e,203c:071c/14,203d:078b,203e:078c,203f:078d,"
  + "2040:0b2f,2041:0b30,2042:0b31,2043:!8712,2044:0807,2045:073f/1c,2046:0742/1c,2047:073c/64,2048:073c/c8,"
  + "2049:071c/c8,204a:0787,204b:0725,204c:0724,204d:071d,204e:071e,204f:0723,2050:0722,2051:072d/64,"
  + "2052:0721,2053:0788,2054:0720,2055:071a/15,2056:071a/1f,2057:071f,2058:071a/29,2059:071a/33,205a:071a/3d,"
  + "205b:071a/47,205c:0c02,205d:0c03,205e:0c04,205f:0702,2060:,2061:,2062:,2063:,2064:,2065:,2066:,2067:,"
  + "2068:,2069:,206a:,206b:,206c:,206d:,206e:,206f:,20a0:079d,20a1:07ab,20a2:07a8,20a3:079e,20a4:079f,"
  + "20a5:07a0,20a6:07a1,20a7:07a2,20a8:07a3,20a9:07a4,20aa:07b6,20ab:07b7,20ac:07a9,20ad:07a0,20ae:07a7,"
  + "20af:07a5,20b0:07a6,20b1:079b,20b2:07b2,20b3:07b3,20b4:07b4,20b5:07b5,20b6:,20b7:,20b8:,20b9:07bf,"
  + "20ba:07c0,20bb:,20bc:,20bd:,20be:,20bf:,20c0:,20c1:,20c2:,20c3:,20c4:,20c5:,20c6:,20c7:,20c8:,20c9:,"
  + "20ca:,20cb:,20cc:,20cd:,20ce:,20cf:,2100:0e05,2101:0e06/04,2102:0e0a/04,2103:0e0a/05,2104:0e13,2105:0e18,"
  + "2106:0e19,2107:0e22/c8,2108:0e92/0a,2109:0e23/04,210a:0e25/04,210b:0e2c/04,210c:0e2c/07,210d:0e2c/06,"
  + "210e:0e2c/05,210f:0e2c/68,2110:0e32/05,2111:0e32/06,2112:0e48/04,2113:0e48/04,2114:0e49,2115:0e70/04,"
  + "2116:0e71,2117:0afa,2118:0e7e/04,2119:0e7e/03,211a:0e89/03,211b:0e8a/05,211c:0e8a/06,211d:0e8a/04,"
  + "211e:0e8b,211f:0e8c,2120:0e93,2121:0e9a,2122:0e9c,2123:0ea3,2124:0ea9/04,2125:0ea9/63,2126:0f32,"
  + "2127:0f32/03,2128:0ea9/05,2129:0f32/05,212a:0e36,212b:0e02/1a,212c:0e09/04,212d:0e0a/06,212e:0e21/05,"
  + "212f:0e21/04,2130:0e21/04,2131:0e23/05,2132:0e23/03,2133:0e51/04,2134:0e7c/04,2135:2802|06,2136:2803|06,"
  + "2137:2804|06,2138:2805|06,2139:0e33/f0,213a:0e89/08,213b:0b02,213c:0f22,213d:0f06/05,213e:0f06/05,"
  + "213f:0f22/05,2140:0e21/08,2141:0e25/0a,2142:0e48/0c,2143:0e48/0d,2144:0ea7/0d,2145:0e1a/04,2146:0e1a/04,"
  + "2147:0e21/06,2148:0e32/07,2149:0e35/05,214a:0b4d,214b:070a/0a,214c:0c64,214d:0c65,214e:0e23/03,214f:0cfd,"
  + "2150:0d0a,2151:0d08,2152:0d07,2153:0d0e,2154:0d14,2155:0d0c,2156:0d10,2157:0d12,2158:0d16,2159:0d0b,"
  + "215a:0d17,215b:0d09,215c:0d0f,215d:0d13,215e:0d18,215f:0da6/e6";

const bytesOf = (hex) => (hex ? [...Buffer.from(hex, "hex")] : []);
const NLS = new Map(NLS_TABLE.split(",").map((entry) => {
  const [code, rest] = entry.split(":");
  const match = /^([0-9a-f]*)(?:\/([0-9a-f]+))?(?:\|([0-9a-f]+))?(?:!([0-9a-f]+))?$/u.exec(rest);
  const primary = bytesOf(match[1]);
  const units = [];
  for (let index = 0; index < primary.length; index += 2) units.push([primary[index], primary[index + 1]]);
  return [Number.parseInt(code, 16), { units, diacritics: bytesOf(match[2]), cases: bytesOf(match[3]),
    special: bytesOf(match[4]) }];
}));

function nlsEntry(code) {
  const known = NLS.get(code);
  if (known) return known;
  // Outside the table: after every tabled character, by code point.
  return { units: [[0xf0, (code >> 8) & 0xff], [0xf0, code & 0xff]], diacritics: [], cases: [], special: [] };
}

/** CompareInfo.GetSortKey(value, IgnoreCase).KeyData of the culture the tools ran under. */
export function nlsSortKey(value) {
  if (value.length === 0) return Buffer.alloc(0);
  const primary = [];
  const diacritics = [];
  const cases = [];
  const special = [];
  let units = 0;
  for (let index = 0; index < value.length; index += 1) {
    const entry = nlsEntry(value.charCodeAt(index));
    if (entry.special.length > 0) {
      const position = 0xffff - units;
      special.push((position >> 8) & 0xff, position & 0xff, ...entry.special);
      continue;
    }
    entry.units.forEach((unit, unitIndex) => {
      primary.push(...unit);
      diacritics.push(entry.diacritics[unitIndex] ?? 2);
      cases.push(entry.cases[unitIndex] ?? 2);
    });
    units += entry.units.length;
  }
  const trim = (list) => { while (list.length && list[list.length - 1] === 2) list.pop(); return list; };
  return Buffer.from([...primary, 1, ...trim(diacritics), 1, ...trim(cases), 1, 1, ...special, 0]);
}

/** The order of Sort-Object (current culture, ignoring case). */
export function nlsCompare(left, right) {
  return Buffer.compare(nlsSortKey(String(left)), nlsSortKey(String(right)));
}

/** PowerShell's -eq / -ne between strings: culture-aware and ignoring case. */
export function psEquals(left, right) {
  const a = psString(left);
  const b = psString(right);
  return a === b || nlsCompare(a, b) === 0;
}

/** -in / -contains of strings. */
export function psIn(value, list) { return list.some((item) => psEquals(value, item)); }

/** Sort-Object of strings, or of items by a string key. */
export function psSort(items, key = (item) => item) {
  return [...items].sort((left, right) => nlsCompare(key(left), key(right)));
}

// ---------------------------------------------------------------------------
// ConvertTo-Json of Windows PowerShell 5.1

/** A double as .NET's round-trip format writes it ("R"). */
function formatNumber(value) {
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : value < 0 ? "-Infinity" : "NaN";
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return Object.is(value, -0) ? "0" : String(value);
  const [mantissa, exponentText] = value.toExponential().split("e");
  const exponent = Number(exponentText);
  if (exponent >= 15 || exponent < -5) {
    return `${mantissa.toUpperCase()}E${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return String(value);
}

const JSON_ESCAPES = new Map([[8, "\\b"], [9, "\\t"], [10, "\\n"], [12, "\\f"], [13, "\\r"], [34, "\\\""], [92, "\\\\"]]);

/** A string as JavaScriptSerializer writes it. */
function jsonString(value) {
  let output = "\"";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const escape = JSON_ESCAPES.get(code);
    if (escape) output += escape;
    else if (code < 0x20 || code === 0x27 || code === 0x3c || code === 0x3e || code === 0x26 || code === 0x85
      || code === 0x2028 || code === 0x2029) output += `\\u${code.toString(16).padStart(4, "0")}`;
    else output += value[index];
  }
  return `${output}"`;
}

function compactJson(value) {
  if (value === null || value === undefined) return "null";
  if (value === AUTOMATION_NULL) return "{}";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return jsonString(value);
  if (value instanceof Date) return `"\\/Date(${value.getTime()})\\/"`;
  if (Array.isArray(value)) return `[${value.map(compactJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${jsonString(key)}:${compactJson(item)}`).join(",")}}`;
  }
  return jsonString(String(value));
}

// The pretty printer of ConvertToJsonCommand (PowerShell 5.1): it re-reads the
// compact text and indents a nested value under the end of its key.
function appendString(json, index, output) {
  for (let position = index; position < json.length; position += 1) {
    output.push(json[position]);
    if (json[position] === "\\") {
      output.push(json[position + 1]);
      position += 1;
    } else if (json[position] === "\"") return position;
  }
  return json.length - 1;
}

function convertList(json, index, output, pad, spaces) {
  output.push(CRLF);
  const newPad = `${pad}${" ".repeat(spaces)}    `;
  let headChar = true;
  for (let position = index; position < json.length; position += 1) {
    const character = json[position];
    if (character === "{") {
      output.push(newPad, character);
      position = convertDictionary(json, position + 1, output, newPad, 0);
      headChar = false;
    } else if (character === "[") {
      output.push(newPad, character);
      position = convertList(json, position + 1, output, newPad, 0);
      headChar = false;
    } else if (character === "]") {
      output.push(CRLF, pad, " ".repeat(spaces), character);
      return position;
    } else if (character === "\"") {
      if (headChar) output.push(newPad);
      output.push(character);
      position = appendString(json, position + 1, output);
      headChar = false;
    } else if (character === ",") {
      output.push(character, CRLF);
      headChar = true;
    } else {
      if (headChar) output.push(newPad);
      output.push(character);
      headChar = false;
    }
  }
  return json.length - 1;
}

function convertDictionary(json, index, output, pad, spaces) {
  output.push(CRLF);
  const newPad = `${pad}${" ".repeat(spaces)}    `;
  let beforeQuote = true;
  let keyWidth = 0;
  for (let position = index; position < json.length; position += 1) {
    const character = json[position];
    if (character === "{") {
      output.push(character);
      position = convertDictionary(json, position + 1, output, newPad, keyWidth);
    } else if (character === "[") {
      output.push(character);
      position = convertList(json, position + 1, output, newPad, keyWidth);
    } else if (character === "}") {
      output.push(CRLF, pad, " ".repeat(spaces), character);
      return position;
    } else if (character === "\"") {
      if (beforeQuote) output.push(newPad);
      output.push(character);
      const end = appendString(json, position + 1, output);
      if (beforeQuote) keyWidth = end - position + 1 + 3;
      beforeQuote = false;
      position = end;
    } else if (character === ":") {
      output.push(character, "  ");
      beforeQuote = false;
    } else if (character === ",") {
      output.push(character, CRLF);
      beforeQuote = true;
    } else output.push(character);
  }
  return json.length - 1;
}

/**
 * ConvertTo-Json of Windows PowerShell 5.1 (objects keep their key order,
 * arrays stay arrays). `compress` gives -Compress.
 */
export function psJson(value, { compress = false } = {}) {
  const json = compactJson(value);
  if (compress || !(json.startsWith("{") || json.startsWith("["))) return json;
  const output = [json[0]];
  if (json[0] === "{") convertDictionary(json, 1, output, "", 0);
  else convertList(json, 1, output, "", 0);
  return output.join("");
}

// ---------------------------------------------------------------------------
// Text, as [System.IO.File] and .NET regular expressions see it

// \s of .NET regular expressions.
export const NET_SPACE = "[\\f\\n\\r\\t\\v\\x85\\p{Z}]";
// White space of .NET (Char.IsWhiteSpace), as escapes so the source stays ASCII.
const NET_WHITE_CLASS = "\t\n\v\f\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const NET_WHITE = new RegExp(`^[${NET_WHITE_CLASS}]*$`, "u");
const NET_TRIM = new RegExp(`^[${NET_WHITE_CLASS}]+|[${NET_WHITE_CLASS}]+$`, "gu");

export function isNullOrWhiteSpace(value) {
  return value === null || value === undefined || value === AUTOMATION_NULL || NET_WHITE.test(psString(value));
}

/** String.Trim() of .NET. */
export function netTrim(value) { return String(value).replace(NET_TRIM, ""); }

/** [System.IO.File]::ReadAllText: a byte order mark chooses the encoding and is dropped; UTF-8 otherwise. */
export function decodeText(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return bytes.toString("utf8");
}

export async function readAllText(file) { return decodeText(await readFile(file)); }

/**
 * ConvertFrom-Json of a file. Windows PowerShell's Get-Content reads a file
 * without a byte order mark in the ANSI code page, which garbles non-ASCII
 * UTF-8 text; this reads UTF-8, as [System.IO.File]::ReadAllText does.
 */
export async function readJson(file) { return JSON.parse(await readAllText(file)); }

/** -match with a .NET pattern: $ also matches before a final line feed. */
export function netMatch(pattern, value, { ignoreCase = true } = {}) {
  const expression = new RegExp(pattern, `u${ignoreCase ? "i" : ""}`);
  const text = String(value);
  if (expression.test(text)) return true;
  return /\$$/u.test(pattern) && text.endsWith("\n") && expression.test(text.slice(0, -1));
}

const INLINE_MEDIA = new RegExp(`data${NET_SPACE}*:${NET_SPACE}*(image|audio|video)/[^,${NET_SPACE.slice(1, -1)}]+`
  + `(?:;[^,${NET_SPACE.slice(1, -1)}]+)*,`, "iu");
const CONTROL_ABSOLUTE = new RegExp(`(^|[${NET_SPACE.slice(1, -1)}"'(<\\[])${NET_SPACE}*(?:file:/+|[a-z]:[\\\\/]`
  + `|\\\\\\\\[^\\\\/${NET_SPACE.slice(1, -1)}]+[\\\\/])`, "iu");
const ORCHESTRATED_ABSOLUTE = new RegExp(`(^|[${NET_SPACE.slice(1, -1)}"'(])(?:[a-z]:[\\\\/]`
  + `|\\\\\\\\[^\\\\/${NET_SPACE.slice(1, -1)}]+[\\\\/])`, "iu");

export function hasInlineMedia(text) { return Boolean(text) && INLINE_MEDIA.test(String(text)); }

/** Assert-ControlTextSafety (orchestration_common.ps1). */
export function assertControlTextSafety(text, description = "content") {
  if (truthy(text) && hasInlineMedia(text)) {
    refuse(`Inline media is forbidden in ${description}. Use a project-relative artifact path.`);
  }
}

/** Assert-ControlDurableText (orchestration_common.ps1). */
export function assertControlDurableText(text, description = "durable content") {
  assertControlTextSafety(text, description);
  if (truthy(text) && CONTROL_ABSOLUTE.test(String(text))) {
    refuse(`Machine-local absolute paths are forbidden in ${description}. Use a project-relative reference.`);
  }
}

/** Assert-ControlRelativeReference (orchestration_common.ps1). */
export function assertControlRelativeReference(value, description) {
  if (isNullOrWhiteSpace(value)) refuse(`${description} must not be empty.`);
  const text = String(value);
  if (isPathRooted(text)) refuse(`${description} must be project-relative: '${text}'.`);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(text)) refuse(`${description} must be project-relative, not a URI: '${text}'.`);
  if (/(^|[\\/])\.\.([\\/]|$)/u.test(text)) refuse(`${description} may not traverse above the project: '${text}'.`);
  assertControlTextSafety(text, description);
}

/** Assert-OrchestratedDurableText (coordination_common.ps1 of the child kit). */
export function assertOrchestratedDurableText(text, description) {
  if (truthy(text) && hasInlineMedia(text)) {
    refuse(`Inline media is forbidden in ${description}. Use a project-relative path.`);
  }
  if (truthy(text) && ORCHESTRATED_ABSOLUTE.test(String(text))) {
    refuse(`Machine-local absolute paths are forbidden in ${description}. Use a project-relative reference.`);
  }
}

// ---------------------------------------------------------------------------
// Paths and files

/** [System.IO.Path]::IsPathRooted. */
export function isPathRooted(value) {
  const text = String(value);
  return /^[\\/]/u.test(text) || /^[a-zA-Z]:/u.test(text) || path.isAbsolute(text);
}

/** [System.IO.Path]::GetFullPath. */
export function fullPath(value) { return path.resolve(String(value)); }

/** Whether a full path starts with a folder (case-insensitive, as the tools compare). */
export function startsInside(candidate, root) {
  const base = fullPath(root).replace(/[\\/]+$/u, "") + path.sep;
  return candidate.toLowerCase().startsWith(base.toLowerCase());
}

/** Resolve-ControlRelativePath (orchestration_common.ps1). */
export async function resolveControlRelativePath(basePath, relativePath, { allowMissing = false } = {}) {
  if (isNullOrWhiteSpace(relativePath)) refuse("Relative path must not be empty.");
  if (isPathRooted(relativePath)) refuse(`Expected a relative path, received '${relativePath}'.`);
  if (/(^|[\\/])\.\.([\\/]|$)/u.test(relativePath)) refuse(`Relative path may not traverse above its root: '${relativePath}'.`);
  const resolved = path.resolve(fullPath(basePath).replace(/[\\/]+$/u, ""), relativePath);
  if (!startsInside(resolved, basePath)) refuse(`Resolved path escapes its root: '${relativePath}'.`);
  if (!allowMissing && !(await exists(resolved))) refuse(`Resolved path does not exist: ${resolved}`);
  return resolved;
}

/**
 * The relative path the tools compute with [System.Uri]::MakeRelativeUri:
 * forward slashes; a target outside the base is refused with `outside`.
 */
export function portableRelativePath(basePath, targetPath, outside) {
  const base = fullPath(basePath).replace(/[\\/]+$/u, "");
  const target = fullPath(targetPath);
  // path.win32.relative compares without case and keeps the target's spelling.
  const relative = path.relative(base, target).split(path.sep).join("/");
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) refuse(outside(target));
  return relative;
}

export async function exists(file) { return Boolean(await lstat(file).catch(() => null)); }
export async function isFile(file) { return Boolean((await stat(file).catch(() => null))?.isFile()); }
export async function isDirectory(file) { return Boolean((await stat(file).catch(() => null))?.isDirectory()); }

export const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sha256Text = (text) => sha256Bytes(Buffer.from(text, "utf8"));
export async function sha256File(file) { return sha256Bytes(await readFile(file)); }

/** Write-TextUtf8NoBom / [System.IO.File]::WriteAllText with UTF-8 without a byte order mark. */
export async function writeTextUtf8NoBom(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(text, "utf8"));
}

/** Write-LinesUtf8NoBom: every line ends with Windows' line end. */
export async function writeLinesUtf8NoBom(file, lines) {
  await writeTextUtf8NoBom(file, lines.map((line) => `${line}${CRLF}`).join(""));
}

/** Write-JsonUtf8NoBom: ConvertTo-Json text, no final line end. */
export async function writePsJson(file, value) { await writeTextUtf8NoBom(file, psJson(value)); }

/** Move-Item: refuses an existing destination unless `force` (then the file is replaced). */
export async function moveItem(source, destination, { force = false } = {}) {
  if (!force && await exists(destination)) {
    refuse(`Cannot create a file when that file already exists: ${destination}`, "desk_task_destination_exists");
  }
  await renameOver(source, destination);
}

/** Copy-Item of one file: the same bytes. */
export async function copyItem(source, destination) { await copyFile(source, destination); }

export async function removeQuietly(file) { await rm(file, { recursive: true, force: true }).catch(() => undefined); }

// ---------------------------------------------------------------------------
// Time

/** ToString("yyyy-MM-ddTHH:mm:ss.fffZ") of a UTC time. */
export const utcStamp = (date) => date.toISOString();

/** ToString("yyyyMMddTHHmmssfffZ"). */
export const compactStamp = (date) => date.toISOString().replace(/[-:]/gu, "").replace(".", "");

/** ToString("o") of a UTC DateTime: seven fraction digits. */
export const roundTripStamp = (date) => `${date.toISOString().slice(0, -1)}0000Z`;

/** A UUID's 32 hex digits ([guid]::NewGuid().ToString('N')). */
export const guidN = () => globalThis.crypto.randomUUID().replaceAll("-", "");

// ---------------------------------------------------------------------------
// Tool runs: logs/<tool>.log and logs/<tool>.report.json (project_tooling_common.ps1)

const MAX_REPORT_STRING = 16_384;

/** Get-TrimmedReportString. */
export function trimReportString(value, maximum = MAX_REPORT_STRING) {
  if (value === null || value === undefined) return null;
  if (maximum <= 0 || value.length <= maximum) return value;
  const prefix = Math.min(Math.floor(maximum * 0.7), value.length);
  const suffix = Math.min(maximum - prefix, value.length - prefix);
  return `${value.slice(0, prefix)}\n...<truncated ${value.length - (prefix + suffix)} chars>...\n`
    + `${value.slice(value.length - suffix)}`;
}

/** ConvertTo-SerializableData: a hashtable's keys sorted, a PSCustomObject's kept. */
export function serializableData(value, depth = 10) {
  if (value === null || value === undefined || value === AUTOMATION_NULL) return null;
  if (depth < 0) return "<max-depth-exceeded>";
  if (value instanceof Date) return utcStamp(value);
  if (typeof value === "string") return trimReportString(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 128).map((item) => serializableData(item, depth - 1));
    if (value.length >= 128) items.push("<truncated_items>");
    return items;
  }
  const keys = Object.keys(value);
  if (value[PS_CUSTOM_OBJECT]) {
    if (keys.length === 0) return value;
    const result = {};
    for (const key of keys.slice(0, 128)) result[key] = serializableData(value[key], depth - 1);
    if (keys.length > 128) result["<truncated_properties>"] = keys.length - 128;
    return result;
  }
  const sorted = psSort(keys).slice(0, 128);
  const result = {};
  for (const key of sorted) result[key] = serializableData(value[key], depth - 1);
  if (keys.length > sorted.length) result["<truncated_keys>"] = keys.length - sorted.length;
  return result;
}

/** The lines a script writes (Write-Host), for the caller and the run's log. */
export function createOutput() {
  const lines = [];
  return { lines, host: (line) => { lines.push(String(line)); }, text: () => lines.join("\n") };
}

async function readProjectManifest(root) {
  const manifestPath = path.join(fullPath(root), "project-version.json");
  if (!(await isFile(manifestPath))) refuse(`Project version manifest was not found: ${manifestPath}`);
  try { return await readJson(manifestPath); } catch (error) {
    return refuse(`Failed to parse project version manifest: ${manifestPath}. ${error.message}`);
  }
}

/** Get-ComponentVersion. */
export async function componentVersion(root, name) {
  const manifest = await readProjectManifest(root);
  const versions = property(manifest, "componentVersions");
  if (!truthy(versions)) refuse("componentVersions is missing in project-version.json");
  const version = property(versions, name);
  if (version === undefined) refuse(`No version entry was found for component '${name}' in project-version.json`);
  return psString(version);
}

function machineInfo() {
  return {
    computerName: process.env.COMPUTERNAME ?? os.hostname(),
    userName: process.env.USERNAME ?? process.env.USER ?? os.userInfo().username,
    osPlatform: process.platform === "win32" ? "Win32NT" : "Unix",
    osVersion: os.release(),
    isWindows: process.platform === "win32",
    psEdition: "Node.js",
    psVersion: process.versions.node,
  };
}

/**
 * Start-ProjectToolRun: archives the tool's previous log and report into
 * logs/old, reads the tool's version from project-version.json (a tool
 * without one is refused) and starts the log.
 */
export async function startToolRun({ root, toolName, parameters, output }) {
  const repoRoot = fullPath(root);
  const logs = path.join(repoRoot, "logs");
  const old = path.join(logs, "old");
  await mkdir(old, { recursive: true });
  const timestamp = compactStamp(new Date());
  const fileResults = [];
  for (const fileName of [`${toolName}.log`, `${toolName}.report.json`]) {
    const source = path.join(logs, fileName);
    if (!(await isFile(source))) continue;
    const archived = path.join(old, fileName.endsWith(".report.json") ? `${toolName}-${timestamp}.report.json`
      : `${toolName}-${timestamp}${path.extname(fileName)}`);
    try {
      await rename(source, archived);
      fileResults.push({ fileName, fresh: false });
    } catch {
      try {
        await copyFile(source, archived);
        fileResults.push({ fileName, fresh: true, locked: true });
      } catch {
        fileResults.push({ fileName, fresh: true, blocked: true });
      }
    }
  }
  const rotated = fileResults.some((item) => item.fresh);
  const fresh = (name) => rotated && fileResults.find((item) => item.fileName === name)?.fresh;
  const logPath = path.join(logs, fresh(`${toolName}.log`) ? `${toolName}-${timestamp}.log` : `${toolName}.log`);
  const reportPath = path.join(logs, fresh(`${toolName}.report.json`) ? `${toolName}-${timestamp}.report.json`
    : `${toolName}.report.json`);
  const manifest = await readProjectManifest(repoRoot);
  const context = {
    toolName, toolVersion: await componentVersion(repoRoot, toolName), projectName: psString(manifest.projectName),
    projectVersion: psString(manifest.projectVersion), repoRoot, startedAt: new Date(), logPath, reportPath,
    parameters: serializableData(parameters), output, firstLine: output.lines.length,
  };
  // The log holds what the run printed; PowerShell's transcript header has no counterpart here.
  await writeTextUtf8NoBom(logPath, `Agents Factory desk task log (Node.js ${process.versions.node})${CRLF}`
    + `Tool: ${toolName}${CRLF}`);
  output.host(`tool_name: ${context.toolName}`);
  output.host(`tool_version: ${context.toolVersion}`);
  output.host(`project_version: ${context.projectVersion}`);
  output.host(`repo_root: ${repoRoot}`);
  output.host(`started_at_utc: ${utcStamp(context.startedAt)}`);
  if (fresh(`${toolName}.log`)) output.host("tool_log_rotation: timestamped-active-log");
  if (fresh(`${toolName}.report.json`)) output.host("tool_report_rotation: timestamped-active-report");
  return context;
}

function errorRecord(error) {
  const message = String(error?.message ?? error);
  return {
    message,
    exceptionType: "System.Management.Automation.RuntimeException",
    category: "OperationStopped",
    fullyQualifiedErrorId: message,
    scriptStackTrace: trimReportString(String(error?.stack ?? ""), 8192),
    invocationInfo: { scriptName: "", line: 0, offsetInLine: 0, positionMessage: "", lineText: "" },
  };
}

/** Stop-ProjectToolRun: writes the run's report (formatVersion 1) and finishes the log. */
export async function stopToolRun(context, status, exitCode, result, error = null) {
  const finishedAt = new Date();
  const report = {
    formatVersion: 1, toolName: context.toolName, toolVersion: context.toolVersion, projectName: context.projectName,
    projectVersion: context.projectVersion, status, exitCode, startedAtUtc: utcStamp(context.startedAt),
    finishedAtUtc: utcStamp(finishedAt), durationMs: Math.round(finishedAt - context.startedAt),
    repoRoot: context.repoRoot, logPath: context.logPath, reportPath: context.reportPath, transcriptStartAttempts: 1,
    machine: machineInfo(), parameters: context.parameters, result: serializableData(result),
  };
  if (error) report.error = errorRecord(error);
  await writePsJson(context.reportPath, report);
  const { output } = context;
  output.host("report_serialization: full-report-written");
  output.host(`tool_status: ${status}`);
  output.host(`exit_code: ${exitCode}`);
  output.host(`tool_log: ${context.logPath}`);
  output.host(`tool_report: ${context.reportPath}`);
  const lines = output.lines.slice(context.firstLine);
  await appendFile(context.logPath, `${lines.map((line) => `${line}${CRLF}`).join("")}`
    + (error ? `ERROR: ${error.message}${CRLF}` : ""));
  return report;
}

/**
 * A script run: start, the action, the success or failure report; a refusal
 * is rethrown. The action may record its result data early with `keep`
 * (PowerShell's $resultData, which a failure report carries too).
 */
export async function withToolRun({ root, toolName, parameters, output }, action) {
  const context = await startToolRun({ root, toolName, parameters, output });
  let result = {};
  const keep = (value) => { result = value; };
  try {
    const returned = await action(keep, context);
    if (returned !== undefined) result = returned;
    await stopToolRun(context, "success", 0, result ?? {});
    return result;
  } catch (error) {
    await stopToolRun(context, "failed", 1, result ?? {}, error).catch(() => undefined);
    throw error;
  }
}

/**
 * Runs a ported script in-process with the answer shape of a PowerShell run:
 * { code, output } where output is what the script printed, then "ERROR:
 * <message>" when it refused (the wrapper of desk-agent-task-tools.mjs).
 */
export async function runInProcess(action) {
  const output = createOutput();
  try {
    await action(output);
    return { code: 0, output: output.text() };
  } catch (error) {
    output.host(`ERROR: ${error?.message ?? error}`);
    return { code: 1, output: output.text(), error };
  }
}

// ---------------------------------------------------------------------------
// The child kit's JSON Schema subset (Test-OrchestratedJsonSchemaNode)

function jsonType(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (Array.isArray(value)) return "array";
  return "object";
}

const identity = (value) => (value === null || value === undefined ? "null" : psJson(value, { compress: true }));

function resolveReference(root, reference) {
  if (!reference.startsWith("#/")) refuse(`Only local JSON Schema references are supported: '${reference}'.`);
  let node = root;
  for (const raw of reference.slice(2).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!hasProperty(node, segment)) refuse(`JSON Schema reference does not exist: '${reference}'.`);
    node = property(node, segment);
  }
  return node;
}

function isDateTime(value) {
  return !Number.isNaN(Date.parse(value)) || /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:\d{2})?$/u.test(value);
}

function validateNode(value, schema, root, jsonPath, errors) {
  if (hasProperty(schema, "$ref")) {
    validateNode(value, resolveReference(root, psString(property(schema, "$ref"))), root, jsonPath, errors);
    return;
  }
  if (hasProperty(schema, "oneOf")) {
    let matches = 0;
    for (const candidate of psArray(property(schema, "oneOf"))) {
      const candidateErrors = [];
      validateNode(value, candidate, root, jsonPath, candidateErrors);
      if (candidateErrors.length === 0) matches += 1;
    }
    if (matches !== 1) {
      errors.push(`${jsonPath} must match exactly one schema alternative; matched ${matches}.`);
      return;
    }
  }
  const actual = jsonType(value);
  if (hasProperty(schema, "type")) {
    const allowed = psArray(property(schema, "type")).map(psString);
    if (!(allowed.includes(actual) || (actual === "integer" && allowed.includes("number")))) {
      errors.push(`${jsonPath} must be ${allowed.join("|")}, got ${actual}.`);
      return;
    }
  }
  if (hasProperty(schema, "const") && identity(value) !== identity(property(schema, "const"))) {
    errors.push(`${jsonPath} does not match the required constant.`);
  }
  if (hasProperty(schema, "enum") && !psArray(property(schema, "enum")).map(identity).includes(identity(value))) {
    errors.push(`${jsonPath} is not one of the allowed values.`);
  }
  if (actual === "string") {
    const { length } = value;
    if (hasProperty(schema, "minLength") && length < Number(schema.minLength)) {
      errors.push(`${jsonPath} is shorter than ${psString(schema.minLength)} characters.`);
    }
    if (hasProperty(schema, "maxLength") && length > Number(schema.maxLength)) {
      errors.push(`${jsonPath} exceeds ${psString(schema.maxLength)} characters.`);
    }
    if (hasProperty(schema, "pattern") && !netMatch(psString(schema.pattern), value, { ignoreCase: false })) {
      errors.push(`${jsonPath} does not match the required pattern.`);
    }
    if (hasProperty(schema, "format") && psString(schema.format) === "date-time" && !isDateTime(value)) {
      errors.push(`${jsonPath} is not a valid date-time.`);
    }
  } else if (actual === "integer" || actual === "number") {
    if (hasProperty(schema, "minimum") && value < Number(schema.minimum)) {
      errors.push(`${jsonPath} is below the minimum ${psString(schema.minimum)}.`);
    }
    if (hasProperty(schema, "maximum") && value > Number(schema.maximum)) {
      errors.push(`${jsonPath} exceeds the maximum ${psString(schema.maximum)}.`);
    }
  } else if (actual === "array") {
    if (hasProperty(schema, "maxItems") && value.length > Number(schema.maxItems)) {
      errors.push(`${jsonPath} exceeds ${psString(schema.maxItems)} items.`);
    }
    if (hasProperty(schema, "uniqueItems") && psBool(schema.uniqueItems)) {
      const identities = value.map(identity);
      if (new Set(identities).size !== identities.length) errors.push(`${jsonPath} contains duplicate items.`);
    }
    if (hasProperty(schema, "items")) {
      value.forEach((item, index) => validateNode(item, property(schema, "items"), root, `${jsonPath}/${index}`, errors));
    }
  } else if (actual === "object") {
    const valueProperties = Object.keys(value);
    for (const required of psArray(hasProperty(schema, "required") ? property(schema, "required") : [])) {
      if (!valueProperties.includes(psString(required))) {
        errors.push(`${jsonPath} is missing required property '${psString(required)}'.`);
      }
    }
    const properties = hasProperty(schema, "properties") ? property(schema, "properties") : {};
    const known = Object.keys(properties ?? {});
    const additional = hasProperty(schema, "additionalProperties") ? property(schema, "additionalProperties") : undefined;
    if (additional === false) {
      for (const name of valueProperties) {
        if (!known.includes(name)) errors.push(`${jsonPath} contains unsupported property '${name}'.`);
      }
    }
    for (const name of known) {
      if (!hasProperty(value, name)) continue;
      validateNode(property(value, name), properties[name], root, `${jsonPath}/${name}`, errors);
    }
  }
}

/** Assert-OrchestratedJsonSchema. */
export async function assertJsonSchema(value, schemaPath, description = "JSON document") {
  if (!(await isFile(schemaPath))) refuse(`JSON Schema was not found for ${description}: ${schemaPath}`);
  const schema = JSON.parse(await readAllText(schemaPath));
  const errors = [];
  validateNode(value, schema, schema, "$", errors);
  if (errors.length > 0) {
    const bounded = errors.slice(0, 12);
    const suffix = errors.length > bounded.length ? ` (+${errors.length - bounded.length} more)` : "";
    refuse(`${description} does not satisfy '${path.basename(schemaPath)}': ${bounded.join(" ")}${suffix}`);
  }
}
