import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseBGraders } from "../graders.mjs";

await runBehavioralGrader(
  "inventory-orientation-task",
  phaseBGraders["inventory-orientation-task"],
);
