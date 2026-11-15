#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Original/edited analysis rendering contracts, disposable photos, no GUI/models."""
import importlib.util, json, shutil, tempfile, hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location("engine_checks",ROOT/"verify/engine-0460.py")
checks=importlib.util.module_from_spec(spec)
exec(compile((ROOT/"verify/engine-0460.py").read_text().replace("sys.exit(main())", ""),str(ROOT/"verify/engine-0460.py"),"exec"),checks.__dict__)
with tempfile.TemporaryDirectory(prefix="immage-analysis-preview-") as tmp:
 work=Path(tmp); first=work/"first.jpg";second=work/"second.jpg"
 shutil.copy(ROOT/"app/sample/stairs-to-mountain.jpg",first);shutil.copy(first,second)
 e=checks.Engine(ROOT/"build/bin/darktable-engine",work,[])
 try:
  a=e.ask(cmd="open",path=str(first))["imgid"];e.ask(cmd="baseline_end")
  output=work/"analysis.jpg"
  def preview(subject,tag=None):
   args=dict(cmd="analysis_preview",imgid=a,subject=subject,out=str(output))
   if tag is None: reply=e.ask(**args)
   else:
    e.child.stdin.write(json.dumps(args|{"tag":tag})+"\n");e.child.stdin.flush()
    assert e.sel.select(120),"analysis worker timeout"
    reply=json.loads(e.child.stdout.readline());assert reply.get("tag")==tag,reply
   assert reply.get("ok"),reply
   result=output.read_bytes();assert result.startswith(b"\xff\xd8"),"JPEG transport"
   return result
  original=preview("original")
  e.ask(cmd="set",op="exposure",enabled=True,params={"exposure":2.0});e.ask(cmd="save")
  def files():return {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in work.iterdir() if p.is_file() and p.name not in ["engine.log","analysis.jpg"]}
  before=files();assert preview("original")==original,"original changed with edits"
  edited=preview("edited");assert edited!=original,"edited ignored exposure"
  e.ask(cmd="close");b=e.ask(cmd="open",path=str(second))["imgid"]
  before=files();assert preview("original",999)==original
  assert preview("edited",1000)==edited
  assert files()==before,"analysis changed source or sidecars"
  assert e.ask(cmd="save").get("ok");assert e.ask(cmd="meta",imgid=b)["image"]["path"]==str(second)
  assert not e.ask(cmd="analysis_preview",imgid=a,subject="unknown",out=str(output)).get("ok")
  assert not e.ask(cmd="analysis_preview",imgid=99999999,subject="original",out=str(output)).get("ok")
  print("PASS independent original/edited sRGB analysis renders, worker path, preserved editor/files, invalid inputs")
 finally:e.quit()
