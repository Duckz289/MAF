import { describe, expect, it } from "vitest";
import {
  derivePerformancePosture,
  derivePerformanceSensitivity,
  type PerformanceMeasurement,
} from "../src/domain/performance";
import { deriveRuntimeGraph } from "../src/domain/runtime-graph";

const patchFor = (file: string, added: string[]): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,1 +1,2 @@",
    ...added.map((line) => `+${line}`),
  ].join("\n");

const removalPatchFor = (file: string, removed: string[]): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,2 +1,1 @@",
    ...removed.map((line) => `-${line}`),
  ].join("\n");

describe("performance sensitivity", () => {
  it("keeps an ordinary task LOW without inventing performance sensitivity", () => {
    const result = derivePerformanceSensitivity(
      ["src/domain/labels.ts"],
      patchFor("src/domain/labels.ts", ["export const label = 'ok';"]),
    );
    expect(result.level).toBe("LOW");
    expect(result.provenance).toBe("DETERMINISTIC");
  });

  it("does not infer DB, network, or schema work from generic code filenames", () => {
    const files = [
      "src/domain/repository.ts",
      "src/index.ts",
      "src/web/client.ts",
      "src/api/request-schema.ts",
      "src/http/status.ts",
      "src/database/labels.ts",
    ];
    const result = derivePerformanceSensitivity(
      files,
      files.map((file) => patchFor(file, ["export const ordinary = true;"])).join("\n"),
    );
    expect(result.level).toBe("LOW");
    expect(result.signals).toEqual([]);
  });

  it("does not treat ordinary update functions, comments, or documentation as performance work", () => {
    const files = ["src/domain/index.ts", "docs/database-design.md", "tests/cache.test.ts"];
    const result = derivePerformanceSensitivity(
      files,
      [
        patchFor("src/domain/index.ts", [
          "export function update(value: string): string { return value; }",
          "// See https://example.invalid/performance guidance",
          "const styles = { cursor: 'pointer' };",
          "const limit = 20;",
          "const offset = x - origin;",
        ]),
        patchFor("docs/database-design.md", ["Example: SELECT * FROM widgets"]),
        patchFor("tests/cache.test.ts", ["expect(cache.get(id)).toBe(value);"]),
      ].join("\n"),
    );
    expect(result.level).toBe("LOW");
    expect(result.signals).toEqual([]);
  });

  it("raises DB/network candidates from concrete diff signals", () => {
    const result = derivePerformanceSensitivity(
      ["src/server/api.ts", "migrations/010_widgets.sql"],
      [
        patchFor("src/server/api.ts", ["await fetch('https://example.invalid/widgets');"]),
        patchFor("migrations/010_widgets.sql", ["CREATE INDEX widgets_name_idx ON widgets(name);"]),
      ].join("\n"),
    );
    expect(result.level).toBe("HIGH");
    expect(result.signals).toEqual(
      expect.arrayContaining(["NETWORK_CALL", "DB_QUERY", "SCHEMA_INDEX"]),
    );
  });

  it("keeps a single ubiquitous weak signal (one JSON.parse) at LOW", () => {
    const result = derivePerformanceSensitivity(
      ["src/domain/config.ts"],
      patchFor("src/domain/config.ts", ["const parsed = JSON.parse(raw);"]),
    );
    expect(result.level).toBe("LOW");
    expect(result.signals).toEqual(["SERIALIZATION"]);
  });

  it("raises sensitivity when a diff removes query bounds or schema structure", () => {
    const limitRemoved = derivePerformanceSensitivity(
      ["src/server/widgets.ts"],
      removalPatchFor("src/server/widgets.ts", ["  return db.listWidgets().limit(10);"]),
    );
    expect(limitRemoved.level).toBe("MEDIUM");
    expect(limitRemoved.signals).toContain("PAGINATION");

    const queryRemoved = derivePerformanceSensitivity(
      ["src/server/widgets.ts"],
      removalPatchFor("src/server/widgets.ts", [
        "  const rows = await db.query('SELECT id FROM widgets');",
      ]),
    );
    expect(queryRemoved.level).toBe("MEDIUM");
    expect(queryRemoved.signals).toContain("DB_QUERY");
  });
});

