import type { AnalysisCoverage } from "../domain/assurance";
import type {
  CapabilityId,
  ConcernEvidence,
  ObligationStatus,
} from "../domain/assurance-obligation";
import {
  capabilitiesEstablishing,
  isConcernType,
  languageClassOf,
  type LanguageClass,
} from "../domain/capability-adequacy";
import { validateCapabilityResultBinding } from "../domain/capability/binding";
import { foldCapabilityResult, type FoldedCapabilityResult } from "../domain/capability/fold";
import type {
  CapabilityFinding,
  CapabilityInput,
  CapabilityResult,
  ProviderExecution,
} from "../domain/capability/provider";
import { redactSensitiveText } from "../domain/security";
import type { DiscoveredConcern } from "../domain/concern-discovery";
import type { CapabilityRegistry, CapabilityResolution } from "./capability-registry";

export type CapabilityExecutionOutcome =
  | ProviderExecution["outcome"]
  | "ANALYZE_THREW"
  | "BINDING_REJECTED"
  | "INVALID_RESULT";

export type CapabilityFailureCategory =
  | "PROVIDER_UNAVAILABLE"
  | "VERSION_UNVERIFIED"
  | "UNSUPPORTED_INPUT"
  | "TIMEOUT"
  | "PROCESS_ERROR"
  | "MALFORMED_OUTPUT"
  | "REFUSED"
  | "ANALYZE_THREW"
  | "BINDING_MISMATCH"
  | "INVALID_RESULT";

/** Safe, bounded fields an observability adapter may emit. */
export interface CapabilityExecutionObservation {
  capabilityId: CapabilityId;
  providerName: string;
  providerVersion: string | null;
  durationMs: number;
  outcome: CapabilityExecutionOutcome;
  coverage: AnalysisCoverage;
  findingCount: number;
  analyzedFileCount: number;
  failureCategory: CapabilityFailureCategory | null;
}

export interface CapabilityExecutionObserver {
  record(observation: CapabilityExecutionObservation): Promise<void> | void;
}

export interface NormalizedCapabilityEvidence extends CapabilityExecutionObservation {
  candidateId: string;
  startedAt: string;
  completedAt: string;
  /** Active invocation binding retained for the internal obligation ledger, never required in OTLP. */
  diffDigest: string;
  baseRevision: string;
  binding: "MATCHED" | "NOT_EVALUATED" | "REJECTED";
  status: ObligationStatus;
  justification: string;
  /** Included only after valid binding and a successful normalized finding fold. */
  findings: CapabilityFinding[];
  /** Relative provider-reported scope, included only after valid binding. */
  analyzedFiles: string[];
  rulesetDigest: string | null;
  telemetry: "DISABLED" | "EMITTED" | "FAILED";
}

export interface ActiveCandidateSnapshot {
  diffDigest: string;
  baseRevision: string;
}

export interface CapabilityConcernProjection {
  concerns: DiscoveredConcern[];
  concernEvidence: ConcernEvidence[];
}

export interface CapabilityProjectionContext {
  changedFiles: string[];
  candidateId: string;
  diffDigest: string;
}

interface ExecuteCapabilityOptions {
  registry: CapabilityRegistry;
  input: CapabilityInput;
  candidateLanguageClasses: LanguageClass[];
  observer?: CapabilityExecutionObserver | undefined;
  /** Re-reads the active workspace after a provider returns and before its result can be folded. */
  revalidate?: (() => Promise<ActiveCandidateSnapshot>) | undefined;
}

interface ExecuteRegisteredCapabilitiesOptions {
  registry: CapabilityRegistry;
  input: Omit<CapabilityInput, "capabilityId">;
  observer?: CapabilityExecutionObserver | undefined;
  revalidate?: (() => Promise<ActiveCandidateSnapshot>) | undefined;
}

const snapshotCapabilityInput = (input: CapabilityInput): CapabilityInput => ({
  capabilityId: input.capabilityId,
  sandbox: { ...input.sandbox },
  diff: { patch: input.diff.patch, changedFiles: [...input.diff.changedFiles] },
  candidateId: input.candidateId,
  diffDigest: input.diffDigest,
  ...(input.signal ? { signal: input.signal } : {}),
});

const boundedDetail = (value: string): string => redactSensitiveText(value).slice(0, 500);

const observationCount = (value: number): number =>
  Number.isFinite(value) ? Math.min(10_000, Math.max(0, Math.trunc(value))) : 0;

