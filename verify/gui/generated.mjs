// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
const inventory=JSON.parse(readFileSync(new URL('./inventory.json',import.meta.url),'utf8'));
export const generated={};
for(const p of inventory.panels)for(const s of p.sections)for(const control of s.controls){
 const name=`control-${p.id}-${control.id}`;
 generated[name]={kind:control.kind==='slider'?'range':'choice',scope:'global',panel:p.id,section:s.title,control,
  liveValidated:false,fixture:p.id==='negative'?'negative':'configured',
  limitation:p.hidden?'Backing control may use a graph/overlay rather than an independent widget; missing UI prerequisite blocks.':undefined};
}
for(const control of inventory.localControls)generated[`local-${control.id}`]={kind:control.kind==='slider'?'range':'choice',scope:'local',panel:'masks',control,liveValidated:false,fixture:'configured'};
for(const [scope,choices] of [['global',inventory.globalModules],['masks',inventory.maskModules]])for(const choice of choices)for(const option of choice.options)
 generated[`module-${scope}-${choice.id}-${option.value}`]={kind:'module',scope,choice,option,liveValidated:false,fixture:'configured'};
export const generatedNames=Object.keys(generated);
