#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# copy an installed darktable engine (cmake --install build --prefix
# build/install) into the app's resources and make it self-contained.
# on macOS every Homebrew library it loads is copied into
# lib/darktable/deps and referenced relative to the file that loads it, then
# everything is signed ad hoc, which Apple silicon requires after
# install_name_tool has edited a binary. on Linux the libraries go to the
# same folder and every file's rpath points there, except the core ones
# every distribution has and must supply itself (SYSTEM_LIBS)
import glob, json, os, re, shutil, subprocess, sys, tarfile

repo = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
src = os.path.join(repo, "build", "install")
dst = os.path.join(repo, "app", "src-tauri", "resources", "darktable")
deps_dir = os.path.join(dst, "lib", "darktable", "deps")
LINUX = sys.platform.startswith("linux")
EXTERNAL = ("/opt/homebrew/", "/usr/local/")
LICENSE_NAMES = ("LICENSE", "LICENCE", "COPYING", "COPYRIGHT", "NOTICE", "GPL", "LGPL", "MIT", "BSD", "APACHE")

def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout

def is_macho(path):
    with open(path, "rb") as f:
        return f.read(4) in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe")

def links(path):
    # the first line is the file itself; a dylib's next line is its own id
    out = run("otool", "-L", path).splitlines()[1:]
    names = [l.strip().split(" (")[0] for l in out]
    if path.endswith((".dylib", ".so")) and names and os.path.basename(names[0]) == os.path.basename(path):
        names = names[1:]
    return names

def resolve(ref, loader):
    # @rpath and @loader_path references inside Homebrew's own libraries
    if ref.startswith(EXTERNAL):
        return os.path.realpath(ref)
    if ref.startswith(("@rpath/", "@loader_path/")):
        name = ref.split("/", 1)[1]
        for base in (os.path.dirname(os.path.realpath(loader)), "/opt/homebrew/lib"):
            cand = os.path.normpath(os.path.join(base, name))
            if os.path.exists(cand) and cand.startswith(EXTERNAL):
                return os.path.realpath(cand)
    return None

# what an AppImage must take from the system it runs on: glibc, the C++
# runtime (a host library the engine loads, such as an OpenCL driver, may
# need a newer one than the build system's), the graphics drivers, X11, and
# the font stack, whose configuration is the host's. the same split as
# AppImage's own excludelist
SYSTEM_LIBS = re.compile(r"(ld-linux.*|linux-vdso.*"
                         r"|lib(c|m|mvec|dl|pthread|rt|resolv|util|nsl|anl|BrokenLocale|thread_db|crypt)"
                         r"|libstdc\+\+|libgcc_s"
                         r"|lib(GL|GLX|GLdispatch|EGL|OpenGL|GLESv2|gbm|drm|vulkan|OpenCL)"
                         r"|libX11|libX11-xcb|libxcb.*|libfontconfig|libfreetype|libharfbuzz|libexpat)"
                         r"\.so(\.[0-9.]+)?")

def is_elf(path):
    with open(path, "rb") as f:
        return f.read(4) == b"\x7fELF"

def needed(path):
    # the libraries the file links against itself (its DT_NEEDED), with where
    # the loader finds each now: (soname, path), the path None when it is not
    # found. ldd also lists what those load in turn, which is left out: what a
    # SYSTEM_LIBS library needs comes from the host along with it, since the
    # loader searches that library's paths, not ours
    direct = run("patchelf", "--print-needed", path).split()
    out = subprocess.run(["ldd", path], capture_output=True, text=True).stdout
    found = {}
    for line in out.splitlines():
        m = re.match(r"\s*(\S+) => (?:not found|(\S+) \(0x)", line)
        if m:
            found[m.group(1)] = m.group(2)
    for name in direct:
        yield name, found.get(name)

shutil.rmtree(dst, ignore_errors=True)
os.makedirs(os.path.join(dst, "bin"))
shutil.copy2(os.path.join(src, "bin", "darktable-engine"), os.path.join(dst, "bin"))
shutil.copytree(os.path.join(src, "lib", "darktable"), os.path.join(dst, "lib", "darktable"), symlinks=False)
shutil.copytree(os.path.join(src, "share", "darktable"), os.path.join(dst, "share", "darktable"))
# darktable installs libonnxruntime.so with its .so.1 and .so.1.x.y symlinks
# (src/ai/CMakeLists.txt:91), which the copy above turns into three copies of
# the 22 MB library. nothing links it: the engine opens libonnxruntime.so by
# name (ORT_LIBRARY_PATH, backend_onnx.c:1196), so that one is kept
if LINUX:
    for f in glob.glob(os.path.join(dst, "lib", "darktable", "libonnxruntime.so.*")):
        os.remove(f)
