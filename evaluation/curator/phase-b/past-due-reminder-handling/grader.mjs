import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseBGraders } from "../graders.mjs";

await runBehavioralGrader(
  "past-due-reminder-handling",
  phaseBGraders["past-due-reminder-handling"],
);
