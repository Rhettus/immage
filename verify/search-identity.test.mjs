// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
const require=createRequire(new URL('../app/package.json',import.meta.url));
const {transformSync}=await import(require.resolve('rolldown/experimental'));
const file=new URL('../app/src/searchIdentity.ts',import.meta.url);
const {searchIdentity,remoteFieldsKnown,preserveSearchEntries}=await import('data:text/javascript,'+encodeURIComponent(transformSync(file.pathname,readFileSync(file,'utf8')).code));
test('merge exact mapped primary paths while retaining copies and unmapped assets',()=>{
 const local={path:'/photos/a.jpg',copy:false,localIndex:{variantId:'1'}};
 const remote={remote:{assetId:'a',localPath:'/photos/a.jpg'}};
 assert.equal(searchIdentity('local',local),searchIdentity('immich',remote));
 assert.notEqual(searchIdentity('local',{...local,copy:true}),searchIdentity('immich',remote));
 assert.notEqual(searchIdentity('local',local),searchIdentity('immich',{remote:{assetId:'b',localPath:null}}));
 assert.notEqual(searchIdentity('local',local),searchIdentity('immich',{remote:{assetId:'a',localPath:'/photos2/a.jpg'}}));
 assert.notEqual(searchIdentity('local',local),searchIdentity('immich',{remote:{assetId:'a',localPath:'/photos/../photos/a.jpg'}}));
 assert.equal(searchIdentity('local',{path:'/photos/a.jpg'}),null);
 assert.equal(searchIdentity('local',{path:'/photos/a.jpg',copy:false,morfphotoPreview:true}),searchIdentity('immich',remote));
 assert.equal(searchIdentity('local',{path:'/photos/a.jpg',copy:true,morfphotoPreview:true}),null);
});
test('unknown remote placeholder fields cannot satisfy selected filters',()=>{
 const f={rejected:'all',edited:'all',labels:0,unlabeled:false,bodies:[],keywords:[]};
 assert.equal(remoteFieldsKnown(f),true);
 for(const patch of [{rejected:'hide'},{rejected:'only'},{edited:'unedited'},{edited:'edited'},{labels:1},{unlabeled:true},{bodies:['body']},{keywords:['tag']}])assert.equal(remoteFieldsKnown({...f,...patch}),false);
});

test('source pagination preserves opened remote handles and metadata edited in existing cells',()=>{
 const incoming={imgid:-1,rating:0,path:'immich:a.jpg',remote:{assetId:'remote-a',localPath:null}};
 const opened={...incoming,imgid:42,rating:4,path:'/photos/a.jpg',remote:{...incoming.remote,localPath:'/photos/a.jpg'}};
 const local={imgid:99,rating:2,path:'/photos/local.jpg',localIndex:{variantId:'local-a'}};
 const edited={...local,rating:5};
 const merged=preserveSearchEntries([incoming,local],[opened,edited]);
 assert.equal(merged[0],opened);assert.equal(merged[1],edited);
 assert.equal(preserveSearchEntries([incoming],[])[0],incoming,'new query does not reuse old cells');
 assert.equal(preserveSearchEntries([local],[opened])[0],local,'local index hit replaces deduplicated remote representation');
});
