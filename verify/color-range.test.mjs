// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
const modulePaths = Object.fromEntries(["react", "lucide-react"].map(name => [name, require.resolve(name)]));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core') return { url: 'data:text/javascript,export async function invoke(){}', shortCircuit: true };
    if (spec === 'react' || spec === 'lucide-react') return next(modulePaths[spec], ctx);
    if (spec.startsWith('./')) for (const ext of ['.ts', '.tsx']) {
      const url = new URL(spec + ext, ctx.parentURL);
      if (existsSync(url)) return next(url.href, ctx);
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, ctx);
    const path = fileURLToPath(url);
    return { format: 'module', source: transformSync(path, readFileSync(path, 'utf8')).code, shortCircuit: true };
  },
});
const { rangeChannels } = await import('../app/src/masks.ts');
test('color bands have ordered markers across hue wrap and broad feathered widths', () => {
  for (const hue of [0, .001, .2, .5, .8, .999, 1])
    for (const width of [.005, .04, .135, .3, .45])
      for (const feather of [.002, .04, .202, .25]) {
        const ch = rangeChannels({type:'color',hue,width,feather,chroma:.002});
        for (const r of Object.values(ch)) {
          assert(r.p.every(Number.isFinite));
          assert(r.p.every((v,i) => v >= 0 && v <= 1 && (!i || v >= r.p[i-1])), JSON.stringify({hue,width,feather,r}));
        }
      }
});
test('minimum chroma sets a soft floor and zero includes neutral pixels', () => {
  for (const chroma of [0,.002,.01,.1,.5]) {
    const { Cz } = rangeChannels({type:'color',hue:.4,width:.04,feather:.04,chroma});
    const p = Cz.p.map(v => v * 2 ** Cz.boost);
    assert(Math.abs(p[0]-chroma*.5)<1e-10);
    assert(Math.abs(p[1]-chroma)<1e-10);
    assert.equal(p[2],p[3]);
  }
});
