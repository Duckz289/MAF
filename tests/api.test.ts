import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppRuntime } from "../src/server/app";
import {
  createAdaptiveFixtureRepository,
  createFixtureRepository,
  type FixtureRepository,
} from "./helpers";

let runtime: AppRuntime | undefined;
const fixtures: FixtureRepository[] = [];
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
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
    const ledger = await runtime.app.inject({ method: "GET", url: "/api/v1/health-ledger" });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json()).toEqual({
      samples: [],
      productionImpact: {
        state: "UNKNOWN",
        strategyDemotionRequired: false,
        maintenanceRecommended: false,
        reasons: ["no trusted production feedback has been observed"],
      },
    });
  });

  it("explains runtime-derived mode transitions through versioned resources", async () => {
    const fixture = await createAdaptiveFixtureRepository();
    fixtures.push(fixture);
    runtime = await createApp();
    const created = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/runs",
      payload: {
        prompt: "Fix image rendering in web",
        repositoryPath: fixture.path,
        verification: { expectedFile: "agent-output.md" },
      },
    });
    expect(created.statusCode).toBe(202);
    const runId = created.json().id as string;
    await runtime.runs.waitForIdle(runId);
    const explanation = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/mode-explanation`,
    });
    expect(explanation.statusCode).toBe(200);
    expect(explanation.json()).toMatchObject({
      mode: "SOLO_NATIVE",
      timeline: [{ from: "GUIDED", to: "SOLO_NATIVE" }],
    });
    const signals = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/runtime-signals`,
    });
    expect(signals.statusCode).toBe(200);
    expect(signals.json().length).toBeGreaterThan(3);
    const verifications = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/verifications`,
    });
    expect(verifications.statusCode).toBe(200);
    expect(verifications.json()).toMatchObject([{ attempt: 1, state: "VERIFIED" }]);
    const summaries = await runtime.app.inject({ method: "GET", url: "/api/v1/runs" });
    expect(summaries.json()).toMatchObject([
      { id: runId, repositoryPath: fixture.path, revision: "HEAD" },
    ]);
    const ledger = await runtime.app.inject({ method: "GET", url: "/api/v1/health-ledger" });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json()).toMatchObject({
      samples: [{ runId, projectId: expect.stringMatching(/^project-[a-f0-9]{64}$/u) }],
    });
    expect(ledger.body).not.toContain(fixture.path);
  });

  it("never exposes consecutive private-key bodies through run, artifact, or event API payloads", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    runtime = await createApp();
    const created = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/runs",
      payload: {
        prompt: "Leak consecutive private keys for the API redaction probe",
        repositoryPath: fixture.path,
        verification: {
          expectedFile: "agent-output.md",
          command: "node -e \"console.log('ghp_VVVV1111WWWW2222XXXX3333YYYY4444ZZZZ')\"",
        },
      },
    });
    expect(created.statusCode).toBe(202);
    const runId = created.json().id as string;
    await runtime.runs.waitForIdle(runId);

    const [run, artifacts, events, verifications, ledger] = await Promise.all([
      runtime.app.inject({ method: "GET", url: `/api/v1/runs/${runId}` }),
      runtime.app.inject({ method: "GET", url: `/api/v1/runs/${runId}/artifacts` }),
      runtime.app.inject({ method: "GET", url: `/api/v1/runs/${runId}/events?follow=false` }),
      runtime.app.inject({ method: "GET", url: `/api/v1/runs/${runId}/verifications` }),
      runtime.app.inject({ method: "GET", url: "/api/v1/health-ledger" }),
    ]);
    expect(run.statusCode).toBe(200);
    expect(artifacts.statusCode).toBe(200);
    expect(events.statusCode).toBe(200);
    expect(verifications.statusCode).toBe(200);
    const exposed = [run.body, artifacts.body, events.body, verifications.body, ledger.body].join(
      "\n",
    );
    expect(exposed).not.toContain("FIRST-PERSISTED-PRIVATE-KEY-BODY");
    expect(exposed).not.toContain("SECOND-PERSISTED-PRIVATE-KEY-BODY");
    expect(exposed).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(exposed).not.toContain("ghp_VVVV1111WWWW2222XXXX3333YYYY4444ZZZZ");
    expect(verifications.json().length).toBeGreaterThan(0);
    expect(
      artifacts.body.match(/credential-shaped line suppressed/gu)?.length ?? 0,
    ).toBeGreaterThanOrEqual(6);
    expect(events.body).toContain("REDACTED PRIVATE KEY");
  });

  it("redacts task and agent-error secrets from run summaries and recovery-capsule APIs", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    runtime = await createApp();
    const created = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/runs",
      payload: {
        prompt: "simulate secret-bearing failure with ghp_TTTT1111UUUU2222VVVV3333WWWW4444XXXX",
        repositoryPath: fixture.path,
        verification: { expectedFile: "agent-output.md" },
      },
    });
    const runId = created.json().id as string;
    await runtime.runs.waitForIdle(runId);

    const [run, summaries, capsule, events] = await Promise.all([
      runtime.app.inject({ method: "GET", url: `/api/v1/runs/${runId}` }),
      runtime.app.inject({ method: "GET", url: "/api/v1/runs" }),
      runtime.app.inject({ method: "GET", url: `/api/v1/runs/${runId}/recovery-capsule` }),
      runtime.app.inject({ method: "GET", url: `/api/v1/runs/${runId}/events?follow=false` }),
    ]);
    expect(run.json()).toMatchObject({ state: "PAUSED" });
    expect(capsule.statusCode).toBe(200);
    const exposed = [run.body, summaries.body, capsule.body, events.body].join("\n");
    for (const rawSecretFragment of [
      "ghp_TTTT1111UUUU2222VVVV3333WWWW4444XXXX",
      "ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE",
      "ERROR-PERSISTED-PRIVATE-KEY-BODY",
      "BEGIN ENCRYPTED PRIVATE KEY",
    ]) {
      expect(exposed).not.toContain(rawSecretFragment);
    }
    expect(exposed).toContain("REDACTED PRIVATE KEY");
  });

  it("exposes product setup metadata without exposing credential values", async () => {
    runtime = await createApp();

    const projectsBefore = await runtime.app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(projectsBefore.json()).toEqual({ durability: "PROCESS_LOCAL", projects: [] });

    const project = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "Harness", repositoryPath: process.cwd(), revision: "main" },
    });
    expect(project.statusCode).toBe(201);
    expect(project.json()).toMatchObject({ name: "Harness", revision: "main" });

    const projectsAfter = await runtime.app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(projectsAfter.json().projects).toMatchObject([{ name: "Harness" }]);

    const connections = await runtime.app.inject({ method: "GET", url: "/api/v1/connections" });
    expect(connections.json()).toMatchObject([
      { id: "claude-code", method: "NATIVE_SESSION", status: "UNKNOWN" },
      {
        id: "openai-api",
        method: "CREDENTIAL_REFERENCE",
        credentialReference: "credential://user/openai/default",
      },
      { id: "development-auth", capability: "Chỉ dùng cho môi trường phát triển local" },
    ]);
    expect(JSON.stringify(connections.json())).not.toMatch(/api[_-]?key|clientSecret|token/i);

    const agents = await runtime.app.inject({ method: "GET", url: "/api/v1/agents" });
    expect(agents.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "claude-code", authMethod: "NATIVE_SESSION" }),
      ]),
    );

    const authConfig = await runtime.app.inject({ method: "GET", url: "/api/v1/auth/config" });
    expect(authConfig.json()).toMatchObject({ mode: "DEVELOPMENT" });
    expect(JSON.stringify(authConfig.json())).not.toMatch(/secret|clientSecret/i);

    const issued = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/platform-keys",
      payload: { ownerId: "development-user", scopes: ["runs.create"] },
    });
    expect(issued.statusCode).toBe(201);
    const { id, key } = issued.json() as { id: string; key: string };
    const listed = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/platform-keys?ownerId=development-user",
    });
    expect(JSON.stringify(listed.json())).not.toContain(key);
    expect(listed.json()).toMatchObject([{ id, revoked: false, scopes: ["runs.create"] }]);

    const revoked = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/platform-keys/${id}/revoke`,
    });
    expect(revoked.json()).toEqual({ id, revoked: true });
    const afterRevoke = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/platform-keys?ownerId=development-user",
    });
    expect(afterRevoke.json()).toMatchObject([{ id, revoked: true }]);

    const home = await runtime.app.inject({ method: "GET", url: "/api/v1/home" });
    expect(home.json()).toMatchObject({
      active: [],
      attention: [],
      usage: { hasKnownCost: false },
    });
  });
});
