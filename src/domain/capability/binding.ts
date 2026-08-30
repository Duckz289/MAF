import type { AnalysisCoverage } from "../assurance";
import {
  isConcernType,
  type EstablishmentTarget,
  type LanguageClass,
} from "../capability-adequacy";
import type {
  CapabilityFinding,
  CapabilityInput,
  CapabilityResult,
  ProviderExecution,
} from "./provider";

const boundCapabilityResult: unique symbol = Symbol("bound-capability-result");

/**
 * A provider result cloned and matched to the active invocation. The private brand prevents a raw
 * provider object from reaching the fold by accident; callers can obtain this type only through
 * {@link validateCapabilityResultBinding}.
 */
export interface BoundCapabilityResult {
  readonly [boundCapabilityResult]: true;
  readonly result: CapabilityResult;
}

export interface ActiveCapabilityBinding {
  input: CapabilityInput;
  /** Registry-selected identity, not a value supplied by the result being checked. */
  providerName: string;
  /** Version returned by the registry's cached successful probe. */
  providerVersion: string;
}

export type CapabilityBindingValidation =
  | { valid: true; boundResult: BoundCapabilityResult }
  | { valid: false; reasons: string[] };

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const maxProviderNameCharacters = 200;
const maxProviderVersionCharacters = 200;
const maxBindingCharacters = 1_000;
const maxRulesetDigestCharacters = 256;
const maxExecutionDetailCharacters = 2_000;
const maxFindingCount = 10_000;
const maxAnalyzedFileCount = 10_000;
const maxEvidencePathCharacters = 4_096;
const maxRuleIdCharacters = 512;
const maxFindingMessageCharacters = 4_096;
const maxTotalEvidenceCharacters = 2_000_000;
const maxDurationMs = 86_400_000;
const maxLineNumber = 10_000_000;

