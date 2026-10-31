import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { collectVerifiedReports, normalizeCollectorReports, verifyCatalogRefresh } from "./control-report-collector.mjs";
import {
  assertControlDurableText, assertControlRelativeReference, componentVersion, copyItem, createOutput, decodeText,
  fullPath, guidN, hasInlineMedia, hasProperty, isDirectory, isFile, isNullOrWhiteSpace, moveItem, NET_SPACE, netMatch,
  netTrim, portableRelativePath, property, psArray, psCustomObject, psEquals, psIn, psSort, psString, readAllText,
  readJson, refuse, removeQuietly, resolveControlRelativePath, roundTripStamp, runInProcess, sha256File, sha256Text,
  startsInside, utcStamp, withToolRun, writePsJson,
} from "./desk-task-common.mjs";
import { isDeskRouteSource, resolveControlSourceWorkspace } from "./desk-task-controller.mjs";

// The controller's report collection for desk agents in Node: what
// collect_child_reports_v2.ps1 runs (collect_child_reports.ps1, which imports
// each report with import_agent_report.ps1, then rebuild_knowledge_catalog.ps1)
// with the same checks, files, hashes and tool reports; and the verified
// report list control-cli's report operations take from it
// (control-report-collector.mjs), in-process. Sources of other routes keep
// the configured PowerShell collector.

export const DESK_TASK_COLLECT_VERSION = "v0.1.0";
const REPORT_ID_PATTERN = "^[a-z0-9][a-z0-9.-]{1,95}$";
const SOURCE_ID_PATTERN = "^[a-z0-9][a-z0-9-]{1,63}$";

/** Lines a nested tool printed, as the calling script echoes them ("<prefix>: line"). */
function prefixedOutput(output, prefix) {
  return { lines: [], host(line) { this.lines.push(String(line)); output.host(`${prefix}: ${line}`); } };
}

/** A nested tool run as the scripts run it: its failure becomes the caller's "exit code 1" refusal. */
async function nested(output, prefix, action, failure) {
  const inner = prefixedOutput(output, prefix);
  try {
    return await action(inner);
  } catch (error) {
    output.host(`${prefix}: ${error?.message ?? error}`);
    return refuse(failure);
  }
}

// ---------------------------------------------------------------------------
// import_agent_report.ps1

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Imports one report into knowledge/reports/inbox/<source> with exact-bytes
 * metadata. Parameters: SourcePath, SourceId, SourceRevision, ReportId,
 * SourceDocument, ReportedAtUtc (a Date), RepoRoot, MaxReportBytes.
 */
