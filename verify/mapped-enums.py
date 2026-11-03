#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Compare mapped enum declarations between two darktable source revisions."""
import argparse,json,re,subprocess,pathlib
root=pathlib.Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--build",type=pathlib.Path,required=True)
parser.add_argument("--old",required=True)
parser.add_argument("--new",required=True)
args=parser.parse_args()
fields=json.loads(subprocess.check_output(['node',str(root/'verify/mapped-fields.mjs')]))
found={}
for op,names in fields.items():
 paths=list((args.build/'lib/darktable/plugins').glob(f'introspection_{op}.c*'))
 assert len(paths)==1,(op,paths)
 s=paths[0].read_text()
 for typ,name in re.findall(r'DT_INTROSPECTION_TYPE_ENUM, \(char\*\)"([^"]+)", \(char\*\)"([^"]+)"',s):
  if name in names:found.setdefault(typ,set()).add(f'{op}.{name}')
old,new=args.old,args.new
for typ,uses in sorted(found.items()):
 hits=subprocess.check_output(['git','-C',str(root/'darktable'),'grep','-l',f'enum {typ}',old,'--','src'],text=True).splitlines()
 defs=[]
 for hit in hits:
  path=hit.split(':',1)[1]
  texts=[subprocess.check_output(['git','-C',str(root/'darktable'),'show',f'{rev}:{path}'],text=True) for rev in (old,new)]
  pattern=rf'\benum\s+{typ}\s*\{{.*?\}}'
  matches=[re.findall(pattern,t,re.S) for t in texts]
  if matches[0]:
   assert matches[0]==matches[1],(typ,path)
   defs.append(path)
 assert defs,(typ,'definition not found')
 print(typ,','.join(sorted(uses)),','.join(defs),'unchanged')
print(len(found),'mapped enum types: definitions unchanged')
