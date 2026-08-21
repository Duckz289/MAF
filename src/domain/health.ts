import { createHash } from "node:crypto";
import { deriveArchitectureGovernance } from "./architecture";
import { parseFilePatches } from "./diff-parse";
import type { RepositorySnapshot, TelemetryRecord } from "./ports";
import { countCrossModuleEdges } from "./risk";
import { redactSensitiveText } from "./security";

/**
 * M11 Codebase Health Ledger: longitudinal structural and operational trends, measured — never a
 * composite "health score". Every metric is deterministic, computed from repository evidence
 * (snapshot, patch) or recorded telemetry, and every unmeasured group stays absent rather than
 * defaulting to a good value: unknown remains unknown. Changeability is the first-class concern —
 * the ledger exists to make structural decay visible over time, and specifically to make it
 * visible even when run outcomes look fine because stronger models are masking the decay.
 */

export interface StructuralHealthMetrics {
  /** Module count and total tracked files at this revision. */
  moduleCount: number;
  fileCount: number;
  /** Files in the largest module — the module-growth trend. */
  largestModuleFiles: number;
  largestModule: string;
  /** Cross-module IMPORTS edges over the parsed subset — the coupling trend. */
  crossModuleEdges: number;
  /** Import cycles: number of SCCs with >1 file, and the largest SCC's file count. */
  importCycleCount: number;
  largestCycleFiles: number;
  /** Parsed-file coverage: cycles/coupling are only meaningful over what was actually parsed. */
  parsedCoverage: number;
  /** Successful parse scope, never attempted-but-unreadable files. */
  parsedScopeFingerprint: string;
  /** Inventory and parse truncation are explicit; incomplete evidence cannot imply clean structure. */
  inventoryTruncated: boolean;
  scopeTruncated: boolean;
  fileScanComplete: boolean;
  /** Import relations come from the bounded deterministic syntax scanner, not a full compiler. */
  relationEvidenceBasis: "BOUNDED_PATTERN_SCAN";
}

export interface ChangeHealthMetrics {
  /** Textual diff coverage; binary/gitlink/rename-only entries make conclusions incomplete. */
  inspectableFiles: number;
  uninspectableFiles: number;
  changeEvidenceComplete: boolean;
  uninspectableDetails: string[];
  /** Layering violations introduced by this diff (M7 rule, reused verbatim). */
  architectureViolations: number;
  violationDetails: string[];
  /** Added unsafe type escapes: `: any`, `as any`, `as unknown as`, `@ts-expect-error`, `@ts-expect-error`. */
  unsafeTypeEscapes: number;
  escapeDetails: string[];
  /** Added skipped/todo tests: `it.skip`, `test.skip`, `describe.skip`, `xit(`, `xdescribe(`, `.todo(`. */
  skippedTests: number;
  skipDetails: string[];
  /** Added relative imports plus keys added inside package.json dependency sections. */
  addedImports: number;
  addedPackageDependencies: number;
  /** Files whose added code adds >= 10 branch points — crude deterministic complexity hotspots. */
  complexityHotspots: string[];
  /** Duplicate added line blocks (>= 5 lines) appearing in 2+ distinct files of the same patch. */
  duplicatedBlocks: number;
  duplicationEvidence: string[];
}

export interface OperationalHealthMetrics {
  /** Averages per completed task over the ledger window. */
  tokensPerTask: number;
  retriesPerTask: number;
  toolCallsPerTask: number | null;
  contextCharsPerTask: number | null;
  verifierFailuresPerTask: number;
  /** Share of tasks that escalated to stricter/stronger execution (strict re-expansions). */
  frontierEscalationRate: number;
  /** Model mix over the window, so decay-vs-model-strength attribution stays visible. */
  modelMix: Record<string, number>;
  taskCount: number;
}

