#!/usr/bin/env node
// Deterministic fake Claude Code CLI for adapter/runtime contract tests. Emits representative
// stream-json lines matching the shapes ClaudeCodeAdapter's consume() parses, selected by the
// HARNESS_RUN_ID env var -- ClaudeCodeAdapter always sets that to the fabricated Run's id, which the
// test controls, and forwards no other custom env var, so it is the one legitimate channel available
// to pick a scenario without changing the adapter's real spawn contract.
//
// Never calls a real provider; this is pure fixture data.
//
// Scenarios reproduce the defects the first billed Protocol v2 preflight exposed
// (INVALID_PREFLIGHT_ATTEMPT) plus the terminal-state combinations that must be distinguished.

import { appendFileSync } from "node:fs";
import path from "node:path";

// ClaudeCodeAdapter deliberately forwards only a curated environment allowlist (PATH, TEMP,
// USERPROFILE, ... plus HARNESS_RUN_ID/HARNESS_MODE) and never arbitrary variables -- that is a
// security boundary, not an oversight, so this fixture must not ask for one to be added. The run id
// is therefore the channel for BOTH the scenario and an optional argv-log token:
//     HARNESS_RUN_ID = "<scenario>"  or  "<scenario>|<logToken>"
// The log is written next to TEMP, which the allowlist does forward.
const [scenario = "success", argvLogToken] = (process.env.HARNESS_RUN_ID ?? "success").split("|");

if (argvLogToken) {
  const dir = process.env.TEMP ?? process.env.TMP ?? ".";
  appendFileSync(
    path.join(dir, `fake-cli-argv-${argvLogToken}.log`),
    `${JSON.stringify(process.argv.slice(2))}\n`,
  );
}

// Drain and ignore stdin (the adapter always writes the full prompt and closes stdin).
process.stdin.resume();
process.stdin.on("data", () => {});

const writeLine = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const assistant = (model = "claude-sonnet-5-20250929") =>
  writeLine({
    type: "assistant",
    message: {
      model,
      content: [
        { type: "text", text: "Working on it." },
        { type: "tool_use", name: "write_file", input: { path: "src/example.ts" } },
      ],
    },
  });

const result = (overrides = {}) =>
  writeLine({
    type: "result",
    subtype: "success",
    result: "Done.",
    session_id: "fake-session-1",
    is_error: false,
    total_cost_usd: 0.1234,
    usage: { input_tokens: 321, output_tokens: 654, cache_read_input_tokens: 12 },
    ...overrides,
  });

switch (scenario) {
  // 1. Structured success + clean exit. The ordinary happy path.
  case "success": {
    assistant();
    result();
    process.exit(0);
    break;
  }

  // 2. Structured ERROR result + nonzero exit. Must NOT become COMPLETED merely because the line
  //    had type "result".
  case "error-result": {
    assistant();
    result({ subtype: "error_during_execution", is_error: true, result: "something broke" });
    process.exit(1);
    break;
  }

  // 3. Structured SUCCESS result followed by a nonzero exit. The regression that made the first
  //    billed preflight report INFRA_FAILURE for what may have been a real completion. The
  //    structured result must win; the discrepancy must be recorded.
  case "success-then-nonzero-exit": {
    assistant();
    result();
    process.exit(1);
    break;
  }

  // 4. Malformed stream + nonzero exit.
  case "malformed": {
    process.stdout.write("this is not json at all\n");
    process.exit(1);
    break;
  }

  // 5. Auth failure on stderr + nonzero exit. Must classify AUTH_CONFIGURATION_FAILURE and must NOT
  //    be auto-retryable.
  case "auth-failure": {
    process.stderr.write("Authentication failed: not logged in. Please run `claude auth login`.\n");
    process.exit(1);
    break;
  }

  // 6. Provider/upstream failure on stderr + nonzero exit. The ONE auto-retryable class.
  case "provider-failure": {
    process.stderr.write("API error: 529 overloaded_error, upstream service unavailable\n");
    process.exit(1);
    break;
  }

  // 7. Bare nonzero exit, nothing else. The exact shape that caused the authorization overrun.
  //    Must classify CLI_PROCESS_FAILURE and must NOT be auto-retryable.
  case "bare-nonzero-exit": {
    process.exit(1);
    break;
  }

  // 8. Placeholder/synthetic model identity -- what the first billed preflight actually recorded as
  //    RESOLVED. Must now classify PLACEHOLDER_OR_SYNTHETIC.
  case "synthetic-model": {
    assistant("<synthetic>");
    result();
    process.exit(0);
    break;
  }

  // 9. Participant's own limit. A VALID run with a non-DVS outcome; never rerun.
  case "max-turns": {
    assistant();
    result({ subtype: "error_max_turns", is_error: true, result: "hit turn limit" });
    process.exit(1);
    break;
  }

  // 10. Success with no cost reported at all. Cost must stay UNKNOWN, never 0.
  case "success-unknown-cost": {
    assistant();
    writeLine({
      type: "result",
      subtype: "success",
      result: "Done.",
      session_id: "fake-session-1",
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
    });
    process.exit(0);
    break;
  }

  // 11. Hangs forever; the controller's own deadline + cancel() must end it. This is also how a
  //     SIGNAL termination is produced: a parent-initiated kill reports (code=null, signal=SIGTERM)
  //     on both POSIX and Windows, whereas a self-kill reports a plain exit code -- so the realistic
  //     signal path is the one the controller itself takes on timeout.
  case "hang": {
    setInterval(() => {}, 1_000_000);
    break;
  }

  default: {
    process.stderr.write(`fake-claude-cli: unknown scenario "${scenario}"\n`);
    process.exit(1);
  }
}
