import type { AnalysisCoverage } from "./assurance";
import { parseFilePatches } from "./diff-parse";
import type { ResilienceScenario } from "./types";

/**
 * M10 production-like resilience: which failure scenarios are relevant to THIS candidate (derived
 * deterministically from the diff's own content — never from filenames, comments, or identifiers
 * that merely look operational), and how executed scenario evidence maps onto the Resilience
 * quality dimension. Scenario execution itself is the resilience verifier port's job (see
 * infrastructure/resilience-verifier.ts); this module only decides relevance and posture, so the
 * same honesty rules as M9 apply: no evidence -> NOT_CHECKED, never PASS.
 */

export interface ResilienceRelevanceEvidence {
  scenarios: ResilienceScenario[];
  evidence: string[];
  /**
   * True when part of the diff could not be inspected for signals (a binary patch). An
   * uninspectable diff must never produce the zero-relevance deterministic PASS — absence of a
   * signal we could not look for is unknown, not evidence of nothing.
   */
  uninspectable: boolean;
  /**
   * COVERAGE of this relevance derivation, as distinct from its RESULT (trust invariant E). The
   * scan reads CODE files (see {@link isResilienceEvidencePath}) looking for outbound-dependency,
   * consistency and concurrency shapes. It never opens a Compose file, a Kubernetes manifest, a
   * Terraform plan, a CI workflow or a `.env`: those carry deployment/operational behaviour with
   * no code shape to match. When such an artefact is in the diff, "zero relevant scenarios" is a
   * statement about the code files only — it cannot discharge a concern that the operational
   * artefact itself raised. That is precisely how an operational RESILIENCE requirement was
   * previously settled by a scan that never looked at the operational file.
   */
  coverage?: AnalysisCoverage;
  /**
   * Changed operational/deployment artefacts this content scan structurally cannot read. Always
   * populated by {@link deriveResilienceRelevance}; optional only so that relevance objects built
   * by older adapters/records stay readable, and read defensively wherever it gates.
   */
  uncoveredOperationalFiles?: string[];
}

