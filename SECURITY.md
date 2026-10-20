# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub's private
vulnerability reporting: the **Security** tab of this repository, then
**Report a vulnerability**. Do not open a public issue for them.

Say what is affected (Immage version and platform), how to reproduce it, and
what an attacker could do with it.

## What belongs where

- **Immage itself**: the app, its engine (`engine/`), the build and the
  installers. Report here.
- **darktable**: Immage's engine is built on darktable, and most of the image
  processing, including raw decoding and file parsing, is darktable's code
  (or rawspeed's and LibRaw's within it). A problem there that darktable has
  too belongs upstream, at
  [darktable-org/darktable](https://github.com/darktable-org/darktable).
  If you are not sure, report it here and it will be passed on.
- **Immporter**, the importer built into Immage:
  [Rhettus/immporter](https://github.com/Rhettus/immporter).

## Supported versions

Fixes go into the latest release only.