export async function importAgentReport(parameters, { output, clock = () => new Date() }) {
  for (const name of ["SourcePath", "SourceId", "SourceRevision", "ReportId"]) {
    if (parameters[name] === undefined || parameters[name] === null || parameters[name] === "") {
      refuse(`Cannot process command because of one or more missing mandatory parameters: ${name}.`);
    }
  }
  for (const [name, pattern] of [["SourceId", SOURCE_ID_PATTERN], ["ReportId", REPORT_ID_PATTERN]]) {
    if (!netMatch(pattern, parameters[name])) {
      refuse(`Cannot validate argument on parameter '${name}'. The argument "${parameters[name]}" does not match the`
        + ` "${pattern}" pattern. Supply an argument that matches "${pattern}" and try the command again.`);
    }
  }
  const root = fullPath(parameters.RepoRoot ?? process.cwd());
  const sourceId = psString(parameters.SourceId);
  const sourceRevision = psString(parameters.SourceRevision);
  const reportId = psString(parameters.ReportId);
  const sourceDocumentParameter = psString(parameters.SourceDocument);
  const reportedAt = parameters.ReportedAtUtc instanceof Date ? parameters.ReportedAtUtc : clock();
  const maxReportBytes = parameters.MaxReportBytes ?? 4_194_304;
  return withToolRun({ root, toolName: "import_agent_report", output, parameters: { SourcePath: psString(parameters.SourcePath),
    SourceId: sourceId, SourceRevision: sourceRevision, ReportId: reportId, SourceDocument: sourceDocumentParameter,
    ReportedAtUtc: utcStamp(reportedAt), MaxReportBytes: maxReportBytes } }, async (keep) => {
    if (isNullOrWhiteSpace(sourceRevision)) {
      refuse("SourceRevision must be a commit, content hash, version, or an explicit uncommitted-state marker.");
    }
    const resolvedSourcePath = fullPath(parameters.SourcePath);
    const info = await stat(resolvedSourcePath).catch(() => null);
    if (!info) refuse(`Cannot find path '${resolvedSourcePath}' because it does not exist.`);
    if (!info.isDirectory() && path.extname(resolvedSourcePath).toLowerCase() !== ".md") {
      refuse(`Only Markdown reports are supported: ${resolvedSourcePath}`);
    }
    if (info.isDirectory()) refuse("SourcePath must identify one Markdown report file.");
    if (info.size > maxReportBytes) refuse(`Report exceeds the ${maxReportBytes} byte limit: ${info.size} bytes.`);
    const sourceBytes = await readFile(resolvedSourcePath);
    let sourceText;
    try { sourceText = strictUtf8.decode(sourceBytes); } catch {
      refuse(`Imported reports must be valid UTF-8 Markdown: ${resolvedSourcePath}`);
    }
    assertControlDurableText(sourceText, "imported report");
    const registry = await readJson(path.join(root, "config", "source-registry.json"));
    if (!psArray(registry.sources).some((source) => psEquals(property(source, "id"), sourceId))) {
      refuse(`SourceId '${sourceId}' is not registered in config/source-registry.json.`);
    }
    let sourceDocument = null;
    if (sourceDocumentParameter) {
      assertControlRelativeReference(sourceDocumentParameter, "SourceDocument");
      sourceDocument = sourceDocumentParameter.replaceAll("\\", "/");
    }
    const reportedDate = utcStamp(reportedAt).slice(0, 10);
    const safeFileId = reportId.toLowerCase().replace(/[^a-z0-9.-]/gu, "-");
    const destinationDirectory = path.join(root, "knowledge", "reports", "inbox", sourceId);
    await mkdir(destinationDirectory, { recursive: true });
    const destinationPath = path.join(destinationDirectory, `${reportedDate}-${safeFileId}.md`);
    const metadataPath = `${destinationPath}.meta.json`;
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const byteCount = sourceBytes.length;
    if (await isFile(destinationPath) || await isFile(metadataPath)) {
      if (await isFile(destinationPath) && await isFile(metadataPath)) {
        const destinationSize = (await stat(destinationPath)).size;
        const destinationHash = await sha256File(destinationPath);
        const metadataText = await readAllText(metadataPath);
        assertControlDurableText(metadataText, "imported report metadata");
        const existing = JSON.parse(metadataText);
        const long = (name) => (existing[name] === undefined ? -1 : Number(existing[name]));
        const matches = Number(existing.schemaVersion) === 2 && psEquals(existing.hashContract, "exact-file-bytes-v1")
          && psEquals(existing.reportId, reportId) && psEquals(existing.sourceId, sourceId)
          && psEquals(existing.sourceRevision, sourceRevision) && psEquals(existing.sourceDocument, sourceDocument)
          && long("sourceBytes") === byteCount && psEquals(existing.sourceSha256, sourceHash)
          && long("bytes") === destinationSize && psEquals(existing.sha256, destinationHash);
        if (matches && destinationHash === sourceHash && destinationSize === byteCount) {
          output.host("report_import_action: already-imported");
          return { Action: "already-imported", SourceId: sourceId, ReportId: reportId, DestinationPath: destinationPath,
            MetadataPath: metadataPath, Bytes: destinationSize, Sha256: destinationHash, HashContract: "exact-file-bytes-v1",
            CatalogState: "rebuild-required" };
        }
      }
      refuse("A different report already uses this source/date/report ID. Choose a new ReportId; imported reports are immutable.");
    }
    const metadata = {
      schemaVersion: 2, hashContract: "exact-file-bytes-v1", reportId, documentId: `report:${sourceId}:${reportId}`,
      sourceId, sourceRevision, sourceDocument, reportedAtUtc: utcStamp(reportedAt), importedAtUtc: utcStamp(clock()),
      status: "inbox", documentPath: `reports/inbox/${sourceId}/${reportedDate}-${safeFileId}.md`,
      sourceFileName: path.basename(resolvedSourcePath), sourceBytes: byteCount, sourceSha256: sourceHash,
      bytes: byteCount, sha256: sourceHash,
    };
    const suffix = guidN();
    const temporaryDestination = `${destinationPath}.tmp-${suffix}`;
    const temporaryMetadata = `${metadataPath}.tmp-${suffix}`;
    let committed = false;
    try {
      await copyItem(resolvedSourcePath, temporaryDestination);
      if ((await stat(temporaryDestination)).size !== byteCount || await sha256File(temporaryDestination) !== sourceHash) {
        refuse("Exact-byte report copy verification failed before import.");
      }
      await writePsJson(temporaryMetadata, metadata);
      await moveItem(temporaryDestination, destinationPath);
      committed = true;
      await moveItem(temporaryMetadata, metadataPath);
    } catch (error) {
      if (committed && !(await isFile(metadataPath))) await removeQuietly(destinationPath);
      throw error;
    } finally {
      await removeQuietly(temporaryDestination);
      await removeQuietly(temporaryMetadata);
    }
    keep({});
    output.host("report_import_action: imported");
    output.host(`report_destination: ${destinationPath}`);
    output.host(`report_sha256: ${sourceHash}`);
    return { Action: "imported", SourceId: sourceId, ReportId: reportId, SourceRevision: sourceRevision,
      DestinationPath: destinationPath, MetadataPath: metadataPath, Bytes: byteCount, Sha256: sourceHash,
      HashContract: "exact-file-bytes-v1", CatalogState: "rebuild-required" };
  });
}

// ---------------------------------------------------------------------------
// collect_child_reports.ps1

/** Get-ChildItem -Recurse -File: every file below a folder (linked folders are not entered). */
async function filesBelow(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
      else if (entry.isSymbolicLink() && (await stat(full).catch(() => null))?.isFile()) files.push(full);
    }
  }
  await walk(directory);
  return files;
}

/**
 * Collects the submitted reports of desk agents (one source, optionally one
 * task) and imports each into the controller's knowledge. Parameters:
 * SourceId, TaskId, RepoRoot.
 */
