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

const { colorzonesMap, czPointValues, czPointsOf } = await import('../app/src/manifest.ts');
const { GRAPHS, graphFields } = await import('../app/src/graphMaps.ts');
const { czCurveFn, czDefaultPoints, czSampleV2, czBandColors, czLabToSrgb } = await import('../app/src/colorzones.ts');
const { layoutFor } = await import('../app/src/advancedLayout.ts');

// params as the engine reports them: slots past the count are zero
const params = (version, channel, pages) => {
  const p = { channel, splines_version: version };
  pages.forEach(({ pts, type }, ch) => {
    p[`curve_num_nodes[${ch}]`] = pts.length;
    p[`curve_type[${ch}]`] = type;
    for (let k = 0; k < 20; k++) { p[`curve[${ch}][${k}].x`] = pts[k]?.[0] ?? 0; p[`curve[${ch}][${k}].y`] = pts[k]?.[1] ?? 0; }
  });
  return p;
};
const round = (p) => { const { channel, splines_version, ...rest } = p; return rest; };

test('the color zones graph is wired to the layout', () => {
  assert.equal(GRAPHS.colorzones, colorzonesMap);
  assert.deepEqual(graphFields('colorzones').sort(), ['channel', 'curve', 'curve_num_nodes', 'curve_type', 'splines_version']);
  assert.equal(layoutFor('colorzones', 'hsl')?.graph, 'colorzones');
});

test('a periodic hue curve round-trips through the map', () => {
  const pages = [
    { pts: [[0.25, 0.5], [0.75, 0.5]], type: 1 },
    { pts: [[0.1, 0.3], [0.4, 0.8], [0.9, 0.2]], type: 0 },
    { pts: [[0.02, 0.5], [0.3, 0.9], [0.6, 0.1], [0.97, 0.5]], type: 2 },
  ];
  const p = params(1, 2, pages);
  const v = colorzonesMap.read(p, {}, {});
  assert.equal(v.cz_channel, 2);
  assert.equal(v.cz_version, 1);
  assert.deepEqual(czPointsOf(v, 2), pages[2].pts);
  assert.equal(v.cz1t, 0);
  assert.deepEqual(colorzonesMap.write(v, {}, {}), round(p));
});

test('a V1 history keeps its node count, its types and no splines_version write', () => {
  const pages = [0, 1, 2].map(() => ({ pts: [[0, 0.5], [0.5, 0.7], [1, 0.5]], type: 1 }));
  const p = params(0, 0, pages);
  const v = colorzonesMap.read(p, {}, {});
  assert.equal(v.cz_version, 0);
  const out = colorzonesMap.write(v, {}, {});
  assert.deepEqual(out, round(p));
  assert.ok(!('splines_version' in out) && !('channel' in out));
});

test('a V1 curve never reads below two nodes, a V2 one may have one', () => {
  const one = { pts: [[0.5, 0.5]], type: 1 };
  const v1 = colorzonesMap.read(params(0, 2, [one, one, one]), {}, {});
  assert.equal(czPointsOf(v1, 0).length, 2);
  const v2 = colorzonesMap.read(params(1, 2, [one, one, one]), {}, {});
  assert.deepEqual(czPointsOf(v2, 0), [[0.5, 0.5]]);
});

test('missing params read as darktable defaults, and a deletion zeroes the freed slot', () => {
  const v = colorzonesMap.read({ channel: 2, splines_version: 1 }, {}, {});
  assert.deepEqual(czPointsOf(v, 1), czDefaultPoints(1, true));
  assert.deepEqual(czDefaultPoints(1, true), [[0.25, 0.5], [0.75, 0.5]]);
  assert.deepEqual(czDefaultPoints(1, false), [[0, 0.5], [1, 0.5]]);
  assert.deepEqual(czDefaultPoints(0, true), [[0, 0.5], [1, 0.5]]);
  const cut = colorzonesMap.write({ ...v, ...czPointValues([[0.5, 0.5]], 1) }, {}, {});
  assert.equal(cut['curve_num_nodes[1]'], 1);
  assert.equal(cut['curve[1][1].x'], 0);
});

test('the V2 sampler matches values worked out from splines.cpp', () => {
  const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-5, `${m}: ${a} vs ${b}`);
  for (const type of [0, 1, 2]) {
    const line = czSampleV2(type, [[0, 0], [1, 1]], false);
    for (const x of [0, 0.3, 1]) near(line(x), x, `line type ${type}`);
  }
  // natural cubic spline through (0,0) (.5,1) (1,0): second derivative -12 at the middle
  const cubic = czSampleV2(0, [[0, 0], [0.5, 1], [1, 0]], false);
  near(cubic(0.5), 1, 'cubic knot');
  near(cubic(0.25), 0.6875, 'cubic mid segment');
  near(cubic(0.75), 0.6875, 'cubic symmetry');
  // Catmull-Rom: tangents (1-0)/1 at the ends, (y2-y0)/(x2-x0) inside
  const cr = czSampleV2(1, [[0, 0], [0.5, 1], [1, 0]], false);
  // tangents 2 and 0 (the ends use the one-sided slope), so at the segment's middle 0.125 * 0.5 * 2 + 0.5 * 1
  near(cr(0.25), 0.625, 'catmull');
  // monotone Hermite never overshoots a step
  const mono = czSampleV2(2, [[0, 0], [0.4, 0.2], [0.6, 0.8], [1, 1]], false);
  for (let i = 0; i <= 100; i++) assert.ok(mono(i / 100) >= -1e-9 && mono(i / 100) <= 1 + 1e-9);
  // the ends hold outside the first and last node
  const held = czSampleV2(1, [[0.2, 0.3], [0.8, 0.9]], false);
  near(held(0), 0.3, 'held start'); near(held(1), 0.9, 'held end');
});

test('flat curves stay flat and periodic curves are continuous across the seam', () => {
  for (const type of [0, 1, 2]) for (const periodic of [false, true]) {
    const f = czSampleV2(type, [[0.25, 0.5], [0.75, 0.5]], periodic);
    for (let i = 0; i <= 20; i++) assert.ok(Math.abs(f(i / 20) - 0.5) < 1e-9);
  }
  for (const type of [0, 1, 2]) {
    const f = czSampleV2(type, [[0.1, 0.9], [0.4, 0.2], [0.8, 0.7]], true);
    assert.ok(Math.abs(f(0) - f(1)) < 1e-9, `type ${type} value`);
    const e = 1e-6;
    assert.ok(Math.abs(f(1 - e) - f(0 + e)) < 1e-4, `type ${type} across the seam`);
    assert.ok(Math.abs(f(0.1) - 0.9) < 1e-6 && Math.abs(f(0.8) - 0.7) < 1e-6, `type ${type} through the nodes`);
  }
});

test('the band uses darktable colors', () => {
  const hue = czBandColors(2);
  assert.equal(hue.length, 64);
  assert.notEqual(hue[0], hue[16]);
  const grey = czBandColors(0);
  assert.match(grey[0], /^rgb\(/);
  // L 50, a = b = 0 is a mid gray (about sRGB 119)
  const [r, g, b] = czLabToSrgb(50, 0, 0);
  assert.ok(Math.abs(r - 0.466) < 0.01 && Math.abs(r - g) < 0.01 && Math.abs(r - b) < 0.01);
});
