// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// The display frame is sRGB encoded. Apply an EV difference in linear light,
// always from the original pixels so repeated moves cannot accumulate clipping.
export function exposurePreview(source: Uint8ClampedArray<ArrayBuffer>, ev: number) {
  const gain = 2 ** ev;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const encoded = i / 255;
    const linear = (encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4) * gain;
    lut[i] = 255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055);
  }
  const pixels = new Uint8ClampedArray(source.length);
  for (let i = 0; i < source.length; i += 4) {
    pixels[i] = lut[source[i]];
    pixels[i + 1] = lut[source[i + 1]];
    pixels[i + 2] = lut[source[i + 2]];
    pixels[i + 3] = source[i + 3];
  }
  return pixels;
}
