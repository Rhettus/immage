# SPDX-License-Identifier: GPL-3.0-or-later
# Reproduce with: uv run --no-project --with pillow==12.0.0 --with numpy==2.3.4 verify/clip-preprocess-reference.py
# Deterministic synthetic RGB fixtures. No photos or model assets are downloaded.
import hashlib, json
import numpy as np
import PIL
from PIL import Image
assert PIL.__version__ == "12.0.0" and np.__version__ == "2.3.4", "Use the pinned reference command above"
cases = [(224,224),(301,199),(199,301),(1600,900),(17,9),(225,224),(224,225),(1,3)]
mean = np.array([0.48145466,0.4578275,0.40821073],dtype=np.float32)
std = np.array([0.26862954,0.26130258,0.27577711],dtype=np.float32)
output=[]
for width,height in cases:
    raw=bytes((x*17+y*31+c*73+(x*y)%251)%256 for y in range(height) for x in range(width) for c in range(3))
    resized=(224,(224*height)//width) if width<=height else ((224*width)//height,224)
    im=Image.frombytes('RGB',(width,height),raw).resize(resized,resample=Image.Resampling.BICUBIC)
    left,top=(resized[0]-224)//2,(resized[1]-224)//2
    rgb=im.crop((left,top,left+224,top+224)).tobytes()
    # Transformers rescale casts to float64 then back to float32 before normalizing.
    a=(np.frombuffer(rgb,dtype=np.uint8).reshape(224,224,3).astype(np.float64)*(1/255)).astype(np.float32)
    chw=((a-mean)/std).transpose(2,0,1).astype('<f4').tobytes()
    output.append(dict(width=width,height=height,rgb_sha256=hashlib.sha256(rgb).hexdigest(),tensor_sha256=hashlib.sha256(chw).hexdigest()))
print(json.dumps(dict(pillow='12.0.0',numpy='2.3.4',cases=output),indent=2))
