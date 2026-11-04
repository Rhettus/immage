// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click,reveal,inspect,openTool } from '../support/controls.mjs';
import { panel,textButton,Blocked,openMaskGroup } from '../support/scenario.mjs';
import { until,pause } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

export async function histogramEndpoints(t){
 if(t.fixture.name!=='endpoints')throw new Blocked('Requires --fixture endpoints');
 // the tone mapper puts the white half near 86%: Exposure at its top clips it
 // to the histogram's last column, and the black half stays in the first
 await panel(t,'basic');const before=await settledPhoto(t),ev=await reveal(t,'[data-control-id="exposure"] input[type=range]');
 await t.driver.point(ev.x,ev.y);await t.driver.keys('\uE010');await settledPhoto(t,p=>p.hash!==before.hash);
 const pixels=await until(()=>t.driver.observe(()=>{
  const c=document.querySelector('.hist-area canvas');if(!c?.width)return null;
  const ctx=c.getContext('2d'),d=ctx.getImageData(0,0,c.width,c.height).data;
  const count=x=>{let n=0;for(let y=0;y<c.height-2;y++){const k=(y*c.width+x)*4;if(d[k+3]>0&&Math.max(d[k],d[k+1],d[k+2])>80)n++;}return n;};
  return{width:c.width,height:c.height,left:count(0),right:count(c.width-1)};
 }),'histogram pixels');
 assert(pixels.left>3&&pixels.right>3,'both endpoint peak columns are visible');t.measure({name:'de6adf7',...pixels});await t.evidence('endpoint-peaks');
}
export async function previewAlignment(t){
 const env=await t.driver.observe(()=>({scale:devicePixelRatio}));
 if(env.scale===1)throw new Blocked('Requires a preconfigured scaled desktop; runner cannot change compositor scale');
 await panel(t,'basic');const selector='[data-control-id="exposure"] input[type=range]';
 const bounds=()=>{
  const c=document.querySelector('canvas.layer.sharp'),draft=document.querySelector('canvas.layer.draft');
  const b=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};return{sharp:b(c),draft:b(draft)};
 };
 const before=await t.driver.observe(bounds),s=await reveal(t,selector);
 await t.driver.drag({x:s.x,y:s.y},{x:s.x+s.bounds.width*.1,y:s.y});await settledPhoto(t);
 const after=await t.driver.observe(bounds);for(const k of ['x','y','width','height'])assert(Math.abs(after.sharp[k]-before.sharp[k])<1,`scaled preview ${k} aligned`);
 t.measure({name:'630672c',before,after,scale:env.scale});await t.evidence('scaled-preview-final');
}
export async function loupeGrid(t){
 await click(t,'button[data-tour="prefs"]');await textButton(t,'.prefs-tabs','General');
 const toggle='[data-pref-label="Detail loupe"] input[type=checkbox]';if(!(await reveal(t,toggle)).checked)await click(t,toggle);
 await textButton(t,'.prefs-foot','Done');await panel(t,'detail');await requireLoupe(t);
 await click(t,'.grid-toggle');
 const count=()=>t.driver.observe(()=>Number(document.documentElement.dataset.loupeFrames??0));
 // Observe an idle interval so a pending preview can drain before comparing.
 await pause(1000);const before=await count();assert(before>0,'loupe must render before grid assertion');await pause(1500);const after=await count();
 assert.equal(after,before,'grid must not deliver more loupe frames after draining');await t.evidence('loupe-grid-paused');
 await click(t,'.grid-toggle');
}
export async function maskLoupe(t){
 await click(t,'button[data-tour="prefs"]');await textButton(t,'.prefs-tabs','General');
 const toggle='[data-pref-label="Detail loupe"] input[type=checkbox]';if(!(await reveal(t,toggle)).checked)await click(t,toggle);
 await textButton(t,'.prefs-foot','Done');
 await openTool(t,'masks');await click(t,'.create-mask');await textButton(t,'.shape-menu-list','Brush');
 const svg=await reveal(t,'svg.mask-svg');
 await t.driver.drag({x:svg.x-svg.bounds.width*.1,y:svg.y},{x:svg.x+svg.bounds.width*.1,y:svg.y});
 await until(()=>t.driver.observe(()=>document.querySelectorAll('.mask-list > li').length>0),'brush mask created');
 await openMaskGroup(t,'Presence');
 const loupe='.masks-panel [data-mask-group="Presence"] ~ * .detail-loupe';
 await until(()=>t.driver.observe(s=>{const c=document.querySelector(`${s} canvas`);return c?.width>0&&getComputedStyle(c).display!=='none';},loupe),'visible mask loupe');
 const shown=await reveal(t,`${loupe} canvas`);
 assert(shown.bounds.width>=100&&shown.bounds.height>=100,'mask loupe canvas has the main panel loupe size');
 await t.evidence('mask-loupe-shown');
 // pick a point with the brush still armed: the click must move the loupe, not paint
 const before=await settledPhoto(t);
 const count=()=>t.driver.observe(()=>Number(document.documentElement.dataset.loupeFrames??0));
 const frames=await count();
 await click(t,`${loupe} button[aria-label="Pick mask-presence loupe point"]`);
 await until(()=>t.driver.observe(s=>document.querySelector(`${s} button`)?.getAttribute('aria-pressed')==='true',loupe),'picker armed');
 const at=await reveal(t,'svg.mask-svg');await t.driver.point(at.x+at.bounds.width*.3,at.y+at.bounds.height*.3);
 await until(()=>t.driver.observe(s=>document.querySelector(`${s} button`)?.getAttribute('aria-pressed')==='false',loupe),'picker released after the click');
 await until(async()=>await count()>frames,'loupe rendered the picked point');
 const after=await settledPhoto(t);
 assert.equal(after.hash,before.hash,'loupe pick must not paint a brush stroke');
 t.measure({name:'mask-loupe',loupe:shown.bounds,framesBefore:frames,framesAfter:await count()});await t.evidence('mask-loupe-picked');
}
async function requireLoupe(t){await until(()=>t.driver.observe(()=>{const c=document.querySelector('.detail-loupe canvas');return c?.width>0&&getComputedStyle(c).display!=='none';}),'visible loupe');}
export async function detailWithoutLoupe(t){
 await click(t,'button[data-tour="prefs"]');await textButton(t,'.prefs-tabs','General');
 const toggle='[data-pref-label="Detail loupe"] input[type=checkbox]';if((await reveal(t,toggle)).checked)await click(t,toggle);
 await textButton(t,'.prefs-foot','Done');await panel(t,'basic');
 const before=await settledPhoto(t),s=await reveal(t,':is([data-control-id="clarity"],[data-control-id^="detail_clarity_"]) input[type=range]');
 await t.driver.drag({x:s.x,y:s.y},{x:s.x+s.bounds.width*.1,y:s.y});
 const after=await settledPhoto(t,p=>p.hash!==before.hash);
 assert.equal(after.width,before.width);assert.equal(after.height,before.height);assert(!await t.driver.observe(()=>!!document.querySelector('.detail-loupe')));
 t.measure({name:'f023c4f',width:after.width,height:after.height});await t.evidence('detail-final-no-loupe');
}
export async function cameraBody(t){
 if(!['camera-a','camera-b','camera-missing'].includes(t.fixture.name))throw new Blocked('Requires --fixture camera-a (synthetic camera family)');
 await click(t,'.kind-button');
 const category=await until(()=>t.driver.observe(()=>{const e=[...document.querySelectorAll('.filter-cat')].find(e=>e.querySelector('.name')?.textContent==='Camera body');if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};}),'Camera body category');
 await t.driver.point(category.x,category.y);
 const names=await until(()=>t.driver.observe(()=>[...document.querySelectorAll('.filter-ticks .name')].map(e=>e.textContent)),'body options');
 assert(names.some(s=>s.includes('BODY-A'))&&names.some(s=>s.includes('BODY-B')),'same model serials independently listed');
 assert(names.some(s=>/without|missing|none|unknown|not recorded/i.test(s)),'missing serial category listed');
 for(const name of names){await textButton(t,'.filter-ticks',name);await t.evidence(`body-${names.indexOf(name)}`);await textButton(t,'.filter-ticks',name);}
 await t.driver.keys('\uE00C');
}
export async function rejectedDeletion(t){
 if(!t.fixture.generated)throw new Blocked('Requires disposable generated library fixture');
 // These shortcuts are scoped to the app's webview, not global keyboard input.
 await t.driver.keys('x');
 await until(()=>t.driver.observe(()=>!!document.querySelector('.thumb.active.rejected')),'fixture rejected');
 await t.evidence('rejected');
 // Current production deletion uses Tauri's native ask() confirmation. Abort
 // before opening it: operating that native dialog violates the app-only boundary.
 throw new Blocked('Deletion regression needs an app-contained confirmation; current Tauri native ask() is outside automation authorization');
}
export async function folderRace(t){
 // Requires a controllably slow isolated filesystem; never fake the GUI state.
 if(!t.fixture.slowFolders)throw new Blocked('Requires controlled slow-folder fixture; no real/user folders may be used');
 const ids=['slow-unrelated','fast-target'];
 for(const id of ids)await click(t,`[data-folder-name="${id}"]`);
 await until(()=>t.driver.observe(()=>document.querySelector('.folder.current')?.textContent.includes('fast-target')),'target folder appears before unrelated load');
 await pause(2000);assert(await t.driver.observe(()=>document.querySelector('.folder.current')?.textContent.includes('fast-target')),'stale folder response cannot replace target');await t.evidence('folder-race');
}