const languageClasses = new Set<LanguageClass>([
  "TS_JS",
  "PYTHON",
  "SHELL",
  "GENERIC_SCRIPTING",
  "BOUNDED_COMPILED",
  "UNMODELLED",
  "CONFIG_WORKFLOW",
]);
const coverageValues = new Set<AnalysisCoverage>([
  "FULL",
  "PARTIAL",
  "UNSUPPORTED",
  "NOT_APPLICABLE",
]);
const strengths = new Set(["LEXICAL", "STRUCTURAL", "BEHAVIORAL", "MEASURED"]);
const severities = new Set(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedText = (value: unknown, maximum: number): value is string =>
  nonEmpty(value) && value.length <= maximum && !value.includes("\0");

const safeEvidencePath = (value: unknown): value is string => {
  if (
    !boundedText(value, maxEvidencePathCharacters) ||
    value !== value.trim() ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /^[a-z]:/iu.test(value)
  ) {
    return false;
  }
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
};

const coverageIsValid = (
  value: unknown,
): value is Partial<Record<LanguageClass, AnalysisCoverage>> =>
  isRecord(value) &&
  Object.keys(value).length <= languageClasses.size &&
  Object.entries(value).every(
    ([languageClass, coverage]) =>
      languageClasses.has(languageClass as LanguageClass) &&
      coverageValues.has(coverage as AnalysisCoverage),
  );

const executionIsValid = (value: unknown): value is ProviderExecution => {
  if (!isRecord(value)) return false;
  switch (value.outcome) {
    case "COMPLETED":
      return Number.isSafeInteger(value.exitCode);
    case "UNAVAILABLE":
    case "UNSUPPORTED":
    case "MALFORMED_OUTPUT":
    case "REFUSED":
      return boundedText(value.detail, maxExecutionDetailCharacters);
    case "TIMED_OUT":
      return (
        Number.isSafeInteger(value.timeoutMs) &&
        (value.timeoutMs as number) > 0 &&
        (value.timeoutMs as number) <= maxDurationMs
      );
    case "PROCESS_ERROR":
      return (
        (value.exitCode === null || Number.isSafeInteger(value.exitCode)) &&
        boundedText(value.detail, maxExecutionDetailCharacters)
      );
    default:
      return false;
  }
};

const findingIsValid = (value: unknown): value is CapabilityFinding => {
  if (!isRecord(value)) return false;
  return (
    typeof value.target === "string" &&
    isConcernType(value.target as EstablishmentTarget) &&
    value.claim === "POSITIVE_FINDING" &&
    strengths.has(value.strength as string) &&
    severities.has(value.severity as string) &&
    boundedText(value.ruleId, maxRuleIdCharacters) &&
    !/[\r\n]/u.test(value.ruleId) &&
    boundedText(value.message, maxFindingMessageCharacters) &&
    safeEvidencePath(value.file) &&
    (value.line === undefined ||
      (Number.isSafeInteger(value.line) &&
        (value.line as number) > 0 &&
        (value.line as number) <= maxLineNumber))
  );
};

const resultShapeIsValid = (value: unknown): value is CapabilityResult => {
  if (!isRecord(value) || !isRecord(value.provenance)) return false;
  const provenance = value.provenance;
  if (
    !boundedText(provenance.capabilityId, maxBindingCharacters) ||
    !boundedText(provenance.providerName, maxProviderNameCharacters) ||
    !boundedText(provenance.providerVersion, maxProviderVersionCharacters) ||
    !boundedText(provenance.invokedAt, 64) ||
    Number.isNaN(Date.parse(provenance.invokedAt)) ||
    typeof provenance.durationMs !== "number" ||
    !Number.isFinite(provenance.durationMs) ||
    provenance.durationMs < 0 ||
    provenance.durationMs > maxDurationMs ||
    !boundedText(provenance.candidateId, maxBindingCharacters) ||
    !boundedText(provenance.diffDigest, maxBindingCharacters) ||
    !boundedText(provenance.baseRevision, maxBindingCharacters) ||
    (provenance.rulesetDigest !== undefined &&
      (!boundedText(provenance.rulesetDigest, maxRulesetDigestCharacters) ||
        !/^sha256:[a-f0-9]{64}$/iu.test(provenance.rulesetDigest))) ||
    !executionIsValid(value.execution) ||
    !coverageIsValid(value.coverage) ||
    !coverageIsValid(value.negativeCoverage) ||
    !Array.isArray(value.findings) ||
    value.findings.length > maxFindingCount ||
    !Array.isArray(value.analyzedFiles) ||
    value.analyzedFiles.length > maxAnalyzedFileCount
  ) {
    return false;
  }

  const analyzedFiles = new Set<string>();
  let totalCharacters = 0;
  for (const file of value.analyzedFiles) {
    if (!safeEvidencePath(file) || analyzedFiles.has(file)) return false;
    analyzedFiles.add(file);
    totalCharacters += file.length;
  }
  for (const finding of value.findings) {
    if (!findingIsValid(finding)) return false;
    if (finding.file !== undefined && !analyzedFiles.has(finding.file)) return false;
    totalCharacters += finding.ruleId.length + finding.message.length + (finding.file?.length ?? 0);
    if (totalCharacters > maxTotalEvidenceCharacters) return false;
  }
  return totalCharacters <= maxTotalEvidenceCharacters;
};

const snapshotExecution = (execution: ProviderExecution): ProviderExecution => {
  switch (execution.outcome) {
    case "COMPLETED":
      return { outcome: execution.outcome, exitCode: execution.exitCode };
    case "TIMED_OUT":
      return { outcome: execution.outcome, timeoutMs: execution.timeoutMs };
    case "PROCESS_ERROR":
      return {
        outcome: execution.outcome,
        exitCode: execution.exitCode,
        detail: execution.detail,
      };
    default:
      return { outcome: execution.outcome, detail: execution.detail };
  }
};

const snapshotResult = (result: CapabilityResult): CapabilityResult => ({
  provenance: {
    capabilityId: result.provenance.capabilityId,
    providerName: result.provenance.providerName,
    providerVersion: result.provenance.providerVersion,
    ...(result.provenance.rulesetDigest !== undefined
      ? { rulesetDigest: result.provenance.rulesetDigest }
      : {}),
    invokedAt: result.provenance.invokedAt,
    durationMs: result.provenance.durationMs,
    candidateId: result.provenance.candidateId,
    diffDigest: result.provenance.diffDigest,
    baseRevision: result.provenance.baseRevision,
  },
  execution: snapshotExecution(result.execution),
  findings: result.findings.map((finding) => ({
    target: finding.target,
    claim: finding.claim,
    strength: finding.strength,
    file: finding.file,
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    ruleId: finding.ruleId,
    message: finding.message,
    severity: finding.severity,
  })),
  coverage: { ...result.coverage },
  negativeCoverage: { ...result.negativeCoverage },
  analyzedFiles: [...result.analyzedFiles],
});

/**
 * Matches provider provenance to the invocation MAF actually made. Provider assertions are never
 * self-authenticating: candidate, digest, revision, capability, and provider identity all come
 * from the active consumer context. Only bounded canonical fields are copied before branding,
 * preventing provider-held references or extra raw payloads from reaching the fold.
 */
export const validateCapabilityResultBinding = (
  result: CapabilityResult,
  active: ActiveCapabilityBinding,
): CapabilityBindingValidation => {
  const activeReasons: string[] = [];
  if (!nonEmpty(active.input.capabilityId)) activeReasons.push("active capability was empty");
  if (!nonEmpty(active.input.candidateId)) activeReasons.push("active candidate id was empty");
  if (!nonEmpty(active.input.diffDigest)) activeReasons.push("active candidate digest was empty");
  if (!nonEmpty(active.input.sandbox.baseRevision)) {
    activeReasons.push("active base revision was empty");
  }
  if (!nonEmpty(active.providerName)) activeReasons.push("selected provider name was empty");
  if (!nonEmpty(active.providerVersion)) {
    activeReasons.push("selected provider version was unverified");
  }
  if (activeReasons.length > 0) return { valid: false, reasons: activeReasons };

  let snapshot: CapabilityResult;
  try {
    if (!resultShapeIsValid(result)) {
      return {
        valid: false,
        reasons: ["provider result was malformed or exceeded canonical evidence bounds"],
      };
    }
    snapshot = snapshotResult(result);
    if (!resultShapeIsValid(snapshot)) {
      return {
        valid: false,
        reasons: ["provider result changed while its canonical snapshot was captured"],
      };
    }
  } catch {
    return { valid: false, reasons: ["provider result could not be safely normalized"] };
  }

  const provenance = snapshot?.provenance;
  if (provenance === null || typeof provenance !== "object") {
    return { valid: false, reasons: ["provider result had no provenance object"] };
  }

  const reasons: string[] = [];
  if (provenance.capabilityId !== active.input.capabilityId) {
    reasons.push("returned capability did not match the requested capability");
  }
  if (provenance.candidateId !== active.input.candidateId) {
    reasons.push("returned candidate id did not match the active candidate");
  }
  if (provenance.diffDigest !== active.input.diffDigest) {
    reasons.push("returned candidate digest did not match the active candidate");
  }
  if (provenance.baseRevision !== active.input.sandbox.baseRevision) {
    reasons.push("returned base revision did not match the active candidate revision");
  }
  if (provenance.providerName !== active.providerName) {
    reasons.push("returned provider identity did not match the selected provider");
  }
  if (provenance.providerVersion !== active.providerVersion) {
    reasons.push("returned provider version did not match the probed provider version");
  }

  if (reasons.length > 0) return { valid: false, reasons };
  return {
    valid: true,
    boundResult: { [boundCapabilityResult]: true, result: snapshot },
  };
};
