# Immage developer docs

For people changing Immage's code: the React front end, the Rust layer and
the headless darktable engine. The photographer's guide is
[one folder up](../README.md).

- [Code map](code-map.md): where to start a change, and a line on each
  file. Short, as agents read it at the start of every session.
- [Architecture](architecture.md): the detail behind it: each file's job,
  the engine's pipes and commands, how an operation moves through the
  app, and where data is kept.
- Diagrams, each an editable [Excalidraw](https://excalidraw.com) scene with an SVG
  beside it:
  - [data flow](diagrams/dataflow.svg) ([.excalidraw](diagrams/dataflow.excalidraw)): the three processes,
    the code blocks in each, and what crosses between them
  - [entities](diagrams/entities.svg) ([.excalidraw](diagrams/entities.excalidraw)): the things the code passes
    around (Control, ModuleMap, Session, Mask, Frame, ...) and how they relate,
    down to darktable's develop, pipes and the XMP sidecar
  - [one slider move](diagrams/slider-sequence.svg) ([.excalidraw](diagrams/slider-sequence.excalidraw)): the
    sequence from an input event to pixels on screen
  - [one mask in darktable's pipe](diagrams/masks.svg) ([.excalidraw](diagrams/masks.excalidraw)): a
    mask's sliders, the module instances they set, and where those run in
    darktable's pipe
  - [masks sharing an instance](diagrams/mask-sharing.svg) ([.excalidraw](diagrams/mask-sharing.excalidraw)):
    several masks' groups summed into a combined mask that drives one shared
    instance
- [Masks in darktable's pipe](masks.md): how a mask and its local sliders
  become darktable mask groups and module instances, where those run, and
  how masks share them.
- [Print and soft proofing](print.md): the Print panel on darktable's
  soft proof and print code, run by the engine without darktable's GUI.
- [GUI performance tracing](performance-tracing.md): diagnostic events, scheduling flow and slow-frame analysis.
- [GUI verification architecture](gui-verification.md): observation hooks, expanded
  control inventory, commit-linked coverage and non-GUI checks.
- [Visible-app GUI verification plan](../../../verify/gui/README.md): native-window
  interaction tests, visual evidence, ignored results and coordination for agents.
- [benchmarking/](../../../benchmarking/README.md): the performance suite.
- [Pinning darktable](darktable-pin.md): which darktable commit Immage
  builds, moving it, and what breaks when it moves.
- [Releasing](releasing.md): cutting a release, from the version bump to
  publishing the draft, and the updater's signing key.
- [darktable/dev-doc/](../../../darktable/dev-doc/README.md): darktable's
  own developer docs, for anything the engine calls into darktable for.

- [Building Immage](building.md): platform dependencies, local builds and packaging.
- [Implementation overview](overview.md): engine, interface and import integration.

## Editing the diagrams

The diagrams are generated from the specs in
[`diagrams/build_diagrams.py`](diagrams/build_diagrams.py), so the SVG and
the Excalidraw file stay the same picture. After changing a spec, regenerate
them:

```bash
python3 -I app/docs/dev/diagrams/build_diagrams.py
```

To rearrange a diagram by hand instead, open its `.excalidraw` file in
excalidraw.com, or in VS Code with the Excalidraw extension. Then carry the
change back into the spec, because the next run of the script overwrites the
file.

## User guide screenshots

The user guide stores published screenshots in `app/docs/images/`. The workspace
overview (`workspace.png`) and Basic panel (`adjustments-basic.png`) were captured
from the visible Linux app using a copied RAW photo on 2026-11-01 (local date).
The overview is reused on the guide index and workspace page. It has no added
annotations; the alt text identifies the main regions. Basic uses an element
screenshot of the Adjustments sidebar so unrelated window content is excluded.

Capture controls or panels alone when sufficient for the section; reserve whole
app images for layout explanations. Inspect legibility and exclude credentials,
personal paths and unrelated windows before publishing. Keep raw capture reports,
profiles and sample originals out of the tracked image directory. A screenshot
documents appearance, not a passing GUI test. Check remaining placeholders with
`python3 -I app/docs/check_images.py`; do not launch another capture session
without the approval and workspace/memory procedure in `AGENTS.local.md`.

Use linked HTML image previews for these assets: the overview has a display
width of 960 pixels and the tall Basic panel 280 pixels. Both links open the
original PNG so readers can inspect details without expanding the whole page.
`check_images.py` recognizes both Markdown images and HTML `img` elements.
