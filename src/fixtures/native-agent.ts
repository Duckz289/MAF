import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

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
  if (/simulate secret-bearing failure/iu.test(input.task.prompt)) {
    emit("error", {
      message: [
        "Provider rejected ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE",
        "-----BEGIN ENCRYPTED PRIVATE KEY-----",
        "ERROR-PERSISTED-PRIVATE-KEY-BODY",
        "-----END ENCRYPTED PRIVATE KEY-----",
      ].join("\n"),
    });
    process.exitCode = 1;
    return;
  }
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
  if (
    /fail during repair/iu.test(input.task.prompt) &&
    /Trusted verification repair request/iu.test(input.message)
  ) {
    emit("error", { message: "Fixture repair session failed after candidate capture" });
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
  // M7A integration scenario: append declared-debt markers to an existing source file so the
  // diff-captured DebtRisk (and the DebtDelta quality dimension) are genuinely non-zero.
  if (/introduce debt/iu.test(input.task.prompt)) {
    const debtPath = path.resolve("src/domain/auth-service.ts");
    const existing = await readFile(debtPath, "utf8").catch(() => undefined);
    if (existing !== undefined) {
      await writeFile(
        debtPath,
        `${existing}\n// TODO: fixture debt marker one\n// TODO: fixture debt marker two\n`,
        "utf8",
      );
      emit("tool", { tool: "edit_file", operation: "edit", path: "src/domain/auth-service.ts" });
      if (!changedFiles.includes("src/domain/auth-service.ts")) {
        changedFiles.push("src/domain/auth-service.ts");
      }
    }
  }
  // M8A integration scenario: write a real-shaped (but fake) credential into a production config
  // file, so the diff-captured Security posture has deterministic evidence of a leak.
  if (/leak a secret/iu.test(input.task.prompt)) {
    await mkdir(path.dirname(path.resolve("src/config/prod-tokens.ts")), { recursive: true });
    await writeFile(
      path.resolve("src/config/prod-tokens.ts"),
      'export const deployToken = "ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE";\n',
      "utf8",
    );
    emit("tool", { tool: "write_file", operation: "create", path: "src/config/prod-tokens.ts" });
    changedFiles.push("src/config/prod-tokens.ts");
  }
  if (/leak consecutive private keys/iu.test(input.task.prompt)) {
    const privateKeys: Record<string, string> = {
      "src/config/first-private.pem": [
        "-----BEGIN RSA PRIVATE KEY-----",
        "FIRST-PERSISTED-PRIVATE-KEY-BODY-with-no-standalone-signature",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n"),
      "src/config/second-private.pem": [
        "-----BEGIN RSA PRIVATE KEY-----",
        "SECOND-PERSISTED-PRIVATE-KEY-BODY-with-no-standalone-signature",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n"),
    };
    for (const [privateKeyPath, privateKey] of Object.entries(privateKeys)) {
      await mkdir(path.dirname(path.resolve(privateKeyPath)), { recursive: true });
      await writeFile(path.resolve(privateKeyPath), `${privateKey}\n`, "utf8");
      // Deliberately include the untrusted file content in an agent event. The harness must
      // sanitize this path independently of the persisted diff-preview redactor.
      emit("tool", {
        tool: "write_file",
        operation: "create",
        path: privateKeyPath,
        output: privateKey,
      });
      changedFiles.push(privateKeyPath);
    }
  }
  if (/write binary credential/iu.test(input.task.prompt)) {
    const binaryPath = "src/auth/credential.bin";
    await mkdir(path.dirname(path.resolve(binaryPath)), { recursive: true });
    await writeFile(
      path.resolve(binaryPath),
      Buffer.from("BINARY-CREDENTIAL-PAYLOAD\0with-nul-so-git-emits-a-binary-patch", "utf8"),
    );
    emit("tool", { tool: "write_file", operation: "create", path: binaryPath });
    changedFiles.push(binaryPath);
  }
  // Hardening repair-pass scenario: hidden-input handling added in a NEUTRALLY NAMED file with a
  // neutrally named binding — no path keyword can see this, only the diff's added code can.
  if (/handle hidden input/iu.test(input.task.prompt)) {
    await mkdir(path.dirname(path.resolve("src/domain/input-flow.ts")), { recursive: true });
    await writeFile(
      path.resolve("src/domain/input-flow.ts"),
      [
        'import { getpass } from "getpass";',
        "",
        "export const confirmValue = (): string => {",
        '  const value = getpass("confirm: ");',
        "  if (!value) {",
        "    throw new Error(`invalid input: $" + "{value}`);",
        "  }",
        "  return value;",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    emit("tool", { tool: "write_file", operation: "create", path: "src/domain/input-flow.ts" });
    changedFiles.push("src/domain/input-flow.ts");
  }
  // Hardening pass #3 adversarial scenario: a PREVIOUSLY UNSEEN local API (`prompt_for` renamed to
  // `ask_hidden` via import alias) configured to conceal input, routed through a temp binding into
  // an externally visible sink — no listed API name, no sensitive variable name, neutral file name.
  // Only bounded structural analysis (alias resolution + concealment kwarg + one-hop propagation)
  // can see this.
  if (/route concealed credential/iu.test(input.task.prompt)) {
    await mkdir(path.dirname(path.resolve("src/domain/reader-flow.py")), { recursive: true });
    await writeFile(
      path.resolve("src/domain/reader-flow.py"),
      [
        "from cli_toolkit import prompt_for as ask_hidden",
        "",
        "def validate():",
        '    value = ask_hidden("api key", conceal=True)',
        "    interim = value",
        '    raise ValueError(f"validation failed: {interim}")',
        "",
      ].join("\n"),
      "utf8",
    );
    emit("tool", { tool: "write_file", operation: "create", path: "src/domain/reader-flow.py" });
    changedFiles.push("src/domain/reader-flow.py");
  }
  // Discovery-adequacy hardening scenario: a neutral path and a representation the cheap concern
  // detector intentionally does not recognize. Risk/planner should remain free to miss Security;
  // the explicit INCOMPLETE scope assessment must still become a material obligation.
  if (/write neutral discovery gap/iu.test(input.task.prompt)) {
    const visibilityPath = "src/domain/visibility.ts";
    await mkdir(path.dirname(path.resolve(visibilityPath)), { recursive: true });
    await writeFile(
      path.resolve(visibilityPath),
      [
        "export interface VisibleRecord { createdBy: string }",
        "export interface Viewer { id: string }",
        "export const visibleTo = (row: VisibleRecord, viewer: Viewer): boolean =>",
        "  row.createdBy === viewer.id;",
        "",
      ].join("\n"),
      "utf8",
    );
    emit("tool", { tool: "write_file", operation: "create", path: visibilityPath });
    changedFiles.push(visibilityPath);
  }
  // Hardening pass #4 (coverage honesty): sensitive-input handling written in a language whose
  // idioms the semantic scanner does not model. The path carries an auth keyword, so the plan DOES
  // require SECURITY — the question under test is whether a credential-literal scan's PASS is
  // allowed to discharge that requirement over material the behavioural scanner cannot read.
  if (/write unmodelled language credential flow/iu.test(input.task.prompt)) {
    const goPath = "src/auth/login.go";
    await mkdir(path.dirname(path.resolve(goPath)), { recursive: true });
    await writeFile(
      path.resolve(goPath),
      [
        "package auth",
        "",
        "func PromptCredential() (string, error) {",
        "  raw, err := term.ReadPassword(int(syscall.Stdin))",
        "  if err != nil {",
        '    return "", fmt.Errorf("could not read %q: %w", string(raw), err)',
        "  }",
        "  return string(raw), nil",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    emit("tool", { tool: "write_file", operation: "create", path: goPath });
    changedFiles.push(goPath);
  }
  // Hardening pass #4 (capability/concern match): a deployment manifest change. This raises
  // OperationalSensitivity, which makes the plan require RESILIENCE — but the resilience relevance
  // scan only reads CODE files, so it has nothing to say about this artefact either way.
  // Deliberately carries no `run:`/`script:` key, so the separate workflow-behavioural path is not
  // what is being exercised here.
  if (/change deployment manifest/iu.test(input.task.prompt)) {
    const manifestPath = "deploy/service.yaml";
    await mkdir(path.dirname(path.resolve(manifestPath)), { recursive: true });
    await writeFile(
      path.resolve(manifestPath),
      ["apiVersion: v1", "kind: Service", "spec:", "  replicas: 4", "  gracePeriod: 5", ""].join(
        "\n",
      ),
      "utf8",
    );
    emit("tool", { tool: "write_file", operation: "create", path: manifestPath });
    changedFiles.push(manifestPath);
  }
  // Hardening pass #4 (deterministic FAIL outranks the planner): a domain file importing outward.
  // In a repository with no wider src/ tree the plan does NOT require ARCHITECTURE, so this is
  // exactly the shape where a reported FAIL used to be ignored.
  if (/invert the domain layer/iu.test(input.task.prompt)) {
    const domainPath = "src/domain/widget.ts";
    await mkdir(path.dirname(path.resolve(domainPath)), { recursive: true });
    await writeFile(
      path.resolve(domainPath),
      [
        'import { helper } from "../infrastructure/helper";',
        "",
        "export const widget = (): string => helper();",
        "",
      ].join("\n"),
      "utf8",
    );
    emit("tool", { tool: "write_file", operation: "create", path: domainPath });
    changedFiles.push(domainPath);
  }
  if (/write secret-shaped filename/iu.test(input.task.prompt)) {
    const secretShapedPath = "ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE";
    await writeFile(path.resolve(secretShapedPath), "filename boundary probe\n", "utf8");
    emit("tool", { tool: "write_file", operation: "create", path: secretShapedPath });
    changedFiles.push(secretShapedPath);
  }
  if (/introduce performance regression/iu.test(input.task.prompt)) {
    const performancePath = "src/server/database-query.ts";
    const absolute = path.resolve(performancePath);
    const existing = await readFile(absolute, "utf8").catch(() => undefined);
    if (existing !== undefined) {
      await writeFile(
        absolute,
        `${existing}\nexport const loadAllWidgets = async (database: { query(sql: string): Promise<unknown> }): Promise<unknown> => database.query("SELECT * FROM widgets");\n`,
        "utf8",
      );
      emit("tool", { tool: "edit_file", operation: "edit", path: performancePath });
      changedFiles.push(performancePath);
    }
  }
  // M10 integration scenario: append an outbound dependency call to an existing source file so
  // the diff-captured content (not a filename or comment) derives fault-scenario relevance.
  if (/introduce a network dependency/iu.test(input.task.prompt)) {
    const dependencyPath = "src/server/dependency-client.ts";
    const absolute = path.resolve(dependencyPath);
    const existing = await readFile(absolute, "utf8").catch(() => undefined);
    if (existing !== undefined) {
      await writeFile(absolute, `${existing}\nfetch("https://example.test/widgets");\n`, "utf8");
      emit("tool", { tool: "edit_file", operation: "edit", path: dependencyPath });
      changedFiles.push(dependencyPath);
    }
  }
  // Review-governance fixture: make a real consistency-sensitive code change without also
  // introducing an unrelated dependency-discovery obligation. This gives a CRITICAL plan a
  // concrete resilience scenario that a candidate-bound verifier can execute before review.
  if (/exercise idempotent auth update/iu.test(input.task.prompt)) {
    const modelPath = "src/domain/model.ts";
    const absolute = path.resolve(modelPath);
    const existing = await readFile(absolute, "utf8").catch(() => undefined);
    if (existing !== undefined) {
      await writeFile(
        absolute,
        `${existing}\nexport const idempotentSessionVersion = 1;\n`,
        "utf8",
      );
      emit("tool", { tool: "edit_file", operation: "edit", path: modelPath });
      changedFiles.push(modelPath);
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
