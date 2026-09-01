#!/usr/bin/env node
// Synthetic, non-scoring grader for the Protocol v2 real-provider preflight fixture only. Exercises
// the same candidate-execution-contract ABI (CANDIDATE_EXECUTION_CONTRACT.md) as the frozen suite's
// real graders -- `node grader.mjs --workspace <absolute-path>` emitting one JSON object with
// `status`/`checks`/`message` -- without grading anything that counts toward the experiment.

import path from "node:path";
import { pathToFileURL } from "node:url";

const workspaceFlagIndex = process.argv.indexOf("--workspace");
const workspace = workspaceFlagIndex === -1 ? null : process.argv[workspaceFlagIndex + 1];

const checks = [];
let status = "FAIL";
let message = "grader did not run";

try {
  if (!workspace) throw new Error("--workspace is required");
  const target = path.join(workspace, "src", "format-name.mjs");
  const moduleUrl = pathToFileURL(target).href;
  const candidate = await import(moduleUrl);
  const result = candidate.formatName("Ada", "Lovelace");
  const passed = result === "Lovelace, Ada";
  checks.push({
    name: "format-name-returns-last-comma-first",
    passed,
    message: `formatName("Ada", "Lovelace") returned ${JSON.stringify(result)}`,
  });
  status = passed ? "PASS" : "FAIL";
  message = passed
    ? "formatName returns the expected last-comma-first format"
    : "formatName does not return the expected last-comma-first format";
} catch (error) {
  checks.push({
    name: "format-name-imports-and-runs",
    passed: false,
    message: error instanceof Error ? error.message : String(error),
  });
  status = "FAIL";
  message = "grader could not import or invoke formatName";
}

process.stdout.write(`${JSON.stringify({ status, checks, message })}\n`);
