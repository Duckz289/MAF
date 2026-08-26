# Telemetry

`DomainTelemetryRecorder` uses the vendor-neutral OpenTelemetry API. `LangfuseHttpExporter` is an
optional AI-specific export adapter. Domain code does not depend on a telemetry vendor.

## Recorded dimensions

- task and run identity
- agent, model, provider, initial mode, and final mode
- input, output, and cached tokens
- model, sandbox, verification, retry, and recovery costs
- latency and retry count
- changed-file count
- verification type and state
- mode-transition and `STRICT` re-expansion counts
- verification attempts, verifier failures, and repair attempts
- latest signal-snapshot ID, touched modules, dependency/context expansion, cross-module edges,
  module count, scope stabilization invalidations, and verification-failure count
- verified-success flag

The primary metric is `cost per verified success`, exposed at
`GET /api/v1/telemetry/cost-per-verified-success`. It is total recorded cost divided by the number of
verified runs, or `null` when no verified success exists. Raw secrets are redacted before export.

Cost is nullable. Unknown cost stays `null` and is excluded from cost-per-verified-success coverage;
it is never converted to zero. Real pricing comes from native agent or provider usage metadata rather
than hard-coded model price tables. Benchmark reports expose both `costStatus` and the number of
verified samples with known cost.

## Optional provider-execution traces

Session 3 adds a trace-only OTLP/HTTP protobuf adapter for capability execution. It is active only
when `MAF_OTEL_ENABLED=true` and either `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or
`OTEL_EXPORTER_OTLP_ENDPOINT` is explicitly configured. A generic endpoint receives the standard
`/v1/traces` suffix. Missing, invalid, or unreachable OTLP configuration never changes provider or
mission results.

The single `maf.capability.execution` span contains an allowlisted, bounded schema: capability,
provider name/version, execution outcome, coverage, failure category, duration, finding count, and
analyzed-file count. It excludes candidate/digest identifiers, timestamps, paths, rule IDs,
messages, findings, diffs, stdout/stderr, exceptions, credentials, headers, and endpoint values.
The runtime uses a provider-owned tracer rather than registering a process-global provider, so
existing run telemetry cannot be captured accidentally; its only resource field is the fixed
service name `adaptive-agent-harness-capabilities`. SDK/exporter failures are swallowed and
shutdown is idempotent and time-bounded.

OTLP is an observability transport only. Exported spans are not candidate evidence and cannot set
an obligation, trust state, policy, or execution mode. MAF's candidate-bound internal event and
obligation ledger remain authoritative.
