// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
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

const { settings } = await import('../app/src/settings.ts');
const { bitDepths, exportOptionsFor, loadSettings, DEFAULTS } = await import('../app/src/exportSettings.ts');

test('JPEG XL sends quality and its own bit depth', () => {
  assert.deepEqual(bitDepths('jxl'), [8, 10, 12, 16]);
  assert.deepEqual(exportOptionsFor({ format: 'jxl', quality: 100, bpp: 12 }), { quality: 100, bpp: 12 });
  assert.deepEqual(exportOptionsFor({ format: 'jxl', quality: 80, bpp: 10 }), { quality: 80, bpp: 10 });
});

test('TIFF and PNG take only 8 or 16 bit, so a JPEG XL depth is sent as 16', () => {
  assert.deepEqual(bitDepths('tiff'), [8, 16]);
  assert.deepEqual(bitDepths('png'), [8, 16]);
  for (const format of ['tiff', 'png']) {
    assert.deepEqual(exportOptionsFor({ format, quality: 90, bpp: 12 }), { quality: null, bpp: 16 }, format);
    assert.deepEqual(exportOptionsFor({ format, quality: 90, bpp: 10 }), { quality: null, bpp: 16 }, format);
    assert.deepEqual(exportOptionsFor({ format, quality: 90, bpp: 8 }), { quality: null, bpp: 8 }, format);
  }
});

test('JPEG and WebP send quality only, and no bit depth', () => {
  assert.deepEqual(exportOptionsFor({ format: 'jpeg', quality: 85, bpp: 16 }), { quality: 85, bpp: null });
  assert.deepEqual(exportOptionsFor({ format: 'webp', quality: 70, bpp: 8 }), { quality: 70, bpp: null });
});

test('saved export settings accept jxl and its bit depths, and fall back on invalid values', () => {
  const saved = (o) => {
    for (const k of settings.keys()) settings.remove(k);
    settings.set('immage.export', JSON.stringify(o));
    return loadSettings();
  };
  assert.equal(saved({ format: 'jxl', bpp: 12, askMigrated: true }).format, 'jxl');
  assert.equal(saved({ format: 'jxl', bpp: 12, askMigrated: true }).bpp, 12);
  assert.equal(saved({ format: 'bogus', bpp: 9, askMigrated: true }).format, DEFAULTS.format);
  assert.equal(saved({ format: 'bogus', bpp: 9, askMigrated: true }).bpp, DEFAULTS.bpp);
  for (const k of settings.keys()) settings.remove(k);
});
