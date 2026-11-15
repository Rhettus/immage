#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Precise capture metadata through actual engine JSON, no GUI/models."""
import importlib.util, subprocess, tempfile, json
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location("engine_checks",ROOT/"verify/engine-0460.py")
checks=importlib.util.module_from_spec(spec)
exec(compile((ROOT/"verify/engine-0460.py").read_text().replace("sys.exit(main())", ""),str(ROOT/"verify/engine-0460.py"),"exec"),checks.__dict__)
with tempfile.TemporaryDirectory(prefix="immage-capture-json-") as tmp:
 work=Path(tmp)
 subprocess.run([str(ROOT/"build/bin/immage-thumbnail-check"),str(work),"--capture-only"],check=True)
 e=checks.Engine(ROOT/"build/bin/darktable-engine",work,[])
 try:
  opened=e.ask(cmd="open",path=str(work/"capture.jpg"));assert opened.get("ok"),opened
  reply=e.ask(cmd="meta",imgid=opened["imgid"]);assert reply.get("ok"),reply
  exif=reply["image"]["exif"]
  assert exif["capture_time_raw"]=="2026:11:15 12:34:56.123456789",exif
  assert exif["capture_offset"]=="-07:30",exif
  assert exif["body_serial"]=="BODY-123",exif
  e.child.stdin.write(json.dumps({"cmd":"meta","imgid":opened["imgid"],"tag":999})+"\n");e.child.stdin.flush()
  assert e.sel.select(120),"tagged metadata worker timed out"
  worker=json.loads(e.child.stdout.readline());assert worker.get("ok") and worker.get("tag")==999,worker
  assert worker["image"]["exif"]==exif,"worker metadata changed capture fields"
  print("PASS foreground/worker engine JSON preserves capture fraction, UTC offset and body serial")
 finally:e.quit()
