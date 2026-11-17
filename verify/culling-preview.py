#!/usr/bin/env python3
"""Independent native-resolution preview regression; disposable photos, no GUI."""
import importlib.util
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("engine_checks", ROOT / "verify/engine-0460.py")
checks = importlib.util.module_from_spec(spec)
exec(compile((ROOT / "verify/engine-0460.py").read_text().replace("sys.exit(main())", ""), str(ROOT / "verify/engine-0460.py"), "exec"), checks.__dict__)
with tempfile.TemporaryDirectory(prefix="immage-culling-") as tmp:
    work = Path(tmp)
    first = work / "first.jpg"
    second = work / "second.jpg"
    shutil.copy(ROOT / "app/sample/stairs-to-mountain.jpg", first)
    shutil.copy(first, second)
    e = checks.Engine(ROOT / "build/bin/darktable-engine", work, [])
    try:
        a = e.ask(cmd="open", path=str(first))["imgid"]
        e.ask(cmd="baseline_end")
        e.ask(cmd="set", op="exposure", enabled=True, params={"exposure": 1.0})
        e.ask(cmd="save")
        e.ask(cmd="close")
        b = e.ask(cmd="open", path=str(second))["imgid"]
        output = work / "detail.jpg"
        reply = e.ask(cmd="thumb", imgid=a, size=0, out=str(output))
        assert reply.get("ok"), reply
        assert reply.get("encoding") == "jpeg" and reply.get("source") == "rendered", reply
        assert output.read_bytes().startswith(b"\xff\xd8")
        # Unedited RAWs use the embedded image, without touching originals.
        raw = work / "raw.ARW"
        shutil.copy(ROOT / "benchmarking/corpus/DSC07636.ARW", raw)
        e.ask(cmd="close")
        rawid = e.ask(cmd="open", path=str(raw))["imgid"]
        e.ask(cmd="close")
        reply = e.ask(cmd="thumb", imgid=rawid, size=0, out=str(output))
        assert reply.get("ok") and reply.get("source") == "embedded", reply
        assert reply["width"] > 1000 and reply["height"] > 1000, reply
        assert len(output.read_bytes()) == reply["width"] * reply["height"] * 4
        e.ask(cmd="open", path=str(second))
        # Request through the worker, as the app does, without replacing b.
        import json
        e.child.stdin.write(json.dumps(dict(cmd="thumb", imgid=a, size=0, out=str(output), tag=999)) + "\n")
        e.child.stdin.flush()
        assert e.sel.select(120), "worker preview timed out"
        reply = json.loads(e.child.stdout.readline())
        assert reply.get("ok"), reply
        assert e.ask(cmd="save").get("ok")
        assert e.ask(cmd="meta", imgid=b)["image"]["path"] == str(second)
        reply = e.ask(cmd="thumb", imgid=9999999, size=0, out=str(output))
        assert not reply.get("ok"), reply
        print("PASS edited native preview, worker path, editor preserved, invalid image")
    finally:
        e.quit()