export interface HealthSample {
  /** Stable opaque repository identity. Samples from different projects are never compared. */
  projectId: string;
  /** Resolved base commit for the candidate workspace, not an unresolved branch/HEAD label. */
  revision: string;
  timestamp: string;
  runId: string;
  candidateId: string;
  candidateDigest: string;
  /** Explicitly prevents this pre-merge candidate observation from impersonating deployed state. */
  evidenceBasis: "VERIFIED_CANDIDATE";
  /** Structural state is captured before candidate execution; change state is the verified diff. */
  structuralBasis: "BASE_REVISION";
  changeBasis: "VERIFIED_CANDIDATE_DIFF";
  structural?: StructuralHealthMetrics | undefined;
  change?: ChangeHealthMetrics | undefined;
  operational?: OperationalHealthMetrics | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Runtime guard at persistence boundaries; malformed payloads are rejected, never trended. */
export const isHealthSample = (value: unknown): value is HealthSample => {
  if (!isRecord(value)) return false;
  if (typeof value.projectId !== "string" || value.projectId.length === 0) return false;
  if (typeof value.runId !== "string" || value.runId.length === 0) return false;
  if (typeof value.candidateId !== "string" || value.candidateId.length === 0) return false;
  if (typeof value.candidateDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.candidateDigest))
    return false;
  if (value.evidenceBasis !== "VERIFIED_CANDIDATE") return false;
  if (value.structuralBasis !== "BASE_REVISION") return false;
  if (value.changeBasis !== "VERIFIED_CANDIDATE_DIFF") return false;
  if (
    typeof value.timestamp !== "string" ||
    value.timestamp.length === 0 ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    new Date(value.timestamp).toISOString() !== value.timestamp
  )
    return false;
  if (
    typeof value.revision !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.revision)
  )
    return false;
  if (value.structural !== undefined) {
    if (!isRecord(value.structural)) return false;
    for (const key of [
      "moduleCount",
      "fileCount",
      "largestModuleFiles",
      "crossModuleEdges",
      "importCycleCount",
      "largestCycleFiles",
      "parsedCoverage",
    ]) {
      if (!isFiniteNonnegative(value.structural[key])) return false;
    }
    if (typeof value.structural.largestModule !== "string") return false;
    if ((value.structural.parsedCoverage as number) > 1) return false;
    if (
      typeof value.structural.parsedScopeFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.structural.parsedScopeFingerprint)
    )
      return false;
    for (const key of ["inventoryTruncated", "scopeTruncated", "fileScanComplete"]) {
      if (typeof value.structural[key] !== "boolean") return false;
    }
    if (value.structural.relationEvidenceBasis !== "BOUNDED_PATTERN_SCAN") return false;
    if (
      value.structural.fileScanComplete === true &&
      ((value.structural.parsedCoverage as number) !== 1 ||
        value.structural.inventoryTruncated === true ||
        value.structural.scopeTruncated === true)
    )
      return false;
  }
  if (value.change !== undefined) {
    if (!isRecord(value.change)) return false;
    for (const key of [
      "architectureViolations",
      "inspectableFiles",
      "uninspectableFiles",
      "unsafeTypeEscapes",
      "skippedTests",
      "addedImports",
      "addedPackageDependencies",
      "duplicatedBlocks",
    ]) {
      if (!isFiniteNonnegative(value.change[key])) return false;
    }
    if (typeof value.change.changeEvidenceComplete !== "boolean") return false;
    if (
      value.change.changeEvidenceComplete === true &&
      (value.change.uninspectableFiles as number) !== 0
    )
      return false;
    for (const key of [
      "uninspectableDetails",
      "violationDetails",
      "escapeDetails",
      "skipDetails",
      "complexityHotspots",
      "duplicationEvidence",
    ]) {
      const details = value.change[key];
      if (
        !Array.isArray(details) ||
        details.length > 10 ||
        !details.every((entry) => typeof entry === "string" && entry.length <= 500)
      )
        return false;
    }
  }
  if (value.operational !== undefined) {
    if (!isRecord(value.operational)) return false;
    for (const key of [
      "tokensPerTask",
      "retriesPerTask",
      "verifierFailuresPerTask",
      "frontierEscalationRate",
      "taskCount",
    ]) {
      if (!isFiniteNonnegative(value.operational[key])) return false;
    }
    for (const key of ["toolCallsPerTask", "contextCharsPerTask"]) {
      const metric = value.operational[key];
      if (metric !== null && !isFiniteNonnegative(metric)) return false;
    }
    if (!isRecord(value.operational.modelMix)) return false;
    if (
      Object.keys(value.operational.modelMix).length > 50 ||
      !Object.keys(value.operational.modelMix).every(
        (key) => key.length > 0 && key.length <= 120 && redactSensitiveText(key) === key,
      )
    )
      return false;
    if (!Object.values(value.operational.modelMix).every(isFiniteNonnegative)) return false;
    if ((value.operational.frontierEscalationRate as number) > 1) return false;
  }
  return (
    value.structural !== undefined || value.change !== undefined || value.operational !== undefined
  );
};

