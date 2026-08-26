import { type Attributes, type Span, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import type {
  CapabilityExecutionObservation,
  CapabilityExecutionObserver,
} from "../application/capability-execution";
import { redactSensitiveText } from "../domain/security";

export const CAPABILITY_EXECUTION_SPAN_NAME = "maf.capability.execution";
export const CAPABILITY_EXECUTION_INSTRUMENTATION_SCOPE =
  "adaptive-agent-harness.capability-execution";

const unknownLabel = "unknown";
const noFailure = "none";
const maxLabelLength = 64;
const maxDurationMs = 86_400_000;
const maxObservationCount = 10_000;
const safeLabel = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,63})?$/u;

const capabilities = new Set(
  Object.keys({
    "CORRECTNESS.TRUSTED_COMMAND": true,
    "ARCHITECTURE.LAYER_BOUNDARY": true,
    "DEBT.DECLARED_MARKER_DELTA": true,
    "SECURITY.CREDENTIAL_AND_SEMANTIC_SCAN": true,
    "PERFORMANCE.MEASURED_METRIC": true,
    "RESILIENCE.FAULT_SCENARIO_EXECUTION": true,
    "REVIEW.FRESH_CONTEXT_SESSION": true,
    "DISCOVERY.CONCERN_WITNESS": true,
    "DISCOVERY.BOUNDED_CHANGE_CLASSIFIER": true,
    "SECURITY.CREDENTIAL_LITERAL_SCAN": true,
    "SECURITY.CONCERN_DISCOVERY": true,
    "SECURITY.NON_BEHAVIORAL_CHANGE_CLASSIFIER": true,
    "SECURITY.SEMANTIC_FLOW_SCAN": true,
    "SECURITY.DEPENDENCY_VULNERABILITY_SCAN": true,
    "RESILIENCE.CODE_RELEVANCE_SCAN": true,
  } satisfies Record<CapabilityExecutionObservation["capabilityId"], true>),
);
const outcomes = new Set(
  Object.keys({
    COMPLETED: true,
    UNAVAILABLE: true,
    UNSUPPORTED: true,
    TIMED_OUT: true,
    PROCESS_ERROR: true,
    MALFORMED_OUTPUT: true,
    REFUSED: true,
    ANALYZE_THREW: true,
    BINDING_REJECTED: true,
    INVALID_RESULT: true,
  } satisfies Record<CapabilityExecutionObservation["outcome"], true>),
);
const coverages = new Set(
  Object.keys({
    FULL: true,
    PARTIAL: true,
    UNSUPPORTED: true,
    NOT_APPLICABLE: true,
  } satisfies Record<CapabilityExecutionObservation["coverage"], true>),
);
const failureCategories = new Set(
  Object.keys({
    PROVIDER_UNAVAILABLE: true,
    VERSION_UNVERIFIED: true,
    UNSUPPORTED_INPUT: true,
    TIMEOUT: true,
    PROCESS_ERROR: true,
    MALFORMED_OUTPUT: true,
    REFUSED: true,
    ANALYZE_THREW: true,
    BINDING_MISMATCH: true,
    INVALID_RESULT: true,
  } satisfies Record<NonNullable<CapabilityExecutionObservation["failureCategory"]>, true>),
);

const boundedLabel = (value: unknown): string =>
  typeof value === "string" &&
  value.length <= maxLabelLength &&
  safeLabel.test(value) &&
  redactSensitiveText(value) === value
    ? value
    : unknownLabel;

const boundedVersion = (value: unknown): string =>
  typeof value === "string" &&
  value.length <= maxLabelLength &&
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value) &&
  redactSensitiveText(value) === value
    ? value
    : unknownLabel;

const allowlistedLabel = (value: unknown, allowed: ReadonlySet<string>): string =>
  typeof value === "string" && allowed.has(value) ? value : unknownLabel;

const boundedNumber = (value: unknown, maximum: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(0, Math.round(value)))
    : 0;

/**
 * Builds the complete attribute set for a provider-execution span.
 *
 * Keep this as an explicit projection: candidate identifiers, wall-clock values, file paths,
 * findings, diffs, provider output, and error text must never become telemetry by accident.
 */
const safeAttributes = (observation: CapabilityExecutionObservation): Attributes => ({
  "maf.capability.id": allowlistedLabel(observation.capabilityId, capabilities),
  "maf.provider.name": boundedLabel(observation.providerName),
  "maf.provider.version":
    observation.providerVersion === null
      ? unknownLabel
      : boundedVersion(observation.providerVersion),
  "maf.provider.outcome": allowlistedLabel(observation.outcome, outcomes),
  "maf.provider.coverage": allowlistedLabel(observation.coverage, coverages),
  "maf.provider.failure_category":
    observation.failureCategory === null
      ? noFailure
      : allowlistedLabel(observation.failureCategory, failureCategories),
  "maf.provider.duration_ms": boundedNumber(observation.durationMs, maxDurationMs),
  "maf.provider.finding_count": boundedNumber(observation.findingCount, maxObservationCount),
  "maf.provider.analyzed_file_count": boundedNumber(
    observation.analyzedFileCount,
    maxObservationCount,
  ),
});

/**
 * Infrastructure-edge adapter for the vendor-neutral application observer port.
 *
 * The adapter is deliberately fail-open. OpenTelemetry SDK/exporter faults are observability
 * faults, never provider-execution authority, and their error text is intentionally discarded.
 */
export class OtelCapabilityExecutionObserver implements CapabilityExecutionObserver {
  constructor(private readonly tracer: Tracer) {}

  record(observation: CapabilityExecutionObservation): void {
    let span: Span | undefined;
    try {
      span = this.tracer.startSpan(CAPABILITY_EXECUTION_SPAN_NAME);
      span.setAttributes(safeAttributes(observation));
      span.setStatus({
        code:
          observation.outcome === "COMPLETED" && observation.failureCategory === null
            ? SpanStatusCode.OK
            : SpanStatusCode.ERROR,
      });
    } catch {
      // Never forward SDK/exporter exception text: it can contain endpoint credentials or payloads.
    } finally {
      try {
        span?.end();
      } catch {
        // Ending a span is best-effort and cannot change capability execution.
      }
    }
  }
}
