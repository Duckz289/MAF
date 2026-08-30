import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseCBand3Graders } from "../graders-band3.mjs";

await runBehavioralGrader(
  "notification-settings-regression",
  phaseCBand3Graders["notification-settings-regression"],
);
