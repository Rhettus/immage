# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors
"""Derived photo, uncompressed Bayer DNG with known isolated hot sensor sites."""
import argparse, array, hashlib, json, struct, subprocess
from pathlib import Path
W,H=1024,576
root=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,required=True,help='DNG output in an isolated verification fixture directory')
parser.add_argument('--source',type=Path,default=root/'app/sample/stairs-to-mountain.jpg')
args=parser.parse_args()
out=args.output
out.parent.mkdir(parents=True,exist_ok=True)
rgb=array.array('H',subprocess.check_output(['magick',str(args.source),'-resize',f'{W}x{H}!','-colorspace','RGB','-depth','16','-endian','LSB','rgb:-']))
assert len(rgb)==W*H*3
raw=array.array('H',[0])*(W*H)
for y in range(H):
 for x in range(W):
  ch=0 if y%2==0 and x%2==0 else 2 if y%2 and x%2 else 1
  raw[y*W+x]=300+int(rgb[(y*W+x)*3+ch]*.12)
defects=[]
for y in range(12,H-12,20):
 for x in range(12,W-12,20):
  value=[2000,6000,15000,45000][(x//20+y//20)%4]
  raw[y*W+x]=value
  for dx,dy in [(-2,0),(2,0),(0,-2),(0,2)]: raw[(y+dy)*W+x+dx]=200
  defects.append([x,y,value])
# TIFF field types: BYTE=1 ASCII=2 SHORT=3 LONG=4 RATIONAL=5 SRATIONAL=10.
tags=[]
def tag(k,t,values):
 if t==2: b=values.encode()+b'\0';n=len(b)
 elif t==1: b=bytes(values);n=len(values)
 elif t in (3,4): b=struct.pack('<'+('H' if t==3 else 'I')*len(values),*values);n=len(values)
 else: b=b''.join(struct.pack('<'+('ii' if t==10 else 'II'),a,b) for a,b in values);n=len(values)
 tags.append([k,t,n,b])
for k,v in [(254,0),(256,W),(257,H),(273,0),(278,H),(279,len(raw)*2),(50717,65535)]:tag(k,4,[v])
for k,v in [(258,16),(259,1),(262,32803),(274,1),(277,1),(284,1),(50711,1),(50778,21)]:tag(k,3,[v])
tag(271,2,'Immage synthetic fixture');tag(272,2,'Known hot sensor sites');tag(50708,2,'Immage Known Hot Sensor Sites')
tag(33421,3,[2,2]);tag(33422,1,[0,1,1,2]);tag(50706,1,[1,4,0,0]);tag(50707,1,[1,1,0,0]);tag(50710,1,[0,1,2])
tag(50714,5,[(0,1)]);tag(50721,10,[(1 if i in (0,4,8) else 0,1) for i in range(9)]);tag(50728,5,[(1,1)]*3)
tags.sort();offset=8+2+12*len(tags)+4
extra=bytearray();entries=[]
for k,t,n,b in tags:
 if len(b)>4:
  field=struct.pack('<I',offset+len(extra));extra+=b
  if len(extra)%2:extra+=b'\0'
 else:field=b.ljust(4,b'\0')
 entries.append([k,t,n,field])
raw_offset=offset+len(extra)
for e in entries:
 if e[0]==273:e[3]=struct.pack('<I',raw_offset)
data=b'II'+struct.pack('<HI',42,8)+struct.pack('<H',len(entries))+b''.join(struct.pack('<HHI',k,t,n)+b for k,t,n,b in entries)+struct.pack('<I',0)+extra+raw.tobytes()
out.write_bytes(data)
out.with_suffix('.json').write_text(json.dumps({'kind':'synthetic CFA positive fixture derived from sample JPEG','sourceSha256':hashlib.sha256(args.source.read_bytes()).hexdigest(),'dngSha256':hashlib.sha256(data).hexdigest(),'width':W,'height':H,'defects':defects,'sameColorCrossNeighborDN':200,'whiteLevel':65535},indent=2)+'\n')
print('Created controlled Bayer fixture:',len(defects),'isolated hot sensor sites')
