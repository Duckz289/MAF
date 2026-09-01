// Re-exports the real grader invocation helper so CuratorIndependentVerifier (which resolves
// `<evaluationRoot>/lib/curator-runner.mjs` relative to whatever evaluationRoot it is given) can run
// against this dry-run root without duplicating or modifying the frozen implementation.
export { invokeGrader } from "../../../lib/curator-runner.mjs";
