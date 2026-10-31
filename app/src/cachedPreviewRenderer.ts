// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import type { CachedPreview } from "./session";
import type { ClipShow } from "./histogram";

type Anchor = { texture:WebGLTexture; pixels:Uint8ClampedArray<ArrayBuffer>; width:number; height:number };
const MAX_TEXTURE_BYTES = 256 * 1024 * 1024;
const vertex = `
attribute vec2 position;
varying vec2 uv;
void main() {
  uv = vec2((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5);
  gl_Position = vec4(position, 0.0, 1.0);
}`;
const fragment = `
precision highp float;
varying vec2 uv;
uniform sampler2D anchorA;
uniform sampler2D anchorB;
uniform float amount;
uniform vec2 clipping;
float byteValue(float value) {
  float base = floor(value), part = value - base;
  // Uint8ClampedArray rounds exact halves to the nearest even byte
  return base + ((part > 0.5 || (part == 0.5 && mod(base, 2.0) > 0.5)) ? 1.0 : 0.0);
}
void main() {
  vec4 a = texture2D(anchorA, uv), b = texture2D(anchorB, uv);
  vec3 av = floor(a.rgb * 255.0 + 0.5), bv = floor(b.rgb * 255.0 + 0.5);
  vec3 rgb = clamp(av + (bv - av) * amount, 0.0, 255.0);
  // clip after byte quantization, as the CPU canvas overlay does
  vec3 bytes = vec3(byteValue(rgb.r), byteValue(rgb.g), byteValue(rgb.b));
  if (clipping.y > 0.5 && max(max(bytes.r, bytes.g), bytes.b) >= 255.0)
    gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
  else if (clipping.x > 0.5 && min(min(bytes.r, bytes.g), bytes.b) <= 0.0)
    gl_FragColor = vec4(0.0, 64.0 / 255.0, 1.0, 1.0);
  else gl_FragColor = vec4(bytes / 255.0, b.a);
}`;

// only two native anchors are retained; slider events change uniforms, not pixels
export class CachedPreviewRenderer {
  private gl:WebGLRenderingContext | null = null;
  private program:WebGLProgram | null = null;
  private buffer:WebGLBuffer | null = null;
  private anchors:Anchor[] = [];
  private amount:WebGLUniformLocation | null = null;
  private clipping:WebGLUniformLocation | null = null;
  private failed = false;
  private maxWidth = 0;
  private maxHeight = 0;
  private lastMix:number | null = null;
  readonly stats = { uploads:0, draws:0, textureBytes:0 };

  constructor(private canvas:HTMLCanvasElement, private onLost:() => void) {
    canvas.addEventListener("webglcontextlost", this.lost);
    canvas.addEventListener("webglcontextrestored", this.restored);
  }
  private lost = (event:Event) => {
    event.preventDefault();
    this.gl = null; this.program = null; this.buffer = null;
    this.anchors = []; this.stats.textureBytes = 0; this.lastMix = null;
    this.failed = true;
    this.onLost();
  };
  private restored = () => { this.failed = false; };

