import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseBGraders } from "../graders.mjs";

await runBehavioralGrader("duration-carry-fix", phaseBGraders["duration-carry-fix"]);
