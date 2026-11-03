#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors
"""Read/write every global/local manifest field through the real engine, headlessly."""
import argparse,json,math,os,pathlib,selectors,struct,subprocess,tempfile,zlib
root=pathlib.Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--build',type=pathlib.Path,default=root/'build')
parser.add_argument('--snapshot',type=pathlib.Path,help='Write initial live/default values for comparison')
parser.add_argument('--controls',action='store_true',help='Exercise production control writes, including all declared choices')
parser.add_argument('--read-report',type=pathlib.Path,help='With --controls, save production read/activation results for cross-build comparison')
args=parser.parse_args()
if args.read_report and not args.controls:parser.error('--read-report requires --controls')
build=args.build.resolve()
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
   snapshot={}
   for op,names in fields.items():
    state=req({'cmd':'get','modules':{op:names}})['modules'][op]
    snapshot[op]=state
    current=state['params']
    assert set(current)==set(names),(op,names,current)
    assert set(state['defaults'])==set(names),(op,state)
    # Use exactly representable binary fractions for floats, and 0/1 for
    # integral scalars (including booleans/enums). This checks storage, not
    # enum meaning or whether an arbitrary value is useful for rendering.
    for name,value in current.items():
     changed=(0 if value else 1) if float(value).is_integer() else (0.25 if value == 0.5 else 0.5)
     assert changed != value,(op,name,value)
     req({'cmd':'set','op':op,'field':name,'value':changed})
     after=req({'cmd':'get','modules':{op:names}})['modules'][op]['params']
     expected=current|{name:changed}
     assert after==expected,(op,name,expected,after)
     req({'cmd':'set','op':op,'field':name,'value':value})
     restored=req({'cmd':'get','modules':{op:names}})['modules'][op]['params']
     assert restored==current,(op,name,current,restored)
     count+=1
   if args.controls:
    seed=p/'snapshot.json';seed.write_text(json.dumps(snapshot))
    cases=json.loads(subprocess.check_output(['node',str(root/'verify/mapped-fields.mjs'),'--controls',str(seed)],text=True))
    records=[]
    for case in cases:
     op=case['op'];params=case['params']
     names=list(set(fields[op])|set(params))
     before=req({'cmd':'get','modules':{op:names}})['modules'][op]['params']
     req({'cmd':'set','op':op,'params':params})
     after=req({'cmd':'get','modules':{op:names}})['modules'][op]['params']
     expected=before|params
     assert set(after)==set(expected),(case,after)
     assert all(math.isclose(after[k],v,rel_tol=2e-6,abs_tol=2e-6) for k,v in expected.items()),(case,expected,after)
     if args.read_report:records.append(case|{'params':after,'defaults':snapshot[op]['defaults']})
     req({'cmd':'set','op':op,'params':before})
     restored=req({'cmd':'get','modules':{op:names}})['modules'][op]['params']
     assert restored==before,(case,before,restored)
    if args.read_report:
     source=p/'reads.json';source.write_text(json.dumps(records))
     results=subprocess.check_output(['node',str(root/'verify/mapped-fields.mjs'),'--reads',str(source)],text=True)
     args.read_report.write_text(results+'\n')
    print(f"Production control writes passed: {len(cases)} scenarios, {sum(c['choice'] for c in cases)} declared-choice scenarios; global/local maps, boundary/neutral values, neighbor preservation and restoration")
   req({'cmd':'quit'});child.wait(timeout=15);assert child.returncode==0
   if args.snapshot:args.snapshot.write_text(json.dumps(snapshot,indent=2,sort_keys=True)+'\n')
   print(f'Manifest changed-scalar access passed: {count} fields in {len(fields)} modules; global/local union, live/default reads, changed writes, neighbor preservation and restoration')
  except BaseException:
   log.flush();print((p/'engine.log').read_text())
   raise
  finally:
   poll.close()
   if child.poll() is None:child.kill();child.wait()
