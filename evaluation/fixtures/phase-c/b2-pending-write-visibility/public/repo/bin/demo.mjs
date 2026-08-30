import { createCommitStore } from "../src/commit-store.mjs";
const store = createCommitStore();
const tx = store.begin("job-1", "ready");
console.log(store.read("job-1") ?? "pending");
store.commit(tx);
console.log(store.read("job-1"));
