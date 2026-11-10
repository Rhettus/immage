// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
const inventory=JSON.parse(readFileSync(new URL('./inventory.json',import.meta.url),'utf8'));
export const generated={};
// the global module choice whose option owns a control, so its case can
// choose that module first (contrast equalizer bands, contrast & texture's
// Clarity/Texture bands, diffuse or sharpen's sharpening)
const owner=(id,scope='global')=>{
 const choices=scope==='masks'?inventory.maskModules:inventory.globalModules;
 for(const choice of choices)for(const option of choice.options){
  const owns=scope==='masks'
   ? option.localControls?.includes(id)||(!option.localControls?.length&&option.op==='atrous'&&choice.id==='contrast'&&choice.covers?.includes(id))
   : option.controls?.includes(id);
  if(owns)return{choice:choice.id,label:choice.label,value:option.value,scope};
 }
};
// a hidden panel holds state edited by a graph, overlay or tool rather than
// sliders (point curve, crop, upright, zones, negative, ...): no widget
// exists for a per-control case to drive, so its written case covers it
// (hiddenPanelCoverage)
// the saturation curve's points are drawn on its graph, not as sliders:
// the saturation-curve case and the module-*-saturation-2 variants drive them
export const graphCoverage={'sc_*, sb_*':'saturation-curve','ce_*':'per-channel graph range cases'};
const onGraph=id=>/^s[cb]_/.test(id);
for(const p of inventory.panels)if(!p.hidden)for(const s of p.sections)for(const control of s.controls){
 if(onGraph(control.id))continue;
 const name=`control-${p.id}-${control.id}`;
 generated[name]={kind:control.kind==='slider'?'range':'choice',scope:'global',panel:p.id,section:s.title,control,module:owner(control.id,'global'),
  liveValidated:false,fixture:'configured'};
}
// which written case drives each hidden panel; null where none does yet
export const hiddenPanelCoverage={
 'tonecurve-points':'curves',crop:'crop-options',orientation:'crop-options',zones:'zones',negative:'negative',film:'film',
 modules:'module-options',upright:null,'vignette-center':null,'exposure-compensation':null,tonemapper:null,
};
for(const control of inventory.localControls)if(!onGraph(control.id))generated[`local-${control.id}`]={kind:control.kind==='slider'?'range':'choice',scope:'local',panel:'masks',control,module:owner(control.id,'masks'),liveValidated:false,fixture:'configured'};
for(const [scope,choices] of [['global',inventory.globalModules],['masks',inventory.maskModules]])for(const choice of choices)for(const option of choice.options)
 generated[`module-${scope}-${choice.id}-${option.value}`]={kind:'module',scope,choice,option,liveValidated:false,fixture:'configured'};
export const generatedNames=Object.keys(generated);
