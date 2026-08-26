import { type Attributes, type Span, SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityExecutionObservation } from "../src/application/capability-execution";
import {
  CAPABILITY_EXECUTION_SPAN_NAME,
  CAPABILITY_EXECUTION_INSTRUMENTATION_SCOPE,
  OtelCapabilityExecutionObserver,
} from "../src/infrastructure/otel-capability-observer";
import {
  CAPABILITY_OTEL_SERVICE_NAME,
  capabilityTraceResource,
  startOtelTraceRuntime,
} from "../src/infrastructure/otel-runtime";

const observation = (
  overrides: Partial<CapabilityExecutionObservation> = {},
): CapabilityExecutionObservation => ({
  capabilityId: "SECURITY.SEMANTIC_FLOW_SCAN",
  providerName: "fixture-provider",
  providerVersion: "v8.29.1",
  durationMs: 12.6,
  outcome: "COMPLETED",
  coverage: "FULL",
  findingCount: 2,
  analyzedFileCount: 3,
  failureCategory: null,
  ...overrides,
});

const fakeTelemetry = () => {
  const span = {
    addEvent: vi.fn(),
    end: vi.fn(),
    recordException: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
  };
  const tracer = { startSpan: vi.fn(() => span as unknown as Span) };
  return {
    observer: new OtelCapabilityExecutionObserver(tracer as unknown as Tracer),
    span,
    tracer,
  };
};

describe("OtelCapabilityExecutionObserver", () => {
  it("emits one fixed-name span with only the exact safe, bounded attribute allowlist", () => {
    const { observer, span, tracer } = fakeTelemetry();

    observer.record(observation());

    expect(tracer.startSpan).toHaveBeenCalledWith(CAPABILITY_EXECUTION_SPAN_NAME);
    expect(span.setAttributes).toHaveBeenCalledWith({
      "maf.capability.id": "SECURITY.SEMANTIC_FLOW_SCAN",
      "maf.provider.name": "fixture-provider",
      "maf.provider.version": "v8.29.1",
      "maf.provider.outcome": "COMPLETED",
      "maf.provider.coverage": "FULL",
      "maf.provider.failure_category": "none",
      "maf.provider.duration_ms": 13,
      "maf.provider.finding_count": 2,
      "maf.provider.analyzed_file_count": 3,
    } satisfies Attributes);
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.addEvent).not.toHaveBeenCalled();
    expect(span.end).toHaveBeenCalledOnce();
  });

  it("does not leak candidate IDs, raw artifacts, or secret-shaped extra fields", () => {
    const secret = "ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE";
    const { observer, span, tracer } = fakeTelemetry();
    const input = {
      ...observation(),
      candidateId: secret,
      capabilityId: secret,
      providerName: secret,
      providerVersion: secret,
      detail: `provider failed with ${secret}`,
      analyzedFiles: [`src/${secret}.ts`],
      diff: `+ const token = '${secret}'`,
    } as unknown as CapabilityExecutionObservation;

    observer.record(input);

    const exported = JSON.stringify({
      spanName: tracer.startSpan.mock.calls,
      attributes: span.setAttributes.mock.calls,
      status: span.setStatus.mock.calls,
    });
    expect(exported).not.toContain(secret);
    expect(exported).not.toContain("detail");
    expect(exported).not.toContain("analyzedFiles");
    expect(exported).not.toContain("diff");
    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ "maf.capability.id": "unknown" }),
    );
  });

  it("normalizes invalid labels and numeric values without exporting their contents", () => {
    const secret = "provider/../../secret?token=do-not-export";
    const { observer, span } = fakeTelemetry();

    observer.record(
      observation({
        providerName: secret,
        providerVersion: "version with raw stdout",
        durationMs: Number.POSITIVE_INFINITY,
        findingCount: -4,
        analyzedFileCount: 99_999,
        outcome: "TIMED_OUT",
        coverage: "UNSUPPORTED",
        failureCategory: "TIMEOUT",
      }),
    );

    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "maf.provider.name": "unknown",
        "maf.provider.version": "unknown",
        "maf.provider.duration_ms": 0,
        "maf.provider.finding_count": 0,
        "maf.provider.analyzed_file_count": 10_000,
      }),
    );
    expect(JSON.stringify(span.setAttributes.mock.calls)).not.toContain(secret);
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  });

  it("fails open when span creation, mutation, or ending throws", () => {
    const creationFailure = new OtelCapabilityExecutionObserver({
      startSpan: vi.fn(() => {
        throw new Error("collector-secret");
      }),
    } as unknown as Tracer);
    expect(() => creationFailure.record(observation())).not.toThrow();

    const span = {
      end: vi.fn(() => {
        throw new Error("end-secret");
      }),
      setAttributes: vi.fn(() => {
        throw new Error("attribute-secret");
      }),
    };
    const mutationFailure = new OtelCapabilityExecutionObserver({
      startSpan: vi.fn(() => span as unknown as Span),
    } as unknown as Tracer);
    expect(() => mutationFailure.record(observation())).not.toThrow();
    expect(span.end).toHaveBeenCalledOnce();
  });
});

