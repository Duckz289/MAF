// Bounded, redacted diagnostic capture for real-provider experiment executions.
//
// The first billed Protocol v2 preflight (INVALID_PREFLIGHT_ATTEMPT, archived outside this repo)
// failed both arms with nothing recorded beyond the string "agent process exited with code 1". The
// adapter had already observed stderr, the CLI's structured result subtype, and the process exit
// code -- all of it was discarded before reaching provenance, which made the true first cause
// unrecoverable after the fact.
//
// This module owns the two things that has to get right: keeping enough evidence to diagnose a
// failure, and never letting a credential reach durable storage while doing it.

import { redactSensitiveText } from "../../../../src/domain/security";

/** Hard ceiling on any single persisted stderr field. Diagnostics are evidence, not a log sink. */
export const MAX_STDERR_TAIL_CHARS = 4_000;
export const MAX_STDERR_SUMMARY_CHARS = 400;

export interface StderrDiagnostics {
  /** Whether any stderr output was observed at all. False is meaningful: it rules out a crash that
   *  printed a reason, which is itself diagnostic. */
  observed: boolean;
  /** Total characters observed before bounding, so a truncated tail is never mistaken for all of it. */
  totalChars: number;
  truncated: boolean;
  /** First meaningful line, redacted and bounded -- usually the actual error. */
  summary: string | null;
  /** Bounded, redacted tail. Errors that matter tend to be at the end. */
  tail: string | null;
}

/**
 * Bounds and redacts collected stderr. Redaction runs on the FULL text before truncation, so a
 * secret split across the truncation boundary cannot survive by being half-copied.
 */
export const summarizeStderr = (chunks: readonly string[]): StderrDiagnostics => {
  const raw = chunks.join("");
  if (raw.length === 0) {
    return { observed: false, totalChars: 0, truncated: false, summary: null, tail: null };
  }
  const redacted = redactSensitiveText(raw);
  const lines = redacted
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstLine = lines[0];
  const summary = firstLine === undefined ? null : firstLine.slice(0, MAX_STDERR_SUMMARY_CHARS);
  const truncated = redacted.length > MAX_STDERR_TAIL_CHARS;
  return {
    observed: true,
    totalChars: raw.length,
    truncated,
    summary,
    tail: redacted.slice(-MAX_STDERR_TAIL_CHARS),
  };
};

/**
 * How much the provider's own reported model identity can be trusted.
 *
 * RESOLVED                  a concrete, plausibly-real provider model identifier was reported.
 * ALIAS_ONLY                nothing more specific than the requested alias is observable.
 * PLACEHOLDER_OR_SYNTHETIC  the provider reported something, but it is a placeholder/synthetic
 *                           marker rather than a real model identity. The first billed preflight
 *                           recorded `<synthetic>` as RESOLVED; that must never happen again.
 * NOT_REPORTED              the provider reported no model identity at all.
 */
export type ModelResolutionStatus =
  | "RESOLVED"
  | "ALIAS_ONLY"
  | "PLACEHOLDER_OR_SYNTHETIC"
  | "NOT_REPORTED";

export interface ModelProvenance {
  requestedModel: string;
  /** Exactly what the provider reported, preserved verbatim (bounded) for audit. Null if none. */
  rawReportedModel: string | null;
  /** The identifier trusted as the resolved model, or null when nothing trustworthy was reported. */
  resolvedModel: string | null;
  resolvedModelStatus: ModelResolutionStatus;
  /** Why the status was assigned, so a reader never has to re-derive the judgement. */
  note: string;
}

/**
 * Placeholder shapes a real Anthropic model identifier never has. Deliberately general rather than
 * a denylist of one literal: the failure mode is "the provider handed us a stand-in", and
 * `<synthetic>` was only the instance we happened to observe.
 */
const placeholderModelPatterns: RegExp[] = [
  /^<.*>$/u, // <synthetic>, <unknown>, <none>
  /^\[.*\]$/u, // [redacted], [placeholder]
  /\bsynthetic\b/iu,
  /\bplaceholder\b/iu,
  /\b(?:mock|fake|dummy|stub)\b/iu,
  /^(?:unknown|none|null|undefined|n\/a|test)$/iu,
];

/**
 * A real provider model identity is a non-trivial token containing at least one letter, e.g.
 * `claude-sonnet-5-20250929`. Anything shorter than this is not a usable identity even if it is not
 * an outright placeholder.
 */
const plausibleModelIdentifier = (value: string): boolean =>
  value.length >= 3 && /[a-z]/iu.test(value);

export const classifyModelProvenance = (input: {
  requestedModel: string;
  reportedModel: string | null;
}): ModelProvenance => {
  const requestedModel = input.requestedModel;
  const reported = input.reportedModel?.trim() ?? "";
  const rawReportedModel = reported.length > 0 ? redactSensitiveText(reported).slice(0, 200) : null;

  if (rawReportedModel === null) {
    return {
      requestedModel,
      rawReportedModel: null,
      resolvedModel: null,
      resolvedModelStatus: "NOT_REPORTED",
      note: "the provider reported no model identity; only the requested alias is known",
    };
  }
  if (placeholderModelPatterns.some((pattern) => pattern.test(rawReportedModel))) {
    return {
      requestedModel,
      rawReportedModel,
      resolvedModel: null,
      resolvedModelStatus: "PLACEHOLDER_OR_SYNTHETIC",
      note:
        `the provider reported ${JSON.stringify(rawReportedModel)}, which matches a placeholder/` +
        "synthetic shape rather than a real model identity; it is recorded verbatim but never " +
        "treated as resolved model provenance",
    };
  }
  if (!plausibleModelIdentifier(rawReportedModel)) {
    return {
      requestedModel,
      rawReportedModel,
      resolvedModel: null,
      resolvedModelStatus: "PLACEHOLDER_OR_SYNTHETIC",
      note:
        `the provider reported ${JSON.stringify(rawReportedModel)}, which is too short/degenerate ` +
        "to be a usable model identity",
    };
  }
  if (rawReportedModel === requestedModel) {
    return {
      requestedModel,
      rawReportedModel,
      resolvedModel: rawReportedModel,
      resolvedModelStatus: "ALIAS_ONLY",
      note:
        "the provider echoed the requested alias without a more specific immutable identifier; no " +
        "underlying version is invented",
    };
  }
  return {
    requestedModel,
    rawReportedModel,
    resolvedModel: rawReportedModel,
    resolvedModelStatus: "RESOLVED",
    note: "the provider reported a concrete model identifier distinct from the requested alias",
  };
};

/**
 * Whether this model provenance is good enough to let a REAL-provider preflight be called a
 * success. A placeholder identity means we cannot prove which model actually ran, which is exactly
 * the reproducibility hole the first billed preflight left behind.
 */
export const modelProvenanceAcceptableForPreflight = (provenance: ModelProvenance): boolean =>
  provenance.resolvedModelStatus === "RESOLVED" || provenance.resolvedModelStatus === "ALIAS_ONLY";
