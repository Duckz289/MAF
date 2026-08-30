import type { AnalysisCoverage } from "../assurance";
import type { CapabilityId } from "../assurance-obligation";
import type {
  EstablishmentTarget,
  EvidenceClaim,
  EvidenceStrength,
  LanguageClass,
} from "../capability-adequacy";
import type { Sandbox, SandboxDiff } from "../ports";

export type ProviderExecution =
  | { outcome: "COMPLETED"; exitCode: number }
  | { outcome: "UNAVAILABLE"; detail: string }
  | { outcome: "UNSUPPORTED"; detail: string }
  | { outcome: "TIMED_OUT"; timeoutMs: number }
  | { outcome: "PROCESS_ERROR"; exitCode: number | null; detail: string }
  | { outcome: "MALFORMED_OUTPUT"; detail: string }
  | { outcome: "REFUSED"; detail: string };

export interface CapabilityProbe {
  available: boolean;
  version: string | null;
  detail: string;
}

export interface CapabilityProbeOptions {
  /** Re-check the installed provider for this invocation instead of relying on process cache. */
  fresh?: boolean;
}

/** Every provider result is provenance-bound. No anonymous evidence, ever. */
export interface ProviderProvenance {
  capabilityId: CapabilityId;
  providerName: string;
  providerVersion: string;
  rulesetDigest?: string;
  invokedAt: string;
  durationMs: number;
  candidateId: string;
  diffDigest: string;
  baseRevision: string;
}

export interface CapabilityFinding {
  target: EstablishmentTarget;
  claim: EvidenceClaim;
  strength: EvidenceStrength;
  /** Canonical candidate-relative file actually reported in analyzedFiles. */
  file: string;
  line?: number;
  ruleId: string;
  message: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

export interface CapabilityResult {
  provenance: ProviderProvenance;
  execution: ProviderExecution;
  findings: CapabilityFinding[];
  /** Per-language-class coverage the provider actually achieved on this candidate. */
  coverage: Partial<Record<LanguageClass, AnalysisCoverage>>;
  /** Separate from positive coverage: scanner silence is never absence by default. */
  negativeCoverage: Partial<Record<LanguageClass, AnalysisCoverage>>;
  /** Files the provider provably read. Empty means no absence claim is admissible. */
  analyzedFiles: string[];
}

export interface CapabilityProvider {
  readonly capabilityId: CapabilityId;
  readonly name: string;
  /** Reports whether the provider is present and runnable. Registry callers never see throws. */
  probe(options?: CapabilityProbeOptions): Promise<CapabilityProbe>;
  analyze(input: CapabilityInput): Promise<CapabilityResult>;
}

export interface CapabilityInput {
  /** The capability selected for this invocation, independent of what a provider later claims. */
  capabilityId: CapabilityId;
  sandbox: Sandbox;
  diff: SandboxDiff;
  candidateId: string;
  diffDigest: string;
  signal?: AbortSignal;
}
