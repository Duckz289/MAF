import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function runBehavioralGrader(taskId, grader) {
  const workspace = readWorkspaceArgument();
  if (!workspace || !(await stat(workspace).catch(() => null))?.isDirectory()) {
    emit("INVALID", [], "candidate workspace is missing");
    return;
  }

  const checks = [];
  const context = {
    workspace,
    async importModule(relativePath) {
      const url = pathToFileURL(path.join(workspace, relativePath));
      return await import(url.href);
    },
    check(name, passed, message) {
      checks.push({ name, passed: Boolean(passed), message: String(message) });
    },
    equal(name, actual, expected) {
      let passed = true;
      try {
        assert.deepStrictEqual(actual, expected);
      } catch {
        passed = false;
      }
      checks.push({
        name,
        passed,
        message: `expected ${inspect(expected)}, got ${inspect(actual)}`,
      });
    },
    async throws(name, action, ErrorType = Error) {
      let thrown;
      try {
        await action();
      } catch (error) {
        thrown = error;
      }
      const passed = thrown instanceof ErrorType;
      checks.push({
        name,
        passed,
        message: passed
          ? `threw ${thrown.name}`
          : `expected ${ErrorType.name}, got ${thrown?.constructor?.name ?? "no error"}`,
      });
    },
  };

  try {
    await grader(context);
  } catch (error) {
    checks.push({
      name: "candidate execution",
      passed: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const status = checks.length > 0 && checks.every((check) => check.passed) ? "PASS" : "FAIL";
  emit(status, checks, `${taskId}: ${status}`);
}

function readWorkspaceArgument() {
  const index = process.argv.indexOf("--workspace");
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function emit(status, checks, message) {
  console.log(JSON.stringify({ status, checks, message }));
}
function inspect(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