  private init():WebGLRenderingContext | null {
    if (this.failed) return null;
    if (this.gl) return this.gl;
    const gl = this.canvas.getContext("webgl", {
      alpha:true, premultipliedAlpha:false, antialias:false, depth:false, stencil:false,
      preserveDrawingBuffer:false,
    });
    if (!gl) { this.failed = true; return null; }
    this.gl = gl;
    const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    this.maxWidth = Math.min(limit,viewport[0]);
    this.maxHeight = Math.min(limit,viewport[1]);
    const compile = (kind:number, source:string) => {
      const shader = gl.createShader(kind);
      if (!shader) throw Error("preview shader allocation");
      gl.shaderSource(shader,source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) {
        gl.deleteShader(shader); throw Error("preview shader compilation");
      }
      return shader;
    };
    const shaders:WebGLShader[] = [];
    try {
      shaders.push(compile(gl.VERTEX_SHADER,vertex));
      shaders.push(compile(gl.FRAGMENT_SHADER,fragment));
      const program = gl.createProgram();
      if (!program) throw Error("preview program allocation");
      this.program = program;
      for (const shader of shaders) gl.attachShader(program,shader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw Error("preview shader linking");
      gl.useProgram(program);
      this.buffer = gl.createBuffer();
      if (!this.buffer) throw Error("preview buffer allocation");
      gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program,"position");
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
      gl.uniform1i(gl.getUniformLocation(program,"anchorA"),0);
      gl.uniform1i(gl.getUniformLocation(program,"anchorB"),1);
      this.amount = gl.getUniformLocation(program,"amount");
      this.clipping = gl.getUniformLocation(program,"clipping");
      gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
      gl.disable(gl.BLEND); gl.disable(gl.DITHER);
      return gl;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  draw(preview:CachedPreview, clipping:ClipShow):boolean {
    const {a,b,mix} = preview;
    if (a.width !== b.width || a.height !== b.height || !Number.isFinite(mix) || mix < -0.5 || mix > 1.5
        || a.width < 1 || a.height < 1 || !Number.isInteger(a.width) || !Number.isInteger(a.height)
        || a.pixels.length !== a.width*a.height*4 || b.pixels.length !== a.pixels.length
        || a.pixels.byteLength*2 > MAX_TEXTURE_BYTES) return false;
    try {
      const gl = this.init();
      if (!gl || gl.isContextLost()) return false;
      if (a.width > this.maxWidth || a.height > this.maxHeight) return false;
      const frames = [a,b];
      // keep the former B when it becomes A; delete retired anchors before uploading
      const matches = (anchor:Anchor, frame:typeof a) => anchor.pixels === frame.pixels
        && anchor.width === frame.width && anchor.height === frame.height;
      for (const anchor of this.anchors) if (!frames.some(frame => matches(anchor,frame))) gl.deleteTexture(anchor.texture);
      this.anchors = this.anchors.filter(anchor => frames.some(frame => matches(anchor,frame)));
      frames.forEach((frame,unit) => {
        gl.activeTexture(gl.TEXTURE0+unit);
        let anchor = this.anchors.find(anchor => matches(anchor,frame));
        if (!anchor) {
          const texture = gl.createTexture();
          if (!texture) throw Error("preview texture allocation");
          anchor = {texture,pixels:frame.pixels,width:frame.width,height:frame.height};
          this.anchors.push(anchor);
          gl.bindTexture(gl.TEXTURE_2D,texture);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
          gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,frame.width,frame.height,0,gl.RGBA,gl.UNSIGNED_BYTE,frame.pixels);
          if (gl.getError() !== gl.NO_ERROR) throw Error("preview texture upload");
          this.stats.uploads++;
        } else gl.bindTexture(gl.TEXTURE_2D,anchor.texture);
      });
      this.stats.textureBytes = this.anchors.reduce((sum,anchor) => sum+anchor.pixels.byteLength,0);
      if (this.canvas.width !== b.width) this.canvas.width = b.width;
      if (this.canvas.height !== b.height) this.canvas.height = b.height;
      gl.viewport(0,0,b.width,b.height);
      this.lastMix = mix;
      return this.redraw(clipping);
    } catch {
      this.failed = true;
      this.reset();
      if (this.gl) {
        this.gl.deleteBuffer(this.buffer); this.gl.deleteProgram(this.program);
      }
      this.gl = null; this.program = null; this.buffer = null;
      return false;
    }
  }

  redraw(clipping:ClipShow):boolean {
    const gl = this.gl;
    if (!gl || gl.isContextLost() || this.lastMix === null) return false;
    gl.uniform1f(this.amount,this.lastMix);
    gl.uniform2f(this.clipping,Number(clipping.low),Number(clipping.high));
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    this.stats.draws++;
    return true;
  }

  reset() {
    const gl = this.gl;
    if (gl) for (const anchor of this.anchors) gl.deleteTexture(anchor.texture);
    this.anchors = []; this.stats.textureBytes = 0; this.lastMix = null;
  }

  dispose() {
    this.reset();
    if (this.gl) {
      this.gl.deleteBuffer(this.buffer); this.gl.deleteProgram(this.program);
    }
    this.gl = null; this.program = null; this.buffer = null;
    this.canvas.removeEventListener("webglcontextlost",this.lost);
    this.canvas.removeEventListener("webglcontextrestored",this.restored);
  }
}
