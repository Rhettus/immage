# Immage developer docs

For people changing Immage's code: the React front end, the Rust layer and
the headless darktable engine. The photographer's guide is
[one folder up](../README.md).

- [Code map](code-map.md): where everything lives, where to start a change,
  how an operation moves through the app, and where data is kept.
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
- [benchmarking/](../../../benchmarking/README.md): the performance suite.
- [Pinning darktable](darktable-pin.md): which darktable commit Immage
  builds, moving it, and what breaks when it moves.
- [Releasing](releasing.md): cutting a release, from the version bump to
  publishing the draft, and the updater's signing key.
- [darktable/dev-doc/](../../../darktable/dev-doc/README.md): darktable's
  own developer docs, for anything the engine calls into darktable for.

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
