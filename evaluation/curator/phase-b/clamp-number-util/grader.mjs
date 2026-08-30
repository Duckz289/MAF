import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseBGraders } from "../graders.mjs";

await runBehavioralGrader("clamp-number-util", phaseBGraders["clamp-number-util"]);