export async function collectChildReports(parameters, { output, clock = () => new Date() }) {
  const root = fullPath(parameters.RepoRoot ?? process.cwd());
  const sourceIdFilter = psString(parameters.SourceId);
  const taskIdFilter = psString(parameters.TaskId);
  return withToolRun({ root, toolName: "collect_child_reports", output, parameters: { SourceId: sourceIdFilter,
    TaskId: taskIdFilter, RepoRoot: psString(parameters.RepoRoot) } }, async () => {
    const registryPath = path.join(root, "config", "source-registry.json");
    if (!(await isFile(registryPath))) refuse(`Source registry was not found: ${registryPath}`);
    const registry = await readJson(registryPath);
    const sources = sourceIdFilter
      ? psArray(registry.sources).filter((source) => psEquals(property(source, "id"), sourceIdFilter))
      : psArray(registry.sources);
    if (sourceIdFilter && sources.length === 0) refuse(`Source '${sourceIdFilter}' is not registered.`);
    const collected = [];
    for (const definition of sources) {
      const currentSourceId = psString(property(definition, "id"));
      const source = await resolveControlSourceWorkspace(root, currentSourceId);
      if (!(await isDirectory(source.reportOutboxPath))) continue;
      const metadataFiles = psSort((await filesBelow(source.reportOutboxPath))
        .filter((file) => path.basename(file).toLowerCase() === "report.json"));
      for (const metadataFile of metadataFiles) {
        const metadataText = await readAllText(metadataFile);
        assertControlDurableText(metadataText, "child report metadata");
        const metadata = JSON.parse(metadataText);
        const taskId = psString(property(metadata, "taskId"));
        if (taskIdFilter && !psEquals(taskId, taskIdFilter)) continue;
        if (!netMatch("^[a-z0-9][a-z0-9.-]{2,95}$", taskId)) refuse(`Invalid taskId in report metadata '${metadataFile}'.`);
        if (!psEquals(property(metadata, "sourceId"), currentSourceId)) {
          refuse(`Report sourceId does not match '${currentSourceId}': ${metadataFile}`);
        }
        const status = psString(property(metadata, "status"));
        if (!psIn(status, ["completed", "blocked", "failed"])) refuse(`Unsupported report status '${status}' in '${metadataFile}'.`);
        const sourceRevision = psString(property(metadata, "sourceRevision"));
        if (isNullOrWhiteSpace(sourceRevision)) refuse(`Report requires sourceRevision: ${metadataFile}`);
        // Get-ControlObjectPropertyValue: the default only for a missing property.
        const reportId = psString(hasProperty(metadata, "reportId") ? property(metadata, "reportId") : `${taskId}-report`);
        const reportFileName = psString(hasProperty(metadata, "reportFile") ? property(metadata, "reportFile") : "report.md");
        assertControlRelativeReference(reportFileName, "reportFile");
        const reportPath = await resolveControlRelativePath(path.dirname(metadataFile), reportFileName);
        if (path.extname(reportPath).toLowerCase() !== ".md") refuse(`Child report must be Markdown: ${reportPath}`);
        assertControlDurableText(await readAllText(reportPath), "child report");
        const reportHash = await sha256File(reportPath);
        const declaredReportHash = psString(property(metadata, "reportSha256"));
        if (declaredReportHash && declaredReportHash.toLowerCase() !== reportHash) {
          refuse(`Child report hash mismatch for task '${taskId}'.`);
        }
        const controlTaskPath = path.join(root, "coordination", "tasks", "dispatched", taskId, "task.json");
        if (!(await isFile(controlTaskPath))) refuse(`No coordinator task package exists for report task '${taskId}'.`);
        const controlTaskHash = await sha256File(controlTaskPath);
        const reportedTaskHash = psString(property(metadata, "taskSha256"));
        if (!reportedTaskHash || reportedTaskHash.toLowerCase() !== controlTaskHash) {
          refuse(`Report task hash does not match coordinator task '${taskId}'.`);
        }
        let sourceDocument = psString(property(metadata, "sourceDocument"));
        if (isNullOrWhiteSpace(sourceDocument)) {
          sourceDocument = portableRelativePath(source.workspacePath, reportPath,
            (outside) => `Target path is outside the requested base path: ${outside}`);
        }
        assertControlRelativeReference(sourceDocument, "sourceDocument");
        const reportedAtText = psString(property(metadata, "reportedAtUtc"));
        let reportedAt;
        if (reportedAtText) {
          const parsed = Date.parse(reportedAtText);
          if (Number.isNaN(parsed)) refuse("String was not recognized as a valid DateTime.");
          reportedAt = new Date(parsed);
        } else reportedAt = clock();
        await nested(output, "report_import", (inner) => importAgentReport({ SourcePath: reportPath, SourceId: currentSourceId,
          SourceRevision: sourceRevision, ReportId: reportId, SourceDocument: sourceDocument,
          ReportedAtUtc: new Date(Date.parse(roundTripStamp(reportedAt))), RepoRoot: root }, { output: inner, clock }),
        `Import failed for report '${reportId}' with exit code 1.`);
        const safeReportId = reportId.toLowerCase().replace(/[^a-z0-9.-]/gu, "-");
        collected.push(psCustomObject({ SourceId: currentSourceId, TaskId: taskId, ReportId: reportId, Status: status,
          SourceRevision: sourceRevision, ReportSha256: reportHash,
          ImportedPath: path.join(root, "knowledge", "reports", "inbox", currentSourceId,
            `${utcStamp(reportedAt).slice(0, 10)}-${safeReportId}.md`) }));
      }
    }
    output.host(`collected_report_count: ${collected.length}`);
    for (const item of collected) output.host(`collected_report: ${item.SourceId}/${item.TaskId} [${item.Status}]`);
    return { Reports: collected, ReportCount: collected.length };
  });
}