# darktable on macOS loads lensfun's database only from share/lensfun beside
# its own data (iop/lens.cc), so the bundle carries Homebrew's copy. on
# Linux that is where it looks when the system has no database of its own;
# the copy is the latest lensfun-update-data fetched, if it was run
if LINUX:
    lensfun_pkg = "/usr/share/lensfun"
    lensfun = next((d for d in ("/var/lib/lensfun-updates", lensfun_pkg)
                    if os.path.isdir(os.path.join(d, "version_1"))), lensfun_pkg)
else:
    lensfun = os.path.realpath("/opt/homebrew/share/lensfun")
if not os.path.isdir(os.path.join(lensfun, "version_1")):
    sys.exit(f"no lensfun database at {lensfun}")
shutil.copytree(lensfun, os.path.join(dst, "share", "lensfun"))
os.makedirs(deps_dir, exist_ok=True)

if LINUX:
    ours = [os.path.join(root, f) for root, _, files in os.walk(dst) for f in files
            if is_elf(os.path.join(root, f))]
    # by soname, the name the loader looks for: the library it found and its
    # bundled copy. each copy's own links are followed in turn
    copied = {}
    queue = list(ours)
    while queue:
        for name, path in needed(queue.pop()):
            if path is None or SYSTEM_LIBS.fullmatch(name) or path.startswith(dst + "/") or name in copied:
                continue
            target = os.path.join(deps_dir, name)
            shutil.copy2(os.path.realpath(path), target)
            os.chmod(target, 0o755)
            copied[name] = (path, target)
            queue.append(target)
    # our files keep their own $ORIGIN entries (the engine's ../lib/darktable)
    for f in ours:
        rel = os.path.relpath(deps_dir, os.path.dirname(f))
        old = run("patchelf", "--print-rpath", f).strip()
        keep = [p for p in old.split(":") if p.startswith("$ORIGIN")]
        run("patchelf", "--set-rpath", ":".join(keep + [f"$ORIGIN/{rel}"]), f)
    for _, target in copied.values():
        run("patchelf", "--set-rpath", "$ORIGIN", target)
else:
    ours = [os.path.join(root, f) for root, _, files in os.walk(dst) for f in files
            if is_macho(os.path.join(root, f))]
    copied = {}  # realpath of a Homebrew library -> its bundled copy
    queue = list(ours)
    while queue:
        f = queue.pop()
        os.chmod(f, 0o755)
        for ref in links(f):
            real = resolve(ref, copied.get(f, f))
            if real is None:
                continue
            if real not in copied:
                target = os.path.join(deps_dir, os.path.basename(real))
                shutil.copy2(real, target)
                os.chmod(target, 0o755)
                copied[real] = target
                queue.append(target)
            rel = os.path.relpath(deps_dir, os.path.dirname(f))
            run("install_name_tool", "-change", ref,
                f"@loader_path/{rel}/{os.path.basename(real)}", f)

    for real, target in copied.items():
        run("install_name_tool", "-id", f"@rpath/{os.path.basename(target)}", target)

    for f in ours + list(copied.values()):
        run("codesign", "--force", "--sign", "-", f)

# the licenses of the packages bundled above, which the GPL and LGPL
# require to travel with the binaries, and an index with every package's
# license and where its source is
lic_dir = os.path.join(dst, "share", "licenses")
os.makedirs(lic_dir, exist_ok=True)
index, bare = [], []

def dpkg_owner(path):
    # merged /usr: dpkg may know a library under /lib or under /usr/lib
    cands = []
    for p in (path, os.path.realpath(path)):
        cands += [p, p[4:] if p.startswith("/usr/") else "/usr" + p]
    for p in cands:
        r = subprocess.run(["dpkg", "-S", p], capture_output=True, text=True)
        if r.returncode == 0:
            return r.stdout.split(":")[0].split(",")[0].strip()
    return None

def dep5_license(text):
    # the license of a machine-readable debian/copyright's "Files: *"
    if text.startswith("Format:"):
        for stanza in text.split("\n\n"):
            if re.search(r"^Files:\s*\*\s*$", stanza, re.M):
                m = re.search(r"^License:\s*(.+)$", stanza, re.M)
                if m:
                    return m.group(1).strip()
    return "see the copyright file"

