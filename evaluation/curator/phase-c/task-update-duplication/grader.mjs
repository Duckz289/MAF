import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseCBand3Graders } from "../graders-band3.mjs";

await runBehavioralGrader("task-update-duplication", phaseCBand3Graders["task-update-duplication"]);
