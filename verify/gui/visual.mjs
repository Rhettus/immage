#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile,writeFile,realpath,mkdir,copyFile } from 'node:fs/promises';
import { resolve,relative,dirname,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG,encodePNG,comparePixels } from './support/pixels.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url));
const args=process.argv.slice(2),mode=args.shift(),options={};
for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||!args[i+1])throw Error('Expected --key value');options[args[i].slice(2)]=args[i+1];}
async function inside(path,area){const full=await realpath(resolve(root,path));const base=await realpath(resolve(root,area));const rel=relative(base,full);if(rel==='..'||rel.startsWith('..'+sep)||rel.startsWith(sep))throw Error(`Path outside ${area}`);return full;}
if(mode==='compare'){
 const expected=await inside(options.reference,'verify/references/gui'),actual=await inside(options.actual,'verify/results/gui');
 const reference=JSON.parse(await readFile(expected+'.json')),metadata=JSON.parse(await readFile(actual+'.json'));
 if(!reference.approvedBy)throw Error('Reference has not been explicitly approved');
 if(JSON.stringify(reference.environment)!==JSON.stringify(metadata.environment))throw Error('Environment mismatch; do not compare different viewport/scale/webview/theme');
 const output=dirname(actual);
 const result=comparePixels(decodePNG(await readFile(expected)),decodePNG(await readFile(actual)),reference.policy);
 await writeFile(resolve(output,'visual-diff.png'),encodePNG(result.diff));const {diff,...summary}=result;
 await writeFile(resolve(output,'visual-comparison.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));process.exitCode=result.pass?0:1;
}else if(mode==='accept'){
 if(!options.reviewer?.trim()||!options.destination)throw Error('Explicit reviewer and destination required; acceptance must be authorized after image review');
 const source=await inside(options.source,'verify/results/gui');decodePNG(await readFile(source));
 const target=resolve(root,options.destination),base=resolve(root,'verify/references/gui');
 const rel=relative(base,target);if(!rel||rel==='..'||rel.startsWith('..'+sep)||rel.startsWith(sep))throw Error('Reference destination must be under verify/references/gui');
 // Create directories, then resolve parents to reject symlink escapes before writing.
 await mkdir(base,{recursive:true});
 let current=base;
 for(const part of relative(base,dirname(target)).split(sep).filter(Boolean)){
   await inside(current,'verify/references/gui');current=resolve(current,part);
   await mkdir(current,{recursive:false}).catch(e=>{if(e.code!=='EEXIST')throw e;});
   await inside(current,'verify/references/gui');
 }
 const {lstat}=await import('node:fs/promises');for(const p of [target,target+'.json']){try{if((await lstat(p)).isSymbolicLink())throw Error('Reference symlink rejected');throw Error('Refusing to overwrite an existing reference');}catch(e){if(e.code!=='ENOENT')throw e;}}
 const metadata=JSON.parse(await readFile(source+'.json'));
 await copyFile(source,target);await writeFile(target+'.json',JSON.stringify({...metadata,approvedBy:options.reviewer,approvedAt:new Date().toISOString(),source:relative(root,source),policy:{channelTolerance:12,maximumChangedFraction:.005}},null,2)+'\n');
 console.log(`Accepted ${relative(root,target)} by ${options.reviewer}`);
}else throw Error('Use compare --reference PATH --actual PATH or accept --source PATH --destination PATH --reviewer NAME. No GUI is launched.');
