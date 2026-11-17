#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless CLIP protocol guards; no photos, model downloads or GUI."""
import json, os, selectors, struct, subprocess, tempfile, sys, math
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="immage-clip-engine-") as temp:
    work=Path(temp)
    log=(work/"engine.log").open("w")
    extra=[]
    if "--synthetic-onnx" in sys.argv:
        ort=Path(os.environ.get("IMMAGE_TEST_ORT",str(ROOT/"build/_deps/onnxruntime/lib/libonnxruntime.so")))
        assert ort.is_file(), "Set IMMAGE_TEST_ORT to the built CPU ONNX Runtime library"
        extra=["--conf",f"plugins/ai/ort_library_path={ort}"]
    child=subprocess.Popen([str(ROOT/"build/bin/darktable-engine"),"--core","--configdir",str(work/"config"),"--cachedir",str(work/"cache"),"--conf","opencl=false","--conf","resourcelevel=0","--conf","plugins/ai/enabled=true","-d","ai",*extra],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,env=os.environ|{"XDG_DATA_HOME":str(work/"data"),"OMP_NUM_THREADS":"2"})
    selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ)
    pending=bytearray()
    def receive():
        while b"\n" not in pending:
            assert selector.select(60), "engine response timed out"
            block=os.read(child.stdout.fileno(),65536)
            assert block, "engine exited"
            pending.extend(block)
        line,_,rest=pending.partition(b"\n")
        pending[:]=rest
        return json.loads(line)
    tag=0
    def ask(**req):
        global tag
        tag+=1
        child.stdin.write(json.dumps(req|{"tag":tag})+"\n");child.stdin.flush()
        reply=receive();assert reply.get("tag")==tag,reply
        return reply
    def refused(fragment,**kw):
        reply=ask(cmd="clip_embed",model_root=str(work/"missing-models"),**kw)
        assert reply.get("ok") is False and fragment in reply.get("error",""),reply
    try:
        refused("tower",tower="unknown",input=str(work/"missing"))
        refused("paths",tower="text",input="relative.bin")
        refused("size",tower="text",input=str(work/"missing"))
        tensor=work/"tensor.bin";tensor.write_bytes(b"bad")
        refused("size",tower="text",input=str(tensor))
        tensor.write_bytes(struct.pack("<154q",*([49406]+[49407]*76+[1,1]+[0]*75)))
        refused("unavailable",tower="text",input=str(tensor))
        tensor.write_bytes(struct.pack("<154q",*([-1]+[49407]*76+[1]*77)))
        refused("values",tower="text",input=str(tensor))
        tensor.write_bytes(struct.pack("<154q",*([49406]+[49407]*76+[1,0,1]+[0]*74)))
        refused("values",tower="text",input=str(tensor))
        tensor.write_bytes(struct.pack("<f",float("nan"))*(3*224*224))
        refused("values",tower="vision",input=str(tensor))
        if "--synthetic-onnx" in sys.argv:
            # Locally generated tiny graphs test CPU execution/I/O mapping only.
            # They are not downloaded CLIP weights or semantic-quality fixtures.
            import numpy as np
            import onnx
            from onnx import TensorProto as T, helper as H, numpy_helper as N
            package=work/"synthetic-package"; (package/"engine").mkdir(parents=True);(package/"onnx").mkdir()
            (package/"engine/config.json").write_text(json.dumps({"id":"immage-clip","name":"Synthetic CLIP protocol fixture","backend":"onnx"}))
            def constant(name,array):
                return H.make_node("Constant",[],[name],value=N.from_array(array,name=name))
            def save(vision,wrong=False):
                hidden=(1,50,768) if vision else (1,77,512)
                nodes=[constant("zeros",np.zeros((1,510),dtype=np.float32)),constant("hidden",np.zeros(hidden,dtype=np.float32))]
                if vision:
                    inputs=[H.make_tensor_value_info("pixel_values",T.FLOAT,[1,3,224,224])]
                    nodes += [H.make_node("ReduceMean",["pixel_values"],["mean"],axes=[0,1,2,3],keepdims=0),constant("shape",np.array([1,1],dtype=np.int64)),H.make_node("Reshape",["mean","shape"],["a"]),constant("b",np.ones((1,1),dtype=np.float32))]
                else:
                    # Reversed declaration order catches positional binding bugs.
                    inputs=[H.make_tensor_value_info("attention_mask",T.INT64,[1,77]),H.make_tensor_value_info("input_ids",T.INT64,[1,77])]
                    nodes += [constant("index",np.array([1],dtype=np.int64)),constant("axis",np.array([1],dtype=np.int64)),H.make_node("Cast",["input_ids"],["idsf"],to=T.FLOAT),H.make_node("Gather",["idsf","index"],["a"],axis=1),H.make_node("Cast",["attention_mask"],["maskf"],to=T.FLOAT),H.make_node("ReduceSum",["maskf","axis"],["b"],keepdims=1)]
                projection="image_embeds" if vision else "text_embeds"
                nodes += [H.make_node("Concat",["a","b","zeros"],[projection],axis=1),H.make_node("Identity",["hidden"],["last_hidden_state"])]
                outputs=[H.make_tensor_value_info("last_hidden_state",T.FLOAT,list(hidden)),H.make_tensor_value_info(projection,T.FLOAT,[1,513 if wrong else 512])]
                graph=H.make_graph(nodes,"synthetic-clip",inputs,outputs)
                model=H.make_model(graph,opset_imports=[H.make_opsetid("",13)]);model.ir_version=8
                onnx.checker.check_model(model)
                onnx.save(model,package/"onnx"/("vision_model.onnx" if vision else "text_model.onnx"))
            save(False);save(True)
            tensor.write_bytes(struct.pack("<154q",*([49406,42]+[49407]*75+[1]*3+[0]*74)))
            reply=ask(cmd="clip_embed",tower="text",model_root=str(package),input=str(tensor))
            assert reply.get("ok"),(reply,(work/"engine.log").read_text()[-6000:])
            expected=math.sqrt(42*42+3*3)
            assert len(reply["embedding"])==512 and abs(reply["embedding"][0]-42/expected)<1e-6 and abs(reply["embedding"][1]-3/expected)<1e-6,reply
            tensor.write_bytes(struct.pack("<f",2.0)*(3*224*224))
            reply=ask(cmd="clip_embed",tower="vision",model_root=str(package),input=str(tensor))
            assert reply.get("ok"),(reply,(work/"engine.log").read_text()[-6000:])
            assert len(reply["embedding"])==512 and abs(reply["embedding"][0]-2/math.sqrt(5))<1e-6 and abs(reply["embedding"][1]-1/math.sqrt(5))<1e-6,reply
            print("PASS synthetic CPU ONNX text/vision execution, named input/output mapping, hidden outputs and normalized projections")
        if hasattr(os,"mkfifo"):
            # Block just the inference worker in a disposable FIFO open. The
            # request reader/foreground loop must keep working with a full queue.
            fifo=work/"blocked-input";os.mkfifo(fifo)
            for n in range(9):
                request={"cmd":"clip_embed","tag":1000+n,"tower":"text","model_root":str(work/"missing-models"),"input":str(fifo if n==0 else work/"missing")}
                child.stdin.write(json.dumps(request)+"\n")
            child.stdin.flush()
            reply=receive();assert reply.get("tag")==1008 and "full" in reply.get("error",""),reply
            child.stdin.write(json.dumps({"cmd":"version","rid":41})+"\n");child.stdin.flush()
            reply=receive();assert reply.get("rid")==41 and reply.get("ok"),reply
            release=os.open(fifo,os.O_RDWR|os.O_NONBLOCK)
            try:
                tags=set()
                for _ in range(8):
                    reply=receive();assert not reply.get("ok"),reply
                    tags.add(reply.get("tag"))
                assert tags==set(range(1000,1008)),tags
            finally: os.close(release)
            print("PASS native inference admission cap includes blocked active work; foreground stays responsive")
        # Failed background requests leave the normal command loop responsive.
        child.stdin.write(json.dumps({"cmd":"version","rid":42})+"\n");child.stdin.flush()
        reply=receive();assert reply.get("rid")==42 and reply.get("ok"),reply
        print("PASS CLIP tower, path, size, value/mask, absent model and foreground-response guards")
    finally:
        child.stdin.close()
        try: child.wait(timeout=30)
        except subprocess.TimeoutExpired: child.kill();child.wait()
        selector.close();log.close()