describe("performance delta", () => {
  const measurement = (candidate: number): PerformanceMeasurement => ({
    state: "MEASURED",
    candidateId: "candidate-1",
    diffDigest: "digest-1",
    metrics: [
      {
        name: "p95 latency",
        unit: "ms",
        baseline: 100,
        candidate,
        lowerIsBetter: true,
      },
    ],
    evidence: ["trusted command measured both workspaces"],
  });

  it("fails a regression over threshold and passes a bounded delta", () => {
    expect(derivePerformancePosture(measurement(130), "candidate-1", "digest-1", 10).state).toBe(
      "FAIL",
    );
    expect(derivePerformancePosture(measurement(105), "candidate-1", "digest-1", 10).state).toBe(
      "PASS",
    );
  });

  it("never accepts missing, stale, or non-comparable evidence", () => {
    expect(derivePerformancePosture(undefined, "candidate-1", "digest-1", 10).state).toBe(
      "NOT_CHECKED",
    );
    expect(derivePerformancePosture(measurement(90), "candidate-2", "digest-1", 10).state).toBe(
      "NOT_CHECKED",
    );
    expect(
      derivePerformancePosture(
        {
          ...measurement(90),
          metrics: [
            {
              name: "p95 latency",
              unit: "ms",
              baseline: 0,
              candidate: 90,
              lowerIsBetter: true,
            },
          ],
        },
        "candidate-1",
        "digest-1",
        10,
      ).state,
    ).toBe("NOT_CHECKED");
    expect(
      derivePerformancePosture(
        {
          ...measurement(105),
          metrics: measurement(105).metrics.map((metric) => ({
            ...metric,
            candidate: Number.NaN,
          })),
        },
        "candidate-1",
        "digest-1",
        10,
      ).state,
    ).toBe("NOT_CHECKED");
  });
});

