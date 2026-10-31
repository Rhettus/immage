// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';

const commands = [];
globalThis.__perfCommands = commands;
registerHooks({ resolve(spec, ctx, next) {
  if (spec === '@tauri-apps/api/core') return { shortCircuit:true, url:'data:text/javascript,' + encodeURIComponent(
    'export function invoke(command,args){globalThis.__perfCommands.push({command,args});if(command==="perf_trace_stop"&&globalThis.__perfBlockStop)return globalThis.__perfBlockStop;return Promise.resolve(command==="perf_modules"?[]:{});}') };
  if (spec.startsWith('./')) {
    const url = new URL(spec + '.ts', ctx.parentURL);
    if (existsSync(url)) return next(url.href, ctx);
  }
  return next(spec, ctx);
} });
globalThis.localStorage = { getItem:()=>null, setItem:()=>{} };
let serial = 0;
const callbacks = new Map();
globalThis.window = {
  requestAnimationFrame(fn) { const id=++serial; callbacks.set(id,fn); return id; },
  cancelAnimationFrame(id) { callbacks.delete(id); },
};
const { perf } = await import('../app/src/perf.ts');
function flush() { const batch=[...callbacks.values()];callbacks.clear();for(const fn of batch)fn(performance.now()); }

test('coalesced native frame retains input identities and dispatch phase through drawing', async t => {
  let now=10; t.mock.method(performance,'now',()=>now);
  const stop = await perf.startMeasurement(true);
  try {
    perf.recording=[]; perf.label='exposure drag';
    perf.input('exposure'); now=20; perf.input('exposure'); now=30;
    const cycle=perf.cycle();
    const requestId=perf.request({kind:'edit',blockingPump:true,...cycle.diagnostic});
    now=40; perf.finish(requestId);
    const trace=perf.rendered({...cycle,diagnostic:perf.frame({...cycle.diagnostic,requestId},'native'),
      kind:'edit',draft:true,setEnd:30,r0:30,width:1,height:1},new ArrayBuffer(64));
    perf.label='exposure release'; now=50; perf.drawStart(trace); now=55; perf.drawEnd();
    now=60; flush();
    const sample=perf.recording[0];
    assert.equal(sample.diagnostic.label,'exposure drag');
    assert.equal(sample.label,'exposure release'); // preserve legacy sample label semantics
    assert.equal(sample.latestInputLatency,40);
    assert.equal(sample.oldestInputLatency,50);
    assert.equal(sample.total,50);
    const events=perf.diagnosticReport().events;
    const inputs=events.filter(e=>e.name==='input');
    assert.equal(sample.diagnostic.firstInputId,inputs[0].id);
    assert.equal(sample.diagnostic.latestInputId,inputs[1].id);
    assert.equal(sample.edits,2);
    assert.equal(commands.find(c=>c.command==='perf_modules').args.request,requestId);
    assert.equal(events.find(e=>e.name==='render.end').id,requestId);
    assert.equal(events.find(e=>e.name==='frame.raf').data.frameId,sample.diagnostic.frameId);
  } finally { perf.recording=null; perf.label=''; stop(); }
  assert.equal(callbacks.size,0);
});

test('diagnostics can be disabled while existing benchmark timings remain enabled', async () => {
  const stop=await perf.startMeasurement(false);
  try {
    perf.input('exposure');
    assert.equal(perf.request({kind:'edit'}),undefined);
    await perf.command('save');
    assert.equal(perf.cycle().edits,1);
    assert.equal(perf.diagnosticReport().enabled,false);
    assert.deepEqual(perf.diagnosticReport().events,[]);
    assert.deepEqual(perf.diagnosticReport().capabilities,[]);
    assert.equal(commands.at(-1).command,'save');
  } finally { stop(); }
  assert.equal(callbacks.size,0);
});


test('late animation callbacks from a prior measurement cannot enter the next recording', async () => {
  const stop=await perf.startMeasurement(true);
  const frame=perf.cached(1,1);
  perf.drawStart(frame); perf.drawEnd(); stop();
  const stopNext=await perf.startMeasurement(true);
  try {
    perf.recording=[];
    flush();
    assert.deepEqual(perf.recording,[]);
    assert.equal(perf.diagnosticReport().events.some(e=>e.name==='frame.raf'),false);
  } finally { perf.recording=null; stopNext(); }
});


test('a new recording waits for prior native shutdown before restarting instrumentation', async () => {
  const stop=await perf.startMeasurement(true);
  let release;
  globalThis.__perfBlockStop=new Promise(resolve=>{release=resolve;});
  stop();
  const before=commands.length;
  const starting=perf.startMeasurement(true);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(commands.slice(before).some(c=>c.command==='perf_trace_start'),false);
  globalThis.__perfBlockStop=null; release();
  const stopNext=await starting;
  assert.equal(commands.at(-1).command,'perf_trace_start');
  stopNext();
});
