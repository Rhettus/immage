# Immage

Immage builds on [darktable](https://www.darktable.org/)'s raw processing
engine, and brings its power to photographers who know other editors. It
works the way mainstream raw editors do: the familiar panels, slider
names, order and tools.

**Immage adds no image processing of its own.** Every adjustment is one of
darktable's existing modules, renamed, regrouped and reordered behind a
new interface (the table under
[Which darktable module does what](#which-darktable-module-does-what)
shows each one). Edits are saved as ordinary darktable XMP sidecars.
Staying out of the pipeline is what keeps Immage compatible with
darktable: darktable of the same version opens an Immage edit and renders
it the same, and every improvement to darktable's engine reaches Immage.

It is a personal, non-commercial project, built for macOS first, with
Windows and Linux among its aims.

Importing is done by **Immporter**, the companion tool that copies photos
off a card, built into Immage as its import screen. Asset management comes
from [Immich](https://immich.app/) rather than from a catalog in the
editor: imports check against an Immich library, and exports can go
straight into an Immich album.

## Who it is for

Immage is for photographers who want darktable's raw processing without
having to learn darktable:

- people coming from a mainstream photo editor, who want the panels,
  slider names and shortcuts they already know
- people who want good results from sensible defaults, so a new photo
  already follows darktable's scene-referred AgX workflow before the first
  slider is touched
- people who want to get through a shoot quickly: one set of panels with
  a fixed order, settings copied from one photo to the next, and nothing
  to set up before editing. Immage does not render faster than darktable;
  the time it saves is the editor's
- people who keep their photos in folders, or in an Immich library,
  rather than in an editor's catalog

It is not meant for experienced darktable users who want every control:

- most darktable modules are not shown, and those that are show only the
  controls Immage's panels need
- Immage decides which module each tool uses, its defaults and the order
  of the pipeline; Preferences › Modules offers a choice only between
  the alternatives Immage supports
- there is no lighttable or collections, and no way to add module
  instances or reorder the pipeline by hand

For any of that, use darktable itself. The two work on the same files:
a darktable of the same version opens Immage's edits and renders them the
same, so a photo started in Immage can be finished in darktable.

**If you already edit in a stable darktable, try Immage on test images
first.** Immage is built from darktable's development branch (5.7 at
present), not from a stable release, so its modules can be newer than
yours. Once Immage saves an edit, the photo's XMP sidecar may hold module
versions that a stable darktable cannot read: it then warns of a version
mismatch and leaves those modules out, or resets them to their defaults,
so the photo looks different there. Masks are saved in the format of
darktable's new flexi masks, which no released darktable reads. Work on
copies, or on photos you have not edited in darktable, until you know how
the two fit your workflow.

## Design goals

**A simple workflow, at the cost of some flexibility.** Immage is meant
for a streamlined way of working that darktable beginners feel at home
in. That involves two compromises:

- not every darktable module or option is shown, only the modules in the
  [table below](#which-darktable-module-does-what) and the controls of
  each that Immage's panels need
- Immage, not the user, settles the default values, which modules a tool
  uses and how each of them behaves. These choices follow darktable's
  scene-referred workflow, the one its tone mappers (sigmoid and AgX) are
  designed for

Immage gives up some of darktable's flexibility in return for a gentler
learning curve. If you need complete control, use darktable: it opens
Immage's edits, and Immage keeps whatever darktable adds.

**Fast where the user is waiting.** Immage aims to be as responsive as it
can be in everything the user does directly, such as moving a slider,
opening a folder or importing photos. How fast darktable renders is up to
darktable; what Immage controls is the order of the work around it, and
there it puts feedback to the user first.

## What it changes from darktable

darktable is a git submodule (`darktable/`), pinned to one commit, and
built unchanged apart from a few lines that add one new program to its
build ([patches/darktable-engine.patch](patches/darktable-engine.patch)).
Everything else in this repository is Immage's own.

- **A headless engine** (`engine/`): a small program that keeps one
  image open in darktable's pixelpipe and takes JSON requests on stdin.
  The requests open, set module parameters, render, save and export. They
  also cover looks (styles), drawn and range masks, AI selections and
  preview renders. It runs darktable with no GUI and an in-memory
  library, so the XMP sidecar is the only thing written.
- **A new interface** (`app/`): a [Tauri 2](https://tauri.app/) app with a
  Rust backend and a [React](https://react.dev/) front end that drives the
  engine. It replaces darktable's lighttable and darkroom with:
  - the familiar panels: Basic, Tone Curve (parametric, point, R/G/B),
    HSL / Color, B&W Mix, Color Grading wheels, Detail, Lens Corrections,
    Transform, Effects and Calibration, each mapped onto darktable modules
    (`app/src/manifest.ts` holds the mapping)
  - masks: brush, linear and radial gradients, color, luminance and depth
    ranges, and AI selection of an object, the subject, the background,
    people, the sky or parts of a landscape, with local adjustments; they
    are stored as darktable drawn and parametric masks
  - Heal and Clone spots with an automatically chosen source and a
    Visualize Spots view, stored in darktable's retouch module
  - presets, film looks with live preview tiles, undo/redo, a before/after
    view, crop and straighten, a white balance picker, export with
    borders and file-name templates (to a folder or an Immich album), a
    filmstrip, and metadata editing
  - an import screen (Immporter, below), and Preferences for what new
    photos start with and for the Immich connection
- **No catalog**: folders are opened directly and browsed as a tree;
  there are no film rolls and no collections.

## Which darktable module does what

Each Immage tool is a darktable module, or darktable's masking, so the same
edit opens in darktable as these modules. `app/src/manifest.ts` holds how
each slider maps onto its module's parameters.

**A photo edited in darktable keeps all of its edit.** Immage loads and
renders the whole darktable history, including modules it has no controls
for, and saves them back unchanged. Only the modules in this table can be
adjusted in Immage; anything else stays as darktable left it, and is still
edited in darktable. Where darktable set one of these modules in a way
Immage's sliders cannot show, such as a tone curve drawn by hand, Immage
leaves its settings alone until one of its sliders is moved.

Some tools can run on more than one module. Preferences › Modules picks
which for the tools a photo has not used yet: Default takes the module
darktable's [AgX workflow](https://avidandrew.com/agx-workflow.html) uses
for each, the first one listed below, and Custom lets each be set. A
photo that already uses one of a tool's modules keeps it.

| Immage | darktable module |
|---|---|
| **Basic** | |
| Treatment (Color, Black & White) | color calibration's gray (`channelmixerrgb`), on an instance of its own after the color equalizer, or the color equalizer (`colorequal`) |
| White Balance: Temp, Tint, the picker | color calibration (`channelmixerrgb`) |
| Exposure | exposure (`exposure`) |
| Contrast | AgX (`agx`), or sigmoid (`sigmoid`) on a photo started under it; or color balance rgb (`colorbalancergb`) |
| Highlights, Shadows | tone equalizer (`toneequal`), or shadows and highlights (`shadhi`) |
| Blacks | AgX's lift, or sigmoid's target black; or exposure's black level (`exposure`) |
| Vibrance | color balance rgb (`colorbalancergb`) |
| Saturation | AgX's saturation; or color balance rgb (`colorbalancergb`), which a photo on sigmoid always uses |
| Whites | AgX (`agx`); sigmoid (`sigmoid`) on a photo started under it |
| Texture | diffuse or sharpen (`diffuse`) |
| Clarity | local contrast (`bilat`) |
| Dehaze | haze removal (`hazeremoval`) |
| **Tone Curve** | |
| Parametric and point curve | tone curve (`tonecurve`) |
| Red, green and blue point curves | rgb curve (`rgbcurve`) |
| **HSL / Color**, **B&W Mix** | color equalizer (`colorequal`) |
| **Color Grading** | color balance rgb (`colorbalancergb`) |
| **Detail** | |
| Sharpening | diffuse or sharpen (`diffuse`), its "sharpness \| normal" preset on an instance of its own, or sharpen (`sharpen`) |
| Noise Reduction: Luminance | denoise (profiled) (`denoiseprofile`) |
| **Lens Corrections** | lens correction (`lens`), with the lensfun database |
| **Transform**: Vertical, Horizontal, Rotate | rotate and perspective (`ashift`) |
| **Effects** | |
| Post-Crop Vignetting | vignetting (`vignette`) |
| Grain | grain (`grain`) |
| **Calibration** | |
| Red, Green, Blue Primary | color calibration (`channelmixerrgb`) |
| Shadows Tint | a second instance of color balance rgb (`colorbalancergb`) |
| **Crop tool** | |
| Crop and aspect | crop (`crop`) |
| Angle and Straighten | rotate and perspective (`ashift`) |
| Rotate and Flip | orientation (`flip`) |
| **Masks** | |
| Brush, Linear Gradient, Radial Gradient | drawn masks: brush, gradient, ellipse |
| Color Range, Luminance Range | parametric masks (blending) |
| Select Object, Subject, Background, Sky, People, Landscape, Depth Range | drawn path masks, traced from the AI model's selection |
| Local Exposure, Blacks, Contrast, Whites, Saturation, Hue | an instance of exposure or color balance rgb per mask |
| Local Highlights, Shadows | an instance of tone equalizer or shadows and highlights (as the photo's) per mask |
| Local Temp, Tint | an instance of color calibration per mask |
| Local Texture, Clarity, Dehaze | an instance of diffuse or sharpen, local contrast or haze removal per mask |
| Local Noise, Defringe, Sharpness | an instance of denoise (profiled), chromatic aberrations (`cacorrectrgb`) or defringe (`defringe`), or diffuse or sharpen or sharpen (as the photo's Sharpening) per mask |
| **Heal and Clone** | retouch (`retouch`) |
| **Looks** | darktable styles, applied as extra module instances |
| **Export** borders | framing (`borders`), added at export only |
| **Keywords** | darktable tags (`dc:subject`, `lr:hierarchicalSubject` in the XMP) |

## Importing and Immich

The import screen is [Immporter](https://github.com/Rhettus/immporter),
a separate project that Immage builds in as a Tauri plugin. It copies
photos off a card or a folder into dated folders, verifying every copy,
and marks the photos already in the destination or in Immich. After an
import, the destination joins Immage's folder list and the new photos
open. Its source is cloned into `immporter/` (ignored by this
repository's git); `app/immporter.rev` pins the commit Immage builds
against, and `app/scripts/fetch_immporter.sh` checks it out.

The Immich server and API key are set in Preferences. The key is kept in
the operating system's own key store (the macOS Keychain, the Windows
Credential Manager, or the Secret Service on Linux), never in a file or
the interface. The key needs these permissions:

| Permission | For |
|---|---|
| `asset.read` | checking imports against the library, and searching it |
| `asset.view` | thumbnails of search results |
| `asset.download` | downloading a result's original to edit it |
| `asset.upload` | exporting to Immich |
| `album.read` | listing albums to export to, and the Albums search filter |
| `album.create` | creating an album from the Export dialog |
| `albumAsset.create` | adding exported photos to the album |
| `person.read`, `tag.read` | the People and Tags search filters (optional) |
| `library.read` | listing the external libraries one by one (optional; admin keys only) |

Immage keeps its own import history and key, apart from a standalone
Immporter's.

Once Immich is set up, the Library panel has an Immich card under
Folders. It searches the external libraries by default, with Immich's
smart search or by file name, and Advanced filters by date, rating,
favorites, RAW, camera, lens, place, people, tags and albums. Results
fill the grid with Immich's thumbnails. Opening one edits the external
library's own file when this computer has it, mapped from Immich's path
in Preferences (by default the importer's path prefix and destination),
and otherwise downloads the original into Immage's cache first.
Right-click a result to show it, or the whole search, in Immich. A
result shows Immich's rating until it is opened; ratings set after that
go into the photo's XMP sidecar, as for any other photo.

## Opening a photo from another program

Another program can hand Immage a photo to edit. Immage shows the
photo's folder and opens the photo, ready for editing:

```sh
open -a Immage /path/to/photo.arw                    # macOS, running or not
/Applications/Immage.app/Contents/MacOS/immage /path/to/photo.arw
```

On macOS, prefer `open -a`: it reaches Immage when it is already
running. Starting the executable directly starts a second copy, which
cannot share the first one's engine.

## Platforms

macOS (Apple silicon) is the platform Immage is developed and packaged
on today. Windows builds too: [app/WINDOWS.md](app/WINDOWS.md) walks
through it, with darktable's MSYS2 toolchain on a Windows machine (a
Windows on ARM virtual machine works). Linux is a goal. darktable, Tauri
and ONNX Runtime run on all three, so the engine and the app carry over.
On macOS, `app/scripts/bundle_engine.py` gathers Homebrew's libraries,
and `app/scripts/build_dmg.sh` makes a disk image.

## Building (macOS, for now)

You need darktable's build dependencies from Homebrew (see
[darktable's README](darktable/README.md)), plus json-glib, Rust,
Node.js and the Tauri CLI.

```sh
git clone https://github.com/Rhettus/immage.git && cd immage

# everything: darktable (the submodule, patched to build the engine), the
# engine, the importer and a self-contained .dmg in build/dmg/
scripts/build.sh

# after that, the app in development
cd app && npm install && npm run tauri dev

# after a change to the engine or a darktable bump
cmake --build build

# every so often: cargo never removes earlier builds' object files
# from app/src-tauri/target, which grows by gigabytes a day
app/scripts/prune_target.sh      # -n to list first; [days], default 3
```

AI masks need their ONNX models in `build/ai-models/` (for development)
or the app's data folder, and the engine started with `--models <dir>`;
the app downloads each model on first use. Select Object uses darktable's
own model from [darktable-ai](https://github.com/darktable-org/darktable-ai);
Select Subject and Background use BiRefNet, Select Sky, People and Landscape
use SegFormer, and Depth Range uses Depth Anything V2.

## Documentation

- [User guide](app/docs/README.md): Immage's editing tools, written for
  photographers.
- [Developer docs](app/docs/dev/README.md): the
  [code map](app/docs/dev/code-map.md) (where everything lives, where to
  start a change, how an operation moves through the app) and diagrams of
  the data flow, the entities and a slider move.
- [Benchmarks](benchmarking/README.md): the performance suite, its
  recorded results and an offline dashboard.
- [darktable/dev-doc/](darktable/dev-doc/README.md): darktable's own
  developer docs, for anything the engine calls into darktable for.
- [Pinning darktable](app/docs/dev/darktable-pin.md): which darktable
  Immage builds, and how to move it.

## Credits

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
- [**lensfun**](https://lensfun.github.io/): the lens correction
  database, bundled with the app. LGPL-3.0 library, CC BY-SA 3.0 data.
- [**Stairs to mountain**](https://commons.wikimedia.org/wiki/File:Stairs_to_mountain.jpg)
  by kinkate (from Pixabay): the sample photo Immage opens on its first
  start (`app/sample/`). CC0.
- [**Poppins**](https://fonts.google.com/specimen/Poppins) via
  [Fontsource](https://fontsource.org/): the interface typeface. OFL-1.1.
- [**Homebrew**](https://brew.sh/) on the Mac and
  [**MSYS2**](https://www.msys2.org/) on Windows: the libraries darktable
  links against, which the app bundles with their license texts
  (`app/scripts/bundle_engine.py`, `app/scripts/bundle_engine_windows.sh`).

## License

GPL-3.0-or-later, as darktable. Bundled third-party content keeps its own
license, listed above and in its folder. Preferences › About lists every
library bundled with the engine and every Rust crate and npm package built
into the app, with its license and text (`app/scripts/notices.mjs`).