export const assertHealthSample: (value: unknown) => asserts value is HealthSample = (value) => {
  if (!isHealthSample(value))
    throw new Error("Malformed health sample cannot become trend evidence");
};

export type MetricDirection = "IMPROVING" | "DEGRADING" | "FLAT" | "UNKNOWN";

export interface HealthTrendMetric {
  metric: string;
  group: "structural" | "change" | "operational";
  previous: number | null;
  current: number | null;
  direction: MetricDirection;
  note?: string | undefined;
}

export interface HealthTrend {
  /** True when either sample is missing a group the other measured — that comparison is unknown. */
  incomplete: boolean;
  metrics: HealthTrendMetric[];
}

export interface MaintenanceNeed {
  needed: boolean;
  /** One evidence-backed entry per materially degraded dimension — not a score. */
  reasons: string[];
  /** Recorded verbatim so decay cannot be hidden behind a stronger model mix. */
  escalationCorrelationNote?: string | undefined;
}

const branchPointPattern = /\b(?:if|for|while|case|catch|else\s+if)\b|&&|\|\||\?\?|\?\.|\?[^.?:]/gu;
const unsafeEscapePattern =
  /:\s*any\b|\bas\s+any\b|\bas\s+unknown\s+as\b|@ts-ignore|@ts-expect-error|<any>/gu;
const skippedTestPattern =
  /\b(?:it|test|describe)\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\b(?:it|test)\.todo\s*\(/gu;
const isTestPath = /(?:^|\/)(?:tests?|__tests__)(\/|$)|\.(?:test|spec)\.[^/]+$/u;

const codeLines = (lines: string[]): string[] =>
  lines.filter((line) => !/^\s*(?:\/\/|\/\*|\*|#|<!--)/u.test(line));

/** Removes string/comment bodies before language-sensitive regex metrics inspect source. */
const lexicalCodeLines = (lines: string[]): string[] => {
  let blockComment = false;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  let stringContent = "";
  const stringMarker = (): string => (stringContent.startsWith(".") ? '"./"' : '""');
  return lines.map((line) => {
    let result = "";
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index] ?? "";
      const next = line[index + 1] ?? "";
      if (blockComment) {
        if (character === "*" && next === "/") {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote !== undefined) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          result += stringMarker();
          quote = undefined;
          stringContent = "";
        } else {
          stringContent += character;
        }
        continue;
      }
      if (character === "/" && next === "/") break;
      if (character === "/" && next === "*") {
        blockComment = true;
        index += 1;
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
        escaped = false;
        stringContent = "";
        continue;
      }
      result += character;
    }
    // Ordinary quote strings do not continue across lines; templates can.
    if (quote !== "`") {
      if (quote !== undefined) result += stringMarker();
      quote = undefined;
      stringContent = "";
    }
    escaped = false;
    return result;
  });
};

const round = (value: number): number => Math.round(value * 1000) / 1000;

const dependencySections = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);

/**
 * Counts only added keys whose surrounding unified-diff evidence places them inside a recognized
 * package.json dependency object. An isolated added JSON property with no visible section is
 * unknown and contributes zero; scripts/name/config values can never inflate this metric.
 */
