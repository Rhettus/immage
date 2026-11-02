// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const { rolldown } = await import(require.resolve("rolldown"));
const source = `
import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
import { flushSync } from ${JSON.stringify(require.resolve("react-dom"))};
import { PanoDialog } from ${JSON.stringify(fileURLToPath(new URL("../app/src/PanoDialog.tsx", import.meta.url)))};
const assert = (ok, message) => { if (!ok) throw Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for(let i=0;i<200;i++) { if(predicate()) return; await delay(10); }
  throw Error('Timed out waiting for preview state');
}
const calls=[], pending=new Map();let capable=true;
window.__TAURI_INTERNALS__ = {invoke: async (cmd, args={}) => {
  calls.push({cmd,...args});
  if(cmd==='pano_can_merge') return capable;
  if(cmd==='merge_cancel') return;
  if(cmd==='pano_preview') return new Promise((resolve,reject)=>pending.set(args.job,{resolve,reject}));
  throw Error(cmd);
}};
const requests=()=>calls.filter(c=>c.cmd==='pano_preview');
const answer=(index,projection='perspective')=>{
  const rgba=new Uint8Array(4*3*4);
  for(let i=0;i<12;i++) {rgba[i*4]=i*10;rgba[i*4+1]=80;rgba[i*4+2]=120;rgba[i*4+3]=0;}
  rgba[5*4+3]=rgba[6*4+3]=255;
  pending.get(requests()[index].job).resolve({rgba:btoa(String.fromCharCode(...rgba)),width:4,height:3,
    crop:[1,1,2,1],projection,used:2});
};
async function check() {
  localStorage.clear();
  const host=document.createElement('div');document.body.append(host);
  let root=createRoot(host),closed=0,merged;
  const photos=[{imgid:11},{imgid:22}];
  const draw=()=>flushSync(()=>root.render(<PanoDialog photos={photos} onClose={()=>closed++}
    onRun={(projection,crop)=>merged={projection,crop}}/>));
  const button=name=>[...host.querySelectorAll('button')].find(b=>b.textContent===name);
  const choose=name=>flushSync(()=>button(name).click());
  draw();
  await until(()=>requests().length===1);
  assert(host.textContent.includes('Preparing preview'), 'loading state missing');
  assert(requests()[0].imgids.join(',')==='11,22', 'selected photos not passed to engine');
  answer(0);
  await until(()=>host.querySelector('canvas'));
  let canvas=host.querySelector('canvas');
  assert(canvas.width===2&&canvas.height===1, 'Auto Crop dimensions wrong');
  assert(canvas.getContext('2d').getImageData(0,0,1,1).data[0]===50, 'crop origin wrong');
  assert(host.textContent.includes('Auto → Perspective'), 'resolved Auto missing');
  flushSync(()=>host.querySelector('input').click());
  canvas=host.querySelector('canvas');
  assert(canvas.width===4&&canvas.height===3, 'uncropped dimensions wrong');
  assert(canvas.getContext('2d').getImageData(0,0,1,1).data[3]===0, 'empty edges must be transparent');
  assert(requests().length===1, 'crop toggle requested another stitch');
  choose('Spherical');await until(()=>requests().length===2);
  choose('Cylindrical');await delay(250);
  assert(calls.some(c=>c.cmd==='merge_cancel'&&c.job===requests()[1].job), 'obsolete preview not canceled');
  assert(requests().length===2, 'replacement started before previous request ended');
  answer(1,'spherical');await until(()=>requests().length===3);
  assert(!host.querySelector('canvas'), 'stale reply replaced current projection');
  answer(2,'cylindrical');await until(()=>host.querySelector('canvas'));
  choose('Auto');await delay(250);
  assert(requests().length===3&&host.textContent.includes('Auto → Perspective'), 'cached projection not reused');
  choose('Perspective');await until(()=>requests().length===4);
  pending.get(requests()[3].job).reject('not enough overlap');
  await until(()=>button('Retry'));
  assert(host.textContent.includes('not enough overlap'), 'preview error hidden');
  assert(!button('Merge').disabled, 'preview error must not block full merge');
  choose('Retry');await until(()=>requests().length===5);answer(4);
  await until(()=>host.querySelector('canvas'));
  choose('Merge');
  assert(closed===1&&merged.projection==='perspective'&&merged.crop===false, 'Merge settings changed');
  assert(localStorage.getItem('immage.panoProjection')==='perspective'&&localStorage.getItem('immage.panoCrop')==='false', 'settings not persisted');
  choose('Spherical');await until(()=>requests().length===6);
  flushSync(()=>root.unmount());
  assert(calls.some(c=>c.cmd==='merge_cancel'&&c.job===requests()[5].job), 'closing did not cancel preview');
  answer(5,'spherical');await delay(20);
  capable=false;root=createRoot(host);draw();
  await until(()=>host.textContent.includes('unavailable in this build'));
  assert(button('Merge').disabled, 'unsupported build can merge');
  assert(requests().length===6, 'unsupported build requested preview');
  flushSync(()=>root.unmount());
  return {cropPixels:true,transparentEdges:true,resolvedAuto:true,cache:true,staleRepliesIgnored:true,
    serializedCancellation:true,retry:true,mergeSettings:true,closeCancels:true,unsupportedBuild:true};
}
check().then(result=>fetch('/result',{method:'POST',body:JSON.stringify(result)}))
  .catch(error=>fetch('/result',{method:'POST',body:JSON.stringify({error:error.stack})}));
`;
const bundle = await rolldown({input:'panorama-ui.tsx',transform:{define:{'process.env.NODE_ENV':'"production"'}},
  plugins:[{name:'ui-fixture',resolveId(id){if(id==='react/jsx-runtime')return require.resolve(id);if(id==='panorama-ui.tsx')return '\0panorama-ui.tsx';},load(id){if(id==='\0panorama-ui.tsx')return source;}}],
  onwarn(warning,warn){if(warning.code!=='MODULE_LEVEL_DIRECTIVE')warn(warning);}});
const {output}=await bundle.generate({format:'es'});await bundle.close();
let resolve,reject;const report=new Promise((a,b)=>{resolve=a;reject=b;});
const server=createServer((req,res)=>{
 if(req.url==='/result'){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{res.end('ok');const result=JSON.parse(body);if(result.error)reject(Error(result.error));else resolve(result);});return;}
 if(req.url==='/check.js'){res.setHeader('Content-Type','text/javascript');res.end(output.find(c=>c.type==='chunk'&&c.isEntry).code);return;}
 res.setHeader('Content-Type','text/html');res.end('<script type="module" src="/check.js"></script>');
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const profile=mkdtempSync('/tmp/immage-panorama-ui-');
const browser=spawn(process.env.CHROMIUM??'chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--no-first-run',`--user-data-dir=${profile}`,`http://127.0.0.1:${server.address().port}`],{stdio:['ignore','ignore','pipe'],detached:true});
let stderr='';browser.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-2000));
browser.on('error',reject);browser.on('exit',code=>reject(Error(`Browser exited ${code}: ${stderr}`)));
const timeout=setTimeout(()=>reject(Error(`UI check timed out: ${stderr}`)),30000);
try{console.log(JSON.stringify(await report,null,2));}finally{
 clearTimeout(timeout);if(browser.pid){try{process.kill(-browser.pid,'SIGTERM');}catch{}}
 server.closeAllConnections();server.close();await new Promise(done=>setTimeout(done,300));rmSync(profile,{recursive:true,force:true});
}
