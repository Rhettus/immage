License texts for MSYS2 packages whose DLLs the Windows engine bundles but
which install no license file. `app/scripts/bundle_engine_windows.sh` ships
a folder here only for a package that has none of its own, under the
package's name without the `mingw-w64-ucrt-x86_64-` prefix.

Each folder holds the license files from the upstream source of the version
MSYS2 built at the time (2026-10-20):

| package | version | license (MSYS2) | from |
|---|---|---|---|
| gmp | 6.3.0 | LGPL-3.0-or-later OR GPL-2.0-or-later | https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz |
| gnutls | 3.8.13 | LGPL-2.1-or-later (library) | https://www.gnupg.org/ftp/gcrypt/gnutls/v3.8/gnutls-3.8.13.tar.xz |
| libidn2 | 2.3.8 | LGPL-3.0-or-later OR GPL-2.0-or-later | https://ftp.gnu.org/gnu/libidn/libidn2-2.3.8.tar.gz |
| libx264 | 0.165.r3222.b35605a | GPL-2.0-or-later | https://code.videolan.org/videolan/x264, commit b35605ace3ddf7c1a5d67a2eb553f034aef41d55 |
| lz4 | 1.10.0 | BSD-2-Clause (library) | https://github.com/lz4/lz4, tag v1.10.0 (LICENSE, lib/LICENSE) |
| nettle | 4.0 | LGPL-3.0-or-later OR GPL-2.0-or-later | https://ftp.gnu.org/gnu/nettle/nettle-4.0.tar.gz |
| p11-kit | 0.26.5 | BSD-3-Clause | https://github.com/p11-glue/p11-kit, tag 0.26.5 |
| potrace | 1.16 | GPL-2.0-or-later | https://potrace.sourceforge.net/download/1.16/potrace-1.16.tar.gz |
| x265 | 4.3 | GPL-2.0-or-later | https://github.com/Multicorewareinc/x265/releases/download/4.3/x265_4.3.tar.gz |

When the bundle script reports a package with no license file, add its
folder here the same way.
