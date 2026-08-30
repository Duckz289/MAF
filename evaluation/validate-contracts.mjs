import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.dirname(fileURLToPath(import.meta.url));
const meta=JSON.parse(await readFile(path.join(root,"contracts","tasks.json"),"utf8"));
const failures=[];
for(const task of meta){const pub=path.join(root,"fixtures",task.phase,task.id,"public"); try{if(!(await stat(path.join(pub,"prompt.md")).catch(()=>null))) failures.push(`${task.id}: prompt`); const files=await readdir(pub,{recursive:true}); if(!files.some(x=>x.endsWith('.mjs'))) failures.push(`${task.id}: source`); for(const f of files){if(/grader|hidden|reference|shortcut|solution|curator|expected/i.test(f)) failures.push(`${task.id}: private filename`); const b=await readFile(path.join(pub,f)).catch(()=>null); if(b?.includes(0)) failures.push(`${task.id}: NUL`); if(b && /hidden grader|expected patch|correct owner/i.test(b.toString())) failures.push(`${task.id}: content leak`)}}catch(e){failures.push(`${task.id}: ${e.message}`)}}
if(failures.length) throw new Error(failures.join('\n')); console.log(JSON.stringify({status:'PASS',label:'NEWLY_AUTHORED_RECONSTRUCTION',phaseB:meta.filter(x=>x.phase==='phase-b').length,phaseC:meta.filter(x=>x.phase==='phase-c').length,total:meta.length}));
