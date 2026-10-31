// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureTuner, searchTuner, tunerCandidates, tunerChanges } from '../app/src/performanceTuner.ts';
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

test('measures photo frames per drag, not display refresh or release frames', () => {
  const run = fixture();
  run.samples = run.samples.filter(s => s.at < 4000 || s.at >= 5000 || s.at % 2 === 0);
  const m = measureTuner(fixture());
  assert.equal(m.fps,40); assert.equal(m.latency,50); assert.equal(m.complete,true);
  const slow = fixture(); slow.samples = slow.samples.filter(s => s.at >= 1000 || s.at < 250);
  assert.equal(measureTuner(slow).fps,10);
});
test('missing, sparse or backgrounded data cannot pass verification', () => {
  assert.equal(measureTuner(fixture(1)).complete,false);
  assert.equal(measureTuner({...fixture(),valid:false}).complete,false);
  assert.equal(measureTuner({path:'empty',phases:[],samples:[]}).complete,false);
});
test('starts at full fidelity, stops at the first passing quality, restores originals', async () => {
  const original = {...tunerCandidates()[4],cachedExposure:true};
  let active = original, runs=0;
  const result = await searchTuner(original,{fps:30,latency:100},async s => {active=s;},async () => {runs++;return fixture(runs===1?10:40,runs===1?150:50);},() => {});
  assert.equal(runs,2); assert.equal(result.met,true);
  assert.equal(result.trial.settings.preview,'balanced'); assert.equal(result.trial.settings.balancedSize,1);
  assert.deepEqual(active,original);
});
test('full-quality pass never tests a lower-quality candidate', async () => {
  let runs=0;
  const r=await searchTuner(tunerCandidates()[7],{fps:30,latency:100},async()=>{},async()=>{runs++;return fixture();},()=>{});
  assert.equal(runs,1); assert.equal(r.trial.settings.preview,'quality');
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
test('recommendations explicitly describe cached exposure and preview quality changes', () => {
  assert.ok(tunerChanges({...tunerCandidates()[0],cachedExposure:true},tunerCandidates()[1]).some(s=>s.startsWith('Cached exposure preview: Off')));
});