describe("startOtelTraceRuntime", () => {
  it("uses fixed resource metadata without an executable path", () => {
    const attributes = capabilityTraceResource().attributes;

    expect(attributes).toEqual({ "service.name": CAPABILITY_OTEL_SERVICE_NAME });
    expect(JSON.stringify(attributes)).not.toContain(process.execPath);
  });

  it("is inert unless tracing and an OTLP endpoint are both explicitly configured", async () => {
    const providerFactory = vi.fn();
    const disabled = startOtelTraceRuntime({
      environment: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" },
      providerFactory,
    });
    const missingEndpoint = startOtelTraceRuntime({
      environment: { MAF_OTEL_ENABLED: "true" },
      providerFactory,
    });

    expect(disabled.enabled).toBe(false);
    expect(missingEndpoint.enabled).toBe(false);
    expect(providerFactory).not.toHaveBeenCalled();
    await expect(disabled.shutdown()).resolves.toBeUndefined();
    await expect(missingEndpoint.shutdown()).resolves.toBeUndefined();
  });

  it("creates an isolated opted-in tracer and appends the OTLP/HTTP traces path", async () => {
    const tracer = fakeTelemetry().tracer as unknown as Tracer;
    const provider = {
      getTracer: vi.fn(() => tracer),
      shutdown: vi.fn(async () => undefined),
    };
    const providerFactory = vi.fn(() => provider);
    const globalBefore = trace.getTracerProvider();
    const runtime = startOtelTraceRuntime({
      environment: {
        MAF_OTEL_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/otel",
      },
      providerFactory,
    });

    expect(runtime.enabled).toBe(true);
    expect(runtime.tracer).toBe(tracer);
    expect(providerFactory).toHaveBeenCalledWith("http://collector:4318/otel/v1/traces");
    expect(provider.getTracer).toHaveBeenCalledWith(CAPABILITY_EXECUTION_INSTRUMENTATION_SCOPE);
    expect(trace.getTracerProvider()).toBe(globalBefore);
    const firstShutdown = runtime.shutdown();
    const secondShutdown = runtime.shutdown();
    expect(firstShutdown).toBe(secondShutdown);
    await firstShutdown;
    expect(provider.shutdown).toHaveBeenCalledOnce();
  });

  it("fails open during tracer construction and bounds a stalled, idempotent shutdown", async () => {
    const failedProviderShutdown = vi.fn(async () => undefined);
    const tracerFailure = startOtelTraceRuntime({
      environment: {
        MAF_OTEL_ENABLED: "true",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/v1/traces",
      },
      providerFactory: () => ({
        getTracer: () => {
          throw new Error("endpoint-secret");
        },
        shutdown: failedProviderShutdown,
      }),
    });
    expect(tracerFailure.enabled).toBe(false);
    await vi.waitFor(() => expect(failedProviderShutdown).toHaveBeenCalledOnce());

    const stalledShutdown = vi.fn(() => new Promise<void>(() => undefined));
    const runtime = startOtelTraceRuntime({
      environment: {
        MAF_OTEL_ENABLED: "true",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/v1/traces",
      },
      providerFactory: () => ({
        getTracer: () => fakeTelemetry().tracer as unknown as Tracer,
        shutdown: stalledShutdown,
      }),
      shutdownTimeoutMs: 5,
    });
    const firstShutdown = runtime.shutdown();
    expect(runtime.shutdown()).toBe(firstShutdown);
    await expect(firstShutdown).resolves.toBeUndefined();
    expect(stalledShutdown).toHaveBeenCalledOnce();
  });
});