// ---------------------------------------------------------------------------
// rebuild_knowledge_catalog.ps1

// (?m)^#\s+(.+?)\s*$ of .NET: ^ and $ at line feeds only, . is anything but a line feed.
const TITLE = new RegExp(`(?:^|(?<=\\n))#${NET_SPACE}+([^\\n]+?)${NET_SPACE}*(?=\\n|$)`, "u");
const OBSIDIAN = `${path.sep}.obsidian${path.sep}`.toLowerCase();
const SUPPORTED = [".md", ".json", ".yaml", ".yml", ".txt"];

/** The knowledge catalog (knowledge/catalog.json). Parameters: RepoRoot, KnowledgeRoot, MaxDocumentBytes. */
export async function rebuildKnowledgeCatalog(parameters, { output }) {
  const root = fullPath(parameters.RepoRoot ?? process.cwd());
  const knowledgeRoot = parameters.KnowledgeRoot ? fullPath(parameters.KnowledgeRoot) : path.join(root, "knowledge");
  const maxDocumentBytes = parameters.MaxDocumentBytes ?? 4_194_304;
  return withToolRun({ root, toolName: "rebuild_knowledge_catalog", output, parameters: {
    RepoRoot: psString(parameters.RepoRoot), KnowledgeRoot: psString(parameters.KnowledgeRoot), MaxDocumentBytes: maxDocumentBytes,
  } }, async () => {
    if (!(await isDirectory(knowledgeRoot))) refuse(`Knowledge root was not found: ${knowledgeRoot}`);
    if (!startsInside(knowledgeRoot, root)) refuse("Knowledge root must stay inside the project repository.");
    const catalogPath = path.join(knowledgeRoot, "catalog.json");
    const registryPath = path.join(knowledgeRoot, "document-registry.json");
    if (!(await isFile(registryPath))) refuse(`Document registry was not found: ${registryPath}`);
    const registry = await readJson(registryPath);
    const registeredIds = new Map();
    const registeredPaths = new Map();
    for (const document of psArray(registry.documents)) {
      const documentId = psString(property(document, "id"));
      const documentPath = psString(property(document, "path")).replaceAll("\\", "/");
      if (isNullOrWhiteSpace(documentId) || isNullOrWhiteSpace(documentPath)) {
        refuse("Every registered document requires non-empty id and path fields.");
      }
      if (registeredIds.has(documentId.toLowerCase())) refuse(`Duplicate registered document ID: ${documentId}`);
      if (registeredPaths.has(documentPath.toLowerCase())) refuse(`Duplicate registered document path: ${documentPath}`);
      registeredIds.set(documentId.toLowerCase(), documentPath);
      registeredPaths.set(documentPath.toLowerCase(), document);
      if (!(await isFile(path.join(knowledgeRoot, ...documentPath.split("/"))))) {
        refuse(`Registered document was not found: ${documentPath}`);
      }
    }
    const all = (await filesBelow(knowledgeRoot)).filter((file) => !file.toLowerCase().includes(OBSIDIAN));
    const reportDocuments = new Map();
    for (const metadataFile of all.filter((file) => path.basename(file).toLowerCase().endsWith(".meta.json"))) {
      const metadata = await readJson(metadataFile);
      const documentPath = psString(property(metadata, "documentPath")).replaceAll("\\", "/");
      const documentId = psString(property(metadata, "documentId"));
      if (documentPath && documentId) {
        const known = reportDocuments.get(documentPath.toLowerCase());
        if (known !== undefined && !psEquals(known, documentId)) refuse(`Conflicting report metadata for '${documentPath}'.`);
        reportDocuments.set(documentPath.toLowerCase(), documentId);
      }
    }
    const files = psSort(all.filter((file) => file.toLowerCase() !== catalogPath.toLowerCase()
      && path.basename(file).toLowerCase() !== ".gitkeep"));
    const relativeOf = (file) => portableRelativePath(knowledgeRoot, file, (outside) => outside);
    const entries = [];
    let totalBytes = 0;
    for (const file of files) {
      const name = path.basename(file);
      const extension = (name.startsWith(".") && name.lastIndexOf(".") === 0 ? name : path.extname(name)).toLowerCase();
      if (!SUPPORTED.includes(extension)) {
        refuse(`Unsupported knowledge file '${relativeOf(file)}'. Store binary artifacts under artifacts/ and link to them.`);
      }
      const { size } = await stat(file);
      if (size > maxDocumentBytes) {
        refuse(`Knowledge document exceeds the ${maxDocumentBytes} byte limit: ${relativeOf(file)} (${size} bytes).`);
      }
      const bytes = await readFile(file);
      const textValue = decodeText(bytes);
      if (hasInlineMedia(textValue)) refuse(`Inline media data URI is forbidden in knowledge document: ${relativeOf(file)}`);
      const relativePath = relativeOf(file);
      const title = TITLE.exec(textValue);
      const registered = registeredPaths.get(relativePath.toLowerCase()) ?? null;
      const reportDocument = reportDocuments.get(relativePath.toLowerCase());
      const documentId = registered ? psString(property(registered, "id"))
        : reportDocument !== undefined ? psString(reportDocument) : `path:${relativePath.toLowerCase()}`;
      entries.push(psCustomObject({
        documentId,
        path: relativePath,
        type: registered ? psString(property(registered, "type")) : "unregistered",
        status: registered ? psString(property(registered, "status")) : null,
        title: title ? netTrim(title[1]) : null,
        bytes: size,
        sha256: (await sha256File(file)),
        registered: registered !== null || reportDocument !== undefined,
      }));
      totalBytes += size;
    }
    const contentSetSha256 = sha256Text(entries.map((entry) => `${entry.path}\t${entry.sha256}`).join("\n"));
    const catalog = { schemaVersion: 1, generatedBy: "rebuild_knowledge_catalog",
      generatorVersion: await componentVersion(root, "rebuild_knowledge_catalog"), documentCount: entries.length, totalBytes,
      contentSetSha256, documents: entries };
    const temporary = `${catalogPath}.tmp-${guidN()}`;
    try {
      await writePsJson(temporary, catalog);
      await moveItem(temporary, catalogPath, { force: true });
    } finally {
      await removeQuietly(temporary);
    }
    output.host(`knowledge_catalog: ${catalogPath}`);
    output.host(`knowledge_documents: ${entries.length}`);
    output.host(`knowledge_bytes: ${totalBytes}`);
    output.host(`knowledge_content_set_sha256: ${contentSetSha256}`);
    return { KnowledgeRoot: knowledgeRoot, CatalogPath: catalogPath, DocumentCount: entries.length,
      RegisteredCount: entries.filter((entry) => entry.registered).length, TotalBytes: totalBytes,
      ContentSetSha256: contentSetSha256 };
  });
}

