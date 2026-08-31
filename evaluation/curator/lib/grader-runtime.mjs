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

    // Records every write applied to `source` AT ANY DEPTH, with the path it happened on.
    //
    // The second independent audit found graders observing only the top level of a value, so a
    // candidate could push onto a nested array (or write a nested field) and pop it back before
    // returning. Shallow observation and final-state equality both miss that; this does not.
    //
    // Wrappers are cached per target so object identity is stable across reads, and only plain
    // objects and arrays are wrapped -- wrapping a Date or a class instance would change behavior
    // rather than observe it.
    trackWrites(source) {
      const writes = [];
      const wrappers = new WeakMap();
      const wrap = (target, prefix) => {
        const cached = wrappers.get(target);
        if (cached) return cached;
        const proxy = new Proxy(target, {
          get(inner, property, receiver) {
            const value = Reflect.get(inner, property, receiver);
            return isPlainContainer(value) ? wrap(value, `${prefix}${String(property)}.`) : value;
          },
          set(inner, property, next, receiver) {
            writes.push({ kind: "set", path: `${prefix}${String(property)}`, value: next });
            return Reflect.set(inner, property, next, receiver);
          },
          deleteProperty(inner, property) {
            writes.push({ kind: "delete", path: `${prefix}${String(property)}` });
            return Reflect.deleteProperty(inner, property);
          },
          defineProperty(inner, property, descriptor) {
            writes.push({
              kind: "define",
              path: `${prefix}${String(property)}`,
              value: descriptor.value,
            });
            return Reflect.defineProperty(inner, property, descriptor);
          },
        });
        wrappers.set(target, proxy);
        return proxy;
      };
      return {
        value: wrap(source, ""),
        writes,
        get target() {
          return source;
        },
      };
    },

    // A deeply frozen structural copy. Any write at any depth throws, which makes a transient
    // nested mutation observable without a proxy -- useful where a candidate may legitimately want
    // to structuredClone its input, which a proxy would break.
    deepFreeze(source) {
      return freezeDeep(structuredClone(source));
    },

    // Deterministic private values.
    //
    // Graders that assert against a handful of memorable literals ("first"/"second"/"third",
    // "tenant-a"/"tenant-b") can be satisfied by a candidate that special-cases exactly those
    // literals. These values are generated from a fixed seed the grader records, so runs stay
    // reproducible while the values themselves are not guessable from the public prompt.
    privateValues(seed, count, prefix = "v") {
      const next = seededGenerator(seed);
      return Array.from({ length: count }, () => `${prefix}-${next().toString(36).slice(2, 10)}`);
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

// A container whose mutation is worth observing. Class instances, dates, maps and functions are
// left alone: wrapping them would change behavior rather than watch it.
function isPlainContainer(value) {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeDeep(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.getOwnPropertyNames(value)) freezeDeep(value[key]);
  return Object.freeze(value);
}

// mulberry32: small, fast, and fully determined by its seed.
function seededGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
