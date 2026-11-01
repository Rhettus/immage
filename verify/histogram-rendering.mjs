// SPDX-License-Identifier: GPL-3.0-or-later
// Check the actual histogram raster and clipping overlay in headless Chromium.
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { rolldown } = await import(require.resolve('rolldown'));
const source = `
import {computeHistogram,drawScope,DEFAULT_SCOPE,paintClipping,clipColor,histogramPath} from ${JSON.stringify(new URL('../app/src/histogram.ts',import.meta.url).pathname)};
import {runPixelTask} from ${JSON.stringify(new URL('../app/src/pixelTasks.ts',import.meta.url).pathname)};
async function check(){
 const assert=(ok,message)=>{if(!ok)throw Error(message);};
 const canvas=document.createElement('canvas');document.body.append(canvas);
 canvas.style.width='512px';canvas.style.height='120px';
 const source=document.createElement('canvas'),overlay=document.createElement('canvas');
 source.width=8;source.height=8;
 for(const value of [0,128,255]){
  const ctx=source.getContext('2d');ctx.fillStyle='rgb('+[value,value,value].join(',')+')';ctx.fillRect(0,0,8,8);
  const pixels=ctx.getImageData(0,0,8,8).data,h=computeHistogram(pixels,8,8);
  drawScope(canvas,h,DEFAULT_SCOPE);
  const raster=canvas.getContext('2d').getImageData(0,60,512,1).data;
  for(let x=value*2;x<value*2+2;x++)assert(raster[x*4]>180,'bin '+value+' loses width at pixel '+x);
  assert(histogramPath(h,512,120).includes('L'+(value*2).toFixed(1)+',12.0 L'+(value*2+2).toFixed(1)+',12.0'),'curve histogram loses bin width');
  paintClipping(source,overlay,{low:true,high:true});
  const actual=overlay.getContext('2d').getImageData(0,0,8,8).data;
  const worker=runPixelTask({kind:'clipping',pixels,width:8,height:8,show:{low:true,high:true}});
  const expected=value===255?[255,0,0,255]:value===0?[0,64,255,255]:[0,0,0,0];
  for(let i=0;i<actual.length;i++)assert(actual[i]===expected[i%4]&&worker[i]===expected[i%4],'clipping differs for '+value);
  if(value!==128)assert(clipColor(h,value===0?'low':'high')!==null,'clipping triangle not lit');
 }
 return {fullWidthBins:true,blackAndWhiteClipping:true,curveHistogram:true};
}
check().then(result=>fetch('/result',{method:'POST',body:JSON.stringify(result)})).catch(error=>fetch('/result',{method:'POST',body:JSON.stringify({error:error.stack})}));`;
const bundle=await rolldown({input:'histogram-check.ts',plugins:[{name:'fixture',resolveId(id){if(id==='histogram-check.ts')return '\0histogram-check.ts';},load(id){if(id==='\0histogram-check.ts')return source;}}]});
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
