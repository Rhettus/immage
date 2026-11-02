#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors
"""Headless Linux engine integration smoke using an isolated synthetic PNG."""
import json,os,pathlib,selectors,struct,subprocess,tempfile,zlib
root=pathlib.Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='immage-output-smoke-') as tmp:
 p=pathlib.Path(tmp);w,h=128,96
 def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
 rows=b''.join(b'\0'+bytes(v for x in range(w) for v in (x*2,y*2,(x+y)%256)) for y in range(h))
 photo=p/'fixture.png';photo.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(rows))+chunk(b'IEND',b''))
 with (p/'engine.log').open('w') as log:
  child=subprocess.Popen([str(root/'build/bin/darktable-engine'),'--core','--configdir',str(p/'config'),'--cachedir',str(p/'cache'),'--conf','opencl=false','--conf','resourcelevel=0'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,env=os.environ|{'OMP_NUM_THREADS':'2','OMP_WAIT_POLICY':'passive','XDG_DATA_HOME':str(p/'data')})
  poll=selectors.DefaultSelector();poll.register(child.stdout,selectors.EVENT_READ)
  def req(data):
   child.stdin.write(json.dumps(data)+'\n');child.stdin.flush()
   assert poll.select(45),'engine response timed out'
   line=child.stdout.readline();r=json.loads(line);assert r.get('ok'),r;return r
  try:
   opened=req({'cmd':'open','path':str(photo)});imgid=opened.get('imgid')
   frames=p/'frame.rgba'
   for width,height in [(96,64),(48,32),(96,64),(80,51)]:
    r=req({'cmd':'render','width':width,'height':height,'rgba':str(frames)})
    b=frames.read_bytes();assert len(b)==4*r['width']*r['height'];assert set(b[3::4])=={255}
   preview=p/'preview.rgba';r=req({'cmd':'preview','size':64,'edits':{},'rgba':str(preview)});assert preview.stat().st_size==4*r['width']*r['height']
   if imgid is None:imgid=opened.get('id')
   assert imgid is not None,opened.keys()
   jpeg=p/'export-preview.jpg';req({'cmd':'export','imgid':imgid,'out':str(jpeg),'format':'jpeg','quality':85,'color_space':'srgb','long_edge':64,'draft':True,'transient':True});assert jpeg.read_bytes()[:2]==b'\xff\xd8'
   req({'cmd':'quit'});child.wait(timeout=15);assert child.returncode==0
   print('Real-engine PNG open, four render sizes, preview and transient JPEG export passed')
  finally:
   poll.close()
   if child.poll() is None:child.kill();child.wait()