// ---------------------------------------------------------------------------
// collect_child_reports_v2.ps1

async function copyVerifiedCompanion(metadataDirectory, relativePath, declaredHash, destinationPath, description) {
  assertControlRelativeReference(relativePath, description);
  const sourcePath = await resolveControlRelativePath(metadataDirectory, relativePath);
  return copyHashedArtifact(sourcePath, destinationPath, description, declaredHash);
}

async function copyHashedArtifact(sourcePath, destinationPath, description, declaredHash = null) {
  const textValue = await readAllText(sourcePath);
  assertControlDurableText(textValue, description);
  const actualHash = await sha256File(sourcePath);
  if (declaredHash !== null && actualHash !== declaredHash.toLowerCase()) refuse(`${description} hash mismatch.`);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  if (await isFile(destinationPath)) {
    if (await sha256File(destinationPath) !== actualHash) {
      refuse(`A different immutable ${description} already exists: ${destinationPath}`);
    }
  } else {
    const temporary = `${destinationPath}.tmp-${guidN()}`;
    try {
      await copyItem(sourcePath, temporary);
      await moveItem(temporary, destinationPath);
    } finally {
      await removeQuietly(temporary);
    }
  }
  return { Path: destinationPath, Sha256: actualHash, Value: JSON.parse(textValue) };
}

const int = (value) => (value === null || value === undefined ? 0 : Math.round(Number(value)));

function assertProgressCompanion(value, sourceId, taskId, status) {
  const expected = psEquals(status, "completed") ? "completed" : psEquals(status, "blocked") ? "blocked" : "failed";
  if (int(value.schemaVersion) !== 1 || !psIn(psString(value.contractVersion), ["v0.2.0", "v0.3.0"])
      || !psEquals(value.sourceId, sourceId) || !psEquals(value.taskId, taskId) || !psEquals(value.state, expected)
      || int(value.sequence) < 1) {
    refuse(`Child progress identity or terminal state does not match '${sourceId}/${taskId}'.`);
  }
  if (psArray(value.plan).length > 100 || psArray(value.agents).length > 256 || psArray(value.stopEvents).length > 100) {
    refuse(`Child progress exceeds the bounded collection limits for '${sourceId}/${taskId}'.`);
  }
  if (psEquals(value.contractVersion, "v0.3.0")) {
    if (!value.workflow || !psEquals(value.workflow.policy, "intent-confirm-plan-v1")) {
      refuse(`Child progress v0.3.0 is missing its workflow policy for '${sourceId}/${taskId}'.`);
    }
    if (psEquals(status, "completed") && (!psEquals(value.workflow.lifecycleStage, "complete")
        || !psEquals(value.workflow.plan?.status, "confirmed") || isNullOrWhiteSpace(psString(value.workflow.plan?.approvalPath)))) {
      refuse(`Completed child progress v0.3.0 lacks final confirmed-plan evidence for '${sourceId}/${taskId}'.`);
    }
  }
}

function assertExecutionSummaryCompanion(value, sourceId, taskId, status, sourceRevision) {
  if (int(value.schemaVersion) !== 1 || !psEquals(value.stage, "child-execution") || !psEquals(value.sourceId, sourceId)
      || !psEquals(value.taskId, taskId) || !psEquals(value.outcome, status) || !psEquals(value.sourceRevision, sourceRevision)) {
    refuse(`Child execution summary does not match '${sourceId}/${taskId}' metadata.`);
  }
  if (psArray(value.completedSteps).length > 100 || psArray(value.remainingSteps).length > 100
      || psArray(value.agentResults).length > 256 || psArray(value.stopEvents).length > 100) {
    refuse(`Child execution summary exceeds the bounded collection limits for '${sourceId}/${taskId}'.`);
  }
}

