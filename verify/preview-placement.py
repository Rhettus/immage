#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Pixel regression for WebKit canvas placement; run on a desktop at GDK_SCALE=2.

GDK_SCALE=2 python verify/preview-placement.py
Add --legacy to verify that fractional CSS canvas sizes fail this check.
Requires GTK 3, WebKitGTK 4.1 and Python's gi/cairo bindings.
"""
import json
import math
import pathlib
import subprocess
import sys

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import GLib, Gtk, WebKit2

ROOT = pathlib.Path(__file__).resolve().parent.parent
# Compile the production placement helper, with the same transformer as Vite.
compiled = subprocess.check_output(['node', '--input-type=module', '-e', '''
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
const require=createRequire(new URL('./app/package.json',import.meta.url));
const {transformSync}=await import(require.resolve('rolldown/experimental'));
process.stdout.write(transformSync('canvasLayers.ts',readFileSync('app/src/canvasLayers.ts','utf8')).code);
'''], cwd=ROOT, text=True)
legacy = '--legacy' in sys.argv
html = '''<style>body{margin:0;background:#777}canvas{position:absolute;left:0;top:0;
transform-origin:0 0;will-change:transform}</style><canvas></canvas><script type="module">
''' + compiled + '''
const canvas=document.querySelector('canvas'),dpr=devicePixelRatio;
const width=Math.floor(innerWidth*dpr-80)|1,height=Math.floor(innerHeight*dpr-80)|1;
const draftWidth=Math.floor(width*.75),scale=draftWidth/width;
function frame(w,h,s) {
  const data=new ImageData(w,h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const u=x/s,v=y/s;
    const value=128+35*Math.sin(u*.17+v*.11)+30*Math.sin(u*.09-v*.19)+25*Math.cos(u*.23+v*.07);
    const i=4*(y*w+x);data.data[i]=data.data[i+1]=data.data[i+2]=value;data.data[i+3]=255;
  }
  return data;
}
const full=frame(width,height,1),draft=frame(draftWidth,Math.floor(height*scale),scale);
window.showFrame=(reduced)=>{
  const data=reduced?draft:full,k=reduced?1/scale:1;
  canvas.width=data.width;canvas.height=data.height;
  canvas.getContext('2d').putImageData(data,0,0);
  const p={x:40-(k-1)/2,y:40-(k-1)/2,k};
  if(LEGACY){
    layerStyle(canvas,'width',`${data.width/dpr}px`);
    layerStyle(canvas,'height',`${data.height/dpr}px`);
    layerStyle(canvas,'transform',`translate(${p.x/dpr}px,${p.y/dpr}px) scale(${k})`);
  }else placeCanvas(canvas,data.width,data.height,p,dpr);
  return JSON.stringify({dpr,width,height});
};
</script>'''.replace('LEGACY', 'true' if legacy else 'false')

if not Gtk.init_check()[0]:
    sys.exit('A desktop display is required; run with GDK_SCALE=2.')
window = Gtk.Window()
window.set_default_size(1280, 900)
view = WebKit2.WebView()
window.add(view)
window.show_all()
snapshots = []
errors = []
geometry = {}


def fail(error):
    errors.append(str(error))
    Gtk.main_quit()


def capture(reduced):
    def evaluated(widget, result, *_args):
        try:
            geometry.update(json.loads(widget.evaluate_javascript_finish(result).to_string()))
            if geometry['dpr'] != 2:
                raise RuntimeError('This regression requires devicePixelRatio=2; run with GDK_SCALE=2.')
        except Exception as error:
            fail(error)
            return

        def snapshot():
            def done(widget, result, *_args):
                try:
                    surface = widget.get_snapshot_finish(result)
                    surface.flush()
                    snapshots.append((surface.get_width(), surface.get_height(), surface.get_stride(), bytes(surface.get_data())))
                    if reduced:
                        Gtk.main_quit()
                    else:
                        capture(True)
                except Exception as error:
                    fail(error)
            view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, done, None)
            return False
        GLib.timeout_add(250, snapshot)
    view.evaluate_javascript('window.showFrame(' + str(reduced).lower() + ')', -1, None, None, None, evaluated, None)


def loaded(_view, event):
    if event == WebKit2.LoadEvent.FINISHED:
        GLib.timeout_add(250, lambda: capture(False))


view.connect('load-changed', loaded)
view.load_html(html, 'file:///tmp/')
GLib.timeout_add_seconds(30, lambda: fail('WebKit snapshot timed out'))
Gtk.main()
window.destroy()
if errors:
    sys.exit('\n'.join(errors))

# Compare texture gradients, ignoring the image's border and the window's size.
# A sharpness difference is allowed; a systematic translation is not.
width, height, stride, full = snapshots[0]
w2, h2, s2, draft = snapshots[1]
assert (width, height, stride) == (w2, h2, s2)
xmax = min(width - 60, geometry['width'] + 20)
ymax = min(height - 60, geometry['height'] + 20)


def gradient(data, x, y):
    p = int(y) * stride + int(x) * 4
    return data[p-32] + data[p+32] + data[p-8*stride] + data[p+8*stride] - 4*data[p]


points = [(x, y, gradient(full, x, y)) for y in range(70, ymax, 13) for x in range(70, xmax, 13)]
assert len(points) > 100, 'Test window is too small'


def correlation(dx, dy):
    aa = bb = ab = 0.0
    for x, y, a in points:
        u, v = x + dx, y + dy
        i, j = math.floor(u), math.floor(v)
        fx, fy = u-i, v-j
        b = ((1-fy)*((1-fx)*gradient(draft, i, j) + fx*gradient(draft, i+1, j))
             + fy*((1-fx)*gradient(draft, i, j+1) + fx*gradient(draft, i+1, j+1)))
        aa += a*a
        bb += b*b
        ab += a*b
    return ab / math.sqrt(aa*bb)


best = max((correlation(dx/8, dy/8), dx/8, dy/8) for dx in range(-8, 9) for dy in range(-8, 9))
print(f'{"Legacy" if legacy else "Native"} canvas placement: best shift {best[1:]} device pixels; correlation {best[0]:.6f}')
assert best[0] > .95, 'Rendered textures do not match'
assert best[1:] == (0.0, 0.0), 'Preview shifts relative to the final frame'
