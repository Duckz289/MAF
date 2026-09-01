#!/usr/bin/env node
// Synthetic, non-scoring grader for the NON_SCORING dry-run fixture only. Exercises the same
// candidate-execution-contract ABI (CANDIDATE_EXECUTION_CONTRACT.md) as the frozen suite's real
// graders -- `node grader.mjs --workspace <absolute-path>` emitting one JSON object with
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
  const target = path.join(workspace, "src", "greet.mjs");
  const moduleUrl = pathToFileURL(target).href;
  const candidate = await import(moduleUrl);
  const result = candidate.greet("World");
  const passed = result === "Hello, World!";
  checks.push({
    name: "greet-returns-hello-greeting",
    passed,
    message: `greet("World") returned ${JSON.stringify(result)}`,
  });
  status = passed ? "PASS" : "FAIL";
  message = passed
    ? "greet returns the expected Hello greeting"
    : "greet does not return the expected Hello greeting";
} catch (error) {
  checks.push({
    name: "greet-imports-and-runs",
    passed: false,
    message: error instanceof Error ? error.message : String(error),
  });
  status = "FAIL";
  message = "grader could not import or invoke greet";
}

process.stdout.write(`${JSON.stringify({ status, checks, message })}\n`);
