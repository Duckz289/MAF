import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppRuntime } from "../src/server/app";

let runtime: AppRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe("control API", () => {
  it("reports health, run collections, auth mode, and telemetry metric", async () => {
    runtime = await createApp();
    const health = await runtime.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", store: "memory" });

    const runs = await runtime.app.inject({ method: "GET", url: "/api/v1/runs" });
    expect(runs.json()).toEqual([]);

    const mission = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/missions",
      payload: {
        id: "mission-root",
        dependencyIds: [],
        state: "READY",
        executionMode: "GUIDED",
        agent: "native-cli",
        model: "native",
        budget: 1,
        inputs: [],
        outputs: [],
        verificationState: "PROPOSED",
      },
    });
    expect(mission.statusCode).toBe(201);
    const missions = await runtime.app.inject({ method: "GET", url: "/api/v1/missions" });
    expect(missions.json()).toMatchObject([{ id: "mission-root" }]);

    const session = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { "x-dev-user": "operator@example.invalid" },
    });
    expect(session.json()).toMatchObject({ verification: "MOCK_VERIFIED" });

    const metric = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/telemetry/cost-per-verified-success",
    });
    expect(metric.json()).toEqual({ value: null, currency: "USD" });
  });
});
