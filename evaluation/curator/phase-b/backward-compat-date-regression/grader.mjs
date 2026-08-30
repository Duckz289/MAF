import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseBGraders } from "../graders.mjs";

await runBehavioralGrader(
  "backward-compat-date-regression",
  phaseBGraders["backward-compat-date-regression"],
);
