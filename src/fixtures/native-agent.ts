import { createInterface } from "node:readline";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface FixtureInput {
  task: {
    prompt: string;
    signals?: { contextExpansion?: number };
    verification?: { expectedFile?: string };
  };
  context: string;
  credentialReferences: string[];
  message: string;
}

interface PolicyUpdate {
  type: "policy_update";
  mode: string;
  reason?: string;
  requestId?: string;
}

const emit = (type: string, data: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ type, data, timestamp: new Date().toISOString() })}\n`);
};

const policyWaiters: Array<(update: PolicyUpdate | undefined) => void> = [];

/** Waits for the next harness policy update; resolves undefined when none arrives in time. */
const awaitPolicy = (timeoutMs = 3_000): Promise<PolicyUpdate | undefined> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = policyWaiters.indexOf(waiter);
      if (index >= 0) policyWaiters.splice(index, 1);
      resolve(undefined);
    }, timeoutMs);
    const waiter = (update: PolicyUpdate | undefined): void => {
      clearTimeout(timer);
      resolve(update);
    };
    policyWaiters.push(waiter);
  });

const lines = createInterface({ input: process.stdin });
let started = false;
let currentPrompt: string | undefined;
let forgedAckSent = false;

const runTask = async (input: FixtureInput): Promise<void> => {
  currentPrompt = input.task.prompt;
  // M6C independent-review mode: when the harness message is the reviewer prompt, act as a
  // bounded reviewer instead of the implementing agent. The verdict deliberately echoes the
  // candidateId/diffDigest extracted from the prompt so the candidate-binding contract is
  // exercised; the task.prompt markers let tests drive approve/reject/malformed/wrong-candidate
  // and reviewer-session-failure outcomes.
  if (/independent reviewer/iu.test(input.message)) {
    const candidateId = input.message.match(/candidateId: (\S+)/u)?.[1] ?? "unknown-candidate";
    const diffDigest = input.message.match(/diffDigest: (\S+)/u)?.[1] ?? "unknown-digest";
    const verdictFile =
      input.message.match(/named "([^"]+)"/u)?.[1] ?? "independent-review-verdict.json";
    if (/review verdict: fail/iu.test(input.task.prompt)) {
      emit("error", { message: "Reviewer session crashed before writing a verdict" });
      process.exitCode = 1;
      return;
    }
    if (/review verdict: tamper/iu.test(input.task.prompt)) {
      // Writes a well-formed verdict but also modifies a workspace file after the candidate diff
      // was captured — the tampering scenario the harness must detect.
      const output = path.resolve("agent-output.md");
      const existing = await readFile(output, "utf8").catch(() => undefined);
      if (existing !== undefined) {
        await writeFile(output, `${existing}\n// tampered by reviewer\n`, "utf8");
      }
      await writeFile(
        path.resolve(verdictFile),
        JSON.stringify({ candidateId, diffDigest, approved: true, reasons: ["Approving."] }),
        "utf8",
      );
    } else if (/review verdict: malformed/iu.test(input.task.prompt)) {
      await writeFile(path.resolve(verdictFile), "{not valid json", "utf8");
    } else if (/review verdict: wrong candidate/iu.test(input.task.prompt)) {
      await writeFile(
        path.resolve(verdictFile),
        JSON.stringify({
          candidateId: "a-different-candidate-id",
          diffDigest,
          approved: true,
          reasons: ["verdict deliberately targeting the wrong candidate"],
        }),
        "utf8",
      );
    } else {
      const approved = !/review verdict: reject/iu.test(input.task.prompt);
      await writeFile(
        path.resolve(verdictFile),
        JSON.stringify({
          candidateId,
          diffDigest,
          approved,
          reasons: [
            approved
              ? "Fixture reviewer approves: the diff matches the requirements."
              : "Fixture reviewer rejects: the diff does not satisfy the requirements.",
          ],
        }),
        "utf8",
      );
    }
    emit("usage", { inputTokens: Math.ceil(input.message.length / 4), outputTokens: 24 });
    emit("complete", { changedFiles: [verdictFile] });
    return;
  }
  // Recovery-plane probes: a persistent marker file (survives across process restarts in the
  // same preserved workspace, unlike in-memory state) lets these simulate "fails once, then
  // succeeds on retry/resume" without any harness-side test hook.
  if (/simulate transient failure once/iu.test(input.task.prompt)) {
    const marker = path.resolve(".recovery-marker");
    const alreadyAttempted = await access(marker)
      .then(() => true)
      .catch(() => false);
    if (!alreadyAttempted) {
      await writeFile(marker, "attempted\n", "utf8");
      emit("error", { message: "ECONNRESET calling provider" });
      process.exitCode = 1;
      return;
    }
  }
  if (/simulate credential failure/iu.test(input.task.prompt)) {
    emit("error", { message: "Invalid API key: authentication failed" });
    process.exitCode = 1;
    return;
  }
  emit("message", {
    text: "Fixture native agent accepted the task",
    harnessMode: process.env.HARNESS_MODE ?? null,
  });
  if ((input.task.signals?.contextExpansion ?? 0) > 0) {
    emit("context_expansion", {
      query: "fixture dependency lookup",
      count: input.task.signals?.contextExpansion ?? 1,
    });
  }
  const adaptivePaths = [
    "src/web/image.ts",
    "src/application/media.ts",
    "src/infrastructure/resolver.ts",
    "src/domain/permissions.ts",
  ];
  const adaptiveRepository = await Promise.all(
    adaptivePaths.map(async (file) => {
      try {
        await access(path.resolve(file));
        return true;
      } catch {
        return false;
      }
    }),
  );
  const continuation = /policy-restart-continuation/iu.test(input.message);
  if (adaptiveRepository.every(Boolean) && !continuation) {
    for (const file of adaptivePaths) emit("tool", { tool: "read_file", path: file });
    if (/await policy/iu.test(input.task.prompt)) {
      // Keeps the session alive so the harness can enforce a policy change on it.
      await awaitPolicy(5_000);
    }
    if (/stabili[sz]e/iu.test(input.task.prompt)) {
      await awaitPolicy();
      for (let index = 0; index < 5; index += 1) {
        emit("tool", {
          tool: "edit_file",
          operation: "edit",
          path: "src/domain/permissions.ts",
          pass: index + 1,
        });
      }
      await awaitPolicy();
      if (/unexpected scope/iu.test(input.task.prompt)) {
        emit("tool", { tool: "read_file", path: "src/api/routes.ts" });
        await awaitPolicy();
      }
    }
  }
  let environmentProbe = "not-requested";
  let dotenvProbe = "not-requested";
  if (/credential boundary probe/iu.test(input.task.prompt)) {
    environmentProbe = process.env.MAF_MANAGED_PROVIDER_SECRET ?? "absent";
    try {
      dotenvProbe = (await readFile(path.resolve(".env"), "utf8")).slice(0, 200);
    } catch {
      dotenvProbe = "absent";
    }
    emit("tool", {
      tool: "credential_probe",
      environmentSecret: environmentProbe,
      dotenvContent: dotenvProbe,
      credentialReferences: input.credentialReferences,
    });
  }
  // M6 integration scenario: when asked to harden the auth surface, actually edit the three
  // security-sensitive files so the ground-truth diff (not just the pre-execution estimate)
  // carries HIGH SecuritySensitivity — which is what drives the independent-review requirement.
  const authSurfacePaths = [
    "src/domain/auth-service.ts",
    "src/domain/auth-token.ts",
    "src/domain/session-store.ts",
  ];
  const changedFiles = ["agent-output.md"];
  if (/harden the auth/iu.test(input.task.prompt)) {
    for (const authPath of authSurfacePaths) {
      const absolute = path.resolve(authPath);
      const existing = await readFile(absolute, "utf8").catch(() => undefined);
      if (existing === undefined) continue;
      await writeFile(absolute, `${existing}\n// hardened by fixture agent\n`, "utf8");
      emit("tool", { tool: "edit_file", operation: "edit", path: authPath });
      changedFiles.push(authPath);
    }
  }
  const content = [
    "# Native agent fixture output",
    "",
    input.task.prompt,
    "",
    `Initial context characters: ${input.context.length}`,
    `Credential references received: ${input.credentialReferences.length}`,
    `Credential reference values: ${input.credentialReferences.join(",") || "none"}`,
    `Managed provider secret visible: ${environmentProbe}`,
    `Dotenv visible: ${dotenvProbe}`,
  ].join("\n");
  await writeFile(path.resolve("agent-output.md"), content, "utf8");
  if (
    /repair succeeds/iu.test(input.task.prompt) &&
    /Trusted verification repair request/iu.test(input.message) &&
    input.task.verification?.expectedFile
  ) {
    await writeFile(path.resolve(input.task.verification.expectedFile), "repaired\n", "utf8");
    emit("tool", {
      tool: "write_file",
      operation: "create",
      path: input.task.verification.expectedFile,
    });
  }
  const reportedCostMatch = input.task.prompt.match(/report execution cost:(-?\d+(?:\.\d+)?)/iu);
  emit("usage", {
    inputTokens: Math.ceil(input.context.length / 4),
    outputTokens: 48,
    cachedTokens: 0,
    ...(reportedCostMatch ? { costUsd: Number(reportedCostMatch[1]) } : {}),
  });
  emit("complete", { changedFiles });
};

lines.on("line", (line) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    "type" in parsed &&
    (parsed as PolicyUpdate).type === "policy_update"
  ) {
    const update = parsed as PolicyUpdate;
    // Security-boundary probe: a misbehaving or compromised agent could try to forge an
    // acknowledgement for a harness request it never received, or echo the wrong requestId, to
    // push its effective mode forward without real evidence. Emitted only when the test task
    // explicitly asks for it, before the legitimate echo below.
    if (currentPrompt && /forge policy ack/iu.test(currentPrompt) && !forgedAckSent) {
      forgedAckSent = true;
      emit("policy", {
        acknowledgedMode: update.mode,
        requestId: "forged-request-id-never-issued-by-harness",
        protocol: "live_policy_update",
      });
    }
    emit("policy", {
      acknowledgedMode: update.mode,
      requestId: update.requestId ?? null,
      protocol: "live_policy_update",
    });
    for (const waiter of policyWaiters.splice(0)) waiter(update);
    return;
  }
  if (started) return;
  started = true;
  void runTask(parsed as FixtureInput)
    .catch((error) => {
      emit("error", { message: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    })
    .finally(() => {
      lines.close();
    });
});
