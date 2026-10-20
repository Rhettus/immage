The app icon: the "mm" of Immage written as one stroke that rises from
the shadow corner to the highlight corner, a tone curve on a faint curve
grid, in an amber to coral gradient. `icon.svg` is the source; `icon-1024.png` is
rendered from it (`rsvg-convert -w 1024 -h 1024 icon.svg -o icon-1024.png`)
and turned into every size the app needs with `npx tauri icon
icon/icon-1024.png` from `app/`.
