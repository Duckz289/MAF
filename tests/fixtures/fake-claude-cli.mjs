#!/usr/bin/env node
// Deterministic fake Claude Code CLI for adapter contract tests
// (tests/claude-code-adapter.test.ts). Emits representative stream-json lines matching the shapes
// ClaudeCodeAdapter's consume() method parses, selected by the HARNESS_RUN_ID env var --
// ClaudeCodeAdapter always sets that to the fabricated Run's id, which the test controls, and
// forwards no other custom env var, so it is the one legitimate channel available to pick a
// scenario without changing the adapter's real spawn contract.
//
// Never calls a real provider; this is pure fixture data.

const scenario = process.env.HARNESS_RUN_ID ?? "success";

// Drain and ignore stdin (the adapter always writes the full prompt and closes stdin).
process.stdin.resume();
process.stdin.on("data", () => {});

const writeLine = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

switch (scenario) {
  case "success": {
    writeLine({
      type: "assistant",
      message: {
        model: "claude-sonnet-5-20250929",
        content: [
          { type: "text", text: "Working on it." },
          { type: "tool_use", name: "write_file", input: { path: "src/example.ts" } },
        ],
      },
    });
    writeLine({
      type: "result",
      subtype: "success",
      result: "Done.",
      session_id: "fake-session-1",
      total_cost_usd: 0.1234,
      usage: { input_tokens: 321, output_tokens: 654, cache_read_input_tokens: 12 },
    });
    process.exit(0);
    break;
  }
  case "malformed": {
    process.stdout.write("this is not json at all\n");
    process.exit(0);
    break;
  }
  case "nonzero-exit": {
    writeLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "about to crash" }] },
    });
    process.exit(2);
    break;
  }
  case "hang": {
    // Never exits on its own; the test's own timeout + adapter.cancel() (SIGTERM) must end it.
    setInterval(() => {}, 1_000_000);
    break;
  }
  default: {
    process.stderr.write(`fake-claude-cli: unknown scenario "${scenario}"\n`);
    process.exit(1);
  }
}
