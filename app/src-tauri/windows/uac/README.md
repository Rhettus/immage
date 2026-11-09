# NSIS UAC plug-in

UAC 0.2.4c (2015-05-26), by Anders, under the zlib/libpng license
in [License.txt](License.txt). Used by Immage's custom NSIS installer to defer
UAC until all-users installation is selected and to run migration and user-data
cleanup in the invoking account, even with over-the-shoulder administrator
credentials. The installer uses the x86 Unicode NSIS stub on x64 Windows.

Upstream documentation and source:
https://nsis.sourceforge.io/UAC_plug-in

Original archive (includes C++ source, UAC.nsh and examples):
https://nsis.sourceforge.io/mediawiki/images/8/8f/UAC.zip

SHA-256:

- Original archive: `20e3192af5598568887c16d88de59a52c2ce4a26e42c5fb8bee8105dcbbd1760`
- `Plugins/x86-unicode/UAC.dll`: `2f7f8fc05dc4fd0d5cda501b47e4433357e887bbfed7292c028d99c73b52dc08`

Only the include, Unicode DLL and license are vendored. The DLL is unmodified;
text files have line endings and trailing whitespace normalized. No download is needed
at build time. Follow the original archive's `UAC_DualMode.nsi` for the page
resume and original-user callback protocol. The app's Windows license notices
include this component.
