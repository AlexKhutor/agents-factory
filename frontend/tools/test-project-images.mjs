// An image of a project's folder for the Files tab (src/host/project-images.mjs): read-only, inside
// the bound folder, no link on the way, no private store, an image type only; wide ones reduced.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProjectImages, imagePathProblem } from "../src/host/project-images.mjs";

const cases = [];
const check = (caseId, condition, detail) => cases.push({ caseId, status: condition ? "passed" : "failed",
  ...(condition ? {} : { detail }) });

// Electron's nativeImage, as far as the module uses it: PNG and JPEG are read, a "wide" PNG is 3200 px.
const resized = [];
const nativeImage = {
  createFromBuffer(bytes) {
    const text = bytes.toString("latin1");
    const known = text.startsWith("PNG") || text.startsWith("JPG");
    const width = text.includes("wide") ? 3200 : 800;
    const image = (w, h) => ({
      isEmpty: () => !known, getSize: () => ({ width: w, height: h }),
      resize({ width: to }) { resized.push(to); return image(to, Math.round(h * to / w)); },
      toDataURL: () => "data:image/png;base64,UkVEVUNFRA==", toJPEG: () => Buffer.from("JPEG"),
    });
    return image(width, width / 2);
  },
};

const root = await mkdtemp(path.join(os.tmpdir(), "atlas-images-"));
try {
  const folder = path.join(root, "project");
  const outside = path.join(root, "outside");
  await mkdir(path.join(folder, "shots"), { recursive: true });
  await mkdir(path.join(folder, ".git"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(folder, "shots", "cam.png"), "PNG small");
  await writeFile(path.join(folder, "shots", "wide.png"), "PNG wide");
  await writeFile(path.join(folder, "shots", "anim.gif"), "GIF89a");
  await writeFile(path.join(folder, ".git", "logo.png"), "PNG small");
  await writeFile(path.join(outside, "secret.png"), "PNG small");
  let linked = true;
  try { await symlink(outside, path.join(folder, "linked"), "junction"); } catch { linked = false; }

  const folders = { alpha: { ok: true, data: { projectId: "alpha", configured: true, workspacePath: folder, available: true } },
    unbound: { ok: true, data: { projectId: "unbound", configured: false } } };
  const images = createProjectImages({ nativeImage, readProjectFolder: async ({ projectId }) => folders[projectId] });
  const read = (projectId, file) => images.readImage({ projectId, path: file });

  const small = await read("alpha", "shots/cam.png");
  check("a-small-png-goes-as-it-is", small.ok && small.data.dataUrl === `data:image/png;base64,${Buffer.from("PNG small").toString("base64")}`
    && small.data.width === 800 && small.data.shownWidth === 800 && small.data.sizeBytes === 9, small);
  const wide = await read("alpha", "shots/wide.png");
  check("a-wide-png-is-reduced", wide.ok && resized.includes(1600) && wide.data.width === 3200 && wide.data.shownWidth === 1600
    && wide.data.dataUrl === "data:image/png;base64,UkVEVUNFRA==", wide);
  const gif = await read("alpha", "shots/anim.gif");
  check("a-type-the-library-does-not-read-goes-as-it-is", gif.ok && gif.data.dataUrl.startsWith("data:image/gif;base64,")
    && gif.data.width === null, gif);
  const refusals = {
    "../outside/secret.png": "image_path_invalid", "shots/../../outside/secret.png": "image_path_invalid",
    ".git/logo.png": "image_path_invalid", "C:/x.png": "image_path_invalid", "shots\\cam.png": "image_path_invalid",
    "notes.txt": "image_type_unsupported", "shots/none.png": "image_missing",
  };
  const got = {};
  for (const file of Object.keys(refusals)) got[file] = (await read("alpha", file)).error?.code;
  check("paths-outside-private-or-not-pictures-are-refused", JSON.stringify(got) === JSON.stringify(refusals), got);
  check("an-unbound-project-has-no-pictures", (await read("unbound", "shots/cam.png")).error?.code === "project_folder_unavailable");
  if (linked) {
    check("a-link-on-the-way-is-not-followed", (await read("alpha", "linked/secret.png")).error?.code === "image_path_invalid");
  }
  check("the-path-check-alone", imagePathProblem("a/b.JPG") === null && imagePathProblem("") === "image_path_invalid"
    && imagePathProblem("node_modules/x.png") === "image_path_invalid");
} finally {
  await rm(root, { recursive: true, force: true });
}

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, suite: "project-images", status: failed.length ? "failed" : "passed",
  failedCount: failed.length, cases }, null, 2)}\n`);
process.exitCode = failed.length ? 1 : 0;