if LINUX:
    # what build_linux_deps.sh built and installed itself, by file
    local = {}
    for meta in glob.glob("/usr/local/share/immage-deps/*/"):
        with open(os.path.join(meta, "files")) as f:
            for line in f:
                local[line.strip()] = meta
    pkgs, local_used = set(), set()
    for name, (path, _) in copied.items():
        meta = local.get(path) or local.get(os.path.realpath(path))
        if meta:
            local_used.add(meta)
            continue
        pkg = dpkg_owner(path)
        if pkg:
            pkgs.add(pkg)
        else:
            bare.append(name)
            index.append(f"{name}\n  license: unknown, from {os.path.realpath(path)}\n")
    lensfun_file = next(iter(sorted(glob.glob(os.path.join(lensfun_pkg, "version_1", "*.xml")))), None)
    if lensfun_file and dpkg_owner(lensfun_file):
        pkgs.add(dpkg_owner(lensfun_file))
    for meta in sorted(local_used):
        with open(os.path.join(meta, "info")) as f:
            head, license, source = f.read().splitlines()[:3]
        name = head.split()[0]
        texts = [t for t in sorted(os.listdir(meta)) if t not in ("info", "files")]
        os.makedirs(os.path.join(lic_dir, name), exist_ok=True)
        for t in texts:
            shutil.copy2(os.path.join(meta, t), os.path.join(lic_dir, name, t))
        index.append(f"{head}, built from source\n  {license}\n  {source}\n"
                     f"  texts: {', '.join(f'{name}/{t}' for t in texts)}\n")
    for pkg in sorted(pkgs):
        version, homepage, srcpkg = run("dpkg-query", "-W", "-f", "${Version}\t${Homepage}\t${source:Package}",
                                        pkg).split("\t")
        copyright = os.path.join("/usr/share/doc", pkg, "copyright")
        license, texts = "unknown", ""
        if os.path.isfile(copyright):
            with open(copyright, errors="replace") as f:
                license = dep5_license(f.read())
            os.makedirs(os.path.join(lic_dir, pkg), exist_ok=True)
            shutil.copy2(copyright, os.path.join(lic_dir, pkg, "copyright"))
            texts = f"  texts: {pkg}/copyright\n"
        else:
            bare.append(pkg)
        index.append(f"{pkg} {version}\n  license: {license}\n"
                     f"  source: {homepage or 'none given'} (source package {srcpkg} {version})\n" + texts)
    with open("/etc/os-release") as f:
        distro = re.search(r'^PRETTY_NAME="?([^"\n]*)', f.read(), re.M).group(1)
    packages_heading = f"From {distro}'s packages:"
    counted = len(pkgs) + len(local_used)
else:
    CELLAR = os.path.realpath("/opt/homebrew/Cellar") + "/"
    kegs = sorted({"/".join(p[len(CELLAR):].split("/")[:2])
                   for p in list(copied) + [lensfun] if p.startswith(CELLAR)})
    for keg in kegs:
        name, version = keg.split("/")
        root = os.path.join(CELLAR, keg)
        texts = [f for f in sorted(os.listdir(root)) if os.path.isfile(os.path.join(root, f))
                 and f.upper().startswith(LICENSE_NAMES)]
        for f in texts:
            os.makedirs(os.path.join(lic_dir, name), exist_ok=True)
            shutil.copy2(os.path.join(root, f), os.path.join(lic_dir, name, f))
        # texts kept in app/licenses for a keg that ships none (lensfun)
        extra = os.path.join(repo, "app", "licenses", name)
        if os.path.isdir(extra):
            shutil.copytree(extra, os.path.join(lic_dir, name), dirs_exist_ok=True)
            texts += sorted(os.listdir(extra))
        license, source = "unknown", ""
        try:
            with open(os.path.join(root, "sbom.spdx.json")) as f:
                pkg = next(p for p in json.load(f)["packages"] if p["name"] == name)
            license = pkg.get("licenseConcluded") or license
            source = pkg.get("downloadLocation") or ""
        except (OSError, ValueError, StopIteration, KeyError):
            pass
        if not texts:
            bare.append(name)
        index.append(f"{name} {version}\n  license: {license}\n  source: {source}\n"
                     + (f"  texts: {', '.join(f'{name}/{t}' for t in texts)}\n" if texts else ""))
    packages_heading = "From Homebrew:"
    counted = len(kegs)

# libraries that come from elsewhere: those darktable compiles in from
# src/external, and ONNX Runtime, from the archive darktable's build
# downloaded (cmake/modules/FindONNXRuntime.cmake keeps only its libraries)
EXTERNAL_LIBS = [  # (folder in src/external, license, source)
    ("rawspeed", "LGPL-2.1-or-later", "https://github.com/darktable-org/rawspeed"),
    ("LibRaw", "LGPL-2.1-only OR CDDL-1.0", "https://github.com/LibRaw/LibRaw"),
    ("whereami", "MIT OR WTFPL", "https://github.com/gpakosz/whereami"),
    ("libxcf", "MIT", "https://github.com/houz/libxcf"),
    ("OpenCL", "Apache-2.0", "https://github.com/KhronosGroup/OpenCL-Headers"),
]
own = []
for name, license, source in EXTERNAL_LIBS:
    root = os.path.join(repo, "darktable", "src", "external", name)
    texts = [f for f in sorted(os.listdir(root)) if f.upper().startswith(LICENSE_NAMES)]
    os.makedirs(os.path.join(lic_dir, name), exist_ok=True)
    for f in texts:
        shutil.copy2(os.path.join(root, f), os.path.join(lic_dir, name, f))
    own.append(f"{name}, in darktable's source (src/external/{name})\n  license: {license}\n  source: {source}\n"
               f"  texts: {', '.join(f'{name}/{t}' for t in texts)}\n")
