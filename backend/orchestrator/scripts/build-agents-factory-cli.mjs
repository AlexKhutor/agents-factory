import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// Builds dist/agents-factory-cli.bundle.mjs (installed in a controller as
// .orchestrator/runtime/agents-factory.mjs). --verify checks that the
// checked-in bundle is byte-identical to a fresh build. The bundle may use Node
// built-ins only: no npm package is installed next to it.

const orchestratorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(orchestratorRoot, "dist");
const outputPath = path.join(outputDirectory, "agents-factory-cli.bundle.mjs");
const argumentsSet = new Set(process.argv.slice(2));

if ([...argumentsSet].some((value) => value !== "--verify")) {
  throw new Error("Only --verify is supported by the agents-factory CLI bundle builder");
}

const verifyOnly = argumentsSet.has("--verify");
await mkdir(outputDirectory, { recursive: true });

const result = await build({
  absWorkingDir: path.resolve(orchestratorRoot, ".."),
  entryPoints: [path.join(orchestratorRoot, "src", "agents-factory-cli.mjs")],
  outfile: outputPath,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  charset: "utf8",
  legalComments: "none",
  sourcemap: false,
  treeShaking: true,
  metafile: true,
  logLevel: verifyOnly ? "silent" : "info",
  write: !verifyOnly,
});

const packages = Object.keys(result.metafile.inputs).filter((input) => /(^|[\\/])node_modules[\\/]/u.test(input));
if (packages.length > 0) {
  throw new Error(`The agents-factory CLI bundle must not include npm packages: ${packages.join(", ")}`);
}

if (verifyOnly) {
  if (result.outputFiles?.length !== 1) {
    throw new Error("agents-factory CLI verification returned an unexpected output set");
  }
  const checkedIn = await readFile(outputPath);
  const generated = Buffer.from(result.outputFiles[0].contents);
  if (!checkedIn.equals(generated)) {
    let firstDifference = 0;
    while (firstDifference < Math.min(checkedIn.length, generated.length)
      && checkedIn[firstDifference] === generated[firstDifference]) firstDifference++;
    throw new Error(`CLI bundle is stale: dist/agents-factory-cli.bundle.mjs`
      + ` (checkedInBytes=${checkedIn.length}, generatedBytes=${generated.length}, firstDifference=${firstDifference})`);
  }
}

const smoke = spawnSync(process.execPath, [outputPath, "version", "--json"], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 15_000,
  env: { ...process.env, AGENTS_FACTORY_HOME: path.join(outputDirectory, ".agents-factory-smoke-instance-absent") },
});
let version = null;
try { version = JSON.parse(smoke.stdout); } catch { version = null; }
if (smoke.status !== 0 || version?.ok !== true || version.command !== "version") {
  throw new Error(`Standalone agents-factory CLI smoke failed (exit ${smoke.status ?? "unknown"}): ${smoke.stdout}${smoke.stderr}`.trim());
}
const refused = spawnSync(process.execPath, [outputPath, "no-such-command", "--json"], {
  encoding: "utf8", windowsHide: true, timeout: 15_000,
});
if (refused.status !== 2 || !refused.stdout.includes("\"code\":\"invalid_arguments\"")) {
  throw new Error(`Standalone agents-factory CLI argument check failed (exit ${refused.status ?? "unknown"})`);
}

if (verifyOnly) console.log("agents_factory_cli_bundle_parity: passed");
