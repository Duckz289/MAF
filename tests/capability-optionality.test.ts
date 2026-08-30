import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";

const names = [
  "MAF_OSV_SCANNER_ENABLED",
  "MAF_OSV_SCANNER_COMMAND",
  "MAF_OPENGREP_ENABLED",
  "MAF_OPENGREP_COMMAND",
  "MAF_OPENGREP_RULES_PATH",
  "MAF_OPENGREP_RULESET_DIGEST",
  "MAF_OPENGREP_MANIFEST_PATH",
  "MAF_OTEL_ENABLED",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
] as const;

const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of names) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("optional capability composition", () => {
  it("starts and closes with every external capability disabled", async () => {
    for (const name of names) delete process.env[name];

    const runtime = await createApp();
    await expect(runtime.app.inject({ method: "GET", url: "/health" })).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("does not make incomplete optional scanner configuration a startup dependency", async () => {
    for (const name of names) delete process.env[name];
    process.env.MAF_OSV_SCANNER_ENABLED = "true";
    process.env.MAF_OPENGREP_ENABLED = "true";
    process.env.MAF_OTEL_ENABLED = "true";

    const runtime = await createApp();
    await expect(runtime.app.inject({ method: "GET", url: "/health" })).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(runtime.close()).resolves.toBeUndefined();
  });
});
