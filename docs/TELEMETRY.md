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
