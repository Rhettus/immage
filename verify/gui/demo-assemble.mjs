#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
//
// Builds the demo video from a `demo` case recording (timeline.json and
// frames/): a drawn cursor and click ring from the pointer log, captions,
// then an MP4. Offline; touches no app or desktop.
//   node verify/gui/demo-assemble.mjs DIR [--width 1280] [--fps 20]
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] ?? '');
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
const width = opt('--width', 1280), fps = opt('--fps', 20);
const tl = JSON.parse(await readFile(join(dir, 'timeline.json'), 'utf8'));
const S = tl.scale || 1;

// a small PNG, written by hand (no image library here): the arrow cursor and the click ring
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixel(x, y).forEach((v, i) => { raw[y * (w * 4 + 1) + 1 + x * 4 + i] = v; });
  const crc = (buf => { let c, table = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    let r = 0xffffffff; for (const b of buf) r = table[(r ^ b) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; });
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const inside = (x, y, poly) => { let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    if ((poly[i][1] > y) !== (poly[j][1] > y) && x < (poly[j][0] - poly[i][0]) * (y - poly[i][1]) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
  return c; };
const size = Math.round(28 * S), k = size / 28;
const arrow = [[1, 1], [1, 20], [6, 15.5], [10, 24], [13, 22.5], [9, 14.5], [16, 14.5]].map(([x, y]) => [x * k, y * k]);
const fat = arrow.map(([x, y]) => [x, y]); // outline drawn by testing a few offsets
await writeFile(join(dir, 'cursor.png'), png(size, size, (x, y) => {
  if (inside(x, y, arrow)) return [255, 255, 255, 255];
  for (const [dx, dy] of [[-1.5, 0], [1.5, 0], [0, -1.5], [0, 1.5]]) if (inside(x + dx * k, y + dy * k, fat)) return [20, 20, 20, 255];
  return [0, 0, 0, 0]; }));
const ring = Math.round(44 * S);
await writeFile(join(dir, 'ring.png'), png(ring, ring, (x, y) => {
  const d = Math.hypot(x - ring / 2, y - ring / 2) / (ring / 2);
  return d > .78 && d < .98 ? [255, 214, 70, 230] : [0, 0, 0, 0]; }));

// pointer position at time t (ms) from the log; a move runs over its `ms`
const path = tl.cursor;
function at(t) {
  // a move begins when it was logged and takes its own ms: the pointer is
  // at the previous point until then, between the two during it, then there
  let from = path[0], to = path[0], start = 0;
  for (const p of path) {
    if (p.click) continue;
    if (p.t > t) break;
    from = to; to = p; start = p.t;
  }
  const f = to.ms ? Math.max(0, Math.min(1, (t - start) / to.ms)) : 1;
  return { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f };
}
const clicks = path.filter(p => p.click);

// frames: hold each screenshot until the next
const frames = tl.frames, end = frames.at(-1).t + 1500;
let list = '';
frames.forEach((f, i) => { list += `file '${join(dir, f.file)}'\nduration ${(((frames[i + 1]?.t ?? end) - f.t) / 1000).toFixed(4)}\n`; });
list += `file '${join(dir, frames.at(-1).file)}'\n`;
await writeFile(join(dir, 'frames.txt'), list);

// per-output-frame overlay positions through sendcmd
let cmd = '';
const total = Math.floor(end / 1000 * fps);
for (let n = 0; n < total; n++) {
  const t = n * 1000 / fps, p = at(t);
  const e = t.toFixed(3) / 1000;
  cmd += `${(t / 1000).toFixed(3)} overlay@cur x ${(p.x * S).toFixed(0)}, overlay@cur y ${(p.y * S).toFixed(0)};\n`;
  const c = clicks.find(c => t >= c.t && t < c.t + 450);
  cmd += c ? `${(t / 1000).toFixed(3)} overlay@ring x ${(c.x * S - ring / 2).toFixed(0)}, overlay@ring y ${(c.y * S - ring / 2).toFixed(0)};\n`
           : `${(t / 1000).toFixed(3)} overlay@ring x -500, overlay@ring y -500;\n`;
  void e;
}
await writeFile(join(dir, 'cmds.txt'), cmd);

// captions: a drawtext per segment, shown until the next
const esc = s => s.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", '’').replaceAll('%', '\\%');
const caps = tl.captions.map((c, i) => {
  const a = c.t / 1000, b = (tl.captions[i + 1]?.t ?? end) / 1000;
  return `drawtext=font=sans:text='${esc(c.text)}':x=(w-text_w)/2:y=h-70:fontsize=${Math.round(30 * S)}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=14:enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`;
}).join(',');
// overlay needs eval=frame to take x/y changes, and sendcmd goes after the overlays it drives
const graph = `[0:v]fps=${fps},format=yuv420p[base];[base][1:v]overlay@cur=0:0:eval=frame:format=auto[a];[a][2:v]overlay@ring=-500:-500:eval=frame:format=auto,sendcmd=f=${join(dir, 'cmds.txt')},scale=${width}:-2${caps ? ',' + caps : ''},format=yuv420p[v]`;
const mp4 = join(dir, 'immage-demo.mp4');
execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt'), '-loop', '1', '-i', join(dir, 'cursor.png'),
  '-loop', '1', '-i', join(dir, 'ring.png'), '-filter_complex', graph, '-map', '[v]', '-t', String(end / 1000),
  '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
console.log(`wrote ${mp4}`);
