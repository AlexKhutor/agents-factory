// An image in a project's folder, for the person's own window (the owner's check of 01.11: the PNG
// files of a project were "access_denied" in the Files tab - the Gateway reads text only).
//
// Read-only, by the trusted host: the project's bound folder (the memory CLI's read-workspace), a
// relative path inside it with no link on the way and no private store, an image type only, at most
// 40 MB. The window gets a copy as a data URL - reduced when it is wide - never the path, and nothing
// is written or opened outside the window.

import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export const IMAGE_TYPES = Object.freeze({
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".bmp": "image/bmp",
});
export const IMAGE_MAX_BYTES = 40 * 1024 * 1024;
// A wider image is reduced to this width; one the image library cannot reduce goes as it is, up to this size.
const SHOWN_WIDTH = 1600;
const UNREDUCED_MAX_BYTES = 8 * 1024 * 1024;
// The same stores the Gateway's reader keeps closed (application-resource-reader.mjs).
const PRIVATE_SEGMENTS = new Set([".git", ".project-context", ".project-local", ".project-runtime", "node_modules"]);

const refused = (code) => ({ ok: false, error: { code } });

/** Whether a path is one an image may be read at: relative, plain parts, no private store, an image type. */
export function imagePathProblem(relative) {
  if (typeof relative !== "string" || relative.length === 0 || relative.length > 256 || relative.includes("\\")
      || relative.startsWith("/") || /^[A-Za-z]:/u.test(relative) || relative.includes("\0")) return "image_path_invalid";
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."
      || PRIVATE_SEGMENTS.has(segment.toLowerCase()))) return "image_path_invalid";
  if (IMAGE_TYPES[path.extname(relative).toLowerCase()] === undefined) return "image_type_unsupported";
  return null;
}

/**
 * `readProjectFolder({ projectId })` is the trusted host's (trusted-actions.mjs); `nativeImage` is
 * Electron's. `readImage({ projectId, path })` answers { ok, data: { dataUrl, type, sizeBytes, width,
 * height, shownWidth, shownHeight } } or { ok: false, error: { code } }.
 */
export function createProjectImages({ readProjectFolder, nativeImage }) {
  return {
    async readImage({ projectId, path: relative } = {}) {
      const problem = imagePathProblem(relative);
      if (problem !== null) return refused(problem);
      const folder = await readProjectFolder({ projectId });
      if (!folder?.ok) return folder?.error ? folder : refused("project_folder_unavailable");
      if (folder.data.configured !== true || folder.data.available !== true) return refused("project_folder_unavailable");
      let root;
      try { root = await realpath(folder.data.workspacePath); } catch { return refused("project_folder_unavailable"); }
      // Each part of the way is what it says: a link (or a Windows junction) is refused, not followed.
      let current = root;
      let info = null;
      try {
        for (const segment of relative.split("/")) {
          current = path.join(current, segment);
          info = await lstat(current);
          if (info.isSymbolicLink()) return refused("image_path_invalid");
        }
      } catch {
        return refused("image_missing");
      }
      if (!info.isFile()) return refused("image_missing");
      const inside = path.relative(root, await realpath(current));
      if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return refused("image_path_invalid");
      if (info.size > IMAGE_MAX_BYTES) return refused("image_too_large");
      const bytes = await readFile(current);
      const type = IMAGE_TYPES[path.extname(relative).toLowerCase()];
      const image = nativeImage.createFromBuffer(bytes);
      if (!image.isEmpty()) {
        const { width, height } = image.getSize();
        const reduced = width > SHOWN_WIDTH ? image.resize({ width: SHOWN_WIDTH, quality: "good" }) : image;
        const shown = reduced.getSize();
        const dataUrl = reduced === image && bytes.length <= UNREDUCED_MAX_BYTES
          ? `data:${type};base64,${bytes.toString("base64")}`
          : type === "image/jpeg" ? `data:image/jpeg;base64,${reduced.toJPEG(85).toString("base64")}` : reduced.toDataURL();
        return { ok: true, data: { dataUrl, type, sizeBytes: info.size, width, height,
          shownWidth: shown.width, shownHeight: shown.height } };
      }
      // A type the image library does not read (GIF, WebP...): the window shows it as it is, if not too big.
      if (bytes.length > UNREDUCED_MAX_BYTES) return refused("image_too_large");
      return { ok: true, data: { dataUrl: `data:${type};base64,${bytes.toString("base64")}`, type, sizeBytes: info.size,
        width: null, height: null, shownWidth: null, shownHeight: null } };
    },
  };
}
