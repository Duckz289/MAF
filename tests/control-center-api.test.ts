import { afterEach, describe, expect, it } from "vitest";
import { type AppRuntime, createApp } from "../src/server/app";

let runtime: AppRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe("control-center API", () => {
  it("serves a bounded Engineering Control Center overview and optional-provider status", async () => {
    runtime = await createApp();
    const overview = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/control-center/overview",
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      product: "ENGINEERING_CONTROL_CENTER",
      emergencyStop: false,
      projects: 0,
      activeRuns: 0,
    });
    expect(overview.json().cost.total.status).toBe("UNKNOWN");
    expect(overview.json().cost.total.display).toBe("unknown");
    expect(overview.json().cost.total.display).not.toContain("$0");
    expect(overview.json().cost.costPerDurableVerifiedSuccess).toBeNull();

    const providers = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/control-center/providers",
    });
    expect(providers.statusCode).toBe(200);
    const body = providers.json() as Array<{
      id: string;
      availability: string;
      systemHealthImpact: string;
    }>;
    expect(body.every((provider) => provider.systemHealthImpact === "NONE")).toBe(true);
    expect(body.some((provider) => provider.availability !== "AVAILABLE")).toBe(true);

    const evolution = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/control-center/evolution",
    });
    expect(evolution.json()).toMatchObject({
      optimizeProductionPolicyAvailable: false,
      promotion: "NONE_RECORDED",
      shadowStatus: "NOT_RUNNING",
    });
  });

  it("rejects work-item payloads that try to mutate trust", async () => {
    runtime = await createApp();
    const created = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/control-center/work-items",
      payload: { projectId: "project-1", title: "Fix the issue" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).not.toHaveProperty("trustState");

    const forbidden = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/control-center/work-items",
      payload: {
        projectId: "project-1",
        title: "Launder trust",
        trustState: "MERGE_ELIGIBLE",
      },
    });
    expect(forbidden.statusCode).toBeGreaterThanOrEqual(400);
    expect(forbidden.json().message ?? forbidden.json().error).toMatch(
      /trustState|authority|INVALID/i,
    );
  });

  it("returns 404 for missing mission inspections and bounds event pages", async () => {
    runtime = await createApp();
    const missing = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/control-center/runs/missing/trust",
    });
    expect(missing.statusCode).toBe(404);

    const events = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/control-center/runs/missing/events?limit=5",
    });
    expect(events.statusCode).toBe(404);
  });
});
