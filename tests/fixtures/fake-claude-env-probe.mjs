#!/usr/bin/env node
// Environment-isolation probe. Writes the subset of environment variables it actually received to a
// file under TEMP, so a test can prove which variables ClaudeCodeAdapter forwards to a participant
// process -- specifically, that no ANTHROPIC_* routing or credential ever reaches it.
//
// Records only PRESENCE and, for non-secret allowlisted variables, a coarse marker. It never writes
// the value of anything credential-shaped, so the artifact is safe even if it is left behind.

import { writeFileSync } from "node:fs";
import path from "node:path";

const token = process.env.HARNESS_RUN_ID ?? "unknown";
const dir = process.env.TEMP ?? process.env.TMP ?? ".";

const observed = {
  // Must be absent: these are the contamination risk.
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? null,
  // Presence only -- never the value, even though a real secret would be redacted downstream.
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN === undefined ? null : "[PRESENT]",
  // Must be present: the CLI legitimately needs these.
  PATH: process.env.PATH ? "[PRESENT]" : null,
  HARNESS_RUN_ID: process.env.HARNESS_RUN_ID ?? null,
  HARNESS_MODE: process.env.HARNESS_MODE ?? null,
};

writeFileSync(path.join(dir, `fake-cli-env-${token}.log`), JSON.stringify(observed), "utf8");

process.stdin.resume();
process.stdin.on("data", () => {});
process.stdout.write(
  `${JSON.stringify({
    type: "result",
    subtype: "success",
    result: "probe complete",
    is_error: false,
    session_id: "env-probe",
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
  })}\n`,
);
process.exit(0);