function assertCompletedCompanions(progress, summary, sourceId, taskId) {
  const unfinished = psArray(progress.plan).filter((step) => !psEquals(step?.state, "completed"));
  if (unfinished.length > 0 || psArray(summary.remainingSteps).length > 0) {
    refuse(`Completed child report contains unfinished plan evidence for '${sourceId}/${taskId}'.`);
  }
}

/**
 * The verified collection: the legacy collection and import, the report's
 * companions (progress, execution summary, an optional correction) copied
 * beside the imported report and checked, then the knowledge catalog.
 * Parameters: SourceId, TaskId, RepoRoot. The result is the tool report's.
 */
export async function collectChildReportsV2(parameters, { output, clock = () => new Date() }) {
  const root = fullPath(parameters.RepoRoot ?? process.cwd());
  const sourceIdFilter = psString(parameters.SourceId);
  const taskIdFilter = psString(parameters.TaskId);
  return withToolRun({ root, toolName: "collect_child_reports_v2", output,
    parameters: { SourceId: sourceIdFilter, TaskId: taskIdFilter } }, async () => {
    const legacy = await nested(output, "legacy_collector", (inner) => collectChildReports({ RepoRoot: root,
      ...(sourceIdFilter ? { SourceId: sourceIdFilter } : {}), ...(taskIdFilter ? { TaskId: taskIdFilter } : {}) },
    { output: inner, clock }), "Legacy report collector failed with exit code 1.");
    const augmented = [];
    for (const entry of psArray(legacy.Reports)) {
      const entrySource = psString(entry.SourceId);
      const entryTask = psString(entry.TaskId);
      const entryStatus = psString(entry.Status);
      const entryRevision = psString(entry.SourceRevision);
      const source = await resolveControlSourceWorkspace(root, entrySource);
      const metadataPath = path.join(source.reportOutboxPath, entryTask, "report.json");
      if (!(await isFile(metadataPath))) refuse(`Child report metadata was not found: ${metadataPath}`);
      const metadataText = await readAllText(metadataPath);
      assertControlDurableText(metadataText, "child report metadata");
      const metadata = JSON.parse(metadataText);
      const contractVersion = psString(metadata.contractVersion);
      let progressImport = null;
      let summaryImport = null;
      let correctionImport = null;
      let correctedProgressImport = null;
      let correctedSummaryImport = null;
      if (psEquals(contractVersion, "v0.2.0")) {
        for (const required of ["progressFile", "progressSha256", "executionSummaryFile", "executionSummarySha256"]) {
          if (property(metadata, required) === undefined || isNullOrWhiteSpace(psString(property(metadata, required)))) {
            refuse(`Report v0.2.0 is missing '${required}': ${metadataPath}`);
          }
        }
        const importedReportPath = fullPath(psString(entry.ImportedPath));
        const baseName = path.basename(importedReportPath, path.extname(importedReportPath));
        const importDirectory = path.dirname(importedReportPath);
        const metadataDirectory = path.dirname(metadataPath);
        progressImport = await copyVerifiedCompanion(metadataDirectory, psString(metadata.progressFile),
          psString(metadata.progressSha256), path.join(importDirectory, `${baseName}.progress.json`), "child progress");
        summaryImport = await copyVerifiedCompanion(metadataDirectory, psString(metadata.executionSummaryFile),
          psString(metadata.executionSummarySha256), path.join(importDirectory, `${baseName}.execution-summary.json`),
          "child execution summary");
        assertProgressCompanion(progressImport.Value, entrySource, entryTask, entryStatus);
        assertExecutionSummaryCompanion(summaryImport.Value, entrySource, entryTask, entryStatus, entryRevision);
        const correctionDirectory = path.join(path.dirname(source.reportOutboxPath), "corrections", entryTask);
        const correctionSourcePath = path.join(correctionDirectory, "correction.json");
        if (await isDirectory(correctionDirectory) && !(await isFile(correctionSourcePath))) {
          refuse(`Child report correction directory is incomplete: ${correctionDirectory}`);
        }
        if (await isFile(correctionSourcePath)) {
          correctionImport = await copyHashedArtifact(correctionSourcePath,
            path.join(importDirectory, `${baseName}.correction.json`), "child report correction");
          const correction = correctionImport.Value;
          if (int(correction.schemaVersion) !== 1 || !psEquals(correction.contractVersion, "v0.1.0")
              || !psEquals(correction.kind, "terminal-plan-step-state-correction")
              || !psEquals(correction.reasonCode, "completed-plan-step-state-omission")
              || !psEquals(correction.sourceId, entrySource) || !psEquals(correction.taskId, entryTask)
              || !psEquals(correction.sourceRevision, entryRevision)
              || !psEquals(correction.original?.reportMetadataSha256, await sha256File(metadataPath))
              || !psEquals(correction.original?.reportSha256, entry.ReportSha256)
              || !psEquals(correction.original?.progressSha256, progressImport.Sha256)
              || !psEquals(correction.original?.executionSummarySha256, summaryImport.Sha256)
              || !psEquals(correction.step?.fromState, "running") || !psEquals(correction.step?.toState, "completed")) {
            refuse(`Child report correction identity or original hashes do not match '${entrySource}/${entryTask}'.`);
          }
          correctedProgressImport = await copyVerifiedCompanion(correctionDirectory,
            psString(correction.corrected?.progressFile), psString(correction.corrected?.progressSha256),
            path.join(importDirectory, `${baseName}.corrected-progress.json`), "corrected child progress");
          correctedSummaryImport = await copyVerifiedCompanion(correctionDirectory,
            psString(correction.corrected?.executionSummaryFile), psString(correction.corrected?.executionSummarySha256),
            path.join(importDirectory, `${baseName}.corrected-execution-summary.json`), "corrected child execution summary");
          assertProgressCompanion(correctedProgressImport.Value, entrySource, entryTask, entryStatus);
          assertExecutionSummaryCompanion(correctedSummaryImport.Value, entrySource, entryTask, entryStatus, entryRevision);
          const unfinished = psArray(progressImport.Value.plan).filter((step) => !psEquals(step?.state, "completed"));
          const remaining = psArray(summaryImport.Value.remainingSteps);
          if (unfinished.length !== 1 || !psEquals(unfinished[0].id, correction.step?.id)
              || !psEquals(unfinished[0].title, correction.step?.title) || !psEquals(unfinished[0].state, "running")
              || remaining.length !== 1 || !psEquals(remaining[0], correction.step?.title)) {
            refuse("Child report correction is broader than one omitted running step.");
          }
          assertCompletedCompanions(correctedProgressImport.Value, correctedSummaryImport.Value, entrySource, entryTask);
        } else {
          assertCompletedCompanions(progressImport.Value, summaryImport.Value, entrySource, entryTask);
        }
      }
      augmented.push(psCustomObject({
        SourceId: entrySource, TaskId: entryTask, ReportId: psString(entry.ReportId), Status: entryStatus,
        SourceRevision: entryRevision, ReportSha256: psString(entry.ReportSha256), ImportedPath: psString(entry.ImportedPath),
        ReportContractVersion: contractVersion,
        ProgressPath: progressImport?.Path ?? null, ProgressSha256: progressImport?.Sha256 ?? null,
        ExecutionSummaryPath: summaryImport?.Path ?? null, ExecutionSummarySha256: summaryImport?.Sha256 ?? null,
        CorrectionPath: correctionImport?.Path ?? null, CorrectionSha256: correctionImport?.Sha256 ?? null,
        CorrectedProgressPath: correctedProgressImport?.Path ?? null,
        CorrectedProgressSha256: correctedProgressImport?.Sha256 ?? null,
        CorrectedExecutionSummaryPath: correctedSummaryImport?.Path ?? null,
        CorrectedExecutionSummarySha256: correctedSummaryImport?.Sha256 ?? null,
      }));
    }
    let catalogRefresh = { Status: "not-required" };
    if (augmented.length > 0) {
      const rebuilt = await nested(output, "catalog_rebuild", (inner) => rebuildKnowledgeCatalog({ RepoRoot: root },
        { output: inner }), "Knowledge catalog rebuild failed with exit code 1.");
      const catalogPath = fullPath(psString(rebuilt.CatalogPath));
      if (!startsInside(catalogPath, root)) refuse("Knowledge catalog path escapes the controller workspace.");
      const catalog = await readJson(catalogPath);
      if (int(catalog.schemaVersion) !== 1 || int(catalog.documentCount) !== int(rebuilt.DocumentCount)
          || Number(catalog.totalBytes) !== Number(rebuilt.TotalBytes)
          || !psEquals(catalog.contentSetSha256, rebuilt.ContentSetSha256)) {
        refuse("Knowledge catalog does not match its rebuild report.");
      }
      catalogRefresh = { Status: "success", CatalogPath: catalogPath, CatalogSha256: await sha256File(catalogPath),
        DocumentCount: int(catalog.documentCount), TotalBytes: Number(catalog.totalBytes),
        ContentSetSha256: psString(catalog.contentSetSha256) };
    }
    output.host(`collected_v2_report_count: ${augmented.length}`);
    return { Reports: augmented, ReportCount: augmented.length, CatalogRefresh: catalogRefresh };
  });
}

