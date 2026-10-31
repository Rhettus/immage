// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import { readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { measureTuner, trimmedMedian, searchTuner, tunerCandidates, tunerChanges } from '../app/src/previewTuning.ts';
import { startTunerWork, stopTunerWork, timeTunerWork } from '../app/src/tunerWorkload.ts';

const fixture = (fps = 40, latency = 50) => {
  const phases = [], samples = [];
  for (let i=0;i<6;i++) {
    const at = i*2000, label = `slider-${i} drag`;
    phases.push({atMs:at,label},{atMs:at+1000,label:`slider-${i} release`});
    for (let n=0;n<fps;n++) samples.push({at:at+10+n*1000/fps,kind:'edit',total:latency,label,modules:[]});
    // release and base renders must not improve drag FPS or inflate drag latency
    samples.push({at:at+1200,kind:'base',total:9000,label:'idle base',modules:[]});
  }
  return {path:'fixture.json',phases,samples,valid:true};
};

test('uses central frame-interval and latency medians, excluding release frames', () => {
  const run=fixture();
  for (let i=0;i<run.samples.length;i+=40) run.samples[i].total=9000;
  const measured=measureTuner(run);
  assert.equal(measured.fps,40);assert.equal(measured.latency,50);assert.equal(measured.complete,true);
  // a single slow slider must not replace the requested median across measured frames
  const slow=fixture();
  slow.samples=slow.samples.filter((s) => s.at>=1000 || s.at<250);
  assert.equal(measureTuner(slow).fps,40);
});
test('trims both deciles and averages the central pair for even samples', () => {
  assert.equal(trimmedMedian([10000,1,2,3,4,5,6,7,8,9]),5.5);
  assert.equal(trimmedMedian([NaN,Infinity,-1,3,5]),4);
  assert.equal(trimmedMedian([]),Infinity);
});
test('75% Balanced is tested between 100% and 50%', () => {
  const candidates=tunerCandidates().filter(s=>!s.cachedDetail);
  assert.deepEqual(candidates.slice(0,3).map((s) => s.balancedSize),[1,0.75,0.5]);
});
test('missing, sparse or backgrounded data cannot pass verification', () => {
  assert.equal(measureTuner(fixture(1)).complete,false);
  assert.equal(measureTuner({...fixture(),valid:false}).complete,false);
  assert.equal(measureTuner({path:'empty',phases:[],samples:[]}).complete,false);
});
test('falls back to native Balanced 100% when adaptive misses targets, restoring originals', async () => {
  const original = {...tunerCandidates()[4],cachedDetail:true};
  let active = original, runs=0;
  const result = await searchTuner(original,{fps:30,latency:100},async s => {active=s;},async () => {runs++;return fixture(runs===1?10:40,runs===1?150:50);},() => {});
  assert.equal(runs,2); assert.equal(result.met,true);
  assert.equal(result.trial.settings.preview,'balanced'); assert.equal(result.trial.settings.balancedSize,1);
  assert.equal(result.trial.settings.cachedDetail,false);
  assert.deepEqual(active,original);
});
test('passing full-size adaptive previews stop the search before native or smaller previews', async () => {
  let runs=0;
  const r=await searchTuner(tunerCandidates()[7],{fps:30,latency:100},async()=>{},async()=>{runs++;return fixture();},()=>{});
  assert.equal(runs,1); assert.equal(r.trial.settings.preview,'balanced');
  assert.equal(r.trial.settings.balancedSize,1); assert.equal(r.trial.settings.smallest,1);
  assert.equal(r.trial.settings.cachedDetail,true);
});
test('latency failure continues search even when FPS passes', async () => {
  let runs=0;
  await searchTuner(tunerCandidates()[0],{fps:30,latency:100},async()=>{},async()=>fixture(40,++runs===1?101:50),()=>{});
  assert.equal(runs,2);
});
test('unreachable targets exhaust a finite search and never report success', async () => {
  let active;
  const original=tunerCandidates()[0];
  const r=await searchTuner(original,{fps:60,latency:50},async s=>{active=s;},async()=>fixture(5,500),()=>{});
  assert.equal(r.met,false);assert.equal(r.trials.length,tunerCandidates().length);assert.deepEqual(active,original);
});
test('failed or invalid trials restore settings and abort', async () => {
  for (const invalid of [false,true]) {
    const original=tunerCandidates()[2];let active;
    await assert.rejects(searchTuner(original,{fps:30,latency:100},async s=>{active=s;},async()=>{if(invalid)return {...fixture(),valid:false};throw Error('report write failed');},()=>{}));
    assert.deepEqual(active,original);
  }
});
test('records only completed work in its own recording', async () => {
  await timeTunerWork('outside',async()=>1);
  startTunerWork();await timeTunerWork('Photo open',async()=>1);
  await assert.rejects(timeTunerWork('failed',async()=>{throw Error('test');}));
  const samples=stopTunerWork();assert.equal(samples.length,2);assert.equal(samples[0].ok,true);assert.equal(samples[1].ok,false);
  assert.deepEqual(stopTunerWork(),[]);
});
test('recommendations explicitly describe cached detail and preview quality changes', () => {
  assert.ok(tunerChanges({...tunerCandidates()[0],cachedDetail:true},tunerCandidates()[1]).some(s=>s.startsWith('Adaptive cached preview: Off')));
});

// TypeScript resolves .ts before .tsx; these must remain distinct on macOS/Windows.
test('frontend module names are unambiguous on case-insensitive filesystems', () => {
  const root = new URL('../app/src/', import.meta.url);
  const seen = new Map();
  for (const path of readdirSync(root, { recursive:true })) {
    if (!/\.tsx?$/.test(path)) continue;
    const key = path.replace(/\.tsx?$/, '').toLowerCase();
    assert.ok(!seen.has(key), `ambiguous modules: ${seen.get(key)} and ${path}`);
    seen.set(key,path);
  }
});


test('full-size previews precede smaller sizes, with adaptive first at each size',()=>{
  const candidates=tunerCandidates();
  assert.deepEqual(candidates.slice(0,2).map(s=>[s.preview,s.balancedSize,s.cachedDetail]),[
    ['balanced',1,true],['balanced',1,false],
  ]);
  assert.equal(new Set(candidates.map(s=>JSON.stringify(s))).size,candidates.length);
  assert.ok(candidates.every(s=>s.preview!=='quality'));
  for(let i=2;i<candidates.length;i+=2) {
    assert.equal(candidates[i].cachedDetail,true);
    assert.ok(candidates[i].balancedSize<1);
    assert.deepEqual(candidates[i+1],{...candidates[i],cachedDetail:false});
  }
});
test('estimated frames alone cannot satisfy tuner verification',()=>{
  const run=fixture();run.samples.forEach(s=>{s.estimated=true;});
  assert.equal(measureTuner(run).complete,false);
});
