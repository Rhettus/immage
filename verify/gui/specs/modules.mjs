// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const inventory=JSON.parse(readFileSync(new URL('../inventory.json',import.meta.url),'utf8'));
import {locateControl} from './ranges.mjs';
import { click,reveal,inspect,tabTo, openTool } from '../support/controls.mjs';
import { choose,textButton,Blocked,panel,expandSections } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

// sets a module choice in Preferences > Modules and returns the value it had
export async function chooseModule(t,scope,label,value){
 await click(t,'button[data-tour="prefs"]');await textButton(t,'.prefs-tabs','Modules');await textButton(t,'.prefs','Custom');
 const fold=`button[aria-controls="module-prefs-${scope}"]`;
 if(!await t.driver.observe(s=>document.querySelector(s)?.getAttribute('aria-expanded')==='true',fold)){
  // the Preferences list does not scroll for WebDriver's wheel; Tab to the fold scrolls it into view
  if(!(await t.driver.observe(inspect,fold))?.visible)await tabTo(t,fold);
  await click(t,fold);
 }
 const selector=`select[aria-label=${JSON.stringify(`${scope==='global'?'Global':'Masks'} ${label}`)}]`;
 const previous=(await reveal(t,selector)).value;
 await choose(t,selector,value);await textButton(t,'.prefs-foot','Done');
 return previous;
}
// samples outside the centered ellipse must stay within quantization noise
const outsideError=(before,after)=>{let error=0,count=0;for(let y=0;y<64;y++)for(let x=0;x<64;x++)if(x<8||x>55||y<8||y>55){const i=(y*64+x)*4;for(let c=0;c<3;c++){error+=Math.abs(before.rgba[i+c]-after.rgba[i+c]);count++;}}return error/count;};
// the saturation curve has no slider: lift its muted end on the graph
async function satcurveOutput(t,scope){
 const root=scope==='masks'?'.masks-panel':await panel(t,'basic');
 if(scope==='masks'){
  // a new mask folds its settings card as it opens, moving the groups up
  // under a click aimed a moment before: click until the group is open
  const heading='[data-mask-group="Presence"]';
  await until(async()=>{
   if(!await t.driver.observe(s=>!!document.querySelector(`${s} .chevron:not(.open)`),heading))return true;
   await click(t,heading);return false;
  },'Presence group open');
 }else await expandSections(t,root);
 const g=await reveal(t,`${root} .saturation-curve svg.point-curve`),before=await settledPhoto(t);
 await t.driver.drag({x:g.bounds.x+2,y:g.bounds.y+g.bounds.height/2},{x:g.bounds.x+2,y:g.bounds.y+g.bounds.height*.2});
 const after=await settledPhoto(t,p=>p.hash!==before.hash);
 t.measure({name:`${scope}/saturation/saturation curve`,photoHash:after.hash});await t.evidence('module-graph-effect');
 if(scope==='masks'){
  assert(outsideError(before,after)<2,'outside-mask photo region remains unchanged');
  await click(t,'.mask-list li.on .mask-del');await settledPhoto(t,p=>p.hash===before.hash);
 }else{
  await textButton(t,`${root} .saturation-curve .equalizer-heading`,'Reset');await settledPhoto(t,p=>p.hash===before.hash);
 }
}
export async function moduleOutput(t,definition){
 const {scope,choice,option}=definition;
 await chooseModule(t,scope,choice.label,option.value);
 if(scope==='masks'){
  await openTool(t,'masks');await click(t,'.create-mask');await textButton(t,'.shape-menu-list','Radial Gradient');
  const svg=await reveal(t,'svg.mask-svg');await t.driver.drag({x:svg.x-svg.bounds.width*.12,y:svg.y-svg.bounds.height*.12},{x:svg.x+svg.bounds.width*.12,y:svg.y+svg.bounds.height*.12});
  await until(()=>t.driver.observe(()=>!!document.querySelector('.mask-list li.on')),'radial mask created');
 }
 if(option.op==='satcurvergb')return satcurveOutput(t,scope);
 // Black & White's modules have no sliders of their own: B&W treatment shows them
 if(choice.id==='bw'&&scope==='global'){
  const basic=await panel(t,'basic'),before=await settledPhoto(t);
  await textButton(t,basic,'B&W');const after=await settledPhoto(t,p=>p.hash!==before.hash);
  t.measure({name:`global/bw/${option.name}`,photoHash:after.hash});await t.evidence('module-effect');
  await textButton(t,basic,'Color');await settledPhoto(t,p=>p.hash===before.hash);return;
 }
 const ids=scope==='masks'?option.localControls:option.controls;
 const candidates=[...(ids??[]),...(choice.covers??[]).map(id=>scope==='masks'&&!id.startsWith('l_')?'l_'+id:id)];
 let control;
 for(const id of candidates){
  if(scope==='global'){
    const p=inventory.panels.find(p=>!p.hidden&&p.sections.some(s=>s.controls.some(c=>c.id===id)));
    if(p){const selector=await panel(t,p.id);await expandSections(t,selector);}
  }else{
    const control=inventory.localControls.find(c=>c.id===id);
    // a graph's points are no sliders: skip them for the graph branch below
    if(control)try{await locateControl(t,{scope:'local',panel:'masks',control});}catch(e){if(!(e instanceof Blocked))throw e;}
  }
  const s=`[data-control-id=${JSON.stringify(id)}] input[type=range]`;
  if(await t.driver.observe(s=>{const e=document.querySelector(s);return e&&!e.disabled;},s)){control=s;break;}
 }
 if(!control&&option.op==='atrous'){
  if(scope==='global')await panel(t,'basic');
  const point=await reveal(t,'.equalizer-graph circle[role=slider]');await t.driver.point(point.x,point.y);const before=await settledPhoto(t);await t.driver.keys('\uE013');
  await settledPhoto(t,p=>p.hash!==before.hash);await t.evidence('module-graph-effect');return;
 }
 if(!control)throw new Blocked(`${scope}/${choice.id}/${option.name}: no enabled control; needs matching RAW/treatment/section prerequisite`);
 const s=await reveal(t,control),before=await settledPhoto(t);
 const start=Number(s.value),target=Math.min(s.max,start+(s.max-s.min)*.15);
 const at=value=>({x:s.bounds.x+8+(s.bounds.width-16)*(value-s.min)/(s.max-s.min),y:s.y});
 await t.driver.drag(at(start),at(target));
 const after=await settledPhoto(t,p=>p.hash!==before.hash);
 t.measure({name:`${scope}/${choice.id}/${option.name}`,control,photoHash:after.hash});await t.evidence('module-effect');
 if(scope==='masks'){
  assert(outsideError(before,after)<2,'outside-mask photo region remains unchanged');
  await click(t,'.mask-list li.on .mask-del');await settledPhoto(t,p=>p.hash===before.hash);
 }else{
  const label=await reveal(t,control.replace('input[type=range]','label'));await t.driver.point(label.x,label.y,2);await settledPhoto(t,p=>p.hash===before.hash);
 }
}
export async function panorama(t){
 // The dedicated overlapping-photo fixture must be opened/selected via the app.
 if(!t.fixture.panorama)throw new Blocked('Requires approved overlapping panorama fixture family; synthetic unrelated images are not sufficient');
 await click(t,'button[title^="grid view"]');await t.driver.chord('\uE009','a');
 await t.driver.keys('p');
 await until(()=>t.driver.observe(()=>!!document.querySelector('.pano-merge')),'Panorama Merge');
 const buttons=await t.driver.observe(()=>[...document.querySelectorAll('[aria-label="Projection"] button')].map(e=>e.textContent.trim()));
 for(const label of buttons){await textButton(t,'[aria-label="Projection"]',label);await until(()=>t.driver.observe(()=>{const c=document.querySelector('[aria-label="Panorama projection preview"]');return c?.width>0;}),'projection preview');await t.evidence(`projection-${buttons.indexOf(label)}`);}
 await textButton(t,'.pano-merge .modal-foot','Cancel');
}
export async function immichWorkflow(t){
 throw new Blocked('Requires an isolated local Immich fixture server and test credentials, with explicit service scope; no user account or external application is used');
}
