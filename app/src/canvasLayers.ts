// SPDX-License-Identifier: GPL-3.0-or-later
type Pixels = { pixels: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };

export function resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

export function layerStyle(element: HTMLElement, key: "width" | "height" | "transform" | "left" | "top" | "visibility", value: string) {
  if (element.style[key] !== value) element.style[key] = value;
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
