// SPDX-License-Identifier: GPL-3.0-or-later
// Exercise actual App slider/panel adapters with production React in Chromium.
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { rolldown } = await import(require.resolve('rolldown'));
const app = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
const slider = app.slice(app.indexOf('function Slider({'), app.indexOf('// a few named values as a segmented control'));
const panel = app.slice(app.indexOf('function useLiveEvent'), app.indexOf('const PanelWidget = memo('));
const source = `
import {memo,useRef,useState,useEffect,useLayoutEffect,useCallback,useSyncExternalStore} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {flushSync} from ${JSON.stringify(require.resolve('react-dom'))};
import {panelValues} from ${JSON.stringify(fileURLToPath(new URL('../app/src/panelValues.ts', import.meta.url)))};
import {Snapshot} from ${JSON.stringify(fileURLToPath(new URL('../app/src/uiUpdates.ts', import.meta.url)))};
import {controlById,mapOf,moduleName,panels} from ${JSON.stringify(fileURLToPath(new URL('../app/src/manifest.ts', import.meta.url)))};
let sliderRenders=0,panelRenders=0;
const perf={count(){sliderRenders++;}},WHEEL_NOTCH=40;
const loadSliderScroll=()=>true,loadSliderScrollStep=()=>.01,keys=s=>s;
${slider}
${panel}
const PanelWidget=memo(function PanelWidget(props){panelRenders++;return <button id="panel" onClick={()=>props.onChange(controlById.get('exposure'),1)}>panel</button>;});
async function check(){
 const assert=(ok,message)=>{if(!ok)throw Error(message);};
 const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
 const exposure=controlById.get('exposure');let called='';
 const draw=(value,version)=>flushSync(()=>root.render(<Slider control={exposure} value={value} neutral={0} disabled={false} values={{exposure:value}} onChange={()=>called=version}/>));
 draw(0,'first');const initial=sliderRenders;
 for(let n=0;n<20;n++)draw(0,'latest');
 assert(sliderRenders===initial,'unchanged slider rendered for unrelated parent updates: '+initial+' -> '+sliderRenders);
 div.querySelector('.slider label').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
 assert(called==='latest','memoized slider used an old callback');
 draw(1,'next');assert(sliderRenders===initial+1,'changed slider did not render');
 const wheelValues=[];
 flushSync(()=>root.render(<Slider control={exposure} value={0} neutral={0} disabled={false} values={{exposure:0}} onChange={v=>wheelValues.push(v)}/>));
 for(let n=0;n<2;n++)div.querySelector('.slider').dispatchEvent(new WheelEvent('wheel',{deltaY:40,bubbles:true,cancelable:true}));
 assert(wheelValues.length===2&&Math.abs(wheelValues[1]-2*wheelValues[0])<1e-9,'wheel steps lost input before React publication');
 const sat=[...controlById.values()].find(c=>c.id.startsWith('cg_')&&typeof c.track==='function');
 const hue=sat.id.replace(/_sat$/,'_hue');
 const color=(h)=>flushSync(()=>root.render(<Slider control={sat} value={10} neutral={0} disabled={false} values={{[hue]:h}} onChange={()=>{}}/>));
 color(0);const style=div.querySelector('input[type=range]').style.getPropertyValue('--track');
 color(120);assert(div.querySelector('input[type=range]').style.getPropertyValue('--track')!==style,'dependent color track stayed stale');
 const histograms=new Snapshot(null);const p=panels.find(p=>p.id==='tonecurve');
 const panelDraw=(exposure,tc_highlights,version,sessionRevision=0)=>flushSync(()=>root.render(<PanelView panel={p} open={true} session={null} disabled={false} sessionRevision={sessionRevision} histograms={histograms} values={{exposure,tc_highlights}} onChange={()=>called=version} onChangeMany={()=>{}} onPreview={()=>{}} onToggle={()=>{}}/>));
 panelDraw(0,0,'first');const before=panelRenders;
 for(let n=1;n<=20;n++)panelDraw(n,0,'latest');
 assert(panelRenders===before,'unrelated values/closures invalidated panel');
 div.querySelector('#panel').click();assert(called==='latest','memoized panel used an old callback');
 panelDraw(20,2,'curve');assert(panelRenders===before+1,'own control edit did not invalidate panel');
 panelDraw(20,2,'module',1);assert(panelRenders===before+2,'module revision did not invalidate panel');
 let parentRenders=0,scopeRenders=0;
 function Scope(){useSyncExternalStore(histograms.subscribe,histograms.get);scopeRenders++;return null;}
 function Parent(){parentRenders++;return <Scope/>;}
 flushSync(()=>root.render(<Parent/>));
 flushSync(()=>histograms.set({samples:10}));
 assert(parentRenders===1&&scopeRenders===2,'histogram rendered parent or missed consumer');
 flushSync(()=>root.unmount());
 return {unchangedSliderSkipped:20,unrelatedPanelSkipped:20,currentCallbacks:true,relativeWheelInput:true,dependentTracks:true,moduleInvalidation:true,histogramConsumerOnly:true};
}
check().then(result=>fetch('/result',{method:'POST',body:JSON.stringify(result)})).catch(error=>fetch('/result',{method:'POST',body:JSON.stringify({error:error.stack})}));`;
const bundle = await rolldown({input:'ui-check.tsx',transform:{define:{'process.env.NODE_ENV':'"production"'}},
  plugins:[{name:'ui-fixture',resolveId(id){if(id==='react/jsx-runtime')return require.resolve(id);if(id==='ui-check.tsx')return '\0ui-check.tsx';},load(id){if(id==='\0ui-check.tsx')return source;}}],
  onwarn(warning,warn){if(warning.code!=='MODULE_LEVEL_DIRECTIVE')warn(warning);}});
const {output}=await bundle.generate({format:'es'});await bundle.close();
let resolve,reject;const report=new Promise((a,b)=>{resolve=a;reject=b;});
const server=createServer((req,res)=>{
 if(req.url==='/result'){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{res.end('ok');const result=JSON.parse(body);if(result.error)reject(Error(result.error));else resolve(result);});return;}
 if(req.url==='/check.js'){res.setHeader('Content-Type','text/javascript');res.end(output.find(c=>c.type==='chunk'&&c.isEntry).code);return;}
 res.setHeader('Content-Type','text/html');res.end('<script type="module" src="/check.js"></script>');
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const profile=mkdtempSync('/tmp/immage-ui-check-');
const browser=spawn(process.env.CHROMIUM??'chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--no-first-run',`--user-data-dir=${profile}`,`http://127.0.0.1:${server.address().port}`],{stdio:['ignore','ignore','pipe'],detached:true});
let stderr='';browser.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-2000));
browser.on('error',reject);browser.on('exit',code=>reject(Error(`Browser exited ${code}: ${stderr}`)));
const timeout=setTimeout(()=>reject(Error(`UI check timed out: ${stderr}`)),30000);
try{console.log(JSON.stringify(await report,null,2));}finally{
 clearTimeout(timeout);if(browser.pid){try{process.kill(-browser.pid,'SIGTERM');}catch{}}
 server.closeAllConnections();server.close();await new Promise(done=>setTimeout(done,300));rmSync(profile,{recursive:true,force:true});
}
