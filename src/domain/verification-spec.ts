import { deterministicDigest } from "./deterministic-identity";
import type { VerificationSpec } from "./types";

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 120_000;
export const MAX_VERIFICATION_TIMEOUT_MS = 600_000;

export type VerificationSpecificationStatus = "CONFIGURED" | "NOT_CONFIGURED" | "INVALID";

export interface NormalizedVerificationSpecification {
  status: VerificationSpecificationStatus;
  command?: string;
  expectedFile?: string;
  timeoutMs?: number;
  identity: string;
  invalidReasons: string[];
}

const normalizeExpectedFile = (
  value: string | undefined,
): { value?: string; invalidReason?: string } => {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return {};
  if (trimmed.includes("\0")) return { invalidReason: "expected-file path contains a NUL byte" };

  const separatorsNormalized = trimmed.replace(/\\/gu, "/");
  if (
    separatorsNormalized.startsWith("/") ||
    separatorsNormalized.startsWith("//") ||
    /^[a-z]:\//iu.test(separatorsNormalized)
  ) {
    return { invalidReason: "expected-file path must be candidate-relative" };
  }

  const segments = separatorsNormalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    return { invalidReason: "expected-file path must not escape the candidate root" };
  }
  const normalized = segments.filter((segment) => segment.length > 0 && segment !== ".").join("/");
  return normalized.length > 0
    ? { value: normalized }
    : { invalidReason: "expected-file path has no supported candidate-relative representation" };
};

/**
 * The one canonical interpretation of verification configuration.
 *
 * Outer command whitespace has no authority. Expected-file paths are candidate-relative and use
 * one separator representation. The identity is over this semantic form, so omitted, empty, and
 * whitespace-only inputs cannot acquire different verification authority in different layers.
 */
export const normalizeVerificationSpecification = (
  specification: VerificationSpec | undefined,
): NormalizedVerificationSpecification => {
  const command = specification?.command?.trim() ?? "";
  const expectedFile = normalizeExpectedFile(specification?.expectedFile);
  const invalidReasons: string[] = [];
  if (expectedFile.invalidReason) invalidReasons.push(expectedFile.invalidReason);

  const configuredCommand = command.length > 0;
  const configuredExpectedFile = expectedFile.value !== undefined;
  let timeoutMs: number | undefined;
  if (configuredCommand) {
    const requested = specification?.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(requested) ||
      requested <= 0 ||
      requested > MAX_VERIFICATION_TIMEOUT_MS
    ) {
      invalidReasons.push(
        `verification timeout must be an integer between 1 and ${MAX_VERIFICATION_TIMEOUT_MS} milliseconds`,
      );
    } else {
      timeoutMs = requested;
    }
  }

  const status: VerificationSpecificationStatus =
    invalidReasons.length > 0
      ? "INVALID"
      : configuredCommand || configuredExpectedFile
        ? "CONFIGURED"
        : "NOT_CONFIGURED";
  const semantic = {
    schemaVersion: 1,
    status,
    ...(status === "CONFIGURED" && configuredCommand && timeoutMs !== undefined
      ? { command, timeoutMs }
      : {}),
    ...(status === "CONFIGURED" && configuredExpectedFile
      ? { expectedFile: expectedFile.value }
      : {}),
    ...(status === "INVALID" ? { invalidReasons: [...invalidReasons].toSorted() } : {}),
  };
  return {
    status,
    ...(status === "CONFIGURED" && configuredCommand && timeoutMs !== undefined
      ? { command, timeoutMs }
      : {}),
    ...(status === "CONFIGURED" && configuredExpectedFile
      ? { expectedFile: expectedFile.value }
      : {}),
    identity: `verification-spec-${deterministicDigest(semantic)}`,
    invalidReasons,
  };
};

export const verificationSpecificationForPersistence = (
  specification: NormalizedVerificationSpecification,
): VerificationSpec => ({
  ...(specification.command ? { command: specification.command } : {}),
  ...(specification.expectedFile ? { expectedFile: specification.expectedFile } : {}),
  ...(specification.command && specification.timeoutMs
    ? { timeoutMs: specification.timeoutMs }
    : {}),
});