ort = sorted(glob.glob(os.path.join(repo, "build", "_deps", "onnxruntime-*.tgz")))
if glob.glob(os.path.join(dst, "lib", "darktable", "libonnxruntime*")):
    if not ort:
        sys.exit("ONNX Runtime is bundled, but its archive (and license) is not in build/_deps")
    version = re.search(r"-(\d[\d.]*)\.tgz$", ort[-1]).group(1)
    os.makedirs(os.path.join(lic_dir, "onnxruntime"), exist_ok=True)
    texts = []
    with tarfile.open(ort[-1]) as t:
        for m in t.getmembers():
            if m.isfile() and m.name.count("/") == 1 and os.path.basename(m.name) in ("LICENSE", "ThirdPartyNotices.txt"):
                with open(os.path.join(lic_dir, "onnxruntime", os.path.basename(m.name)), "wb") as f:
                    f.write(t.extractfile(m).read())
                texts.append(os.path.basename(m.name))
    own.append(f"onnxruntime {version}\n  license: MIT\n  source: https://github.com/microsoft/onnxruntime\n"
               f"  texts: {', '.join(f'onnxruntime/{t}' for t in sorted(texts))}\n")
# OpenCV, compiled into darktable for HDR Merge's alignment from the build
# app/scripts/build_opencv.sh makes, with the texts of the parts it includes
cv = os.path.join(repo, "build", "opencv", "install")
with open(os.path.join(repo, "build", "CMakeCache.txt")) as f:
    with_cv = "USE_OPENCV:BOOL=ON" in f.read()
if with_cv and os.path.exists(os.path.join(cv, "info")):
    with open(os.path.join(cv, "info")) as f:
        head, license, source = f.read().splitlines()[:3]
    os.makedirs(os.path.join(lic_dir, "opencv"), exist_ok=True)
    texts = [os.path.join(cv, "LICENSE")] + sorted(glob.glob(os.path.join(cv, "share", "licenses", "opencv4", "*")))
    for t in texts:
        shutil.copy2(t, os.path.join(lic_dir, "opencv", os.path.basename(t)))
    own.append(f"{head}, compiled into darktable\n  {license}\n  {source}\n"
               f"  texts: {', '.join('opencv/' + os.path.basename(t) for t in texts)}\n")
# the darktable commit built, so its source can be found exactly; a source
# archive has no git, and then the notice says only where darktable is
try:
    dt_rev = run("git", "-C", os.path.join(repo, "darktable"), "rev-parse", "HEAD").strip()
    dt_source = f"https://github.com/darktable-org/darktable/tree/{dt_rev}"
except (OSError, subprocess.CalledProcessError):
    dt_source = "https://github.com/darktable-org/darktable, at the commit in Immage's source"
with open(os.path.join(lic_dir, "INDEX.txt"), "w") as f:
    f.write("Libraries bundled with Immage's engine. Each keeps its own license; texts\n"
            "are in the folder named after it. darktable itself is under the GNU GPL,\n"
            "version 3 or later, as Immage is.\n\n"
            f"darktable\n  license: GPL-3.0-or-later\n  source: {dt_source}\n\n"
            "Compiled into darktable, or bundled beside it:\n\n" + "\n".join(own)
            + f"\n{packages_heading}\n\n" + "\n".join(index))
print(f"licenses for {counted} packages; no license file: {', '.join(bare) or 'none'}")

if LINUX:
    bundled = ours + [t for _, t in copied.values()]
    left = [(f, n + " => " + (p or "not found")) for f in bundled for n, p in needed(f)
            # the system ones first: ldd prints the loader without a "=>"
            if not SYSTEM_LIBS.fullmatch(n) and (p is None or not p.startswith(dst + "/"))]
else:
    left = [(f, r) for f in ours + list(copied.values()) for r in links(f) if r.startswith(EXTERNAL)]
size = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(dst) for f in fs)
print(f"bundled {len(copied)} libraries, {size / 1e6:.0f} MB; unresolved external refs: {len(left)}")
for f, r in left[:10]:
    print("  ", os.path.relpath(f, dst), "->", r)
sys.exit(1 if left else 0)
