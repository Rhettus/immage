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
import { CaptureTimeDialog } from ${JSON.stringify(fileURLToPath(new URL("../app/src/CaptureTimeDialog.tsx", import.meta.url)))};
const assert = (ok, message) => { if (!ok) throw Error(message); };
async function check() {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const targets = [
    {imgid: 1, filename: 'camera-b-1.jpg', exif: {datetime: '2026:10:31 23:59:58.125'}},
    {imgid: 2, filename: 'camera-b-2.jpg', exif: {datetime: '2026:10:31 23:59:59.625'}},
    {imgid: 3, filename: 'no-time.jpg', exif: {datetime: ''}},
  ];
  let applied = [], closed = 0, finish;
  const draw = (extra = {}) => flushSync(() => root.render(<CaptureTimeDialog targets={targets} reference={targets[0]}
    onClose={() => closed++} onApply={entries => { applied.push(entries); return new Promise(resolve => finish = resolve); }} {...extra}/>));
  draw();
  const buttons = () => [...host.querySelectorAll('button')];
  assert(buttons().at(-1).disabled, 'unchanged clock must not apply');
  assert(host.textContent.includes('1 photo without a valid recorded capture time'), 'missing timestamp skip is invisible');
  const input = host.querySelector('input');
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '2026-11-01T00:03:11.250');
    input.dispatchEvent(new Event('input', {bubbles:true}));
  });
  assert(host.textContent.includes('forward by 3 minutes, 13.125 seconds for 2 photos?'), 'confirmation must show shift and eligible count');
  assert(buttons().at(-1).textContent === 'Adjust 2 photos', 'confirmation button count');
  assert(applied.length === 0, 'editing a time must not apply');
  flushSync(() => buttons().at(-1).click());
  assert(applied.length === 1, 'explicit confirmation did not apply');
  assert(applied[0].length === 2 && applied[0][1].after === '2026:11:01 00:03:12.750', 'relative timing or milliseconds lost');
  flushSync(() => host.querySelector('.modal-backdrop').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})));
  assert(closed === 0 && buttons().every(b => b.disabled), 'saving must prevent closing and duplicate application');
  await new Promise(resolve => { finish('2 photos adjusted.'); setTimeout(resolve, 0); });
  assert(host.textContent.includes('2 photos adjusted.') && buttons().length === 1, 'completion did not remove apply action');
  flushSync(() => buttons()[0].click()); assert(closed === 1, 'Done did not close');
  flushSync(() => root.unmount());
  const undoRoot = createRoot(host);
  flushSync(() => undoRoot.render(<CaptureTimeDialog targets={[]} reference={targets[0]} undo={applied[0]}
    onClose={() => closed++} onApply={async () => {throw Error('stale capture time');}}/>));
  assert(host.textContent.includes('Restore the previous capture times for 2 photos?'), 'undo must confirm its batch');
  flushSync(() => buttons().at(-1).click());
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(host.querySelector('[role=alert]').textContent.includes('stale capture time'), 'save error must remain visible');
  flushSync(() => buttons()[0].click()); assert(closed === 2, 'cancel did not close');
  flushSync(() => undoRoot.unmount());
  return {confirmation:true, relativeTiming:true, missingTimesSkipped:true, busyGuard:true, undoConfirmation:true, errorsVisible:true};
}
check().then(result => fetch('/result', {method:'POST', body:JSON.stringify(result)}))
  .catch(error => fetch('/result', {method:'POST', body:JSON.stringify({error:error.stack})}));
`;
const bundle = await rolldown({input:'capture-time-ui.tsx',transform:{define:{'process.env.NODE_ENV':'"production"'}},
  plugins:[{name:'ui-fixture',resolveId(id){if(id==='react/jsx-runtime')return require.resolve(id);if(id==='capture-time-ui.tsx')return '\0capture-time-ui.tsx';},load(id){if(id==='\0capture-time-ui.tsx')return source;}}],
  onwarn(warning,warn){if(warning.code!=='MODULE_LEVEL_DIRECTIVE')warn(warning);}});
const {output}=await bundle.generate({format:'es'});await bundle.close();
let resolve,reject;const report=new Promise((a,b)=>{resolve=a;reject=b;});
const server=createServer((req,res)=>{
 if(req.url==='/result'){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{res.end('ok');const result=JSON.parse(body);if(result.error)reject(Error(result.error));else resolve(result);});return;}
 if(req.url==='/check.js'){res.setHeader('Content-Type','text/javascript');res.end(output.find(c=>c.type==='chunk'&&c.isEntry).code);return;}
 res.setHeader('Content-Type','text/html');res.end('<script type="module" src="/check.js"></script>');
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const profile=mkdtempSync('/tmp/immage-capture-ui-');
const browser=spawn(process.env.CHROMIUM??'chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--no-first-run',`--user-data-dir=${profile}`,`http://127.0.0.1:${server.address().port}`],{stdio:['ignore','ignore','pipe'],detached:true});
let stderr='';browser.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-2000));
browser.on('error',reject);browser.on('exit',code=>reject(Error(`Browser exited ${code}: ${stderr}`)));
const timeout=setTimeout(()=>reject(Error(`UI check timed out: ${stderr}`)),30000);
try{console.log(JSON.stringify(await report,null,2));}finally{
 clearTimeout(timeout);if(browser.pid){try{process.kill(-browser.pid,'SIGTERM');}catch{}}
 server.closeAllConnections();server.close();await new Promise(done=>setTimeout(done,300));rmSync(profile,{recursive:true,force:true});
}
