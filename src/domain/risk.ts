/**
 * Task risk profiler: a vector, never a scalar. Each dimension is derived deterministically from
 * repository evidence where possible (touched files, module/package ownership, resolved
 * cross-module edges — reusing the same deterministic graph M2 built) and marked HEURISTIC when
 * only a path-pattern proxy is available, or explicitly INSUFFICIENT_EVIDENCE rather than guessed
 * when nothing reliable exists yet. Never calls a model to assess risk.
 */

export type RiskDimension =
  | "ReasoningDifficulty"
  | "CodeCoupling"
  | "BlastRadius"
  | "ArchitectureSensitivity"
  | "DebtRisk"
  | "SecuritySensitivity"
  | "PerformanceSensitivity"
  | "OperationalSensitivity"
  | "NetworkBoundaryChanges"
  | "DataConsistencyRisk";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type RiskProvenance = "DETERMINISTIC" | "HEURISTIC" | "INSUFFICIENT_EVIDENCE";

/** Ordinal comparison for RiskLevel — lets callers detect an increase/decrease, not just equality. */
export const riskLevelRank: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export interface RiskValue {
  level: RiskLevel;
  provenance: RiskProvenance;
  evidence: string[];
}

export type RiskVector = Record<RiskDimension, RiskValue>;

export interface RiskEvidenceInput {
  /** Repository-relative paths believed or known to be touched. */
  files: string[];
  /** File → deeper architectural module (M2's moduleOwnership). */
  moduleOwnership: Record<string, string>;
  /** File → outer package/workspace root (M2's packageOwnership). */
  packageOwnership: Record<string, string>;
  /** Resolved cross-module IMPORTS edges among the touched modules (M2's relations, filtered). */
  crossModuleEdgeCount: number;
}

const securitySensitivePattern =
  /\b(auth|session|login|logout|credential|password|token|permission|authoriz|payment|billing|webhook|upload|deserializ)\b/iu;
const dataSensitivePattern =
  /migrat|schema|\.sql$|\bquery\b|\btransaction\b|\brepository\b|\bdao\b/iu;
const networkSensitivePattern = /\b(fetch|http|webhook|proxy|gateway|client|api)\b/iu;
const operationalSensitivePattern =
  /\.env|config|docker|compose|deploy|migrations?\/|infra|terraform|ci\/|\.github\/workflows/iu;

/**
 * Counts resolved local IMPORTS edges that cross a module boundary between two touched files —
 * the same "meaningful cross-module edge" concept the M1 runtime-signal collector uses, computed
 * here directly from repository evidence so risk assessment doesn't depend on collector state.
 */
export const countCrossModuleEdges = (
  relations: Array<{ from: string; to: string; kind: string }>,
  moduleOwnership: Record<string, string>,
  files: string[],
): number => {
  const touchedModules = new Set(files.map((file) => moduleOwnership[file]).filter(Boolean));
  let count = 0;
  for (const relation of relations) {
    if (relation.kind !== "IMPORTS") continue;
    const fromModule = moduleOwnership[relation.from];
    const toModule = moduleOwnership[relation.to];
    if (!fromModule || !toModule || fromModule === toModule) continue;
    if (touchedModules.has(fromModule) && touchedModules.has(toModule)) count += 1;
  }
  return count;
};

const level = (evidence: unknown[], mediumAt: number, highAt: number): RiskLevel => {
  if (evidence.length >= highAt) return "HIGH";
  if (evidence.length >= mediumAt) return "MEDIUM";
  return "LOW";
};

const matches = (files: string[], pattern: RegExp): string[] =>
  files.filter((file) => pattern.test(file));

/**
 * Derives a full risk vector from deterministic repository evidence. `files` should be the best
 * currently-available estimate of what is touched — the initially-selected scope before execution,
 * or the actual diff's changed files once one exists (the caller decides which; this function is
 * evidence-agnostic about where `files` came from, only how confident to be given what it is).
 */
/**
 * `moduleOwnership`/`packageOwnership` only cover source files that M2's indexer actually parses
 * (see `isSourceFile` in project-brain.ts) — a migration, Dockerfile, or CI workflow path is
 * legitimately absent from both maps, not merely unowned. Claiming DETERMINISTIC "LOW" for a
 * change the ownership maps have zero visibility into would be dishonestly confident, so coverage
 * is checked explicitly rather than treating an empty owner lookup the same as a real "LOW" count.
 */
const coverageProvenance = (files: string[], ownership: Record<string, string>): RiskProvenance => {
  if (files.length === 0) return "DETERMINISTIC";
  const covered = files.filter((file) => Boolean(ownership[file])).length;
  if (covered === 0) return "INSUFFICIENT_EVIDENCE";
  if (covered < files.length) return "HEURISTIC";
  return "DETERMINISTIC";
};

