import type { Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { CAPABILITY_EXECUTION_INSTRUMENTATION_SCOPE } from "./otel-capability-observer";

const enabledValue = "true";
const defaultShutdownTimeoutMs = 5_000;
const maximumShutdownTimeoutMs = 30_000;
const exporterTimeoutMs = 3_000;
export const CAPABILITY_OTEL_SERVICE_NAME = "adaptive-agent-harness-capabilities";

/** Fixed resource metadata prevents SDK defaults from embedding process executable paths. */
export const capabilityTraceResource = () =>
  resourceFromAttributes({ "service.name": CAPABILITY_OTEL_SERVICE_NAME });

interface TraceProviderRuntime {
  getTracer(name: string): Tracer;
  shutdown(): Promise<void>;
}

export interface OtelTraceRuntime {
  /** True only after an explicitly configured provider produced an isolated tracer. */
  readonly enabled: boolean;
  /** Provider-owned tracer; never installed as the process-global tracer provider. */
  readonly tracer: Tracer | null;
  /** Resolves within the configured bound and is safe to invoke more than once. */
  shutdown(): Promise<void>;
}

export interface OtelTraceRuntimeOptions {
  /** Defaults to process.env. Exposed so composition tests do not mutate global environment state. */
  environment?: NodeJS.ProcessEnv;
  shutdownTimeoutMs?: number;
  /** Infrastructure test seam; production composition should use the default SDK provider. */
  providerFactory?: (endpoint: string) => TraceProviderRuntime;
}

const disabledRuntime = (): OtelTraceRuntime => {
  const shutdown = Promise.resolve();
  return { enabled: false, tracer: null, shutdown: () => shutdown };
};

const validHttpUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url;
  } catch {
    return null;
  }
};

const traceEndpoint = (environment: NodeJS.ProcessEnv): string | null => {
  const signalEndpoint = environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (signalEndpoint) return validHttpUrl(signalEndpoint)?.toString() ?? null;

  const baseEndpoint = environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!baseEndpoint) return null;
  const url = validHttpUrl(baseEndpoint);
  if (!url) return null;
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/v1/traces`;
  return url.toString();
};

const defaultProviderFactory = (endpoint: string): TraceProviderRuntime => {
  const exporter = new OTLPTraceExporter({
    url: endpoint,
    timeoutMillis: exporterTimeoutMs,
  });
  const processor = new BatchSpanProcessor(exporter, {
    maxQueueSize: 512,
    maxExportBatchSize: 128,
    scheduledDelayMillis: 5_000,
    exportTimeoutMillis: exporterTimeoutMs,
  });
  return new NodeTracerProvider({
    resource: capabilityTraceResource(),
    forceFlushTimeoutMillis: exporterTimeoutMs,
    spanProcessors: [processor],
    spanLimits: {
      attributeCountLimit: 9,
      attributeValueLengthLimit: 64,
      eventCountLimit: 0,
      linkCountLimit: 0,
    },
  });
};

const boundedTimeout = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximumShutdownTimeoutMs, Math.max(1, Math.round(value)))
    : defaultShutdownTimeoutMs;

const settleWithin = (operation: () => Promise<void>, timeoutMs: number): Promise<void> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    try {
      void operation().then(finish, finish);
    } catch {
      finish();
    }
  });

/**
 * Registers Node tracing only when MAF_OTEL_ENABLED=true and an explicit OTLP HTTP endpoint exists.
 * Importing this module performs no registration or network activity.
 */
export const startOtelTraceRuntime = (options: OtelTraceRuntimeOptions = {}): OtelTraceRuntime => {
  const environment = options.environment ?? process.env;
  if (environment.MAF_OTEL_ENABLED?.trim().toLowerCase() !== enabledValue) {
    return disabledRuntime();
  }

  const endpoint = traceEndpoint(environment);
  if (endpoint === null) return disabledRuntime();

  const shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs);
  let provider: TraceProviderRuntime;
  try {
    provider = (options.providerFactory ?? defaultProviderFactory)(endpoint);
  } catch {
    // Startup is fail-open. Do not surface exporter errors, which may contain auth material.
    return disabledRuntime();
  }
  let tracer: Tracer;
  try {
    tracer = provider.getTracer(CAPABILITY_EXECUTION_INSTRUMENTATION_SCOPE);
  } catch {
    // A partly initialized provider is also shut down within the same bound, without blocking boot.
    void settleWithin(() => provider.shutdown(), shutdownTimeoutMs);
    return disabledRuntime();
  }

  let shutdownPromise: Promise<void> | undefined;
  return {
    enabled: true,
    tracer,
    shutdown: () => {
      shutdownPromise ??= settleWithin(() => provider.shutdown(), shutdownTimeoutMs);
      return shutdownPromise;
    },
  };
};