const countAddedPackageDependencies = (patch: string): number => {
  let packageManifest = false;
  let inHunk = false;
  let oldSection: { name: string; indent: number } | undefined;
  let newSection: { name: string; indent: number } | undefined;
  const added = new Set<string>();
  const removed = new Set<string>();
  let manifest = "";
  for (const rawLine of patch.split(/\r?\n/u)) {
    const diff = rawLine.match(/^diff --git (?:"?a\/)?(.+?)"? (?:"?b\/)?(.+?)"?$/u);
    if (diff) {
      manifest = (diff[2] ?? "").replaceAll("\\", "/");
      packageManifest = /(^|\/)package\.json$/u.test(manifest);
      inHunk = false;
      oldSection = undefined;
      newSection = undefined;
      continue;
    }
    if (!packageManifest) continue;
    if (rawLine.startsWith("@@")) {
      inHunk = true;
      oldSection = undefined;
      newSection = undefined;
      continue;
    }
    if (!inHunk || !/^[ +-]/u.test(rawLine)) continue;
    if (rawLine.startsWith("+++") || rawLine.startsWith("---")) continue;
    const marker = rawLine[0];
    const content = rawLine.slice(1);
    const property = content.match(/^(\s*)"([^"]+)"\s*:\s*(.*)$/u);
    if (!property) continue;
    const indent = property[1]?.length ?? 0;
    const key = property[2] ?? "";
    const value = property[3] ?? "";
    const updateSide = (
      side: "old" | "new",
      section: { name: string; indent: number } | undefined,
    ): { name: string; indent: number } | undefined => {
      if (dependencySections.has(key) && value.startsWith("{")) return { name: key, indent };
      if (section !== undefined && indent <= section.indent) return undefined;
      if (
        section !== undefined &&
        indent > section.indent &&
        /^"[^"]+"\s*:\s*"[^"]*"\s*,?\s*$/u.test(content.trim())
      ) {
        // A key moved between dependency sections is still the same existing package.
        const identity = `${manifest}\u0000${key}`;
        (side === "new" ? added : removed).add(identity);
      }
      return section;
    };
    if (marker !== "+") oldSection = updateSide("old", oldSection);
    if (marker !== "-") newSection = updateSide("new", newSection);
  }
  return [...added].filter((identity) => !removed.has(identity)).length;
};

/**
 * Structural metrics from an M2 RepositorySnapshot. Cycles (Tarjan SCC over IMPORTS relations)
 * and coupling are computed over the parsed subset only, so `parsedCoverage` travels with them —
 * a 3-file parse saying "no cycles" is a coverage fact, not a clean bill of health.
 */
export const deriveStructuralHealth = (snapshot: RepositorySnapshot): StructuralHealthMetrics => {
  const moduleFiles = new Map<string, number>();
  for (const file of snapshot.files) {
    const module = snapshot.moduleOwnership[file];
    if (module === undefined) continue;
    moduleFiles.set(module, (moduleFiles.get(module) ?? 0) + 1);
  }
  let largestModule = "(none)";
  let largestModuleFiles = 0;
  for (const [module, count] of moduleFiles) {
    if (count > largestModuleFiles) {
      largestModule = module;
      largestModuleFiles = count;
    }
  }
  const importEdges = snapshot.relations.filter((relation) => relation.kind === "IMPORTS");
  // Tarjan strongly-connected components over the import graph.
  const adjacency = new Map<string, string[]>();
  for (const edge of importEdges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  const strongConnect = (node: string): void => {
    indices.set(node, index);
    lowlinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!indices.has(next)) {
        strongConnect(next);
        lowlinks.set(node, Math.min(lowlinks.get(node) ?? 0, lowlinks.get(next) ?? 0));
      } else if (onStack.has(next)) {
        lowlinks.set(node, Math.min(lowlinks.get(node) ?? 0, indices.get(next) ?? 0));
      }
    }
    if ((lowlinks.get(node) ?? 0) === (indices.get(node) ?? -1)) {
      const component: string[] = [];
      let popped = "";
      do {
        popped = stack.pop() ?? "";
        onStack.delete(popped);
        component.push(popped);
      } while (popped !== node);
      components.push(component);
    }
  };
  for (const node of adjacency.keys()) {
    if (!indices.has(node)) strongConnect(node);
  }
  const cycles = components.filter(
    (component) =>
      component.length > 1 ||
      (component.length === 1 &&
        (adjacency.get(component[0] ?? "") ?? []).includes(component[0] ?? "")),
  );
  const eligibleFiles = Object.keys(snapshot.moduleOwnership).sort();
  const eligible = new Set(eligibleFiles);
  // Evidence is emitted only after content was read, digested, and parsed. `parsedFiles` is an
  // attempt cache in older snapshots and can include missing/oversized inputs, so it is not proof.
  const successfullyParsedFiles = [...new Set(snapshot.evidence.map((entry) => entry.uri))]
    .filter((file) => eligible.has(file))
    .sort();
  const parsedCoverage =
    eligibleFiles.length === 0 ? 0 : successfullyParsedFiles.length / eligibleFiles.length;
  const fileScanComplete =
    !snapshot.filesTruncated &&
    !snapshot.scopeTruncated &&
    eligibleFiles.length > 0 &&
    successfullyParsedFiles.length === eligibleFiles.length;
  return {
    moduleCount: moduleFiles.size,
    fileCount: snapshot.files.length,
    largestModule,
    largestModuleFiles,
    crossModuleEdges: countCrossModuleEdges(
      snapshot.relations,
      snapshot.moduleOwnership,
      snapshot.files,
    ),
    importCycleCount: cycles.length,
    largestCycleFiles: cycles.reduce((max, cycle) => Math.max(max, cycle.length), 0),
    parsedCoverage,
    parsedScopeFingerprint: createHash("sha256")
      .update(successfullyParsedFiles.join("\n"))
      .digest("hex"),
    inventoryTruncated: snapshot.filesTruncated,
    scopeTruncated: snapshot.scopeTruncated,
    fileScanComplete,
    relationEvidenceBasis: "BOUNDED_PATTERN_SCAN",
  };
};

