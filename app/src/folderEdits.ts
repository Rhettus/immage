// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// A folder read holds snapshots from before metadata changes made while it
// runs. Keep only changed fields, so fresh EXIF and other read results survive.
export class FolderEdits<T extends { imgid: number }> {
  private fields = new Map<number, Partial<T>>();

  patch(imgid: number, fields: Partial<T>) {
    this.fields.set(imgid, { ...this.fields.get(imgid), ...fields });
  }

  apply(images: T[]): T[] {
    return images.map((image) => {
      const fields = this.fields.get(image.imgid);
      return fields ? { ...image, ...fields } : image;
    });
  }
}
