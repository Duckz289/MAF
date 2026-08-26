import type { AgentSkillSelection } from "../domain/agent-skill";
import type { MissionContract } from "../domain/mission";
import type { ModelIdentity } from "../domain/model-intelligence";
import { compilePromptArtifact, type PromptArtifact } from "../domain/prompt";
import type { ContextWorkingSet } from "../domain/context-navigation";

export const SESSION_7_PROMPT_TEMPLATE_VERSION = "maf-native-prompt/1";
export const SESSION_7_PROMPT_POLICY_VERSION = "maf-authority-constitution/1";

/** Application boundary: it accepts already-selected Skills and an existing Context OS artifact. */
export class PromptCompiler {
  compile(input: {
    mission: MissionContract;
    skills: AgentSkillSelection[];
    initialContext: string;
    workingSet: ContextWorkingSet;
    executionDirective: string;
    modelTarget: ModelIdentity;
  }): PromptArtifact {
    return compilePromptArtifact({
      ...input,
      templateVersion: SESSION_7_PROMPT_TEMPLATE_VERSION,
      policyVersion: SESSION_7_PROMPT_POLICY_VERSION,
    });
  }
}
