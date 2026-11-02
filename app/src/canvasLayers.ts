// SPDX-License-Identifier: GPL-3.0-or-later
type Pixels = { pixels: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };

export function resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

export function layerStyle(element: HTMLElement, key: "width" | "height" | "transform" | "left" | "top" | "visibility", value: string) {
  if (element.style[key] !== value) element.style[key] = value;
}

export function placeCanvas(canvas: HTMLCanvasElement, width: number, height: number,
                            p: { x: number; y: number; k: number }, dpr: number) {
  // Keep the CSS box in native pixels. WebKit rounds fractional canvas box
  // sizes when painting, stretching each axis differently as preview sizes
  // change. Apply display scaling only in the compositor transform instead.
  layerStyle(canvas, "width", `${width}px`);
  layerStyle(canvas, "height", `${height}px`);
  layerStyle(canvas, "transform", `translate(${p.x / dpr}px, ${p.y / dpr}px) scale(${p.k / dpr})`);
  const ratio = String(dpr);
  if (canvas.style.getPropertyValue("--canvas-dpr") !== ratio) canvas.style.setProperty("--canvas-dpr", ratio);
}

// immutable frame identity avoids repeated uploads; clear after external canvas writes
export class CanvasFrames {
  private frames = new WeakMap<HTMLCanvasElement, Pixels>();
  clear() { this.frames = new WeakMap(); }
  matches(canvas: HTMLCanvasElement, frame: Pixels) {
    const previous = this.frames.get(canvas);
    return previous?.pixels === frame.pixels && previous.width === frame.width && previous.height === frame.height
      && canvas.width === frame.width && canvas.height === frame.height;
  }
  draw(canvas: HTMLCanvasElement, frame: Pixels, source?: HTMLCanvasElement | null) {
    if (this.matches(canvas, frame)) return false;
    resizeCanvas(canvas, frame.width, frame.height);
    const context = canvas.getContext("2d")!;
    if (source && this.matches(source, frame)) {
      context.save();
      context.globalCompositeOperation = "copy";
      context.drawImage(source, 0, 0);
      context.restore();
    } else context.putImageData(new ImageData(frame.pixels, frame.width, frame.height), 0, 0);
    this.frames.set(canvas, frame);
    return true;
  }
}

// tokens expire on every replacement, including an A -> B -> A transition
export class FrameGeneration {
  private serial = 0;
  next() { return ++this.serial; }
  capture() { return this.serial; }
  matches(token: number) { return this.serial === token; }
}