export const deriveRiskVector = (input: RiskEvidenceInput): RiskVector => {
  const { files, moduleOwnership, packageOwnership, crossModuleEdgeCount } = input;
  const touchedModules = new Set(files.map((file) => moduleOwnership[file]).filter(Boolean));
  const touchedPackages = new Set(files.map((file) => packageOwnership[file]).filter(Boolean));
  const moduleCoverage = coverageProvenance(files, moduleOwnership);
  const packageCoverage = coverageProvenance(files, packageOwnership);

  const securityMatches = matches(files, securitySensitivePattern);
  const dataMatches = matches(files, dataSensitivePattern);
  const networkMatches = matches(files, networkSensitivePattern);
  const operationalMatches = matches(files, operationalSensitivePattern);

  return {
    CodeCoupling: {
      level: level([...touchedModules], 2, 4),
      provenance: moduleCoverage,
      evidence:
        moduleCoverage === "DETERMINISTIC"
          ? [`${touchedModules.size} distinct module(s) touched`]
          : [
              `${touchedModules.size} distinct module(s) touched among files with known module ownership`,
              `${files.length - files.filter((file) => Boolean(moduleOwnership[file])).length} of ${files.length} touched file(s) have no module-ownership evidence (not a parsed source file)`,
            ],
    },
    BlastRadius: {
      level: level([...touchedPackages], 2, 3),
      provenance: packageCoverage,
      evidence:
        packageCoverage === "DETERMINISTIC"
          ? [`${touchedPackages.size} distinct package(s) touched`]
          : [
              `${touchedPackages.size} distinct package(s) touched among files with known package ownership`,
              `${files.length - files.filter((file) => Boolean(packageOwnership[file])).length} of ${files.length} touched file(s) have no package-ownership evidence (not a parsed source file)`,
            ],
    },
    ArchitectureSensitivity: {
      level: level(new Array(crossModuleEdgeCount).fill(0), 2, 5),
      provenance: moduleCoverage,
      evidence:
        moduleCoverage === "DETERMINISTIC"
          ? [`${crossModuleEdgeCount} resolved cross-module import edge(s) among touched files`]
          : [
              `${crossModuleEdgeCount} resolved cross-module import edge(s) among touched files with known module ownership`,
              "one or more touched files have no module-ownership evidence, so this edge count cannot see their architectural impact",
            ],
    },
    SecuritySensitivity: {
      level: level(securityMatches, 1, 3),
      provenance: securityMatches.length > 0 ? "DETERMINISTIC" : "HEURISTIC",
      evidence:
        securityMatches.length > 0
          ? securityMatches.map((file) => `security-sensitive path: ${file}`)
          : ["no security-sensitive path pattern matched among touched files"],
    },
    DataConsistencyRisk: {
      level: level(dataMatches, 1, 2),
      provenance: dataMatches.length > 0 ? "DETERMINISTIC" : "HEURISTIC",
      evidence:
        dataMatches.length > 0
          ? dataMatches.map((file) => `data/migration-sensitive path: ${file}`)
          : ["no data/migration-sensitive path pattern matched among touched files"],
    },
    PerformanceSensitivity: {
      level: level(dataMatches, 2, 4),
      provenance: "HEURISTIC",
      evidence: [
        "proxied from data/query-sensitive path matches; no runtime measurement exists yet",
      ],
    },
    NetworkBoundaryChanges: {
      level: level(networkMatches, 1, 3),
      provenance: networkMatches.length > 0 ? "DETERMINISTIC" : "HEURISTIC",
      evidence:
        networkMatches.length > 0
          ? networkMatches.map((file) => `network-sensitive path: ${file}`)
          : ["no network-sensitive path pattern matched among touched files"],
    },
    OperationalSensitivity: {
      level: level(operationalMatches, 1, 2),
      provenance: operationalMatches.length > 0 ? "DETERMINISTIC" : "HEURISTIC",
      evidence:
        operationalMatches.length > 0
          ? operationalMatches.map((file) => `operational/config-sensitive path: ${file}`)
          : ["no operational/config-sensitive path pattern matched among touched files"],
    },
    // Not knowable from repository evidence alone at this stage of the pipeline — honestly
    // reported as insufficient evidence rather than guessed. Later milestones may add real
    // sources: M7A (debt-delta history) for DebtRisk, nothing yet planned for ReasoningDifficulty.
    ReasoningDifficulty: {
      level: "LOW",
      provenance: "INSUFFICIENT_EVIDENCE",
      evidence: ["no deterministic source for reasoning difficulty exists yet"],
    },
    DebtRisk: {
      level: "LOW",
      provenance: "INSUFFICIENT_EVIDENCE",
      evidence: ["no debt-delta history exists yet (see the M7A roadmap milestone)"],
    },
  };
};
