// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
const inventory=JSON.parse(readFileSync(new URL('./inventory.json',import.meta.url),'utf8'));
export const generated={};
// the global module choice whose option owns a control, so its case can
// choose that module first (contrast equalizer bands, contrast & texture's
// Clarity/Texture bands, diffuse or sharpen's sharpening)
const owner=id=>{for(const choice of inventory.globalModules)for(const option of choice.options)
 if(option.controls?.includes(id))return{choice:choice.id,label:choice.label,value:option.value};};
// a hidden panel holds state edited by a graph, overlay or tool rather than
// sliders (point curve, crop, upright, zones, negative, ...): no widget
// exists for a per-control case to drive, so its written case covers it
// (hiddenPanelCoverage)
for(const p of inventory.panels)if(!p.hidden)for(const s of p.sections)for(const control of s.controls){
 const name=`control-${p.id}-${control.id}`;
 generated[name]={kind:control.kind==='slider'?'range':'choice',scope:'global',panel:p.id,section:s.title,control,module:owner(control.id),
  liveValidated:false,fixture:'configured'};
}
// which written case drives each hidden panel; null where none does yet
export const hiddenPanelCoverage={
 'tonecurve-points':'curves',crop:'crop-options',orientation:'crop-options',zones:'zones',negative:'negative',
 modules:'module-options',upright:null,'vignette-center':null,'exposure-compensation':null,tonemapper:null,
};
for(const control of inventory.localControls)generated[`local-${control.id}`]={kind:control.kind==='slider'?'range':'choice',scope:'local',panel:'masks',control,liveValidated:false,fixture:'configured'};
for(const [scope,choices] of [['global',inventory.globalModules],['masks',inventory.maskModules]])for(const choice of choices)for(const option of choice.options)
 generated[`module-${scope}-${choice.id}-${option.value}`]={kind:'module',scope,choice,option,liveValidated:false,fixture:'configured'};
export const generatedNames=Object.keys(generated);
