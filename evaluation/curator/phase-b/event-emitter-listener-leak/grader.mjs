import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseBGraders } from "../graders.mjs";

await runBehavioralGrader(
  "event-emitter-listener-leak",
  phaseBGraders["event-emitter-listener-leak"],
);
