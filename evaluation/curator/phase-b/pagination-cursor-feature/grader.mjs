import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseBGraders } from "../graders.mjs";

await runBehavioralGrader("pagination-cursor-feature", phaseBGraders["pagination-cursor-feature"]);
