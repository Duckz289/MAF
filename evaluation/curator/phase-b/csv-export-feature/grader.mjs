import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseBGraders } from "../graders.mjs";

await runBehavioralGrader("csv-export-feature", phaseBGraders["csv-export-feature"]);
