import { createReadStream } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { createGunzip } from "node:zlib";

import { fail } from "./agents-factory-common.mjs";

// A small tar.gz reader for npm package tarballs. It writes regular files and
// directories only, into a fresh folder of our own: absolute names, `..`,
// drive letters, backslashes, device names and every kind of link are refused,
// so nothing can land outside the destination (npm itself does not pack links).

const BLOCK = 512;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/iu;

function refuse(reason) {
  fail("archive_unsafe", `The package archive was refused: ${reason}`, { detail: { reason } });
}

function text(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function octal(buffer, start, length) {
  if (buffer[start] & 0x80) {
    // Base-256 (GNU) for large sizes.
    let value = 0;
    for (let index = start + 1; index < start + length; index += 1) value = value * 256 + buffer[index];
    if (!Number.isSafeInteger(value)) refuse("size");
    return value;
  }
  const raw = text(buffer, start, length).trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/u.test(raw)) refuse("header");
  return Number.parseInt(raw, 8);
}

function checksumValid(header) {
  const expected = octal(header, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 32 : header[index];
  return sum === expected;
}

function parsePax(buffer) {
  const values = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(buffer.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > buffer.length) refuse("pax header");
    const record = buffer.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) values[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return values;
}

/** The safe relative parts of an entry name, after npm's `package/` prefix. */
export function safeEntryParts(name, stripComponents = 1) {
  if (typeof name !== "string" || name.length > 4096) refuse("name");
  if (/[\u0000-\u001f\\:]/u.test(name)) refuse("name characters");
  if (name.startsWith("/")) refuse("absolute name");
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) refuse("parent reference");
  if (parts.some((part) => WINDOWS_RESERVED.test(part) || /[. ]$/u.test(part) || part.length > 255)) refuse("name");
  return parts.slice(stripComponents);
}

/**
 * Extracts a .tar.gz file into `destination` (created if missing). Returns
 * { files, directories, bytes }.
 */
export async function extractTarGz(file, destination, {
  stripComponents = 1, maxBytes = 2 * 1024 * 1024 * 1024, maxEntries = 100_000, platform = process.platform,
} = {}) {
  const root = path.resolve(destination);
  await mkdir(root, { recursive: true });
  const inside = (parts) => {
    const target = path.resolve(root, ...parts);
    const relative = path.relative(root, target);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) refuse("outside destination");
    return target;
  };
  const created = new Set([root]);
  const ensureDirectory = async (target) => {
    if (created.has(target)) return;
    await mkdir(target, { recursive: true });
    created.add(target);
  };
  let header = Buffer.alloc(0);
  /** @type {any} */
  let state = { kind: "header" };
  let pending = {};
  let ended = false;
  let entries = 0;
  let bytes = 0;
  let files = 0;
  let directories = 0;

  const startEntry = async (block) => {
    if (block.every((byte) => byte === 0)) {
      ended = true;
      return { kind: "end" };
    }
    if (!checksumValid(block)) refuse("header checksum");
    entries += 1;
    if (entries > maxEntries) refuse("too many entries");
    const type = String.fromCharCode(block[156] || 48);
    const size = octal(block, 124, 12);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      if (size > 1024 * 1024) refuse("extended header size");
      return { kind: "meta", type, remaining: size, padding, chunks: [] };
    }
    const magic = text(block, 257, 6);
    const prefix = magic.startsWith("ustar") ? text(block, 345, 155) : "";
    const headerName = prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100);
    const name = pending.path ?? headerName;
    const finalSize = pending.size !== undefined ? Number(pending.size) : size;
    pending = {};
    if (type === "1" || type === "2") refuse("link entry");
    if (type !== "0" && type !== "7" && type !== "5") refuse(`entry type ${JSON.stringify(type)}`);
    if (!Number.isSafeInteger(finalSize) || finalSize < 0) refuse("size");
    const finalPadding = (BLOCK - (finalSize % BLOCK)) % BLOCK;
    const parts = safeEntryParts(name, stripComponents);
    if (type === "5") {
      if (parts.length > 0) {
        await ensureDirectory(inside(parts));
        directories += 1;
      }
      return finalSize > 0 ? { kind: "skip", remaining: finalSize + finalPadding } : { kind: "header" };
    }
    if (parts.length === 0) return { kind: "skip", remaining: finalSize + finalPadding };
    bytes += finalSize;
    if (bytes > maxBytes) refuse("unpacked size");
    const target = inside(parts);
    await ensureDirectory(path.dirname(target));
    const handle = await open(target, "w", 0o644);
    files += 1;
    const mode = octal(block, 100, 8);
    if (finalSize === 0) {
      await handle.close();
      if (platform !== "win32" && (mode & 0o111)) await chmod(target, 0o755);
      return { kind: "header" };
    }
    return { kind: "file", handle, target, mode, remaining: finalSize, padding: finalPadding };
  };

  const consume = async (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (state.kind === "end") return;
      if (state.kind === "header") {
        const take = Math.min(BLOCK - header.length, chunk.length - offset);
        header = Buffer.concat([header, chunk.subarray(offset, offset + take)]);
        offset += take;
        if (header.length === BLOCK) {
          const block = header;
          header = Buffer.alloc(0);
          state = await startEntry(block);
        }
        continue;
      }
      if (state.kind === "skip") {
        const take = Math.min(state.remaining, chunk.length - offset);
        offset += take;
        state.remaining -= take;
        if (state.remaining === 0) state = { kind: "header" };
        continue;
      }
      if (state.kind === "meta") {
        const take = Math.min(state.remaining, chunk.length - offset);
        state.chunks.push(chunk.subarray(offset, offset + take));
        offset += take;
        state.remaining -= take;
        if (state.remaining === 0) {
          const data = Buffer.concat(state.chunks);
          if (state.type === "x") {
            const values = parsePax(data);
            if (values.path !== undefined) pending.path = values.path;
            if (values.size !== undefined) pending.size = values.size;
            if (values.linkpath !== undefined) pending.linkpath = values.linkpath;
          } else if (state.type === "L") {
            pending.path = text(data, 0, data.length);
          }
          state = state.padding > 0 ? { kind: "skip", remaining: state.padding } : { kind: "header" };
        }
        continue;
      }
      if (state.kind === "file") {
        const take = Math.min(state.remaining, chunk.length - offset);
        await state.handle.write(chunk.subarray(offset, offset + take));
        offset += take;
        state.remaining -= take;
        if (state.remaining === 0) {
          await state.handle.close();
          if (platform !== "win32" && (state.mode & 0o111)) await chmod(state.target, 0o755);
          state = state.padding > 0 ? { kind: "skip", remaining: state.padding } : { kind: "header" };
        }
      }
    }
  };

  const source = createReadStream(file);
  const stream = createGunzip();
  source.on("error", (error) => stream.destroy(error));
  source.pipe(stream);
  try {
    for await (const chunk of stream) {
      await consume(chunk);
      if (state.kind === "end") break;
    }
  } catch (error) {
    if (state.kind === "file") await state.handle.close().catch(() => {});
    if (error?.code === "archive_unsafe") throw error;
    if (typeof error?.code === "string" && error.code.startsWith("Z_")) refuse("not gzip");
    throw error;
  } finally {
    source.destroy();
    stream.destroy();
  }
  if (state.kind === "file") {
    await state.handle.close().catch(() => {});
    refuse("truncated");
  }
  if (!ended && (state.kind !== "header" || header.length !== 0)) refuse("truncated");
  return { files, directories, bytes };
}
