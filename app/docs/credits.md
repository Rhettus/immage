# Credits

Immage stands on the work of these projects:

- [**darktable**](https://github.com/darktable-org/darktable): the
  raw processing engine, every image module, masks, styles and the AI
  segmentation code. GPL-3.0, which Immage inherits.
- [**Tauri**](https://tauri.app/): the application shell.
  MIT / Apache-2.0.
- [**React**](https://react.dev/) and [**Vite**](https://vite.dev/): the
  interface and its build. MIT.
- [**RapidRAW**](https://github.com/CyberTimon/RapidRAW): the inspiration
  for the look of the interface and for building a raw editor on Tauri,
  React and Rust. Only its appearance was matched, from screenshots; none
  of its code is used.
- [**t3mujinpack**](https://github.com/t3mujinpack/t3mujinpack) by João
  Almeida: the film emulation styles shipped as looks
  (`app/looks/t3mujinpack/`). MIT.
- [**Segment Anything 2.1**](https://github.com/facebookresearch/sam2) by
  Meta: the AI object selection model, as packaged for darktable by
  [darktable-ai](https://github.com/darktable-org/darktable-ai).
  Apache-2.0 weights.
- [**BiRefNet**](https://github.com/ZhengPeng7/BiRefNet) by Peng Zheng
  et al.: the Select Subject and Background model, in the ONNX export by
  [onnx-community](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX).
  MIT.
- [**SegFormer**](https://github.com/NVlabs/SegFormer) by NVIDIA,
  trained on [ADE20K](https://groups.csail.mit.edu/vision/datasets/ADE20K/):
  the Select Sky model, in the ONNX export by
  [Xenova](https://huggingface.co/Xenova/segformer-b2-finetuned-ade-512-512).
  NVIDIA Source Code License, for non-commercial use, which is how Immage
  is used.
- [**Depth Anything V2**](https://github.com/DepthAnything/Depth-Anything-V2)
  (Small): the Depth Range model, in the ONNX export by
  [onnx-community](https://huggingface.co/onnx-community/depth-anything-v2-small).
  Apache-2.0.
- [**Immporter**](https://github.com/Rhettus/immporter): the import
  screen. Its interface uses [Tailwind CSS](https://tailwindcss.com/),
  [Zustand](https://github.com/pmndrs/zustand) and
  [TanStack Virtual](https://tanstack.com/virtual) (MIT) and
  [Lucide](https://lucide.dev/) icons (ISC); its Rust side uses
  [rawler](https://github.com/dnglab/dnglab), [SQLite](https://sqlite.org/)
  via rusqlite, [keyring](https://github.com/open-source-cooperative/keyring-rs)
  and [reqwest](https://github.com/seanmonstar/reqwest), each under its
  own license.
- [**ONNX Runtime**](https://github.com/microsoft/onnxruntime): runs the
  AI models. MIT.
- [**OpenCV**](https://opencv.org/): aligns the brackets of an HDR Merge,
  in darktable's HDR merge, and stitches Panorama Merge's photos; built
  from source with only the parts they need
  (`app/scripts/build_opencv.sh`). Apache-2.0.
- [**lensfun**](https://lensfun.github.io/): the lens correction
  database, bundled with the app. LGPL-3.0 library, CC BY-SA 3.0 data.
- [**Stairs to mountain**](https://commons.wikimedia.org/wiki/File:Stairs_to_mountain.jpg)
  by kinkate (from Pixabay): the sample photo Immage opens on its first
  start (`app/sample/`). CC0.
- [**Poppins**](https://fonts.google.com/specimen/Poppins) via
  [Fontsource](https://fontsource.org/): the interface typeface. OFL-1.1.
- [**Homebrew**](https://brew.sh/) on the Mac,
  [**MSYS2**](https://www.msys2.org/) on Windows and
  [**Ubuntu**](https://ubuntu.com/) on Linux: the libraries darktable
  links against, which the app bundles with their license texts
  (`app/scripts/bundle_engine.py`, `app/scripts/bundle_engine_windows.sh`).

## License

GPL-3.0-or-later, as darktable. Bundled third-party content keeps its own
license, listed above and in its folder. Preferences › About lists every
library bundled with the engine and every Rust crate and npm package built
into the app, with its license and text (`app/scripts/notices.mjs`).

Each release attaches its source: Immage, with darktable and Immporter at
the commits it was built from. The libraries bundled from Homebrew, MSYS2
and Ubuntu are listed in Preferences › About with the version shipped
and where their source is published. For at least three years after a
release, anyone may also ask for the complete source of any GPL or LGPL
library in its binaries, at the version shipped, free of charge: open an
issue at [github.com/Rhettus/immage/issues](https://github.com/Rhettus/immage/issues).

## Location metadata and map attribution

See [Location in the Library guide](library.md#location) for map controls.

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
Map tiles are provided by the OpenStreetMap Foundation and are subject to its
[tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
Immage identifies its requests, caches viewed tiles for seven days, and does not
prefetch areas for offline use. Opening the map sends the viewed area and your
IP address to the tile service.

Interactive maps use [Leaflet](https://leafletjs.com/), Copyright © 2010–2023
Volodymyr Agafonkin and © 2010–2011 CloudMade, under the
[BSD 2-Clause license](https://github.com/Leaflet/Leaflet/blob/main/LICENSE).