const failureFor = (outcome: CapabilityExecutionOutcome): CapabilityFailureCategory | null => {
  switch (outcome) {
    case "COMPLETED":
      return null;
    case "UNAVAILABLE":
      return "PROVIDER_UNAVAILABLE";
    case "UNSUPPORTED":
      return "UNSUPPORTED_INPUT";
    case "TIMED_OUT":
      return "TIMEOUT";
    case "PROCESS_ERROR":
      return "PROCESS_ERROR";
    case "MALFORMED_OUTPUT":
      return "MALFORMED_OUTPUT";
    case "REFUSED":
      return "REFUSED";
    case "ANALYZE_THREW":
      return "ANALYZE_THREW";
    case "BINDING_REJECTED":
      return "BINDING_MISMATCH";
    case "INVALID_RESULT":
      return "INVALID_RESULT";
  }
};

const deliverObservation = async (
  observer: CapabilityExecutionObserver | undefined,
  evidence: Omit<NormalizedCapabilityEvidence, "telemetry">,
): Promise<NormalizedCapabilityEvidence> => {
  if (!observer) return { ...evidence, telemetry: "DISABLED" };
  try {
    const observation: CapabilityExecutionObservation = {
      capabilityId: evidence.capabilityId,
      providerName: evidence.providerName,
      providerVersion: evidence.providerVersion,
      durationMs: evidence.durationMs,
      outcome: evidence.outcome,
      coverage: evidence.coverage,
      findingCount: evidence.findingCount,
      analyzedFileCount: evidence.analyzedFileCount,
      failureCategory: evidence.failureCategory,
    };
    await Promise.resolve().then(() => observer.record(observation));
    return { ...evidence, telemetry: "EMITTED" };
  } catch {
    // Observability is never execution authority. An exporter outage cannot repaint or abort the
    // provider result, and error text is intentionally excluded to avoid exporting credentials.
    return { ...evidence, telemetry: "FAILED" };
  }
};

const nonResult = async (
  options: ExecuteCapabilityOptions,
  resolution: CapabilityResolution,
  input: {
    startedAt: string;
    durationMs: number;
    outcome: CapabilityExecutionOutcome;
    justification: string;
    failureCategory?: CapabilityFailureCategory | undefined;
    binding?: "NOT_EVALUATED" | "REJECTED" | undefined;
  },
): Promise<NormalizedCapabilityEvidence> => {
  const completedAt = new Date().toISOString();
  const evidence: Omit<NormalizedCapabilityEvidence, "telemetry"> = {
    capabilityId: options.input.capabilityId,
    providerName: resolution.selectedProviderName,
    providerVersion: resolution.probe.version,
    candidateId: options.input.candidateId,
    diffDigest: options.input.diffDigest,
    baseRevision: options.input.sandbox.baseRevision,
    startedAt: input.startedAt,
    completedAt,
    durationMs: Math.max(0, input.durationMs),
    outcome: input.outcome,
    coverage: "UNSUPPORTED",
    findingCount: 0,
    analyzedFileCount: 0,
    failureCategory: input.failureCategory ?? failureFor(input.outcome),
    binding: input.binding ?? "NOT_EVALUATED",
    status: "NOT_CHECKED",
    justification: boundedDetail(input.justification),
    findings: [],
    analyzedFiles: [],
    rulesetDigest: null,
  };
  return deliverObservation(options.observer, evidence);
};

