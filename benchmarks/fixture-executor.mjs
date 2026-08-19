import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const strategy = process.argv[2];
if (strategy !== "NATIVE" && strategy !== "MAF_ADAPTIVE") {
  throw new Error("Expected NATIVE or MAF_ADAPTIVE strategy");
}

const workspace = await mkdtemp(path.join(tmpdir(), "maf-benchmark-fixture-"));
const output = path.join(workspace, "verified-output.txt");
let verificationResult = "FAILED";
try {
  await writeFile(output, "benchmark-fixture-ok\n", "utf8");
  verificationResult =
    (await readFile(output, "utf8")) === "benchmark-fixture-ok\n" ? "VERIFIED" : "QUARANTINED";
} finally {
  await rm(workspace, { recursive: true, force: true });
}

process.stdout.write(
  `${JSON.stringify({
    agent: "filesystem-fixture",
    model: "none",
    provider: "local",
    initialMode: strategy === "NATIVE" ? "NATIVE" : "GUIDED",
    finalMode: strategy === "NATIVE" ? "NATIVE" : "GUIDED",
    modeTransitions: [],
    signalSnapshots: [],
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reportedCost: null,
    latencyMs: 0,
    retryCount: 0,
    verificationResult,
    filesChanged: ["verified-output.txt"],
    contextExpansion: 0,
    orchestrationOverheadMs: 0,
  })}\n`,
);
