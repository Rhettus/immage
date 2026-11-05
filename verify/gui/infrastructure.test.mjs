// SPDX-License-Identifier: GPL-3.0-or-later
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from './support/journal.mjs';
import {sampleProcesses,parseProcessStat} from './support/process-memory.mjs';
import {encodePNG,decodePNG,comparePixels} from './support/pixels.mjs';
import {cases,resolveCases} from './suites.mjs';
import {implementationFor} from './registry.mjs';
import {hiddenPanelCoverage} from './generated.mjs';
const temp=()=>mkdtempSync(join(tmpdir(),'immage-gui-unit-'));
test('every declared GUI case resolves to an implementation, without executing it',()=>{
 for(const name of Object.keys(cases))assert.equal(typeof implementationFor(name),'function',name);
 assert.equal(new Set(resolveCases('all')).size,Object.keys(cases).length);
 for(const name of ['toString','__proto__','missing'])assert.throws(()=>resolveCases(name));
});
test('hidden panels have no generated control cases; each names its written case',()=>{
 const inventory=JSON.parse(readFileSync(new URL('./inventory.json',import.meta.url),'utf8'));
 const hidden=inventory.panels.filter(p=>p.hidden).map(p=>p.id);
 assert.deepEqual([...hidden].sort(),Object.keys(hiddenPanelCoverage).sort());
 for(const id of hidden){
  assert.equal(Object.keys(cases).filter(n=>n.startsWith(`control-${id}-`)).length,0,id);
  const written=hiddenPanelCoverage[id];
  if(written!==null)assert.ok(cases[written],`${id} -> ${written}`);
 }
});
test('journal retains a valid checkpoint and ordered events after abrupt child death',()=>{
 const directory=temp();try{
  const script=`import {Journal} from ${JSON.stringify(new URL('./support/journal.mjs',import.meta.url).href)};const j=new Journal(${JSON.stringify(directory)});j.checkpoint({status:'running',cases:[{name:'one',status:'pass'}]});j.event('case-start',{name:'two'});process.kill(process.pid,'SIGKILL');`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script]);assert.equal(result.signal,'SIGKILL');
  assert.equal(JSON.parse(readFileSync(join(directory,'report.json'))).status,'running');
  assert.equal(JSON.parse(readFileSync(join(directory,'events.jsonl'),'utf8').trim()).data.name,'two');
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('journal atomically replaces snapshots rather than concatenating JSON',()=>{
 const directory=temp();try{const j=new Journal(directory);j.checkpoint({status:'running'});j.checkpoint({status:'failure',error:'test'});j.close();assert.equal(JSON.parse(readFileSync(join(directory,'report.json'))).status,'failure');}finally{rmSync(directory,{recursive:true,force:true});}
});
function stat(pid,ppid,name){const fields=Array(22).fill('0');fields[0]='S';fields[1]=String(ppid);fields[2]='123';fields[19]='500';return`${pid} (${name}) ${fields.join(' ')}`;}
test('process stat handles spaces and closing parentheses in names',()=>{
 const p=parseProcessStat(stat(12,1,'engine ) name'));assert.equal(p.name,'engine ) name');assert.equal(p.ppid,1);assert.equal(p.started,'500');
});
test('memory sampling includes descendants but excludes unrelated processes',async()=>{
 const directory=temp();try{
  for(const [pid,ppid,name] of [[12,1,'driver'],[13,12,'app'],[14,13,'engine'],[15,1,'unrelated']]){
   const d=join(directory,String(pid));mkdirSync(d);writeFileSync(join(d,'stat'),stat(pid,ppid,name));writeFileSync(join(d,'status'),'VmRSS: 10 kB\nVmHWM: 12 kB\nVmSwap: 3 kB\n');writeFileSync(join(d,'smaps_rollup'),'Pss: 7 kB\n');
  }
  const s=await sampleProcesses(12,directory);assert.deepEqual(s.processes.map(p=>p.pid).sort(),[12,13,14]);assert.equal(s.rssSum,30*1024);assert.equal(s.swapSum,9*1024);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
const image=(width=20,height=20)=>({width,height,rgba:Buffer.alloc(width*height*4,255)});
test('PNG codec round trips RGBA screenshot pixels',()=>{const a=image();a.rgba[7]=123;const b=decodePNG(encodePNG(a));assert.deepEqual(b,a);});
test('PNG CRC corruption is rejected',()=>{const png=encodePNG(image());png[45]^=1;assert.throws(()=>decodePNG(png));});
test('visual comparison catches a moved control and produces a PNG diff',()=>{
 const a=image(),b=image();for(let y=3;y<9;y++)for(let x=3;x<9;x++)b.rgba[(y*20+x)*4]=0;
 const result=comparePixels(a,b);assert(!result.pass);assert.equal(result.changed,36);assert.equal(decodePNG(encodePNG(result.diff)).width,20);
});
test('visual tolerances, masks, regions and size mismatches are explicit',()=>{
 const a=image(),b=image();b.rgba[0]=250;assert(comparePixels(a,b).pass);
 b.rgba[0]=0;assert(comparePixels(a,b,{exclude:[{x:0,y:0,width:1,height:1}]}).pass);
 assert.throws(()=>comparePixels(a,b,{region:{x:0,y:0,width:0,height:1}}));
 assert.throws(()=>comparePixels(a,image(21,20)));
});
test('process sampler rejects a reused root PID before collecting its memory',async()=>{
 const directory=temp();try{const d=join(directory,'12');mkdirSync(d);writeFileSync(join(d,'stat'),stat(12,1,'different'));const s=await sampleProcesses(12,directory,'earlier-start');assert(s.identityLost);assert.equal(s.processes.length,0);}finally{rmSync(directory,{recursive:true,force:true});}
});
