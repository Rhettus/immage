# Presets and looks

**Presets** set sliders: a saved set of Adjustments values you can apply to
any photo. **Looks** are film emulations, darktable styles laid on top of
your edit with their own strength. Both show live previews of the open
photo.

**If you've used another editor:** presets work like develop presets
elsewhere, with an Amount slider. Looks are closer to creative profiles:
one at a time, with their own amount.

Open them with **Presets** on the rail.

![The Presets panel with film look tiles](images/presets-panel.png)
<!-- screenshot: Presets mode, Basics expanded, a Film group expanded, one look applied with its chip in the header -->

## Presets

Every preset shows as a small tile of the open photo with the preset
applied. Hover over a tile to preview it full size; click to apply it.

After you apply one, **Amount** (0-200%) sets how strongly: 50% goes half
way from where the photo was, 200% goes twice as far. Double-click it for
100%.

**Built-in presets**

- **Default** (Import): lens corrections and chromatic aberration removal,
  for raws. It adds no sharpening; add your own in **Detail**. New raws
  get it unless you choose otherwise in Preferences.
- **Basics**: **Vivid**, **Soft**, **Bright & Airy**, **Moody** and
  **B&W Contrast**.

**Your own presets**

1. Edit a photo the way you want.
2. Click **+** in the panel's toolbar.
3. Name it, and choose or type a group.
4. Tick the settings to include. **White Balance** and **Transform** start
   unticked, as they belong to one photo; crop is never included.
5. Tick **Use for new photos** to have photos start from it.
6. Click **Create**.

The **⋯** on one of your presets has **Rename**, **Apply to new photos**
(or **Stop applying**), **Update with current settings**, **Export…** and
**Delete**.
The preset new photos get carries a **new photos** badge.

## Looks

Immage comes with 53 film looks from the t3mujinpack collection, in three
groups:

- **Film · Black and White** (12): AGFA APX, Fuji Neopan, Ilford Delta, FP4,
  HP5 and XP2, Kodak T-Max and Tri-X.
- **Film · Color Negative** (26): Agfa Vista, CineStill, Fuji Pro and
  Superia, Kodak ColorPlus, Ektar, Gold, Portra and Ultra Max.
- **Film · Color Slide** (15): Fuji Astia, Fortia, Provia, Sensia and
  Velvia, Kodak Ektachrome, Elite Chrome and Kodachrome.

Click a look to apply it, and again to take it off. One look applies at a
time. While one is on, the panel's head shows its name with **×** to remove
it, and **Look amount** (0-100) sets its strength.

A look sits on top of your edit: changing sliders afterwards still works.

Looks you import go in **My Looks**. Any darktable style (`.dtstyle`)
works as a look, though film emulations suit it best.

## Sharing presets and looks

The toolbar at the top of the panel works as the Export dialog's does, on
the tile you last clicked: **+** new preset, **Save** (update it with the
current settings), **Import**, **Share** and **Delete** (click twice).

**Share**, or **Export…** on a tile's **⋯**, saves it as a file to give
someone: a preset as a `.json` file, a look as its darktable style
(`.dtstyle`).

**Import** adds presets and looks from files, several at once if you like:

- a preset file's presets join their own group. Settings this version of
  Immage doesn't have are left out.
- a `.dtstyle` file becomes a look in **My Looks**. Its **⋯** can export or
  delete it; the film looks Immage comes with can be exported but not
  deleted.

An imported preset or look whose name is taken gets a number:
**Warm (2)**. Deleting a look doesn't change photos that have it on.

## Starting new photos from a preset

**Preferences › New Photos › Preset** chooses the preset every new photo
starts from. **Save current settings…** there makes one from the open
photo. See [Preferences](preferences.md).
