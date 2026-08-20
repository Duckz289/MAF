import { describe, expect, it } from "vitest";

import { deriveSecurityPosture, redactPatchPreview } from "../src/domain/security";

const patchFor = (file: string, added: string[], removed: string[] = []): string =>
  [
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,1 1,1 @@",
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");

describe("deriveSecurityPosture (M8A)", () => {
  it("passes when no credential patterns are present", () => {
    const result = deriveSecurityPosture(
      patchFor("src/domain/widget.ts", ["export const x = 1;", 'const label = "hello";']),
    );
    expect(result.state).toBe("PASS");
    expect(result.findings).toHaveLength(0);
    expect(result.evidence[0]).toContain("no credential or secret patterns");
  });

  it("fails on a structured secret format in a production file, with redacted evidence", () => {
    for (const [name, line] of [
      ["AWS key", 'const key = "AKIAIOSFODNN7EXAMPLE";'],
      ["GitHub token", 'const t = "ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE";'],
      ["private key", "-----BEGIN RSA PRIVATE KEY-----"],
    ] as const) {
      const result = deriveSecurityPosture(patchFor("src/config/prod.ts", [line]));
      expect(result.state, name).toBe("FAIL");
      expect(result.findings[0]).toContain("src/config/prod.ts");
      // The matched value must never appear in full in the harness's own evidence.
      expect(result.findings.join(" ")).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(result.findings.join(" ")).not.toContain("ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE");
    }
  });

  it("scans non-source files too — secrets live in .env and yaml", () => {
    const result = deriveSecurityPosture(
      patchFor(".env.production", ["api_key=xoxb-1234567890abcdef"]),
    );
    expect(result.state).toBe("FAIL");
  });

  it("warns on a literal assigned to a credential-shaped name in a production file", () => {
    const result = deriveSecurityPosture(
      patchFor("src/domain/auth-service.ts", ['const password = "hunter2hunter2";']),
    );
    expect(result.state).toBe("WARN");
    expect(result.findings).toHaveLength(1);
  });

  it("warns on UNQUOTED env/yaml credential literals — the quoted form never matches those", () => {
    for (const [name, line] of [
      ["dotenv", "password=hunter2hunter2"],
      ["yaml", "api_key: hunter2hunter2"],
    ] as const) {
      const result = deriveSecurityPosture(patchFor(".env.production", [line]));
      expect(result.state, name).toBe("WARN");
      expect(result.findings.join(" ")).not.toContain("hunter2hunter2");
    }
  });

  it("does not treat source expressions as env literals", () => {
    const result = deriveSecurityPosture(
      patchFor("src/domain/tokens.ts", ["const token = crypto.randomUUID();"]),
    );
    expect(result.state).toBe("PASS");
  });

  it("downgrades structural matches confined to test/fixture files to WARN", () => {
    const result = deriveSecurityPosture(
      patchFor("tests/auth.test.ts", ['const key = "AKIAIOSFODNN7EXAMPLE";']),
    );
    expect(result.state).toBe("WARN");
    expect(result.evidence.join(" ")).toContain("test/fixture");
  });

  it("passes on dummy credentials confined to test files, with disclosure", () => {
    const result = deriveSecurityPosture(
      patchFor("tests/auth.test.ts", ['const password = "dummy-password-123";']),
    );
    expect(result.state).toBe("PASS");
    expect(result.evidence[0]).toContain("dummy credential");
  });

  it("ignores placeholders and references — they are not literals", () => {
    const result = deriveSecurityPosture(
      patchFor("src/domain/config.ts", [
        "const apiKey = process.env.API_KEY;",
        'const secret = "<your-secret-here>";',
        'const token = "${' + 'TOKEN}";',
        'const password = "xxxxxxxx";',
      ]),
    );
    expect(result.state).toBe("PASS");
    expect(result.findings).toHaveLength(0);
  });

  it("does not scan removed lines — deleting a secret is an improvement", () => {
    const result = deriveSecurityPosture(patchFor(".env", [], ['AWS_KEY="AKIAIOSFODNN7EXAMPLE"']));
    expect(result.state).toBe("PASS");
  });
});

describe("redactPatchPreview (M8 redaction invariant)", () => {
  it("passes a clean patch through byte-identical", () => {
    const patch = patchFor("src/domain/widget.ts", ["export const x = 1;"]);
    expect(redactPatchPreview(patch)).toBe(patch);
  });

  it("suppresses every added line of a file containing a private key — the body has no signature", () => {
    const patch = [
      "--- a/keys.pem",
      "+++ b/keys.pem",
      "@@ -0,0 +1,3 @@",
      "+-----BEGIN RSA PRIVATE KEY-----",
      "+MIIEpAIBAAKCAQEA1bodywithnosignatureatall1234567890abcdefghij",
      "+-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactPatchPreview(patch);
    expect(redacted).not.toContain("bodywithnosignatureatall");
    expect(redacted).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(redacted).toContain("redacted by the security checker");
    // Headers survive — the preview still shows WHICH file changed.
    expect(redacted).toContain("+++ b/keys.pem");
  });

  it("suppresses unquoted env literals, and only in the offending file", () => {
    const patch = [
      "--- a/.env",
      "+++ b/.env",
      "@@ -0,0 +1,1 @@",
      "+password=hunter2hunter2",
      "--- a/src/domain/widget.ts",
      "+++ b/src/domain/widget.ts",
      "@@ -1,1 1,2 @@",
      " export const x = 1;",
      "+export const y = 2;",
    ].join("\n");
    const redacted = redactPatchPreview(patch);
    expect(redacted).not.toContain("hunter2hunter2");
    expect(redacted).toContain("+export const y = 2;");
  });

  it("keeps placeholder values visible — they are not secrets", () => {
    const patch = patchFor("src/domain/config.ts", ["const apiKey = process.env.API_KEY;"]);
    expect(redactPatchPreview(patch)).toBe(patch);
  });
});
