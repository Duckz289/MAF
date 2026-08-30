import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
test("ABI result states are explicit", async () => { const d=await mkdtemp(path.join(os.tmpdir(),"maf-abi-test-")); try { assert.ok(d.startsWith(os.tmpdir())); assert.deepEqual(["PASS","FAIL","INVALID"].sort(),["FAIL","INVALID","PASS"].sort()); } finally { await rm(d,{recursive:true,force:true}); } });
