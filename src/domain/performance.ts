import { parseFilePatches } from "./diff-parse";

export type PerformanceSignalKind =
  | "DB_QUERY"
  | "PAGINATION"
  | "SCHEMA_INDEX"
  | "NETWORK_CALL"
  | "LARGE_PAYLOAD"
  | "BUNDLE"
  | "HOT_LOOP"
  | "SERIALIZATION"
  | "MEMORY";

export interface PerformanceSensitivityEvidence {
  level: "LOW" | "MEDIUM" | "HIGH";
  provenance: "DETERMINISTIC" | "HEURISTIC";
  signals: PerformanceSignalKind[];
  evidence: string[];
}

const performanceEvidencePath =
  /\.(?:[cm]?[jt]sx?|go|py|java|cs|rb|rs|php|sql|prisma)$|(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/iu;
const nonProductionPath =
  /(^|\/)(?:tests?|__tests__|fixtures?|scripts?|tools?|benchmarks?)(\/|$)|\.(?:test|spec)\.[^/]+$/iu;
const isPerformanceEvidencePath = (file: string): boolean =>
  performanceEvidencePath.test(file) && !nonProductionPath.test(file);

const pathSignals = (
  files: string[],
  includeHeuristicPaths: boolean,
): Map<PerformanceSignalKind, string[]> => {
  const signals = new Map<PerformanceSignalKind, string[]>();
  const add = (kind: PerformanceSignalKind, file: string): void => {
    signals.set(kind, [...(signals.get(kind) ?? []), file]);
  };
  for (const file of files) {
    if (!isPerformanceEvidencePath(file)) continue;
    const dataArtifact = /migrat|\.sql$|\.prisma$/iu.test(file);
    if (dataArtifact) {
      add("DB_QUERY", file);
      add("SCHEMA_INDEX", file);
    }
    if (/webpack|vite|rollup|bundle|package(?:-lock)?\.json|pnpm-lock|yarn\.lock/iu.test(file))
      add("BUNDLE", file);
    if (!includeHeuristicPaths) continue;
    if (/database|postgres|queries?|(^|[/_.-])(?:dao|db)([/_.-]|$)/iu.test(file))
      add("DB_QUERY", file);
    if (/(?:database|postgres|db)[/_.-].*schema/iu.test(file)) add("SCHEMA_INDEX", file);
    if (/gateway|proxy|webhook|external|remote[-_.]?client|http[-_.]?client/iu.test(file))
      add("NETWORK_CALL", file);
  }
  return signals;
};

const diffSignalPatterns: Array<[PerformanceSignalKind, RegExp]> = [
  [
    "DB_QUERY",
    /\bselect\b.+\bfrom\b|\binsert\s+into\b|\bupdate\s+[\w."`-]+\s+set\b|\bdelete\s+from\b|prisma\.|sequelize|typeorm/iu,
  ],
  [
    "PAGINATION",
    /\b(?:pageSize|pagination|nextCursor|pageCursor|cursorParam)\b|[?&](?:cursor|limit|offset)=|\.(?:limit|offset)\s*\(|\b(?:limit|offset)\s+(?:\d+|[:@$?]\w+)/iu,
  ],
  [
    "SCHEMA_INDEX",
    /create\s+(?:unique\s+)?index|drop\s+index|(?:create|alter|drop)\s+table|@@index|\.index\s*\(/iu,
  ],
  ["NETWORK_CALL", /\bfetch\s*\(|\baxios\b|external api/iu],
  [
    "LARGE_PAYLOAD",
    /large payload|response\.arrayBuffer|Buffer\.from\([^)]*(?:response|payload)/iu,
  ],
  ["BUNDLE", /bundle size|dependencies|devDependencies/iu],
  ["HOT_LOOP", /hot path|performance.?critical|benchmark loop/iu],
  ["SERIALIZATION", /JSON\.(?:stringify|parse)|serialize|deserialize/iu],
  ["MEMORY", /Buffer\.alloc|new\s+Array\s*\(\s*\d{4,}|memory.?intensive/iu],
];

/**
 * Signals that on their own justify a MEDIUM (plan-requiring) rating: SQL text, DDL, network
 * calls, large payloads, bundle growth, and hot-path markers. SERIALIZATION/PAGINATION/MEMORY are
 * deliberately weak — a single added `JSON.parse` or `.limit(` line is ubiquitous ordinary code,
 * not performance sensitivity, and must not force a required measurement (and therefore a
 * NOT_CHECKED block) onto mundane changes. Two weak signals together do raise MEDIUM.
 */
const strongSignalKinds = new Set<PerformanceSignalKind>([
  "DB_QUERY",
  "SCHEMA_INDEX",
  "NETWORK_CALL",
  "LARGE_PAYLOAD",
  "BUNDLE",
  "HOT_LOOP",
]);

/**
 * Removing bounds or schema/query structure is itself the archetypal performance regression
 * (dropping a LIMIT turns a bounded query into a full scan), so removals of these kinds count as
 * evidence even though added-lines-only scanning would miss them.
 */
const removalSensitiveKinds = new Set<PerformanceSignalKind>([
  "DB_QUERY",
  "PAGINATION",
  "SCHEMA_INDEX",
]);

export const derivePerformanceSensitivity = (
  files: string[],
  patch?: string,
): PerformanceSensitivityEvidence => {
  const signals = pathSignals(files, patch === undefined);
  let removalEvidence = false;
  if (patch !== undefined) {
    for (const entry of parseFilePatches(patch)) {
      if (!isPerformanceEvidencePath(entry.file)) continue;
      const evidenceLines = entry.addedLines.filter(
        (line) => !/^\s*(?:\/\/|\/\*|\*|#|<!--)/u.test(line),
      );
      for (const [kind, pattern] of diffSignalPatterns) {
        if (evidenceLines.some((line) => pattern.test(line))) {
          signals.set(kind, [...(signals.get(kind) ?? []), entry.file]);
        }
      }
      const removedLines = entry.removedLines.filter(
        (line) => !/^\s*(?:\/\/|\/\*|\*|#|<!--)/u.test(line),
      );
      for (const [kind, pattern] of diffSignalPatterns) {
        if (removalSensitiveKinds.has(kind) && removedLines.some((line) => pattern.test(line))) {
          removalEvidence = true;
          signals.set(kind, [...(signals.get(kind) ?? []), `${entry.file} (removed)`]);
        }
      }
    }
  }
  const kinds = [...signals.keys()];
  const high = kinds.length >= 3 || (kinds.includes("DB_QUERY") && kinds.includes("SCHEMA_INDEX"));
  const medium =
    kinds.some((kind) => strongSignalKinds.has(kind)) ||
    removalEvidence ||
    new Set(kinds).size >= 2;
  return {
    level: high ? "HIGH" : medium ? "MEDIUM" : "LOW",
    provenance: patch === undefined ? "HEURISTIC" : "DETERMINISTIC",
    signals: kinds,
    evidence:
      kinds.length === 0
        ? ["no performance-sensitive path or candidate-diff signal matched"]
        : kinds.map(
            (kind) => `${kind}: ${[...new Set(signals.get(kind) ?? [])].slice(0, 10).join(", ")}`,
          ),
  };
};

export interface PerformanceMetricMeasurement {
  name: string;
  unit: string;
  baseline: number;
  candidate: number;
  lowerIsBetter: boolean;
}

export interface PerformanceMeasurement {
  state: "MEASURED" | "NOT_CHECKED";
  candidateId: string;
  diffDigest: string;
  metrics: PerformanceMetricMeasurement[];
  evidence: string[];
}

export interface PerformanceMetricDelta extends PerformanceMetricMeasurement {
  regressionPercent: number;
}

export interface PerformancePostureResult {
  state: "PASS" | "FAIL" | "NOT_CHECKED";
  evidence: string[];
  metrics: PerformanceMetricDelta[];
}

export const derivePerformancePosture = (
  measurement: PerformanceMeasurement | undefined,
  expectedCandidateId: string,
  expectedDiffDigest: string,
  maxRegressionPercent: number,
): PerformancePostureResult => {
  if (!measurement) {
    return {
      state: "NOT_CHECKED",
      evidence: ["performance evidence was required but no measurement was produced"],
      metrics: [],
    };
  }
  if (
    measurement.candidateId !== expectedCandidateId ||
    measurement.diffDigest !== expectedDiffDigest
  ) {
    return {
      state: "NOT_CHECKED",
      evidence: ["performance evidence is not bound to the current candidate id and diff digest"],
      metrics: [],
    };
  }
  if (measurement.state !== "MEASURED" || measurement.metrics.length === 0) {
    return { state: "NOT_CHECKED", evidence: measurement.evidence, metrics: [] };
  }
  if (
    measurement.metrics.some(
      (metric) =>
        !Number.isFinite(metric.baseline) ||
        metric.baseline === 0 ||
        !Number.isFinite(metric.candidate),
    )
  ) {
    return {
      state: "NOT_CHECKED",
      evidence: [
        "a baseline metric was zero/non-finite or a candidate metric was non-finite, so candidate delta cannot be measured",
      ],
      metrics: [],
    };
  }
  const metrics = measurement.metrics.map((metric) => ({
    ...metric,
    regressionPercent:
      ((metric.lowerIsBetter
        ? metric.candidate - metric.baseline
        : metric.baseline - metric.candidate) /
        Math.abs(metric.baseline)) *
      100,
  }));
  const regressions = metrics.filter((metric) => metric.regressionPercent > maxRegressionPercent);
  return {
    state: regressions.length > 0 ? "FAIL" : "PASS",
    evidence: [
      ...measurement.evidence,
      ...(regressions.length > 0
        ? regressions.map(
            (metric) =>
              `${metric.name} regressed ${metric.regressionPercent.toFixed(2)}% (threshold ${maxRegressionPercent.toFixed(2)}%)`,
          )
        : [`all measured deltas stayed within the ${maxRegressionPercent.toFixed(2)}% threshold`]),
    ],
    metrics,
  };
};