const executeResolution = async (
  requestedOptions: ExecuteCapabilityOptions,
  resolution: CapabilityResolution,
): Promise<NormalizedCapabilityEvidence> => {
  // The active binding is captured before any untrusted provider code runs. The provider receives
  // a second snapshot, so mutating its input cannot repaint the consumer-owned invocation later
  // used by workspace revalidation or provenance binding.
  const options: ExecuteCapabilityOptions = {
    ...requestedOptions,
    input: snapshotCapabilityInput(requestedOptions.input),
  };
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const { provider, probe, selectedCapabilityId, selectedProviderName } = resolution;

  if (!probe.available) {
    return nonResult(options, resolution, {
      startedAt,
      durationMs: performance.now() - started,
      outcome: "UNAVAILABLE",
      justification: `Provider was unavailable: ${probe.detail}`,
    });
  }
  if (!probe.version) {
    return nonResult(options, resolution, {
      startedAt,
      durationMs: performance.now() - started,
      outcome: "UNAVAILABLE",
      failureCategory: "VERSION_UNVERIFIED",
      justification: "Provider probe did not establish an exact version.",
    });
  }
  if (selectedCapabilityId !== options.input.capabilityId) {
    return nonResult(options, resolution, {
      startedAt,
      durationMs: performance.now() - started,
      outcome: "BINDING_REJECTED",
      binding: "REJECTED",
      justification: "Registry resolution returned a provider for a different capability.",
    });
  }

  let rawResult: CapabilityResult;
  try {
    rawResult = await provider.analyze(snapshotCapabilityInput(options.input));
  } catch {
    return nonResult(options, resolution, {
      startedAt,
      durationMs: performance.now() - started,
      outcome: "ANALYZE_THREW",
      justification: "Provider analyze threw before producing a bounded result.",
    });
  }

  if (options.revalidate) {
    let active: ActiveCandidateSnapshot;
    try {
      active = await options.revalidate();
    } catch {
      return nonResult(options, resolution, {
        startedAt,
        durationMs: performance.now() - started,
        outcome: "BINDING_REJECTED",
        binding: "REJECTED",
        justification: "The active candidate could not be re-read after provider execution.",
      });
    }
    if (
      active.diffDigest !== options.input.diffDigest ||
      active.baseRevision !== options.input.sandbox.baseRevision
    ) {
      return nonResult(options, resolution, {
        startedAt,
        durationMs: performance.now() - started,
        outcome: "BINDING_REJECTED",
        binding: "REJECTED",
        justification: "The active candidate changed during provider execution.",
      });
    }
  }

  const validation = validateCapabilityResultBinding(rawResult, {
    input: options.input,
    providerName: selectedProviderName,
    providerVersion: probe.version,
  });
  if (!validation.valid) {
    return nonResult(options, resolution, {
      startedAt,
      durationMs: performance.now() - started,
      outcome: "BINDING_REJECTED",
      binding: "REJECTED",
      justification: `Provider result was rejected before folding: ${validation.reasons.join("; ")}`,
    });
  }

  let folded: FoldedCapabilityResult;
  try {
    folded = foldCapabilityResult(validation.boundResult, options.candidateLanguageClasses);
  } catch {
    return nonResult(options, resolution, {
      startedAt,
      durationMs: performance.now() - started,
      outcome: "INVALID_RESULT",
      binding: "REJECTED",
      justification: "Bound provider result could not be normalized by the canonical fold.",
    });
  }

  const result = validation.boundResult.result;
  const outcome = result.execution.outcome;
  const validFindings = folded.status === "FAIL" || folded.status === "WARN";
  const evidence: Omit<NormalizedCapabilityEvidence, "telemetry"> = {
    capabilityId: options.input.capabilityId,
    providerName: selectedProviderName,
    providerVersion: probe.version,
    candidateId: options.input.candidateId,
    diffDigest: options.input.diffDigest,
    baseRevision: options.input.sandbox.baseRevision,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.max(0, performance.now() - started),
    outcome,
    coverage: folded.coverage,
    findingCount: observationCount(validFindings ? result.findings.length : 0),
    analyzedFileCount: observationCount(result.analyzedFiles.length),
    failureCategory: failureFor(outcome),
    binding: "MATCHED",
    status: folded.status,
    justification: boundedDetail(folded.justification),
    findings: validFindings ? result.findings : [],
    analyzedFiles: result.analyzedFiles,
    rulesetDigest: result.provenance.rulesetDigest ?? null,
  };
  return deliverObservation(options.observer, evidence);
};

export const executeCapability = async (
  options: ExecuteCapabilityOptions,
): Promise<NormalizedCapabilityEvidence[]> => {
  const resolutions = await options.registry.resolveWithStatus(options.input.capabilityId, {
    freshProbe: true,
  });
  return Promise.all(resolutions.map((resolution) => executeResolution(options, resolution)));
};

/** Executes every configured capability without hard-coding provider identities in the kernel. */
export const executeRegisteredCapabilities = async (
  options: ExecuteRegisteredCapabilitiesOptions,
): Promise<NormalizedCapabilityEvidence[]> => {
  const candidateLanguageClasses = [
    ...new Set(options.input.diff.changedFiles.map(languageClassOf)),
  ].toSorted();
  const nested = await Promise.all(
    options.registry.capabilityIds().map((capabilityId) =>
      executeCapability({
        registry: options.registry,
        input: { ...options.input, capabilityId },
        candidateLanguageClasses,
        ...(options.observer ? { observer: options.observer } : {}),
        ...(options.revalidate ? { revalidate: options.revalidate } : {}),
      }),
    ),
  );
  return nested.flat();
};

const findingSeverityRank: Record<CapabilityFinding["severity"], number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

/**
 * Projects only bound positive findings into the existing exact-concern obligation vocabulary.
 * Silence, partial execution, unsupported targets, and capability/target mismatches project
 * nothing, so adding an external provider can block on new evidence but can never promote.
 */