const resilienceEvidencePath =
  /\.(?:[cm]?[jt]sx?|go|py|java|cs|rb|rs|php|sql|prisma)$|(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/iu;
const nonProductionPath =
  /(^|\/)(?:tests?|__tests__|fixtures?|scripts?|tools?|benchmarks?)(\/|$)|\.(?:test|spec)\.[^/]+$/iu;
const isResilienceEvidencePath = (file: string): boolean =>
  resilienceEvidencePath.test(file) && !nonProductionPath.test(file);

/**
 * Deployment/operational artefacts: the file classes that make OperationalSensitivity rise and
 * that this content scan has no way to reason about. Declaring the boundary is the point — it is
 * a coverage statement, not a detector, and no verdict is derived from matching it.
 */
const operationalArtifactPath =
  /\.(?:ya?ml|tf|tfvars|hcl|toml|ini|cfg|conf|properties)$|(^|\/)(?:dockerfile[^/]*|docker-compose\.ya?ml|compose\.ya?ml|procfile|makefile)$|(^|\/)\.env(\.|$)|(^|\/)\.github\/workflows\/|(^|\/)(?:deploy|deployment|infra|infrastructure|k8s|kubernetes|helm|charts|terraform|ansible)(\/|$)/iu;
const isUncoveredOperationalArtifact = (file: string): boolean =>
  !isResilienceEvidencePath(file) &&
  !nonProductionPath.test(file) &&
  operationalArtifactPath.test(file);

/** An outbound dependency on another process/service over a network or IPC boundary. */
const outboundDependencySignal =
  /\bfetch\s*\(|\baxios\b|\bhttp\s*\.\s*(?:get|post|put|patch|del)|\bhttps?\s*\.\s*(?:get|post|request)|\bgrpc\b|\bgraphql\b|\bredis\b|\bmemcached\b|\b(?:s3|sqs|sns|kafka|rabbitmq|amqp|mqtt)\b|\bWebSocket\b|\bnew\s+[A-Za-z_$][\w$]*Client\s*\(|\bselect\b.+\bfrom\b|\binsert\s+into\b|\bprisma\.|\.query\s*\(/iu;

/** A write path where re-delivery or concurrent interleaving can corrupt state. */
const consistencySignal =
  /\btransaction\b|\bidempoten|\bserializable\b|\boptimistic.?(?:lock|concurrency)|\bunique\s+constraint\b|\bmutex\b|\blocked\s+at\b/iu;

/** Multiple in-flight operations whose completion order is not guaranteed. */
const concurrencySignal =
  /Promise\.(?:all|allSettled|race|any)\s*\(|\bconcurrent(?:ly)?\b|\bparallel(?:ly|ism)?\b|\bworker\s*(?:pool|thread)s?\b|\bsubscri(?:be|ption)\b/iu;

const networkScenarios: ResilienceScenario[] = [
  "HIGH_LATENCY",
  "TIMEOUT",
  "CONNECTION_RESET",
  "MALFORMED_UPSTREAM_RESPONSE",
  "RATE_LIMITING",
];

/**
 * Scenario relevance from the diff itself. Network-boundary code owes latency/timeout/reset/
 * malformed/rate-limit behavior; consistency-critical writes owe duplicate-request safety;
 * concurrent/interleaved flows owe out-of-order tolerance. A plan-required CONCURRENCY check adds
 * the interleaving scenarios regardless of markers (the plan already saw DataConsistencyRisk HIGH).
 */
export const deriveResilienceRelevance = (
  patch: string,
  concurrencyRequired: boolean,
): ResilienceRelevanceEvidence => {
  const scenarios = new Set<ResilienceScenario>();
  const evidence: string[] = [];
  // A binary patch carries code we cannot scan; git emits it with no +/- content lines, so the
  // loop below would silently see "nothing changed". Only uninspectable content on an
  // evidence-bearing path fails closed — a binary asset elsewhere in the diff proves nothing
  // either way about fault relevance.
  const uninspectable = [
    ...patch.matchAll(/^--- a\/(\S+)\n\+\+\+ b\/\S+\nGIT binary patch$/gmu),
  ].some((match) => isResilienceEvidencePath(match[1] ?? ""));
  if (uninspectable) {
    evidence.push("the diff contains a binary patch whose contents cannot be inspected");
  }
  for (const entry of parseFilePatches(patch)) {
    if (!isResilienceEvidencePath(entry.file)) continue;
    const codeLines = [...entry.addedLines, ...entry.removedLines].filter(
      (line) => !/^\s*(?:\/\/|\/\*|\*|#|<!--)/u.test(line),
    );
    if (codeLines.length === 0) continue;
    if (codeLines.some((line) => outboundDependencySignal.test(line))) {
      for (const scenario of networkScenarios) scenarios.add(scenario);
      evidence.push(`${entry.file}: outbound dependency call/edge changed`);
    }
    if (codeLines.some((line) => consistencySignal.test(line))) {
      scenarios.add("DUPLICATE_REQUEST");
      evidence.push(`${entry.file}: consistency-critical write path changed`);
    }
    if (codeLines.some((line) => concurrencySignal.test(line))) {
      scenarios.add("OUT_OF_ORDER_RESPONSE");
      evidence.push(`${entry.file}: concurrent/interleaved completion path changed`);
    }
  }
  if (concurrencyRequired) {
    scenarios.add("DUPLICATE_REQUEST");
    scenarios.add("OUT_OF_ORDER_RESPONSE");
    evidence.push(
      "assurance plan requires CONCURRENCY (DataConsistencyRisk HIGH): duplicate-request and out-of-order scenarios are always relevant",
    );
  }
  const uncoveredOperationalFiles = parseFilePatches(patch)
    .filter((entry) => isUncoveredOperationalArtifact(entry.file))
    .map((entry) => entry.file);
  const coveredFileCount = parseFilePatches(patch).filter((entry) =>
    isResilienceEvidencePath(entry.file),
  ).length;
  const coverage: AnalysisCoverage =
    uncoveredOperationalFiles.length > 0
      ? coveredFileCount > 0
        ? "PARTIAL"
        : "UNSUPPORTED"
      : coveredFileCount > 0
        ? "FULL"
        : "NOT_APPLICABLE";
  if (uncoveredOperationalFiles.length > 0) {
    evidence.push(
      `resilience relevance coverage ${coverage}: ${uncoveredOperationalFiles.length} deployment/operational artefact(s) changed that this content scan cannot read (${uncoveredOperationalFiles.slice(0, 10).join(", ")}) — their failure behaviour is not represented by the scenario relevance above`,
    );
  }
  if (evidence.length === 0) {
    evidence.push("no production-like failure scenario is evidenced by this candidate diff");
  }
  return {
    scenarios: [...scenarios],
    evidence,
    uninspectable,
    coverage,
    uncoveredOperationalFiles,
  };
};

export interface ResilienceScenarioResult {
  scenario: ResilienceScenario;
  outcome: "PASSED" | "FAILED" | "NOT_RUN";
  exitCode?: number | undefined;
  evidence: string[];
}

export interface ResilienceMeasurement {
  state: "EXECUTED" | "NOT_CHECKED";
  candidateId: string;
  diffDigest: string;
  /** Digest of declared candidate-local execution inputs, including the Compose configuration. */
  executionInputDigest?: string | undefined;
  executionInputs?: string[] | undefined;
  scenarios: ResilienceScenarioResult[];
  evidence: string[];
}

export interface ResilienceExecutionInputSnapshot {
  digest: string;
  inputs: string[];
}

export interface ResiliencePostureResult {
  state: "PASS" | "FAIL" | "NOT_CHECKED";
  evidence: string[];
  scenarios: ResilienceScenarioResult[];
  /** Coverage of the relevance scan this posture rests on. Never inferred from the verdict. */
  coverage?: AnalysisCoverage;
}

/**
 * Maps executed scenario evidence onto the Resilience dimension. Every scenario the diff made
 * relevant must actually have run and exited 0; a FAILED scenario is deterministic FAIL evidence;
 * anything missing, stale, or not candidate-bound is NOT_CHECKED. Scenario commands run in a
 * bounded local environment — that is resilience evidence, never production verification.
 */
export const deriveResiliencePosture = (
  measurement: ResilienceMeasurement | undefined,
  expectedCandidateId: string,
  expectedDiffDigest: string,
  relevance: ResilienceRelevanceEvidence,
): ResiliencePostureResult => {
  // A relevance scan is bounded discovery, not proof that no resilience scenario matters. An
  // empty result therefore stays NOT_CHECKED; only candidate-bound scenario execution may PASS.
  const uncoveredOperational = relevance.uncoveredOperationalFiles ?? [];
  if (relevance.scenarios.length === 0 && uncoveredOperational.length > 0) {
    // Trust invariant C/E: a relevance-empty verdict only resolves what the relevance scan can
    // actually read. A deployment/operational artefact changed in this candidate, and the scan
    // never opened it — reporting PASS here would let a content scan of the CODE discharge an
    // obligation raised by the OPERATIONAL change. Unsupported coverage stays unresolved.
    return {
      state: "NOT_CHECKED",
      evidence: [
        ...relevance.evidence,
        `no failure scenario was derivable from the code files, but this candidate changes ${uncoveredOperational.length} deployment/operational artefact(s) whose resilience behaviour no available capability evaluates — absence of a code-shaped signal cannot resolve that`,
      ],
      scenarios: [],
      ...(relevance.coverage ? { coverage: relevance.coverage } : {}),
    };
  }
  if (relevance.scenarios.length === 0 && !relevance.uninspectable) {
    return {
      state: "NOT_CHECKED",
      evidence: [
        ...relevance.evidence,
        "the bounded relevance scan found no scenario, but detector silence is not durability evidence",
      ],
      scenarios: [],
      ...(relevance.coverage ? { coverage: relevance.coverage } : {}),
    };
  }
  if (relevance.scenarios.length === 0 && relevance.uninspectable) {
    return {
      state: "NOT_CHECKED",
      evidence: [
        ...relevance.evidence,
        "relevance could not be derived from an uninspectable diff, so no scenario verdict is possible",
      ],
      scenarios: [],
      ...(relevance.coverage ? { coverage: relevance.coverage } : {}),
    };
  }
  if (!measurement) {
    return {
      state: "NOT_CHECKED",
      evidence: ["resilience evidence was required but no scenario execution was produced"],
      scenarios: [],
      ...(relevance.coverage ? { coverage: relevance.coverage } : {}),
    };
  }
  if (
    measurement.candidateId !== expectedCandidateId ||
    measurement.diffDigest !== expectedDiffDigest
  ) {
    return {
      state: "NOT_CHECKED",
      evidence: ["resilience evidence is not bound to the current candidate id and diff digest"],
      scenarios: [],
      ...(relevance.coverage ? { coverage: relevance.coverage } : {}),
    };
  }
  if (measurement.state !== "EXECUTED") {
    return {
      state: "NOT_CHECKED",
      evidence: measurement.evidence,
      scenarios: [],
      ...(relevance.coverage ? { coverage: relevance.coverage } : {}),
    };
  }
  const executed = new Map(measurement.scenarios.map((result) => [result.scenario, result]));
  const missing = relevance.scenarios.filter((scenario) => !executed.has(scenario));
  if (missing.length > 0) {
    return {
      state: "NOT_CHECKED",
      evidence: [
        ...measurement.evidence,
        `relevant scenario(s) were never executed: ${missing.join(", ")}`,
      ],
      scenarios: measurement.scenarios,
      ...(relevance.coverage ? { coverage: relevance.coverage } : {}),
    };
  }
  const scored = relevance.scenarios
    .map((scenario) => executed.get(scenario))
    .filter((result) => result !== undefined);
  const failed = scored.filter((result) => result.outcome === "FAILED");
  const notRun = scored.filter((result) => result.outcome === "NOT_RUN");
  if (notRun.length > 0) {
    // A NOT_RUN scenario is unknown, not failure — report it as not checked rather than
    // dressing absence of evidence up as either verdict.
    return {
      state: "NOT_CHECKED",
      evidence: [
        ...measurement.evidence,
        `scenario(s) were not run: ${notRun.map((result) => result.scenario).join(", ")}`,
      ],
      scenarios: measurement.scenarios,
      ...(relevance.coverage ? { coverage: relevance.coverage } : {}),
    };
  }
  if (failed.length === 0 && uncoveredOperational.length > 0) {
    // Every scenario the CODE made relevant passed — and that is exactly as far as the evidence
    // reaches. A deployment/operational artefact also changed in this candidate, and no scenario
    // was or could be derived for it, so the obligation is not fully discharged. The executed
    // evidence is preserved on the result rather than discarded.
    return {
      state: "NOT_CHECKED",
      evidence: [
        ...measurement.evidence,
        `all ${scored.length} code-derived scenario(s) executed and passed, but ${uncoveredOperational.length} deployment/operational artefact(s) changed that the relevance scan cannot read (${uncoveredOperational.slice(0, 10).join(", ")}) — their failure behaviour remains unevaluated`,
      ],
      scenarios: measurement.scenarios,
      ...(relevance.coverage ? { coverage: relevance.coverage } : {}),
    };
  }
  return {
    state: failed.length > 0 ? "FAIL" : "PASS",
    evidence: [
      ...measurement.evidence,
      ...(failed.length > 0
        ? failed.flatMap((result) => [
            `${result.scenario} FAILED${result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ""}: ${result.evidence.join("; ")}`,
          ])
        : [
            `all ${scored.length} relevant scenario(s) executed and passed in the bounded local environment (this is not production verification)`,
          ]),
    ],
    scenarios: measurement.scenarios,
    ...(relevance.coverage ? { coverage: relevance.coverage } : {}),
  };
};