// ---------------------------------------------------------------------------
// control-cli: the verified reports of a collection

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function portableReference(root, candidate, label) {
  const resolved = path.resolve(candidate);
  if (!pathInside(root, resolved)) throw new Error(`${label} is outside the controller workspace`);
  return path.relative(root, resolved).replaceAll(path.sep, "/");
}

const ID = /^[a-z0-9][a-z0-9._-]{0,95}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * What collectVerifiedReports (control-report-collector.mjs) returns for a
 * collection, with the collection run in-process by collectChildReportsV2
 * instead of the configured collector command.
 */
export async function collectDeskVerifiedReports({ controllerRoot, collector = null, sourceId = null, taskId = null,
  logger = async () => {}, clock }) {
  const root = path.resolve(controllerRoot);
  await logger("control_collector_started", { executable: "node:desk-task-collect", argumentCount: 0,
    sourceId: sourceId ?? null, taskId: taskId ?? null });
  const output = createOutput();
  const result = await collectChildReportsV2({ RepoRoot: root, ...(sourceId ? { SourceId: sourceId } : {}),
    ...(taskId ? { TaskId: taskId } : {}) }, { output, ...(clock ? { clock } : {}) });
  const collected = normalizeCollectorReports(result.Reports);
  const reports = [];
  const sha256 = (file) => sha256File(file);
  for (const entry of collected) {
    const entrySource = entry.SourceId;
    const entryTask = entry.TaskId;
    const reportId = entry.ReportId ?? `${entryTask}-report`;
    const reportSha256 = String(entry.ReportSha256 ?? "").toLowerCase();
    const sourceRevision = String(entry.SourceRevision ?? "").trim();
    if (!ID.test(entrySource ?? "") || !ID.test(entryTask ?? "")) {
      throw new Error(`Collector returned an invalid source/task identity: ${entrySource}/${entryTask}`);
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(reportId ?? "")) throw new Error(`Collector returned an invalid report identity: ${reportId}`);
    if (!SHA256.test(reportSha256)) throw new Error(`Collector returned an invalid report hash for ${entrySource}/${entryTask}`);
    if (!sourceRevision) throw new Error(`Collected report requires sourceRevision for ${entrySource}/${entryTask}`);
    const importedPath = path.resolve(root, entry.ImportedPath);
    const importedReference = portableReference(root, importedPath, "Imported report");
    const taskPath = path.resolve(root, collector?.taskRoot || "coordination/tasks/dispatched", entryTask, "task.json");
    const taskReference = portableReference(root, taskPath, "Task packet");
    const task = JSON.parse(await readFile(taskPath, "utf8"));
    if (task.taskId !== entryTask || task.targetId !== entrySource) {
      throw new Error(`Collector result does not match task ownership for ${entrySource}/${entryTask}`);
    }
    if (await sha256(importedPath) !== reportSha256) {
      throw new Error(`Imported report hash changed after collection for ${entrySource}/${entryTask}`);
    }
    const taskSha256 = await sha256(taskPath);
    const evidence = [
      { kind: "report", path: importedReference, sha256: reportSha256 },
      { kind: "artifact", path: taskReference, sha256: taskSha256 },
    ];
    for (const [kind, filePath, declaredHash] of [
      ["progress", entry.ProgressPath, entry.ProgressSha256],
      ["execution-summary", entry.ExecutionSummaryPath, entry.ExecutionSummarySha256],
      ["report-correction", entry.CorrectionPath, entry.CorrectionSha256],
      ["corrected-progress", entry.CorrectedProgressPath, entry.CorrectedProgressSha256],
      ["corrected-execution-summary", entry.CorrectedExecutionSummaryPath, entry.CorrectedExecutionSummarySha256],
    ]) {
      if (!filePath) continue;
      const companionPath = path.resolve(root, filePath);
      const reference = portableReference(root, companionPath, kind);
      const actual = await sha256(companionPath);
      if (actual !== String(declaredHash ?? "").toLowerCase()) {
        throw new Error(`${kind} hash changed after collection for ${entrySource}/${entryTask}`);
      }
      evidence.push({ kind, path: reference, sha256: actual });
    }
    reports.push({
      sourceId: entrySource, taskId: entryTask, reportId, title: task.title || entryTask,
      reportStatus: entry.Status ?? "completed", reportSha256, taskSha256, sourceRevision,
      reportPath: importedReference, taskPath: taskReference, decisionPath: `coordination/reviews/${entryTask}/decision.json`,
      priority: ({ critical: 200, high: 100, normal: 0, low: -100 })[task.priority] ?? 0,
      dispatchSequence: Number.isFinite(Date.parse(task.dispatchedAtUtc)) ? Date.parse(task.dispatchedAtUtc) : 0,
      dependencies: task.dependsOnTaskIds ?? [],
      plan: [
        { id: "verify-integrity", title: "Verify immutable task and report integrity", state: "pending" },
        { id: "apply-operation", title: "Apply the selected report operation", state: "pending" },
      ],
      summary: `Verified report from ${entrySource} is waiting for a selected report operation.`,
      evidence,
    });
  }
  const catalogRefresh = await verifyCatalogRefresh(root, result, collected);
  await logger("control_collector_completed", { reportCount: reports.length, catalogRefresh });
  return reports;
}

