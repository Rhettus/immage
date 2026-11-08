// SPDX-License-Identifier: GPL-3.0-or-later
// Export the actual global/local manifest fields; no copied field inventory.
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require=createRequire(new URL('../app/package.json',import.meta.url));
const reactPath=require.resolve('react');
const {transformSync}=await import(require.resolve('rolldown/experimental'));
registerHooks({
  resolve(spec,ctx,next){
    if(spec==='@tauri-apps/api/core')return {url:'data:text/javascript,export async function invoke(){return {};}',shortCircuit:true};
    if(spec==='react')return next(reactPath,ctx);
    if(spec.startsWith('./')||spec.startsWith('../'))for(const ext of ['.ts','.tsx']){
      const url=new URL(spec+ext,ctx.parentURL);if(existsSync(url))return next(url.href,ctx);
    }
    return next(spec,ctx);
  },
  load(url,ctx,next){
    if(!url.startsWith('file:')||!/\.tsx?$/.test(url))return next(url,ctx);
    const path=fileURLToPath(url),out=transformSync(path,readFileSync(path,'utf8'),{jsx:{runtime:'automatic'}});
    if(out.errors?.length)throw Error(JSON.stringify(out.errors));
    return {format:'module',source:out.code,shortCircuit:true};
  },
});

const { modules, localMaps, allControls, LOCAL_CONTROLS, choiceOn, choiceShows } = await import('../app/src/manifest.ts');
const fields = {};
for (const map of [...modules, ...localMaps]) {
  const op = map.op.split('#')[0];
  fields[op] = [...new Set([...(fields[op] ?? []), ...map.fields])];
}
if (process.argv[2] === '--reads') {
  const records = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const ctx = {sensorWidth:128, sensorHeight:96, orientation:0, camera:0};
  const results = records.map(({scope,index,values,params,defaults}) => {
    const m = (scope === 'global' ? modules : localMaps)[index];
    const read = m.read(params,defaults,ctx,values);
    if (Object.values(read).some(v => !Number.isFinite(v))) throw Error(`Nonfinite read ${scope}/${index}`);
    return {read, recognized:m.controls.filter(id => read[id] !== undefined),
      chosen:choiceOn(m,values), enabled:m.enabled ? m.enabled(values) : null,
      visible:Object.fromEntries(m.controls.map(id => [id,choiceShows(id,values)]))};
  });
  process.stdout.write(JSON.stringify(results));
} else if (process.argv[2] === '--controls') {
  const snapshot = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const ctx = {sensorWidth:128, sensorHeight:96, orientation:0, camera:0};
  const cases = [];
  for (const [scope, maps, controls] of [['global', modules, allControls], ['local', localMaps, [...allControls, ...LOCAL_CONTROLS]]]) {
    const byId = new Map(controls.map(c => [c.id,c]));
    const base = Object.fromEntries(controls.map(c => [c.id, c.neutral ?? c.min]));
    // Start with production reads so image-dependent defaults seed other controls.
    for (const m of maps) Object.assign(base,m.read(snapshot[m.op.split('#')[0]].params,snapshot[m.op.split('#')[0]].defaults,ctx,base));
    for (const [index,m] of maps.entries()) {
      const op=m.op.split('#')[0], d=snapshot[op].defaults;
      // Dynamic ICC choices need the engine's role-specific menu, not the
      // manifest's loading placeholder; covered by color-profiles.py.
      if (op === 'colorin') continue;
      for (const id of m.controls) {
        const c=byId.get(id);
        if (!c) throw Error(`Missing control ${scope}/${id}`);
        const options=c.options ?? c.optionGroups?.flatMap(g=>g[1]);
        const values=options?.map(o=>o[1]) ?? [c.min,c.neutral ?? base[id],c.max];
        for (const value of new Set(values)) {
          const v={...base,[id]:value};
          const params=m.write(v,d,ctx);
          if (Object.values(params).some(x=>!Number.isFinite(x))) throw Error(`Nonfinite ${scope}/${index}/${id}/${value}`);
          cases.push({scope,index,op,id,value,params,values:v,choice:!!options});
        }
      }
    }
  }
  process.stdout.write(JSON.stringify(cases));
} else process.stdout.write(JSON.stringify(fields));