export const projectCapabilityConcerns = (
  results: NormalizedCapabilityEvidence[],
  context?: CapabilityProjectionContext,
): CapabilityConcernProjection => {
  const concerns: DiscoveredConcern[] = [];
  const concernEvidence: ConcernEvidence[] = [];
  const orderedResults = [...results].toSorted(
    (left, right) =>
      left.capabilityId.localeCompare(right.capabilityId) ||
      left.providerName.localeCompare(right.providerName) ||
      (left.providerVersion ?? "").localeCompare(right.providerVersion ?? ""),
  );

  for (const result of orderedResults) {
    if (
      result.binding !== "MATCHED" ||
      result.outcome !== "COMPLETED" ||
      (result.status !== "FAIL" && result.status !== "WARN")
    ) {
      continue;
    }
    const findings = [...result.findings].toSorted(
      (left, right) =>
        left.target.localeCompare(right.target) ||
        (left.file ?? "").localeCompare(right.file ?? "") ||
        (left.line ?? 0) - (right.line ?? 0) ||
        left.ruleId.localeCompare(right.ruleId) ||
        findingSeverityRank[right.severity] - findingSeverityRank[left.severity],
    );
    for (const finding of findings) {
      if (!isConcernType(finding.target)) continue;
      const producer = capabilitiesEstablishing(finding.target).find(
        (capability) => capability === result.capabilityId,
      );
      if (!producer) continue;
      const file =
        finding.file ?? (result.analyzedFiles.length === 1 ? result.analyzedFiles[0] : undefined);
      if (!file) continue;
      const line = finding.line ?? 0;
      const boundedRuleId = boundedDetail(finding.ruleId);
      const witness = `${file}${line > 0 ? `:${line}` : ""}: ${boundedRuleId} reported a ${finding.severity} positive finding`;
      concerns.push({
        concern: finding.target,
        file,
        languageClass: languageClassOf(file),
        evidence: `bound positive capability finding ${boundedRuleId}`,
        obligationAtomIdentities: [
          `capability:${producer}:${finding.target}:${file}:${line}:${boundedRuleId}`,
        ],
      });
      concernEvidence.push({
        concern: finding.target,
        producedBy: producer,
        outcome: finding.severity === "HIGH" || finding.severity === "CRITICAL" ? "FAIL" : "WARN",
        claim: "POSITIVE_FINDING",
        completeness: "NOT_APPLICABLE",
        coverage: result.coverage,
        strength: finding.strength,
        analysisScope: `${result.analyzedFiles.length} bound candidate file(s) reported analyzed`,
        evidence: [witness],
        candidateId: result.candidateId,
        diffDigest: result.diffDigest,
      });
    }
  }

  // A changed dependency inventory raises a question even when an optional scanner is absent or
  // silent. The configured advisory scanner currently has positive-finding authority only: its database/ruleset and
  // inventory coverage are not attested strongly enough for silence to establish clean absence.
  // Keeping this as a typed residual obligation prevents provider availability from deciding
  // whether dependency risk exists at all.
  const dependencyInventoryPattern =
    /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?|requirements(?:\.[^/]+)?\.txt|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/iu;
  for (const file of (context?.changedFiles ?? [])
    .map((item) => item.replace(/\\/gu, "/"))
    .filter((item) => dependencyInventoryPattern.test(item))
    .toSorted()) {
    concerns.push({
      concern: "SECURITY.DEPENDENCY_VULNERABILITY",
      file,
      languageClass: languageClassOf(file),
      evidence:
        "dependency inventory changed; bounded known-vulnerability absence has not been established",
      obligationAtomIdentities: [`dependency-inventory:${file}`],
    });

    const scanner = orderedResults.find(
      (result) =>
        result.capabilityId === "SECURITY.DEPENDENCY_VULNERABILITY_SCAN" &&
        result.candidateId === context?.candidateId &&
        result.diffDigest === context?.diffDigest,
    );
    if (!scanner) continue;
    const inventoryAnalyzed = scanner.analyzedFiles
      .map((item) => item.replace(/\\/gu, "/"))
      .includes(file);
    concernEvidence.push({
      concern: "SECURITY.DEPENDENCY_VULNERABILITY",
      producedBy: "SECURITY.DEPENDENCY_VULNERABILITY_SCAN",
      outcome: "NOT_CHECKED",
      claim: "NEGATIVE_ABSENCE",
      completeness:
        scanner.binding === "MATCHED" && scanner.outcome === "COMPLETED" && inventoryAnalyzed
          ? "COMPLETE"
          : "INCOMPLETE",
      coverage: scanner.coverage,
      strength: "STRUCTURAL",
      analysisScope: inventoryAnalyzed
        ? `the changed dependency inventory ${file}`
        : `no complete scan of the changed dependency inventory ${file}`,
      evidence: [
        scanner.justification,
        scanner.rulesetDigest
          ? `provider ruleset identity: ${scanner.rulesetDigest}`
          : "provider did not supply a promotion-authoritative advisory database/ruleset identity",
        "this capability may report concrete advisory matches but is not authorized to claim vulnerability absence",
      ],
      candidateId: context?.candidateId,
      diffDigest: context?.diffDigest,
    });
  }
  return { concerns, concernEvidence };
};
