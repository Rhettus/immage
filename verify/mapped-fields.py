#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors
"""Read/write every global/local manifest field through the real engine, headlessly."""
import argparse,json,os,pathlib,selectors,struct,subprocess,tempfile,zlib
root=pathlib.Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--build',type=pathlib.Path,default=root/'build')
build=parser.parse_args().build.resolve()
fields=json.loads(subprocess.check_output(['node',str(root/'verify/mapped-fields.mjs')],text=True))
with tempfile.TemporaryDirectory(prefix='immage-mapped-fields-') as tmp:
 p=pathlib.Path(tmp);w,h=128,96
 def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
 rows=b''.join(b'\0'+bytes(v for x in range(w) for v in (x*2,y*2,(x+y)%256)) for y in range(h))
 photo=p/'fixture.png';photo.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(rows))+chunk(b'IEND',b''))
 with (p/'engine.log').open('w') as log:
  child=subprocess.Popen([str(build/'bin/darktable-engine'),'--core','--configdir',str(p/'config'),'--cachedir',str(p/'cache'),'--datadir',str(build/'share/darktable'),'--moduledir',str(build/'lib/darktable'),'--conf','opencl=false','--conf','resourcelevel=0'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,env=os.environ|{'OMP_NUM_THREADS':'2','OMP_WAIT_POLICY':'passive','XDG_DATA_HOME':str(p/'data')})
  poll=selectors.DefaultSelector();poll.register(child.stdout,selectors.EVENT_READ)
  def req(data, ok=True):
   child.stdin.write(json.dumps(data)+'\n');child.stdin.flush()
   assert poll.select(45),'engine response timed out'
   line=child.stdout.readline();r=json.loads(line);assert bool(r.get('ok')) == ok,r;return r
  try:
   req({'cmd':'open','path':str(photo)})
   count=0
   for op,names in fields.items():
    state=req({'cmd':'get','modules':{op:names}})['modules'][op]
    current=state['params']
    assert set(current)==set(names),(op,names,current)
    assert set(state['defaults'])==set(names),(op,state)
    # Write each scalar separately through the production setter. Preserve its
    # actual initial value, including enum/bool/array elements, then verify all
    # fields together to detect overwrites of adjacent parameter storage.
    for name,value in current.items():
     req({'cmd':'set','op':op,'field':name,'value':value})
     after=req({'cmd':'get','modules':{op:names}})['modules'][op]['params']
     assert after==current,(op,name,current,after)
     count+=1
   req({'cmd':'quit'});child.wait(timeout=15);assert child.returncode==0
   print(f'Manifest scalar access passed: {count} fields in {len(fields)} modules; global/local union, live/default reads and individual writes')
  except BaseException:
   log.flush();print((p/'engine.log').read_text())
   raise
  finally:
   poll.close()
   if child.poll() is None:child.kill();child.wait()
