#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Read-only recovery summary; never launches an app or changes the original run.
import { readFile,realpath } from 'node:fs/promises';
import { resolve,relative,sep } from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../results/gui/',import.meta.url));
const directory=await realpath(resolve(process.argv[2]??'')),base=await realpath(root),rel=relative(base,directory);
if(!rel||rel==='..'||rel.startsWith('..'+sep)||rel.startsWith(sep))throw Error('Specify one run directory under verify/results/gui');
let snapshot={};try{snapshot=JSON.parse(await readFile(resolve(directory,'report.json'),'utf8'));}catch{}
let text='';try{text=await readFile(resolve(directory,'events.jsonl'),'utf8');}catch{}
const events=[];for(const line of text.split('\n')){if(!line.trim())continue;try{events.push(JSON.parse(line));}catch{break;}}
const lastMemory=events.findLast(e=>e.type==='memory');
console.log(JSON.stringify({id:snapshot.id??rel,status:snapshot.finished?snapshot.status:'incomplete — no recorded finish (interrupted or still running)',cases:snapshot.cases??[],lastEvent:events.at(-1),lastAction:events.findLast(e=>e.type==='action'),lastMemory,errors:snapshot.errors??[],note:'A surviving screenshot or case-start event is not a pass. This command does not infer an OOM cause.'},null,2));
