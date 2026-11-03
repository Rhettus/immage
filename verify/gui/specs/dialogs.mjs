// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click,reveal,inspect, openTool } from '../support/controls.mjs';
import { textButton,choose,panel,Blocked } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

export async function preferencesMatrix(t) {
  // Only controls with local effects. Never press relaunch, benchmarks, downloads,
  // external links, credential/service actions, native color/file dialogs.
  const unsafe=new Set(['Window renderer','Edit on the GPU','GPU','Device','Shared-memory frames','Check automatically']);
  await click(t,'button[data-tour="prefs"]');
  for(const tab of ['New Photos','General','Performance']) {
    await textButton(t,'.prefs-tabs',tab);
    const labels=await t.driver.observe(()=>[...document.querySelectorAll('.prefs [data-pref-label]')].map(e=>e.dataset.prefLabel));
    for(const label of labels) {
      const row=`.prefs [data-pref-label=${JSON.stringify(label)}]`;
      if(unsafe.has(label)){t.measure({name:label,status:'blocked',reason:'hardware/restart/network prerequisite'});continue;}
      const checkbox=await t.driver.observe(s=>!!document.querySelector(`${s} input[type=checkbox]`),row);
      const select=await t.driver.observe(s=>!!document.querySelector(`${s} select`),row);
      if(checkbox){
        const selector=`${row} input[type=checkbox]`,before=await reveal(t,selector);
        if(before.disabled){t.measure({name:label,status:'blocked',reason:'disabled prerequisite'});continue;}
        await click(t,selector);assert.equal((await t.driver.observe(inspect,selector)).checked,!before.checked);await t.evidence(`${tab}-${labels.indexOf(label)}-toggle`);await click(t,selector);
      }else if(select){
        const selector=`${row} select`,before=await reveal(t,selector);
        if(before.disabled)continue;
        for(const o of before.options.filter(o=>!o.disabled)){await choose(t,selector,o.value);await t.evidence(`${tab}-${labels.indexOf(label)}-${o.value.replace(/[^a-z0-9]/gi,'-')}`);}
        await choose(t,selector,before.value);
      }else{
        const selectors=await t.driver.observe(s=>[...document.querySelectorAll(`${s} .segmented button, ${s} .pref-swatches button`)].map(e=>({text:e.textContent.trim(),aria:e.getAttribute('aria-label')})),row);
        for(const o of selectors){if(o.aria)await click(t,`${row} button[aria-label=${JSON.stringify(o.aria)}]`);else await textButton(t,`${row} .segmented`,o.text);await t.evidence(`${tab}-${labels.indexOf(label)}-${selectors.indexOf(o)}`);}
      }
    }
  }
  await textButton(t,'.prefs-foot','Done');
}
export async function sliderWheel(t) {
  await click(t,'button[data-tour="prefs"]');await textButton(t,'.prefs-tabs','General');
  const toggle='.prefs [data-pref-label="Scroll adjusts sliders"] input[type=checkbox]';
  if((await reveal(t,toggle)).checked)await click(t,toggle);
  await textButton(t,'.prefs-foot','Done');await panel(t,'basic');
  const selector='[data-control-id="exposure"] input[type=range]';let s=await reveal(t,selector);
  const before=+s.value;await t.driver.wheel(s.x,s.y,-40);
  assert.equal(+(await t.driver.observe(inspect,selector)).value,before,'wheel off scrolls rather than changes value');
  await click(t,'button[data-tour="prefs"]');await textButton(t,'.prefs-tabs','General');await click(t,toggle);await textButton(t,'.prefs-foot','Done');
  s=await reveal(t,selector);await t.driver.wheel(s.x,s.y,-40);
  await until(async()=>+(await t.driver.observe(inspect,selector)).value!==before,'enabled wheel changes Exposure');
  await settledPhoto(t);await t.evidence('wheel-enabled');
}
export async function exportOptions(t) {
  await click(t,'button[data-tour="export"]');
  await until(()=>t.driver.observe(()=>!!document.querySelector('.modal.export')),'export dialog');
  const sections=await t.driver.observe(()=>[...document.querySelectorAll('.export-section-head .title')].map(e=>e.textContent));
  for(const title of sections){
    const open=await t.driver.observe(title=>[...document.querySelectorAll('.export-section')].find(e=>e.querySelector('.title')?.textContent===title)?.classList.contains('open'),title);
    const section=`[data-export-section=${JSON.stringify(title)}]`;
    if(!open)await click(t,`${section} > .export-section-head`);
    const seen=new Set();
    for(let pass=0;pass<30;pass++) {
      const fields=await t.driver.observe(s=>[...document.querySelectorAll(`${s} select[data-export-field]`)].map(e=>e.dataset.exportField),section);
      const field=fields.find(f=>!seen.has(f));if(!field)break;seen.add(field);
      const selector=`${section} select[data-export-field="${field}"]`,menu=await reveal(t,selector);
      if(menu.disabled)continue;
      for(const option of menu.options.filter(o=>!o.disabled)) {
        if(option.value.startsWith('ai')){t.measure({name:option.label,status:'blocked',reason:'AI model/hardware prerequisite'});continue;}
        await choose(t,selector,option.value);
        await t.evidence(`export-${field}-${option.value.replace(/[^a-z0-9]/gi,'-')}`);
      }
      await choose(t,selector,menu.value);
    }
  }
  // Settings and preview only: never native destination chooser or external editor.
  await textButton(t,'.export .modal-foot','Cancel');
}
export async function filters(t) {
  await click(t,'.kind-button');
  const categories=await t.driver.observe(()=>[...document.querySelectorAll('.filter-cat .name')].map(e=>e.textContent));
  assert(categories.length>0);
  for(const name of categories){
    const point=await until(()=>t.driver.observe(name=>{const e=[...document.querySelectorAll('.filter-cat')].find(e=>e.querySelector('.name')?.textContent===name);if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};},name),'filter category');
    await t.driver.point(point.x,point.y);
    const shown=await t.driver.observe(()=>document.querySelector('.filter-pane h3')?.textContent);assert.equal(shown,name);
    await t.evidence(`filter-${categories.indexOf(name)}`);
  }
  await t.driver.keys('\uE00C');
}
export async function presets(t) {
  const baseline=await settledPhoto(t);await openTool(t,'presets');
  const tiles=await t.driver.observe(()=>[...document.querySelectorAll('.tile')].map(e=>e.title));
  if(!tiles.length)throw new Blocked('No expanded preset tiles; requires a preset fixture/group');
  for(const name of tiles){
    const selector=`.tile[title=${JSON.stringify(name)}]`;const p=await reveal(t,selector);await t.driver.point(p.x,p.y);
    await settledPhoto(t);await t.evidence(`preset-${tiles.indexOf(name)}`);
  }
  await openTool(t,'adjust');await click(t,'button[aria-label="reset all"]');await settledPhoto(t,p=>p.hash===baseline.hash);
}
export async function shortcuts(t){await click(t,'button[title^="keyboard shortcuts"]');await reveal(t,'.shortcuts');await t.evidence('shortcuts');await textButton(t,'.shortcuts .modal-foot','Done');}
