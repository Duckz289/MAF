import { describe, expect, it } from "vitest";

import {
  deriveSecurityPosture,
  redactPatchPreview,
  redactSensitiveData,
  redactSensitiveText,
} from "../src/domain/security";

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
      ["AWS temporary key", 'const key = "ASIAIOSFODNN7EXAMPLE";'],
      ["GitHub token", 'const t = "ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE";'],
      ["private key", "-----BEGIN RSA PRIVATE KEY-----"],
      ["encrypted private key", "-----BEGIN ENCRYPTED PRIVATE KEY-----"],
    ] as const) {
      const result = deriveSecurityPosture(patchFor("src/config/prod.ts", [line]));
      expect(result.state, name).toBe("FAIL");
      expect(result.findings[0]).toContain("src/config/prod.ts");
      // The matched value must never appear in full in the harness's own evidence.
      expect(result.findings.join(" ")).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(result.findings.join(" ")).not.toContain("ASIAIOSFODNN7EXAMPLE");
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
    const patch = patchFor("src/domain/auth-service.ts", [
      'const password = "hunter2hunter2";',
      'const recoveryPassword = "correct horse battery staple";',
    ]);
    const result = deriveSecurityPosture(patch);
    expect(result.state).toBe("WARN");
    expect(result.findings).toHaveLength(2);
    expect(redactPatchPreview(patch)).not.toContain("correct horse battery staple");
    expect(redactSensitiveText('password="correct horse battery staple"')).not.toContain(
      "correct horse battery staple",
    );
  });

  it("warns on UNQUOTED env/yaml credential literals — the quoted form never matches those", () => {
    for (const [name, line] of [
      ["dotenv", "password=hunter2hunter2"],
      ["yaml", "api_key: hunter2hunter2"],
      ["dotenv inline comment", "PASSWORD=hunter2hunter2 # deployed credential"],
      ["exported environment", "export PASSWORD=hunter2hunter2"],
      ["yaml list", "- client_secret: hunter2hunter2"],
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

  it("finds every literal when multiple credential assignments share one line", () => {
    const result = deriveSecurityPosture(
      patchFor("src/config/prod.ts", [
        'password="first-secret-value"; token="second-secret-value";',
      ]),
    );

    expect(result.state).toBe("WARN");
    expect(result.findings).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("first-secret-value");
    expect(JSON.stringify(result)).not.toContain("second-secret-value");
  });

  it("recognizes common client/refresh credential names in camel and snake case", () => {
    const literals = [
      'const clientSecret = "first-secret-value";',
      'const config = { refresh_token: "second-secret-value" };',
    ];
    const result = deriveSecurityPosture(patchFor("src/config/oauth.ts", literals));

    expect(result.state).toBe("WARN");
    expect(result.findings).toHaveLength(2);
    expect(redactSensitiveText(literals.join("\n"))).not.toContain("first-secret-value");
    expect(redactSensitiveText(literals.join("\n"))).not.toContain("second-secret-value");
  });

  it("recognizes template literals, Go short assignments, and YAML block scalars", () => {
    const patch = patchFor("src/config/secrets.yaml", [
      "const password = `correct-horse-battery-staple`;",
      'password := "second-secret-value"',
      "password: |",
      "  third-secret-value",
    ]);
    const result = deriveSecurityPosture(patch);

    expect(result.state).toBe("WARN");
    expect(result.findings).toHaveLength(3);
    const preview = redactPatchPreview(patch);
    expect(preview).not.toContain("correct-horse-battery-staple");
    expect(preview).not.toContain("second-secret-value");
    expect(preview).not.toContain("third-secret-value");
    const text = redactSensitiveText(
      [
        "const password = `correct-horse-battery-staple`;",
        'password := "second-secret-value"',
        "password: |",
        "  third-secret-value",
      ].join("\n"),
    );
    expect(text).not.toContain("correct-horse-battery-staple");
    expect(text).not.toContain("second-secret-value");
    expect(text).not.toContain("third-secret-value");
  });

  it("recognizes separator-delimited credential namespaces without matching unrelated words", () => {
    const literals = [
      "DATABASE_PASSWORD=first-secret-value",
      "OPENAI_API_KEY=second-secret-value",
      "AWS_SECRET_ACCESS_KEY=third-secret-value",
      '"database_password": "fourth-secret-value"',
      "db.password=fifth-secret-value",
      "DB__PASSWORD=sixth-secret-value",
      'const dbPassword = "seventh-secret-value";',
      '"databasePassword": "eighth-secret-value"',
    ];
    const result = deriveSecurityPosture(patchFor(".env.production", literals));

    expect(result.state).toBe("WARN");
    expect(result.findings).toHaveLength(8);
    const redacted = redactSensitiveText(literals.join("\n"));
    for (const value of [
      "first",
      "second",
      "third",
      "fourth",
      "fifth",
      "sixth",
      "seventh",
      "eighth",
    ]) {
      expect(redacted).not.toContain(`${value}-secret-value`);
    }
    expect(
      deriveSecurityPosture(patchFor("src/text.ts", ['const tokenizer = "ordinary-value";'])).state,
    ).toBe("PASS");
  });

  it("keeps binary diffs explicitly NOT_CHECKED instead of claiming a zero-line PASS", () => {
    const patch = [
      "diff --git a/assets/credential.bin b/assets/credential.bin",
      "new file mode 100644",
      "index 0000000..1234567",
      "--- /dev/null",
      "+++ b/assets/credential.bin",
      "GIT binary patch",
      "literal 32",
      "zcmeAS@N?(olHy`uVBq!ia0vp^0wB1",
    ].join("\n");

    const result = deriveSecurityPosture(patch);

    expect(result.state).toBe("NOT_CHECKED");
    expect(result.evidence.join(" ")).toContain("binary");
    expect(result.evidence.join(" ")).not.toContain("no credential or secret patterns");
  });

  it("keeps gitlink and rename-only destination content NOT_CHECKED", () => {
    for (const [name, patch] of [
      [
        "gitlink",
        [
          "diff --git a/vendor/sdk b/vendor/sdk",
          "new file mode 160000",
          "index 0000000..1234567",
          "--- /dev/null",
          "+++ b/vendor/sdk",
          "@@ -0,0 +1 @@",
          "+Subproject commit 1234567890abcdef1234567890abcdef12345678",
        ].join("\n"),
      ],
      [
        "rename",
        [
          "diff --git a/tests/fixtures/key.pem b/src/config/key.pem",
          "similarity index 100%",
          "rename from tests/fixtures/key.pem",
          "rename to src/config/key.pem",
        ].join("\n"),
      ],
    ] as const) {
      const result = deriveSecurityPosture(patch);
      expect(result.state, name).toBe("NOT_CHECKED");
      expect(result.evidence.join(" ")).toContain("destination");
    }
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

  it("suppresses consecutive private-key files without leaking matcher state between files", () => {
    const patch = [
      "--- /dev/null",
      "+++ b/first-key.pem",
      "@@ -0,0 +1,3 @@",
      "+-----BEGIN RSA PRIVATE KEY-----",
      "+FIRST-PRIVATE-KEY-BODY-which-has-no-standalone-secret-signature",
      "+-----END RSA PRIVATE KEY-----",
      "--- /dev/null",
      "+++ b/second-key.pem",
      "@@ -0,0 +1,3 @@",
      "+-----BEGIN RSA PRIVATE KEY-----",
      "+SECOND-PRIVATE-KEY-BODY-which-has-no-standalone-secret-signature",
      "+-----END RSA PRIVATE KEY-----",
    ].join("\n");

    const redacted = redactPatchPreview(patch);

    expect(redacted).not.toContain("FIRST-PRIVATE-KEY-BODY");
    expect(redacted).not.toContain("SECOND-PRIVATE-KEY-BODY");
    expect(redacted.match(/credential-shaped line suppressed/gu)).toHaveLength(6);
  });

  it("suppresses encrypted private-key bodies and binary patch payloads", () => {
    const encrypted = patchFor("encrypted.pem", [
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
      "ENCRYPTED-PRIVATE-KEY-BODY-with-no-standalone-signature",
      "-----END ENCRYPTED PRIVATE KEY-----",
    ]);
    const binary = [
      "diff --git a/assets/credential.bin b/assets/credential.bin",
      "new file mode 100644",
      "index 0000000..1234567",
      "--- /dev/null",
      "+++ b/assets/credential.bin",
      "GIT binary patch",
      "literal 32",
      "REVERSIBLE-BINARY-PATCH-PAYLOAD",
    ].join("\n");

    expect(redactPatchPreview(encrypted)).not.toContain("ENCRYPTED-PRIVATE-KEY-BODY");
    const redactedBinary = redactPatchPreview(binary);
    expect(redactedBinary).not.toContain("REVERSIBLE-BINARY-PATCH-PAYLOAD");
    expect(redactedBinary).not.toContain("GIT binary patch");
    expect(redactedBinary).toContain("uninspectable binary patch payload suppressed");
  });

  it("fails closed on binary payloads whose Git header cannot be attributed", () => {
    const patch = String.raw`diff --git "a/assets/\303\251.bin" "b/assets/\303\251.bin"
new file mode 100644
GIT binary patch
literal 24
REVERSIBLE-QUOTED-BINARY-PAYLOAD`;

    expect(deriveSecurityPosture(patch).state).toBe("NOT_CHECKED");
    const redacted = redactPatchPreview(patch);
    expect(redacted).not.toContain("REVERSIBLE-QUOTED-BINARY-PAYLOAD");
    expect(redacted).not.toContain("GIT binary patch");
    expect(redacted).toContain("uninspectable binary patch payload suppressed");
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

  it("is deterministic across private-key and clean-file call ordering", () => {
    const privateKeyPatch = patchFor("private.pem", [
      "-----BEGIN PRIVATE KEY-----",
      "ORDER-INDEPENDENT-PRIVATE-KEY-BODY",
      "-----END PRIVATE KEY-----",
    ]);
    const cleanPatch = patchFor("src/domain/widget.ts", ["export const clean = true;"]);
    const expectedPrivate = redactPatchPreview(privateKeyPatch);

    expect(redactPatchPreview(cleanPatch)).toBe(cleanPatch);
    expect(redactPatchPreview(privateKeyPatch)).toBe(expectedPrivate);
    expect(redactPatchPreview(privateKeyPatch)).toBe(expectedPrivate);
    expect(redactPatchPreview(cleanPatch)).toBe(cleanPatch);
    expect(expectedPrivate).not.toContain("ORDER-INDEPENDENT-PRIVATE-KEY-BODY");
  });
});

describe("redactSensitiveData (M8 persistence boundary)", () => {
  it("suppresses a complete private-key block, including its unsigned body", () => {
    const privateKey = [
      "verifier output before key",
      "-----BEGIN PRIVATE KEY-----",
      "EVENT-PRIVATE-KEY-BODY-WITH-NO-STANDALONE-SIGNATURE",
      "-----END PRIVATE KEY-----",
      "verifier output after key",
    ].join("\n");

    const serialized = JSON.stringify(redactSensitiveData({ output: privateKey }));

    expect(serialized).not.toContain("EVENT-PRIVATE-KEY-BODY");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).toContain("REDACTED PRIVATE KEY");
    expect(serialized).toContain("verifier output before key");
    expect(serialized).toContain("verifier output after key");
  });

  it("suppresses an encrypted private-key block, including its unsigned body", () => {
    const serialized = JSON.stringify(
      redactSensitiveData({
        output: [
          "-----BEGIN ENCRYPTED PRIVATE KEY-----",
          "ENCRYPTED-EVENT-PRIVATE-KEY-BODY",
          "-----END ENCRYPTED PRIVATE KEY-----",
        ].join("\r\n"),
      }),
    );

    expect(serialized).not.toContain("ENCRYPTED-EVENT-PRIVATE-KEY-BODY");
    expect(serialized).not.toContain("BEGIN ENCRYPTED PRIVATE KEY");
    expect(serialized).toContain("REDACTED PRIVATE KEY");
  });

  it("redacts generic credential assignments in untrusted strings but preserves placeholders", () => {
    const serialized = JSON.stringify(
      redactSensitiveData({
        output: [
          "password=hunter2hunter2 # deployed credential",
          'password="first-secret-value"; token="second-secret-value";',
          "export PASSWORD=third-secret-value",
          "- client_secret: fourth-secret-value",
          'const clientSecret = "fifth-secret-value";',
          'refresh_token: "sixth-secret-value"',
          "api_key=$" + "{API_KEY}",
        ].join("\r\n"),
      }),
    );

    expect(serialized).not.toContain("hunter2hunter2");
    expect(serialized).not.toContain("first-secret-value");
    expect(serialized).not.toContain("second-secret-value");
    expect(serialized).not.toContain("third-secret-value");
    expect(serialized).not.toContain("fourth-secret-value");
    expect(serialized).not.toContain("fifth-secret-value");
    expect(serialized).not.toContain("sixth-secret-value");
    expect(serialized).toContain("$" + "{API_KEY}");
  });

  it("preserves only validated credential references and known capability labels", () => {
    const redacted = redactSensitiveData({
      credentialReference: "UNSTRUCTURED-PROVIDER-SECRET-9f8e7d6c5b4a",
      credentialReferences: ["credential://owner/safe", "raw-provider-secret"],
      validCredentialReference: "credential://owner/safe",
      credentialCapability: "REFERENCE_ONLY",
      invalidCredentialCapability: "raw-provider-secret",
    });

    expect(redacted).toEqual({
      credentialReference: "[REDACTED]",
      credentialReferences: "[REDACTED]",
      validCredentialReference: "credential://owner/safe",
      credentialCapability: "REFERENCE_ONLY",
      invalidCredentialCapability: "[REDACTED]",
    });
  });
});
