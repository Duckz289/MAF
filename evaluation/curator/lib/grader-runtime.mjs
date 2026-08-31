import assert from "node:assert/strict";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Behavioral grader runtime.
//
// Design rules, derived from the independent audit of snapshot bb326527:
//
//  * An assertion may only encode a requirement the task's public prompt states. Exception
//    subclasses, file layout, helper names and internal call counts are hidden requirements unless
//    the prompt names them, so `throws` accepts a *set* of acceptable error types and defaults to
//    "any Error".
//  * Ordering contracts ("validate before persisting", "do not publish before the ledger accepts")
//    cannot be checked by comparing final state, because mutate-then-restore reaches the same final
//    state. `trackWrites` and `writeModule` let a grader observe the intermediate state instead,
//    without dictating how the candidate is structured.
//  * "Preserves unrelated fields" is a superset requirement, not an equality requirement, so
//    `includes` exists alongside `equal`.

export async function runBehavioralGrader(taskId, grader) {
  const workspace = readWorkspaceArgument();
  if (!workspace || !(await stat(workspace).catch(() => null))?.isDirectory()) {
    emit("INVALID", [], "candidate workspace is missing");
    return;
  }

  const checks = [];
  const record = (name, passed, message) => {
    checks.push({ name: String(name), passed: Boolean(passed), message: String(message) });
  };

  const context = {
    workspace,

    async importModule(relativePath) {
      return await import(pathToFileURL(path.join(workspace, relativePath)).href);
    },

    // Write an extra module into the candidate workspace. Used to install pass-through probes that
    // observe *when* a candidate touches shared state. Must be called before the module under test
    // is imported.
    async writeModule(relativePath, source) {
      const target = path.join(workspace, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source, "utf8");
    },

    // Relocate an existing workspace module so a probe can re-export the original from a new path.
    async moveModule(fromRelative, toRelative) {
      const from = path.join(workspace, fromRelative);
      const to = path.join(workspace, toRelative);
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
    },

    check: record,

    equal(name, actual, expected) {
      let passed = true;
      try {
        assert.deepStrictEqual(actual, expected);
      } catch {
        passed = false;
      }
      record(name, passed, `expected ${inspect(expected)}, got ${inspect(actual)}`);
    },

    // Superset assertion: every entry of `expected` must appear in `actual` with the same value.
    // Extra fields on `actual` are explicitly allowed, so a candidate is never rejected merely for
    // returning additional harmless diagnostic data.
    includes(name, actual, expected) {
      let passed = actual !== null && typeof actual === "object";
      if (passed) {
        for (const [key, value] of Object.entries(expected)) {
          try {
            assert.deepStrictEqual(actual[key], value);
          } catch {
            passed = false;
          }
        }
      }
      record(name, passed, `expected ${inspect(expected)} to be contained in ${inspect(actual)}`);
    },

    // `accepted` may be a single constructor, or an array of constructors when the public prompt
    // requires rejection but does not name the error class. Defaults to "any Error".
    async throws(name, action, accepted = Error) {
      const types = Array.isArray(accepted) ? accepted : [accepted];
      let thrown;
      let returned;
      let threw = false;
      try {
        returned = await action();
      } catch (error) {
        thrown = error;
        threw = true;
      }
      const passed = threw && types.some((Type) => thrown instanceof Type);
      const wanted = types.map((Type) => Type.name).join(" or ");
      record(
        name,
        passed,
        threw
          ? `threw ${thrown?.constructor?.name ?? String(thrown)}, accepted ${wanted}`
          : `expected ${wanted}, but the call returned ${inspect(returned)}`,
      );
      return thrown;
    },

    // Returns a proxy that records every write, delete and redefinition applied to `source`, along
    // with the value observed at that moment. Lets a grader distinguish "validated before mutating"
    // from "mutated, then restored", which final-state equality cannot see.
    trackWrites(source) {
      const writes = [];
      const value = new Proxy(source, {
        set(target, property, next, receiver) {
          writes.push({ kind: "set", property: String(property), value: next });
          return Reflect.set(target, property, next, receiver);
        },
        deleteProperty(target, property) {
          writes.push({ kind: "delete", property: String(property) });
          return Reflect.deleteProperty(target, property);
        },
        defineProperty(target, property, descriptor) {
          writes.push({ kind: "define", property: String(property), value: descriptor.value });
          return Reflect.defineProperty(target, property, descriptor);
        },
      });
      return { value, writes, get target() { return source; } };
    },
  };

  try {
    await grader(context);
  } catch (error) {
    record("candidate execution", false, error instanceof Error ? error.message : String(error));
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
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
