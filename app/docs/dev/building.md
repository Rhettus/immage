# Building Immage

`scripts/build.sh` is the one entry point on every platform; what each
needs installed first is below (OpenCV is not among it: `build.sh` builds
the few parts of it darktable uses, into `build/opencv`), and the CI workflow
([build.yml](../../../.github/workflows/build.yml)) does the same steps on a clean
machine. A release's `immage-<version>-source.tar.gz` builds the same way
as a clone.

## macOS

You need darktable's build dependencies from Homebrew (the engine's are in
[.github/Brewfile](../../../.github/Brewfile): `brew bundle install --file
.github/Brewfile`), plus the Xcode command line tools, Rust and Node.js.

```sh
git clone https://github.com/Rhettus/immage.git && cd immage

# everything: darktable (the submodule, patched to build the engine), the
# engine, the importer and a self-contained .dmg in build/dmg/
scripts/build.sh

# after that, the app in development
cd app && npm install && npm run tauri dev

# after a change to the engine or a darktable bump
cmake --build build

```

Cargo never removes earlier builds from `app/src-tauri/target`, which
grows by gigabytes a day. `npm run tauri ...` prunes it before and after
each build, keeping what the last two builds of each profile use
(`app/scripts/prune_target.mjs`; `-n` lists what would go).

## Windows

[app/WINDOWS.md](../../WINDOWS.md) walks through it: darktable's MSYS2
toolchain for the engine (`scripts/build.sh` in the MSYS2 UCRT64 shell),
then `npm run tauri build` in PowerShell with the MSVC Rust toolchain. It
makes the NSIS `.exe` installer in
`app/src-tauri/target/release/bundle/`. A Windows on ARM virtual machine
works, building under x64 emulation.

## Linux

On Ubuntu 22.04, the system the release AppImages are built on:

```sh
sudo add-apt-repository ppa:savoury1/graphics
sudo add-apt-repository ppa:savoury1/ffmpeg4
sudo add-apt-repository ppa:savoury1/display
sudo sed -i 's/^# deb-src /deb-src /' /etc/apt/sources.list
sudo apt-get update
sudo apt-get install $(grep -v '^#' .github/ubuntu-packages.txt) \
  lld libgstreamer-plugins-bad1.0-dev flite1-dev
sudo apt-get build-dep -y webkit2gtk

# Image-format libraries first: ARM64 also needs their JPEG XL build for WebKit.
sh app/scripts/build_linux_deps.sh
# Pinned WebKitGTK / JavaScriptCore 2.54.2 and matching helpers.
# Building WebKit takes substantial time; CI caches its staged installation.
CC=gcc-12 CXX=g++-12 sh app/scripts/build_webkitgtk.sh

# With Rust and Node.js installed, build and verify the AppImage.
(cd app && npm ci)
CC=gcc-12 CXX=g++-12 scripts/build.sh
python3 -I app/scripts/check_webkit_bundle.py \
  app/src-tauri/target/release/bundle/appimage/Immage.AppDir 2.54.2 --max-glibc 2.35
```

### Native ARM64 builds

CI builds Linux natively on Ubuntu 22.04 for x86-64 and ARM64, including
WebKitGTK, JavaScriptCore and matching helper processes. ARM64 uses GCC 14
from `ppa:ubuntu-toolchain-r/test` (replace the GCC 12 packages and commands
above) and builds missing image libraries with `build_linux_deps.sh` instead
of installing `libjxl-dev`, `libsharpyuv-dev` and `libopenexr-dev`.
Packaging fails if the bundled WebKit libraries do not report 2.54.2,
helpers are missing, or any packaged ELF imports glibc newer than 2.35.
This keeps the runtime baseline compatible with Linux Mint 22.x.

The Linux build scripts also build natively on an ARM64 host. The Rust app,
darktable engine, OpenCV and ONNX Runtime use the host architecture; the
AppImage is named `Immage_<version>_aarch64.AppImage`.

On Arch Linux, install the native equivalents of the dependencies above
instead of adding Ubuntu PPAs or running `build_linux_deps.sh`. The engine
bundler reads package versions and licenses from pacman. `po4a` also needs
`perl-pod-parser` to generate darktable's translated manual pages.

With the dependencies, Rust and Node.js installed:

```sh
(cd app && npm ci)
CMAKE_BUILD_PARALLEL_LEVEL=2 CARGO_BUILD_JOBS=2 APPIMAGE_EXTRACT_AND_RUN=1 scripts/build.sh
```

The two-job limit is useful on machines with 8 GB of RAM. An AppImage built
on Arch requires a sufficiently recent host glibc; it does not establish
the Ubuntu 22.04 compatibility baseline of the release builds.

## Printing

The Print panel needs darktable's print support, which `scripts/build.sh`
turns on (`-DBUILD_PRINT=ON`). On Linux it needs CUPS's development files:
`libcups2-dev` on Ubuntu (in `.github/ubuntu-packages.txt`), `libcups` on
Arch. macOS has CUPS in its SDK, and Windows prints through its own APIs.
cmake reports `Print mode: enabled`. A `build/` configured before printing
was on keeps `BUILD_PRINT=OFF` in its cache: configure it again with
`cmake -S darktable -B build -DBUILD_PRINT=ON`. Without print support the
engine still soft proofs, and the panel says it can't print.

## AI models

AI masks need their ONNX models in `build/ai-models/` (for development)
or the app's data folder, and the engine started with `--models <dir>`;
the app downloads each model on first use. Select Object uses darktable's
own model from [darktable-ai](https://github.com/darktable-org/darktable-ai);
Select Subject and Background use BiRefNet, Select Sky, People and Landscape
use SegFormer, and Depth Range uses Depth Anything V2.

## CI and packaging

macOS is where Immage is developed.
All three are built by GitHub Actions
([.github/workflows/build.yml](../../../.github/workflows/build.yml)) on every
change, and a `v*` tag makes a draft release
([release.yml](../../../.github/workflows/release.yml)). Release builds can also run
manually on the release branch to reuse its dependency caches, with the tag
required to match that exact commit; see [Releasing](releasing.md).
Each build bundles the
engine with the libraries it links: from Homebrew on macOS, MSYS2 on
Windows and Ubuntu on Linux (`app/scripts/bundle_engine.py`,
`app/scripts/bundle_engine_windows.sh`).
