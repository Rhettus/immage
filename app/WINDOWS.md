# Building Immage on Windows

The result is an x64 installer, `.msi` and `.exe`, that runs on any 64-bit
Windows 10 or 11 PC, and on Windows on ARM through its x64 emulation. It is
built on Windows itself; a Windows 11 on ARM virtual machine works, building
under the same emulation, only more slowly.

## One-time setup

Install, choosing the x64 download wherever there is a choice:

1. **Git for Windows** (git-scm.com)
2. **MSYS2** (msys2.org), into `C:\msys64`
3. **Build Tools for Visual Studio 2022**, with the *Desktop development
   with C++* workload and *MSVC v143 - VS 2022 C++ x64/x86 build tools*
4. **Rust** (rustup.rs). On Windows on ARM rustup installs the ARM
   toolchain whichever installer you run; for an x64 build switch to the
   x64 one, which runs under Windows' x64 emulation (rustup asks for
   `--force-non-host` to install a toolchain for another processor), in
   PowerShell:

   ```powershell
   rustup toolchain install stable-x86_64-pc-windows-msvc --force-non-host
   rustup default stable-x86_64-pc-windows-msvc
   ```
5. **Node.js LTS** (nodejs.org, the x64 `.msi`)

Then, in the **MSYS2 UCRT64** shell (not "MSYS2 MSYS"), darktable's
libraries, the list darktable's own Windows CI installs plus `json-glib`
for the engine:

```sh
pacman -Syu        # again if it closes the shell half way
pacman -S --needed git intltool po4a mingw-w64-ucrt-x86_64-{cc,cmake,ninja,nsis,libxslt,python-jsonschema,curl,drmingw,exiv2,gcc-libs,gettext,gmic,graphicsmagick,gtk3,icu,imath,iso-codes,lcms2,lensfun,libarchive,libavif,libgphoto2,libheif,libjpeg-turbo,libjxl,libpng,libraw,librsvg,libsecret,libtiff,libwebp,libxml2,omp,opencv,openexr,openjpeg2,osm-gps-map,portmidi,potrace,pugixml,SDL2,sqlite3,zlib,json-glib}
```

And the code, also in the UCRT64 shell. A short path such as `C:\src`
keeps clear of Windows' path length limit:

```sh
git config --global core.longpaths true
mkdir -p /c/src && cd /c/src
git clone https://github.com/Rhettus/immage.git immage
cd immage
git submodule update --init darktable
git -C darktable submodule update --init src/external/rawspeed src/external/OpenCL src/external/libxcf src/external/whereami src/external/LibRaw
git clone https://github.com/Rhettus/immporter immporter
git -C immporter checkout --detach $(cat app/immporter.rev)
```

darktable is a submodule, at the commit Immage pins
([darktable-pin.md](docs/dev/darktable-pin.md)). Its clone brings
darktable's release tags, which the engine's version string is worked out
from (`tools/get_git_version_string.sh`). Without them the engine reports
a version such as `0.10.0-49-g...`, and the AI model download, which looks
up models by darktable version, has no match for it.
`git -C darktable describe --tags --match 'release-*'` should print
`release-5.7.0-...`.

## Each build

**1. The engine**, in the **MSYS2 UCRT64** shell. The first build takes a
long while; later ones only rebuild what changed:

```sh
cd /c/src/immage
git pull
git submodule update darktable
git -C immporter fetch
git -C immporter checkout --detach $(cat app/immporter.rev)
sh app/scripts/build_engine_windows.sh
```

The two `immporter` lines keep the import screen at the commit this
version of Immage pins (`app/immporter.rev`); they do nothing when it has
not moved.

It ends with `bundled N DLLs, ... MB; not found: 0`.

**2. The app and its installers**, in **PowerShell** (MSYS2's shell does
not see Windows' Node and Rust):

Windows ships with PowerShell scripts switched off, and `npm` starts
through one. Allow your own once (or call `npm.cmd` instead of `npm`):

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

```powershell
cd C:\src\immage\immporter; npm ci
cd C:\src\immage\app; npm ci
npm run tauri build
```

The installers land in `app\src-tauri\target\release\bundle\`:
`msi\Immage_<version>_x64_en-US.msi` and `nsis\Immage_<version>_x64-setup.exe`.
The `.msi` installs into `C:\Program Files\Immage` for every user. The
`.exe` asks: for everyone, into Program Files, or just for you, under
AppData, without administrator rights. On an administrator's account
Windows asks for permission before that choice either way; a standard
user gets no prompt and installs just for themselves. Settings, AI
models and caches stay in each user's AppData. Installing for everyone
over a per-user install (0.31 and earlier were always per user) removes
that copy first.

## When it goes wrong

- Copy the last 20 or so lines of the window's output; the first error is
  the one that matters.
- If only the `.msi` step fails (WiX's `light.exe`), turn on **VBScript**
  in *Settings > System > Optional features*; the `.exe` installer is made
  either way.
- An unsigned installer makes SmartScreen warn on first run: *More info >
  Run anyway*.
- AI masks download their models on first use with Windows' own `curl`
  and `tar`, which come with Windows 10 (1803 and later) and Windows 11.
  A download that fails says so in the status line at the bottom right of
  the photo.