/** Change metrics from the candidate diff — what THIS change did to the structure. */
export const deriveChangeHealth = (patch: string): ChangeHealthMetrics => {
  const violationDetails: string[] = [];
  const escapeDetails: string[] = [];
  const skipDetails: string[] = [];
  const complexityHotspots: string[] = [];
  let addedImports = 0;
  const addedPackageDependencies = countAddedPackageDependencies(patch);
  const blocksByContent = new Map<string, Set<string>>();
  const filePatches = parseFilePatches(patch);
  const uninspectableDetails = filePatches.flatMap((entry) =>
    (entry.uninspectableReasons ?? []).map((reason) => `${entry.file}: ${reason}`),
  );
  const uninspectableFiles = filePatches.filter(
    (entry) => (entry.uninspectableReasons?.length ?? 0) > 0,
  ).length;

  const governance = deriveArchitectureGovernance(patch);
  violationDetails.push(...governance.violations);

  for (const entry of filePatches) {
    const sourceFile = /\.(?:[cm]?[jt]sx?)$/u.test(entry.file);
    if (!sourceFile) continue;
    const typeScriptFile = /\.tsx?$/u.test(entry.file);
    const lines = codeLines(entry.addedLines);
    const metricLines = lexicalCodeLines(lines);
    if (typeScriptFile) {
      for (const line of entry.addedLines) {
        for (const _ of line.matchAll(/^\s*\/\/\s*@ts-(?:ignore|expect-error)\b/gu)) {
          escapeDetails.push(`${entry.file}: unsafe TypeScript suppression directive`);
        }
      }
    }
    let branchPoints = 0;
    for (let index = 0; index < metricLines.length; index += 1) {
      const metricLine = metricLines[index] ?? "";
      branchPoints += (metricLine.match(branchPointPattern) ?? []).length;
      const escapes = typeScriptFile ? (metricLine.match(unsafeEscapePattern) ?? []) : [];
      for (const _ of escapes) {
        escapeDetails.push(`${entry.file}: unsafe type escape`);
      }
      addedImports += (metricLine.match(/\bfrom\s+["']\./gu) ?? []).length;
      addedImports += (metricLine.match(/\bimport\s*\(?\s*["']\./gu) ?? []).length;
      addedImports += (metricLine.match(/\brequire\s*\(\s*["']\./gu) ?? []).length;
      if (isTestPath.test(entry.file)) {
        const skips = metricLine.match(skippedTestPattern) ?? [];
        for (const _ of skips) {
          skipDetails.push(`${entry.file}: skipped/todo test marker`);
        }
      }
    }
    if (branchPoints >= 10)
      complexityHotspots.push(`${entry.file} (${branchPoints} added branch points)`);
    // Sliding 5-line blocks; the same block content in 2+ distinct files is duplication.
    const duplicationLines = metricLines.filter((line) => line.trim().length > 0);
    for (let start = 0; start + 5 <= duplicationLines.length; start += 1) {
      const block = duplicationLines
        .slice(start, start + 5)
        .map((line) => line.trim())
        .join("\n");
      const files = blocksByContent.get(block) ?? new Set<string>();
      files.add(entry.file);
      blocksByContent.set(block, files);
    }
  }
  // Overlapping windows from one copied region must not manufacture several findings. Conservatively
  // count each distinct cross-file duplication relationship once per patch.
  const duplicatedRelationships = new Map<string, Set<string>>();
  for (const [block, files] of blocksByContent) {
    if (files.size < 2) continue;
    const relationship = [...files].sort().join("\u0000");
    const blocks = duplicatedRelationships.get(relationship) ?? new Set<string>();
    blocks.add(block);
    duplicatedRelationships.set(relationship, blocks);
  }
  return {
    inspectableFiles: filePatches.length - uninspectableFiles,
    uninspectableFiles,
    changeEvidenceComplete: uninspectableFiles === 0,
    uninspectableDetails: uninspectableDetails.slice(0, 10),
    architectureViolations: violationDetails.length,
    violationDetails: violationDetails.slice(0, 10),
    unsafeTypeEscapes: escapeDetails.length,
    escapeDetails: escapeDetails.slice(0, 10),
    skippedTests: skipDetails.length,
    skipDetails: skipDetails.slice(0, 10),
    addedImports,
    addedPackageDependencies,
    complexityHotspots: complexityHotspots.slice(0, 10),
    duplicatedBlocks: duplicatedRelationships.size,
    duplicationEvidence: [...duplicatedRelationships]
      .slice(0, 5)
      .map(
        ([relationship]) =>
          `${relationship.split("\u0000").join(" + ")}: identical region of at least 5 lines`,
      ),
  };
};

/**
 * Operational metrics over a window of telemetry records. Tool calls and context size are null
 * when not recorded — unknown, not zero. Escalation is the strict-re-expansion rate: the share of
 * tasks that had to be re-expanded under a stricter/stronger execution posture.
 */
export const deriveOperationalHealth = (
  records: TelemetryRecord[],
): OperationalHealthMetrics | undefined => {
  if (records.length === 0) return undefined;
  const tokens = records.reduce(
    (sum, record) => sum + record.inputTokens + record.outputTokens + record.cachedTokens,
    0,
  );
  const retries = records.reduce((sum, record) => sum + record.retryCount, 0);
  const verifierFailures = records.reduce((sum, record) => sum + record.verifierFailures, 0);
  const toolRecords = records.filter((record) => record.toolCalls !== undefined);
  const contextRecords = records.filter((record) => record.contextChars !== undefined);
  const modelCounts = new Map<string, number>();
  for (const record of records) {
    const safeModel = redactSensitiveText(record.model).slice(0, 120);
    modelCounts.set(safeModel, (modelCounts.get(safeModel) ?? 0) + 1);
  }
  const modelMix = Object.fromEntries(modelCounts);
  return {
    tokensPerTask: round(tokens / records.length),
    retriesPerTask: round(retries / records.length),
    toolCallsPerTask:
      toolRecords.length === records.length
        ? round(
            toolRecords.reduce((sum, record) => sum + (record.toolCalls ?? 0), 0) / records.length,
          )
        : null,
    contextCharsPerTask:
      contextRecords.length === records.length
        ? round(
            contextRecords.reduce((sum, record) => sum + (record.contextChars ?? 0), 0) /
              records.length,
          )
        : null,
    verifierFailuresPerTask: round(verifierFailures / records.length),
    frontierEscalationRate: round(
      records.filter((record) => record.strictReexpansions > 0).length / records.length,
    ),
    modelMix,
    taskCount: records.length,
  };
};

/**
 * Trend between two consecutive samples. Each metric reports flat/improving/degrading only when
 * both samples measured it; a group present in one sample but absent from the other marks the
 * trend incomplete for that comparison rather than inventing a value.
 */
export const deriveHealthTrend = (previous: HealthSample, current: HealthSample): HealthTrend => {
  if (previous.projectId !== current.projectId) return { incomplete: true, metrics: [] };
  const metrics: HealthTrendMetric[] = [];
  let incomplete = false;
  const compare = (
    group: HealthTrendMetric["group"],
    metric: string,
    previousValue: number | null | undefined,
    currentValue: number | null | undefined,
    higherIsWorse: boolean,
    note?: string,
  ): void => {
    if (
      previousValue === undefined ||
      previousValue === null ||
      currentValue === undefined ||
      currentValue === null
    ) {
      incomplete = true;
      return;
    }
    const direction: MetricDirection =
      currentValue === previousValue
        ? "FLAT"
        : higherIsWorse === currentValue > previousValue
          ? "DEGRADING"
          : "IMPROVING";
    metrics.push({
      metric,
      group,
      previous: previousValue,
      current: currentValue,
      direction,
      note,
    });
  };
  const compareAddedDelta = (
    metric: string,
    previousValue: number | undefined,
    currentValue: number | undefined,
  ): void => {
    if (previousValue === undefined || currentValue === undefined) {
      incomplete = true;
      return;
    }
    metrics.push({
      metric,
      group: "change",
      previous: previousValue,
      current: currentValue,
      // These values are additions introduced by one change, not cumulative repository totals.
      // A smaller positive addition is still damage; it must not be mislabeled IMPROVING.
      direction: currentValue > 0 ? "DEGRADING" : "FLAT",
      note: "per-change addition; zero means this change introduced none, not that prior debt vanished",
    });
  };
  const compareNeutral = (
    group: HealthTrendMetric["group"],
    metric: string,
    previousValue: number | undefined,
    currentValue: number | undefined,
    note: string,
  ): void => {
    if (previousValue === undefined || currentValue === undefined) {
      incomplete = true;
      return;
    }
    metrics.push({
      metric,
      group,
      previous: previousValue,
      current: currentValue,
      direction: currentValue === previousValue ? "FLAT" : "UNKNOWN",
      note,
    });
  };
  const recordUnknown = (
    group: HealthTrendMetric["group"],
    metric: string,
    previousValue: number,
    currentValue: number,
    note: string,
  ): void => {
    incomplete = true;
    metrics.push({
      metric,
      group,
      previous: previousValue,
      current: currentValue,
      direction: "UNKNOWN",
      note,
    });
  };
  if (previous.structural || current.structural) {
    const p = previous.structural;
    const c = current.structural;
    if (p && c) {
      const scopeNote =
        p.fileScanComplete && c.fileScanComplete
          ? "base-revision observations have no proven ancestry/merge lineage; structural direction is unclassified"
          : `incomplete successful parse evidence (${round(p.parsedCoverage * 100)}% → ${round(c.parsedCoverage * 100)}%; inventory truncated ${String(p.inventoryTruncated)} → ${String(c.inventoryTruncated)}; scope truncated ${String(p.scopeTruncated)} → ${String(c.scopeTruncated)})`;
      // These samples describe independent run bases. Same-project ordering is not revision
      // ancestry and a verified candidate is not a merge. Until repository-state lineage exists,
      // structural observations remain useful raw evidence but cannot claim decay or recovery.
      recordUnknown(
        "structural",
        "crossModuleEdges",
        p.crossModuleEdges,
        c.crossModuleEdges,
        scopeNote,
      );
      recordUnknown(
        "structural",
        "importCycleCount",
        p.importCycleCount,
        c.importCycleCount,
        scopeNote,
      );
      recordUnknown(
        "structural",
        "largestCycleFiles",
        p.largestCycleFiles,
        c.largestCycleFiles,
        scopeNote,
      );
      recordUnknown(
        "structural",
        "largestModuleFiles",
        p.largestModuleFiles,
        c.largestModuleFiles,
        scopeNote,
      );
      recordUnknown("structural", "moduleCount", p.moduleCount, c.moduleCount, scopeNote);
      recordUnknown("structural", "fileCount", p.fileCount, c.fileCount, scopeNote);
    } else {
      incomplete = true;
    }
  }
  if (previous.change || current.change) {
    const p = previous.change;
    const c = current.change;
    if (p && c) {
      if (!p.changeEvidenceComplete || !c.changeEvidenceComplete) {
        const note = `uninspectable candidate entries (${p.uninspectableFiles} → ${c.uninspectableFiles}); change direction is unclassified`;
        for (const [metric, previousValue, currentValue] of [
          ["architectureViolations", p.architectureViolations, c.architectureViolations],
          ["unsafeTypeEscapes", p.unsafeTypeEscapes, c.unsafeTypeEscapes],
          ["skippedTests", p.skippedTests, c.skippedTests],
          ["duplicatedBlocks", p.duplicatedBlocks, c.duplicatedBlocks],
          ["addedImports", p.addedImports, c.addedImports],
          ["addedPackageDependencies", p.addedPackageDependencies, c.addedPackageDependencies],
        ] as const) {
          recordUnknown("change", metric, previousValue, currentValue, note);
        }
      } else {
        compareAddedDelta(
          "architectureViolations",
          p.architectureViolations,
          c.architectureViolations,
        );
        compareAddedDelta("unsafeTypeEscapes", p.unsafeTypeEscapes, c.unsafeTypeEscapes);
        compareAddedDelta("skippedTests", p.skippedTests, c.skippedTests);
        compareAddedDelta("duplicatedBlocks", p.duplicatedBlocks, c.duplicatedBlocks);
        compareNeutral(
          "change",
          "addedImports",
          p.addedImports,
          c.addedImports,
          "per-change dependency growth; impact is unclassified without coupling evidence",
        );
        compareNeutral(
          "change",
          "addedPackageDependencies",
          p.addedPackageDependencies,
          c.addedPackageDependencies,
          "per-change package growth; impact is unclassified without dependency-specific evidence",
        );
      }
    } else {
      incomplete = true;
    }
  }
  if (previous.operational || current.operational) {
    const p = previous.operational;
    const c = current.operational;
    if (p && c) {
      compare("operational", "tokensPerTask", p.tokensPerTask, c.tokensPerTask, true);
      compare("operational", "retriesPerTask", p.retriesPerTask, c.retriesPerTask, true);
      compare("operational", "toolCallsPerTask", p.toolCallsPerTask, c.toolCallsPerTask, true);
      compare(
        "operational",
        "contextCharsPerTask",
        p.contextCharsPerTask,
        c.contextCharsPerTask,
        true,
      );
      compare(
        "operational",
        "verifierFailuresPerTask",
        p.verifierFailuresPerTask,
        c.verifierFailuresPerTask,
        true,
      );
      compare(
        "operational",
        "frontierEscalationRate",
        p.frontierEscalationRate,
        c.frontierEscalationRate,
        true,
      );
    } else {
      incomplete = true;
    }
  }
  return { incomplete, metrics };
};

/**
 * Maintenance Mission decision from material measured degradation or rising execution cost.
 * Changeability damage (coupling, cycles, escapes, duplication, violations) matters even when
 * task outcomes still succeed. Never a composite score: each reason is one measured dimension
 * with its numbers. Co-occurring execution escalation is recorded as correlation, never assigned
 * as the cause of structural/change damage.
 */
export const deriveMaintenanceNeed = (trend: HealthTrend): MaintenanceNeed => {
  const reasons: string[] = [];
  let escalationDegraded = false;
  for (const metric of trend.metrics) {
    if (metric.direction !== "DEGRADING") continue;
    const delta = (metric.current ?? 0) - (metric.previous ?? 0);
    switch (metric.metric) {
      case "importCycleCount":
        reasons.push(`import cycles grew from ${metric.previous} to ${metric.current}`);
        break;
      case "largestCycleFiles":
        reasons.push(
          `the largest import cycle grew from ${metric.previous} to ${metric.current} files`,
        );
        break;
      case "crossModuleEdges":
        if (delta >= 3)
          reasons.push(
            `cross-module coupling grew by ${delta} edges (${metric.previous} → ${metric.current})${metric.note ? ` — ${metric.note}` : ""}`,
          );
        break;
      case "unsafeTypeEscapes":
        reasons.push(`${metric.current} unsafe type escape(s) introduced by the current change`);
        break;
      case "skippedTests":
        reasons.push(`${metric.current} skipped test(s) introduced by the current change`);
        break;
      case "architectureViolations":
        reasons.push(
          `${metric.current} architecture violation(s) introduced by the current change`,
        );
        break;
      case "duplicatedBlocks":
        if ((metric.current ?? 0) >= 2)
          reasons.push(`${metric.current} duplicated block(s) introduced by the current change`);
        break;
      case "largestModuleFiles":
        if (delta >= 10)
          reasons.push(
            `the largest module grew by ${delta} files (${metric.previous} → ${metric.current})`,
          );
        break;
      case "frontierEscalationRate":
        if (delta >= 0.2) {
          escalationDegraded = true;
          reasons.push(
            `frontier escalation rate rose from ${metric.previous} to ${metric.current}; investigate task mix, uncertainty, and changeability without assuming a cause`,
          );
        }
        break;
      default:
        break;
    }
  }
  const nonOperationalDegradation = trend.metrics.some(
    (metric) => metric.group !== "operational" && metric.direction === "DEGRADING",
  );
  const escalationCorrelationNote =
    nonOperationalDegradation && escalationDegraded
      ? "measured codebase degradation coincided with rising escalation to stronger execution; this is correlation evidence, not proof that either caused the other"
      : undefined;
  return { needed: reasons.length > 0, reasons, escalationCorrelationNote };
};