/**
 * The report collection of control-cli by route: a desk agent's reports are
 * collected in-process (no collector command needed); every other source
 * with the configured collector (the PowerShell scripts of the Codex era).
 */
export async function collectReportsByRoute(input, { fallback = collectVerifiedReports } = {}) {
  if (input?.sourceId && await isDeskRouteSource(input.controllerRoot, input.sourceId)) {
    return collectDeskVerifiedReports(input);
  }
  return fallback(input);
}

/**
 * The control cycle's collection of every source: in-process when every
 * registered source is a desk agent, otherwise the configured collector
 * (which also covers desk agents). Nothing without a configured collector.
 */
export async function collectAllReportsByRoute(input, { fallback = collectVerifiedReports } = {}) {
  if (!input?.collector) return [];
  let sources = [];
  try {
    sources = psArray((await readJson(path.join(path.resolve(input.controllerRoot), "config", "source-registry.json"))).sources);
  } catch {
    return fallback(input);
  }
  const ids = sources.map((source) => psString(property(source, "id")));
  if (ids.length === 0) return fallback(input);
  for (const id of ids) if (!(await isDeskRouteSource(input.controllerRoot, id))) return fallback(input);
  const reports = [];
  for (const id of ids) reports.push(...await collectDeskVerifiedReports({ ...input, sourceId: id, taskId: null }));
  return reports;
}

/** The scripts by name, for a runner that is handed a script path and -File arguments. */
export async function runDeskCollector(parameters, { clock } = {}) {
  return runInProcess((output) => collectChildReportsV2(parameters, { output, ...(clock ? { clock } : {}) }));
}

