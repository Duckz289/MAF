import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseBGraders } from "../graders.mjs";

await runBehavioralGrader("idempotency-key-race", phaseBGraders["idempotency-key-race"]);
