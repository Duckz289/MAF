import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseBGraders } from "../graders.mjs";

await runBehavioralGrader(
  "report-output-path-boundary",
  phaseBGraders["report-output-path-boundary"],
);
