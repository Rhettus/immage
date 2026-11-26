// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click, reveal, inspect, rangeSelector } from '../support/controls.mjs';
import { panel, expandSections, textButton, Blocked } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

const exposure = rangeSelector('exposure');
const cell = name => `.filmstrip .thumb[title=${JSON.stringify(name)}]`;
async function value(t, expected) {
  await panel(t,'basic');
  await until(async()=>Math.abs(+(await t.driver.observe(inspect,exposure)).value-expected)<.02,`Exposure ${expected}`);
}
async function typeValue(t, id, v) {
  const basic=await panel(t,'basic');await expandSections(t,basic);
  // a fold just opened above can still be pushing the number down: aim once it is still
  let last=null;
  const p=await until(async()=>{const c=await reveal(t,`[data-control-id="${id}"] .value`);
    const still=last&&Math.abs(c.y-last.y)<.5;last=c;return still&&c;},`${id} value settled`);
  await t.driver.point(p.x,p.y,2);
  await until(()=>t.driver.observe(id=>!!document.querySelector(`[data-control-id="${id}"] .value-edit`),id),'numeric editor');
  await t.driver.keys(...String(v),'\uE007');
  await until(async()=>Math.abs(+(await t.driver.observe(inspect,rangeSelector(id))).value-v)<.02,`${id} ${v}`);
  await settledPhoto(t);
}
async function presets(t) { await click(t,'.rail button[title="presets"]'); }
async function look(t, name, amount) {
  await presets(t);
  assert.equal(await t.driver.observe(()=>document.querySelector('.look-chip b')?.textContent),name??'none');
  if(name) assert.equal(+(await t.driver.observe(inspect,'.preset-amount input')).value,amount);
  await click(t,'.rail button[title="adjustments"]');
}
async function selected(t) { return t.driver.observe(()=>[...document.querySelectorAll('.filmstrip .thumb.selected')].map(e=>e.dataset.imgid).sort()); }
async function waitDone(t) {
  await until(()=>t.driver.observe(()=>!document.querySelector('[data-batch-paste="busy"]')),'batch completed',120000);
  await settledPhoto(t);
}
export async function batchPaste(t) {
  if(t.fixture.raw) throw new Blocked('batch-paste needs the isolated JPEG fixture');
  for(const name of ['batch-target-1.jpg','batch-target-2.jpg','batch-untouched.jpg'])
    await until(()=>t.driver.observe(s=>!!document.querySelector(s),cell(name)),`imported ${name}`,60000);
  // A preceding case may have edited a target's masks. Compare the
  // untouched photo with its own original rendering, not another target.
  await click(t,cell('batch-untouched.jpg'));
  const untouchedBefore=await settledPhoto(t);
  await click(t,cell(t.fixture.file));await settledPhoto(t);
  await typeValue(t,'exposure',1);
  await presets(t);
  // Open the film group through a real pointer click if it was folded.
  const group=await t.driver.observe(()=>{
    const e=[...document.querySelectorAll('.preset-group-title')].find(e=>e.textContent.includes('Color Negative'));
    if(!e || e.querySelector('.tri.open'))return null;
    const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
  });
  if(group)await t.driver.point(group.x,group.y);
  await click(t,'.tile[title="Kodak Gold 200"]');
  await until(()=>t.driver.observe(()=>document.querySelector('.look-chip b')?.textContent==='Kodak Gold 200'),'Kodak look applied');
  const amount=await reveal(t,'.preset-amount input');
  await t.driver.point(amount.x,amount.y); await t.driver.keys('\uE010',...Array(65).fill('\uE012')); // End, then Left to 35
  await until(async()=>+(await t.driver.observe(inspect,'.preset-amount input')).value===35,'Look amount 35');
  await settledPhoto(t);
  await click(t,'[data-action="copy-settings"]');
  await textButton(t,'.copy-settings','Check None');
  await click(t,'[data-copy-group="basic:Tone"]');
  await click(t,'[data-copy-group="look"]');
  await textButton(t,'.copy-settings .modal-foot','Copy');
  await click(t,'.rail button[title="adjustments"]');
  await click(t,cell('batch-target-2.jpg')); await value(t,0);
  await typeValue(t,'vibrance',17);
  const secondBefore=await settledPhoto(t);
  await click(t,cell('batch-target-1.jpg')); await value(t,0);
  const baseline=await settledPhoto(t);
  const sidecarsBefore=await t.sidecarsNamed();
  const other=await reveal(t,cell('batch-target-2.jpg'));
  const modifier=await t.driver.observe(()=>/Mac/.test(navigator.userAgent)?'\uE03D':'\uE009');
  await t.driver.modifiedPoint(modifier,other.x,other.y);
  const selection=await selected(t);assert.equal(selection.length,2);
  const active=await t.driver.observe(()=>document.querySelector('.filmstrip .thumb.active')?.dataset.imgid);
  await t.evidence('two-selected');
  await click(t,'[data-action="paste-settings"]'); await waitDone(t);await value(t,1);
  assert.deepEqual(await selected(t),selection,'paste preserves selection');
  assert.equal(await t.driver.observe(()=>document.querySelector('.filmstrip .thumb.active')?.dataset.imgid),active,'paste preserves active photo');
  const edited=await settledPhoto(t,p=>p.hash!==baseline.hash);
  await look(t,'Kodak Gold 200',35);await t.evidence('batch-pasted');
  await click(t,'button[title^="undo ("]'); await waitDone(t);await value(t,0);await look(t,null);
  await settledPhoto(t,p=>p.hash===baseline.hash);await t.evidence('batch-undone');
  const undone=await t.sidecarsNamed();
  assert(undone.filter(s=>s.file.startsWith('batch-target-')).every(s=>!s.text.includes('look: Kodak Gold 200')),'undo restores both sidecars');
  await click(t,'button[title^="redo ("]');await waitDone(t);await value(t,1);await look(t,'Kodak Gold 200',35);
  await settledPhoto(t,p=>p.hash===edited.hash);await t.evidence('batch-redone');
  const after=await t.sidecarsNamed();
  assert.equal(after.filter(s=>s.file.startsWith('batch-target-')&&s.text.includes('look: Kodak Gold 200')).length,2,'both selected sidecars contain the look');
  for(const s of sidecarsBefore.filter(s=>!s.file.startsWith('batch-target-')))
    assert.equal(after.find(a=>a.file===s.file)?.text,s.text,'unselected source sidecar stays unchanged');
  await click(t,cell('batch-target-2.jpg'));await value(t,1);await look(t,'Kodak Gold 200',35);
  // the reopened photo's values arrive after its thumbnail is selected
  await until(async()=>+(await t.driver.observe(inspect,rangeSelector('vibrance'))).value===17,'unticked Presence stays unchanged');
  await settledPhoto(t,p=>p.hash!==secondBefore.hash);await t.evidence('second-photo-reopened');
  await click(t,cell('batch-untouched.jpg'));await value(t,0);await look(t,null);
  await settledPhoto(t,p=>p.hash===untouchedBefore.hash);await t.evidence('unselected-photo');
  t.measure({name:'batch-paste',selected:selection,baseline:baseline.hash,pasted:edited.hash,sidecars:after.map(s=>s.file)});

  await click(t,cell(t.fixture.file));
  await settledPhoto(t);
  await typeValue(t,'tint',-100);
  await click(t,'[data-action="copy-settings"]');
  await textButton(t,'.copy-settings','Check None');
  await click(t,'[data-copy-group="basic:White Balance"]');
  const offset=await t.driver.observe(() => {
    const parent=document.querySelector('[data-copy-group="basic:White Balance"]').getBoundingClientRect();
    const child=document.querySelector('.copy-auto-wb input').getBoundingClientRect();
    return document.dir==='rtl' ? parent.right-child.right : child.left-parent.left;
  });
  assert(offset>=16,'Auto on Paste is indented under White Balance');
  assert.equal(await t.driver.observe(() => document.querySelector('.copy-auto-wb input').checked),false);
  await click(t,'.copy-auto-wb input');
  assert.equal(await t.driver.observe(() => document.querySelector('.copy-auto-wb input').checked),true);
  await t.evidence('auto-white-balance-copy-option');
  await textButton(t,'.copy-settings .modal-foot','Copy');

  await click(t,cell('batch-target-1.jpg'));
  const wbBefore=await settledPhoto(t);
  const wbOther=await reveal(t,cell('batch-target-2.jpg'));
  await t.driver.modifiedPoint(modifier,wbOther.x,wbOther.y);
  assert.equal((await selected(t)).length,2);
  const beforeWB=await t.sidecarsNamed();
  await click(t,'[data-action="paste-settings"]');
  await waitDone(t);
  const autoFrame=await settledPhoto(t,p=>p.hash!==wbBefore.hash);
  const tint=+(await t.driver.observe(inspect,rangeSelector('tint'))).value;
  assert(Number.isFinite(tint),'destination tint is visible');
  assert.notEqual(tint,-100,'paste computes tint from the destination');
  const afterWB=await t.sidecarsNamed();
  const targets=beforeWB.filter(s=>s.file.startsWith('batch-target-'));
  assert.equal(targets.length,2);
  // Paste and undo both advance the change timestamp.
  const withoutTimestamp=text=>text.replace(/darktable:change_timestamp="[^"]*"/,'');
  for(const {file,text} of targets) {
    const pasted=afterWB.find(s=>s.file===file);
    assert(pasted,file);
    assert.notEqual(withoutTimestamp(pasted.text),withoutTimestamp(text),file);
  }
  await t.evidence('auto-white-balance-pasted');
  await click(t,'button[title^="undo ("]');
  await waitDone(t);
  await settledPhoto(t,p=>p.hash===wbBefore.hash);
  const undoneWB=await t.sidecarsNamed();
  for(const {file,text} of targets) {
    const undone=undoneWB.find(s=>s.file===file);
    assert(undone,file);
    assert.equal(withoutTimestamp(undone.text),withoutTimestamp(text),file);
  }
  t.measure({name:'auto-white-balance-on-paste',tint,before:wbBefore.hash,after:autoFrame.hash});
}
