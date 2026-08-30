import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseBGraders } from "../graders.mjs";

await runBehavioralGrader(
  "webhook-retry-terminal-state",
  phaseBGraders["webhook-retry-terminal-state"],
);
