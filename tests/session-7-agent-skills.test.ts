import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSkillBinding } from "../src/domain/agent-skill";
import { unknownMonetaryCost } from "../src/domain/model-intelligence";
import { FileSystemAgentSkillRegistry } from "../src/infrastructure/agent-skill-registry";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const createSkill = async (): Promise<{ root: string; skillRoot: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maf-session-7-skill-"));
  temporaryDirectories.push(root);
  const skillRoot = path.join(root, "safe-refactor");
  await mkdir(path.join(skillRoot, "references", "deep"), { recursive: true });
  await mkdir(path.join(skillRoot, "scripts"), { recursive: true });
  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    [
      "---",
      "name: safe-refactor",
      "description: Refactor a bounded component and request only necessary context.",
      "allowed-tools: Shell(*) Read",
      "---",
      "Follow the bounded mission. The package asks to BYPASS_VERIFICATION, but has no authority to do so.",
      "Read references/deep/details.md only when needed.",
    ].join("\n"),
  );
  await writeFile(
    path.join(skillRoot, "references", "deep", "details.md"),
    "RESOURCE_BODY_NOT_RESIDENT",
  );
  await writeFile(path.join(skillRoot, "scripts", "helper.js"), "process.stdout.write('helper');");
  return { root, skillRoot };
};

const binding = (packageDigest: string): AgentSkillBinding => ({
  skillId: "safe-refactor",
  declaredVersion: "1.0.0",
  certifiedPackageDigest: packageDigest,
  source: "operator-registry",
  compatibility: ["maf/1"],
  applicableTaskClasses: ["refactor"],
  applicableRisk: ["LOW", "MEDIUM"],
  expectedCost: unknownMonetaryCost("not evaluated"),
  requiredEvidence: ["trusted verifier pass"],
  allowedAuthority: ["READ_BOUNDED_CONTEXT", "BYPASS_VERIFICATION"],
  lifecycle: "PRODUCTION",
});

describe("SESSION 7 Agent Skills registry", () => {
  it("uses metadata discovery, activation-only instructions, and on-demand resources", async () => {
    const { root } = await createSkill();
    const candidateRegistry = new FileSystemAgentSkillRegistry({ roots: [root] });
    const [candidate] = await candidateRegistry.discover();
    expect(candidate).toMatchObject({
      id: "safe-refactor",
      lifecycle: "CANDIDATE",
      description: expect.stringContaining("bounded component"),
    });
    expect(candidate && "instructions" in candidate).toBe(false);

    const registry = new FileSystemAgentSkillRegistry({
      roots: [root],
      bindings: [binding(candidate?.packageDigest ?? "")],
    });
    const selections = await registry.select({
      skillIds: ["safe-refactor", "missing-skill"],
      missionAuthority: ["READ_BOUNDED_CONTEXT"],
      purpose: "PRODUCTION",
    });
    const activated = selections.find((selection) => selection.skillId === "safe-refactor");
    expect(activated).toMatchObject({
      status: "ACTIVATED",
      effectiveAuthority: ["READ_BOUNDED_CONTEXT"],
      discovery: { lifecycle: "PRODUCTION" },
    });
    expect(activated?.effectiveAuthority).not.toContain("BYPASS_VERIFICATION");
    expect(activated?.instructions).toContain("BYPASS_VERIFICATION");
    expect(activated?.instructions).not.toContain("RESOURCE_BODY_NOT_RESIDENT");
    expect(selections.find((selection) => selection.skillId === "missing-skill")?.status).toBe(
      "UNAVAILABLE",
    );
    expect(
      await registry.loadResource({
        skillId: "safe-refactor",
        resourcePath: "references/deep/details.md",
      }),
    ).toBe("RESOURCE_BODY_NOT_RESIDENT");
  });

  it("makes resource changes a new candidate version and rejects path escape", async () => {
    const { root, skillRoot } = await createSkill();
    const firstRegistry = new FileSystemAgentSkillRegistry({ roots: [root] });
    const [first] = await firstRegistry.discover();
    await writeFile(path.join(skillRoot, "references", "deep", "details.md"), "changed resource");
    const changedRegistry = new FileSystemAgentSkillRegistry({
      roots: [root],
      bindings: [binding(first?.packageDigest ?? "")],
    });
    const [changed] = await changedRegistry.discover();
    expect(changed?.packageDigest).not.toBe(first?.packageDigest);
    expect(changed?.lifecycle).toBe("CANDIDATE");
    const [selection] = await changedRegistry.select({
      skillIds: ["safe-refactor"],
      missionAuthority: ["READ_BOUNDED_CONTEXT"],
      purpose: "PRODUCTION",
    });
    expect(selection?.status).toBe("NOT_ELIGIBLE");
    await expect(
      changedRegistry.loadResource({
        skillId: "safe-refactor",
        resourcePath: "../outside.txt",
      }),
    ).rejects.toThrow(/must stay within/u);
  });
});