describe("runtime graph", () => {
  it("keeps deployment topology distinct, evidence-backed, and attributes unknown", () => {
    const graph = deriveRuntimeGraph(
      patchFor("src/server/api.ts", [
        "const result = await database.query('SELECT * FROM widgets LIMIT 20');",
        "await fetch('https://example.invalid/audit', { timeoutMs: 5000 });",
      ]),
    );
    expect(graph.nodes.map((node) => node.kind)).toEqual(
      expect.arrayContaining(["API", "DATABASE", "SERVICE"]),
    );
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.find((edge) => edge.to === "database")?.attributes.networkBoundary).toBe(
      null,
    );
    expect(graph.edges.find((edge) => edge.to === "database")?.attributes.timeoutMs).toBe(null);
    expect(graph.edges.find((edge) => edge.to === "service")?.attributes).toMatchObject({
      networkBoundary: true,
      timeoutMs: 5000,
    });
    expect(graph.unknowns).toContain("service: service ownership/internal-vs-external unknown");
    expect(graph.unknowns.some((unknown) => unknown.includes("retryPolicy"))).toBe(true);
  });

  it("does not fabricate a universal topology from an empty diff", () => {
    expect(deriveRuntimeGraph("")).toEqual({
      nodes: [],
      edges: [],
      unknowns: ["No runtime topology is evidenced by this candidate diff."],
    });
  });

  it("does not turn documentation co-change into an application component", () => {
    const graph = deriveRuntimeGraph(
      patchFor("docs/database-design.md", ["Example: SELECT * FROM widgets"]),
    );
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.unknowns).toEqual(["No runtime topology is evidenced by this candidate diff."]);
  });

  it("records a migration-owned database without inventing an application caller", () => {
    const graph = deriveRuntimeGraph(
      patchFor("migrations/001_widgets.sql", ["CREATE INDEX widgets_name_idx ON widgets(name);"]),
    );
    expect(graph.nodes.map((node) => node.kind)).toEqual(["DATABASE"]);
    expect(graph.edges).toEqual([]);
    expect(graph.unknowns).toContain(
      "database: no runtime relationship is evidenced by this candidate diff",
    );
  });

  it("ignores comment-only topology and merges repeated relationship evidence", () => {
    expect(
      deriveRuntimeGraph(patchFor("src/core/worker.ts", ["// See https://example.invalid/docs"]))
        .edges,
    ).toEqual([]);
    expect(
      deriveRuntimeGraph(patchFor("tests/cache.test.ts", ["expect(cache.get(id)).toBe(value);"]))
        .nodes,
    ).toEqual([]);
    expect(
      deriveRuntimeGraph(
        patchFor("tests/fixtures/migrations/001.sql", ["CREATE INDEX fixture_idx ON fixture(id);"]),
      ).nodes,
    ).toEqual([]);

    const graph = deriveRuntimeGraph(
      [
        patchFor("src/api/first.ts", ["await fetch(remoteUrl);"]),
        patchFor("src/api/second.ts", ["await fetch(remoteUrl, { timeoutMs: 5000 });"]),
      ].join("\n"),
    );
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.attributes.timeoutMs).toBe(5000);
    expect(graph.edges[0]?.evidence).toHaveLength(2);
  });

  it("marks EXTERNAL_SERVICE only when the code itself identifies an external API", () => {
    const graph = deriveRuntimeGraph(
      patchFor("src/server/partner.ts", [
        "const response = await fetch(config.endpoint('external api'));",
      ]),
    );
    expect(graph.nodes.map((node) => node.kind)).toEqual(["API", "EXTERNAL_SERVICE"]);
    expect(graph.edges[0]).toMatchObject({ from: "api", to: "external-service", kind: "CALLS" });
    expect(graph.unknowns.some((unknown) => unknown.includes("internal-vs-external unknown"))).toBe(
      false,
    );
  });

  it("keeps server-side service ownership unknown without explicit external evidence", () => {
    const graph = deriveRuntimeGraph(
      patchFor("src/server/health.ts", ["await fetch('http://localhost:3001/internal/health');"]),
    );
    expect(graph.nodes.map((node) => node.kind)).toEqual(["API", "SERVICE"]);
    expect(graph.nodes.some((node) => node.kind === "EXTERNAL_SERVICE")).toBe(false);
    expect(graph.unknowns).toContain("service: service ownership/internal-vs-external unknown");
  });

  it("does not fabricate CACHE/STORAGE topology from filenames or local in-memory/fs code", () => {
    const cacheGraph = deriveRuntimeGraph(
      patchFor("src/utils/cache.ts", ["const cache = new Map<string, string>();"]),
    );
    expect(cacheGraph.nodes.some((node) => node.kind === "CACHE")).toBe(false);

    const fsGraph = deriveRuntimeGraph(
      patchFor("src/storage/uploads.ts", [
        "await fs.writeFile(target, buffer);",
        "const stored = fs.readFile(source);",
      ]),
    );
    expect(fsGraph.nodes.some((node) => node.kind === "STORAGE")).toBe(false);

    const identifierGraph = deriveRuntimeGraph(
      patchFor("src/server/data.ts", ["const database = connect(settings);"]),
    );
    expect(identifierGraph.nodes.some((node) => node.kind === "DATABASE")).toBe(false);
  });

  it("recognizes named cache and object-storage technologies from code content", () => {
    const graph = deriveRuntimeGraph(
      patchFor("src/server/session.ts", [
        "await redis.set(key, value);",
        "await s3.putObject(bucket, key, body);",
      ]),
    );
    expect(graph.nodes.map((node) => node.kind)).toEqual(
      expect.arrayContaining(["API", "CACHE", "STORAGE"]),
    );
  });

  it("does not treat an inbound webhook handler as an outbound runtime call", () => {
    const graph = deriveRuntimeGraph(
      patchFor("src/server/webhooks.ts", [
        "app.post('/webhook', (req, res) => res.json(req.body));",
      ]),
    );
    expect(graph.nodes.map((node) => node.kind)).toEqual(["API"]);
    expect(graph.edges).toEqual([]);
  });
});
