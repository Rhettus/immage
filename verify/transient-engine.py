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
  def req(data, ok=True):
   child.stdin.write(json.dumps(data)+'\n');child.stdin.flush()
   assert poll.select(45),'engine response timed out'
   line=child.stdout.readline();r=json.loads(line);assert bool(r.get('ok')) == ok,r;return r
  try:
   opened=req({'cmd':'open','path':str(photo)});imgid=opened.get('imgid')
   frames=p/'frame.rgba'
   for width,height in [(96,64),(48,32),(96,64),(80,51)]:
    r=req({'cmd':'render','width':width,'height':height,'rgba':str(frames)})
    b=frames.read_bytes();assert len(b)==4*r['width']*r['height'];assert set(b[3::4])=={255}
   # PPM opts into the legacy BGRX backbuf; compare its simultaneous RGBA
   # output byte-for-byte with the direct sink, including warm cache and resize.
   for mode in ({}, {'draft':True}, {'base':True}):
    for width,height in [(97,65),(49,33),(97,65),(97,65)]:
     args={'cmd':'render','width':width,'height':height}|mode
     direct=req(args|{'rgba':str(frames)})
     pixels=frames.read_bytes()
     assert 'process_output_ms' in direct,direct
     legacy=p/'legacy.rgba';ppm=p/'legacy.ppm'
     old=req(args|{'rgba':str(legacy),'out':str(ppm)})
     assert (direct['width'],direct['height'],direct['hash']) == (old['width'],old['height'],old['hash'])
     assert pixels==legacy.read_bytes(),'sink differs from legacy conversion'
     assert ppm.read_bytes().split(b'\n',3)[3] == bytes(v for i,v in enumerate(pixels) if i%4!=3)
     assert 'process_output_ms' not in old
     # A retained client frame must not acquire/write a destination at all.
     kept=req(args|{'rgba':str(p/'missing'/'kept.rgba'),'have':[direct['hash']]})
     assert kept.get('kept') and kept['width']==0,kept
    # Failed destination must not reply with an old frame or poison the next
    # sink/legacy request. The same cache pixels must remain usable afterward.
    req(args|{'rgba':str(p/'missing'/'failed.rgba')},ok=False)
    recovered=req(args|{'rgba':str(frames)})
    assert frames.read_bytes()==pixels and recovered['hash']==direct['hash']
    req(args|{'out':str(ppm),'rgba':str(legacy)})
    assert legacy.read_bytes()==pixels
   child.stdin.write(json.dumps({'cmd':'cancel_base','id':100})+'\n');child.stdin.flush()
   canceled=p/'canceled.rgba'
   req({'cmd':'render','base':True,'id':100,'rgba':str(canceled)},ok=False)
   assert not canceled.exists(),'pre-canceled render published output'
   req({'cmd':'render','base':True,'id':101,'rgba':str(frames),'width':97,'height':65})
   preview=p/'preview.rgba' ;r=req({'cmd':'preview','size':64,'edits':{},'rgba':str(preview)});assert preview.stat().st_size==4*r['width']*r['height']
   if imgid is None:imgid=opened.get('id')
   assert imgid is not None,opened.keys()
   jpeg=p/'export-preview.jpg';req({'cmd':'export','imgid':imgid,'out':str(jpeg),'format':'jpeg','quality':85,'color_space':'srgb','long_edge':64,'draft':True,'transient':True});assert jpeg.read_bytes()[:2]==b'\xff\xd8'
   req({'cmd':'quit'});child.wait(timeout=15);assert child.returncode==0
   print('Real-engine PNG open, full/drag/base sink equality, resize/cache/reuse/failure recovery, preview and JPEG export passed')
  finally:
   poll.close()
   if child.poll() is None:child.kill();child.wait()
