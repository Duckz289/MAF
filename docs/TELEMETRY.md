# Telemetry

`DomainTelemetryRecorder` uses the vendor-neutral OpenTelemetry API. `LangfuseHttpExporter` is an
optional AI-specific export adapter. Domain code does not depend on a telemetry vendor.

## Recorded dimensions

- task and run identity
- agent, model, provider, and execution mode
- input, output, and cached tokens
- model, sandbox, verification, retry, and recovery costs
- latency and retry count
- changed-file count
- verification type and state
- mode-transition count
- verified-success flag

The primary metric is `cost per verified success`, exposed at
`GET /api/v1/telemetry/cost-per-verified-success`. It is total recorded cost divided by the number of
verified runs, or `null` when no verified success exists. Raw secrets are redacted before export.

The fixture gateway reports zero cost by design. Real pricing should come from Bifrost/provider
usage metadata rather than hard-coded model price tables.
