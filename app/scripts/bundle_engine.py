#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# copy an installed darktable engine (cmake --install build --prefix
# build/install) into the app's resources and make it self-contained: every
# Homebrew library it loads is copied into lib/darktable/deps and referenced
# relative to the file that loads it, then everything is signed ad hoc, which
# Apple silicon requires after install_name_tool has edited a binary
import glob, json, os, re, shutil, subprocess, sys, tarfile

repo = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
src = os.path.join(repo, "build", "install")
dst = os.path.join(repo, "app", "src-tauri", "resources", "darktable")
deps_dir = os.path.join(dst, "lib", "darktable", "deps")
EXTERNAL = ("/opt/homebrew/", "/usr/local/")

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

shutil.rmtree(dst, ignore_errors=True)
os.makedirs(os.path.join(dst, "bin"))
shutil.copy2(os.path.join(src, "bin", "darktable-engine"), os.path.join(dst, "bin"))
shutil.copytree(os.path.join(src, "lib", "darktable"), os.path.join(dst, "lib", "darktable"), symlinks=False)
shutil.copytree(os.path.join(src, "share", "darktable"), os.path.join(dst, "share", "darktable"))
# darktable on macOS loads lensfun's database only from share/lensfun beside
# its own data (iop/lens.cc), so the bundle carries Homebrew's copy
lensfun = os.path.realpath("/opt/homebrew/share/lensfun")
if not os.path.isdir(os.path.join(lensfun, "version_1")):
    sys.exit(f"no lensfun database at {lensfun}")
shutil.copytree(lensfun, os.path.join(dst, "share", "lensfun"))
os.makedirs(deps_dir, exist_ok=True)

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

# the licenses of the Homebrew packages bundled above, which the GPL and
# LGPL require to travel with the binaries: each keg's own license files,
# and an index with every package's license and where its source is, from
# the SPDX record Homebrew keeps in the keg
LICENSE_NAMES = ("LICENSE", "LICENCE", "COPYING", "COPYRIGHT", "NOTICE", "GPL", "LGPL", "MIT", "BSD", "APACHE")
CELLAR = os.path.realpath("/opt/homebrew/Cellar") + "/"
kegs = sorted({"/".join(p[len(CELLAR):].split("/")[:2])
               for p in list(copied) + [lensfun] if p.startswith(CELLAR)})
lic_dir = os.path.join(dst, "share", "licenses")
os.makedirs(lic_dir, exist_ok=True)
index, bare = [], []
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
            + "\nFrom Homebrew:\n\n" + "\n".join(index))
print(f"licenses for {len(kegs)} packages; no license file in the keg: {', '.join(bare) or 'none'}")

left = [(f, r) for f in ours + list(copied.values()) for r in links(f) if r.startswith(EXTERNAL)]
size = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(dst) for f in fs)
print(f"bundled {len(copied)} libraries, {size / 1e6:.0f} MB; unresolved external refs: {len(left)}")
for f, r in left[:10]:
    print("  ", os.path.relpath(f, dst), "->", r)
sys.exit(1 if left else 0)
