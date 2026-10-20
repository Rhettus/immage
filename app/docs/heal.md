# Heal and clone

Remove dust spots, blemishes and distractions.

**If you've used another editor:** this is spot removal, Q to open it,
with a visualize-spots view on A. Immage picks the source for you, and you can move it.

Open it with **Heal** on the rail, or Q.

![Heal with a spot selected and its source shown](images/heal.png)
<!-- screenshot: Heal mode, a sky with dust spots, one spot selected showing its source outline and link line -->

## Removing a spot

- **Click** a spot to cover it with a round patch.
- **Drag** along a line, such as a wire, to paint over it.

Immage finds a source for the patch: the area that best matches the
spot's surroundings. It shows as an outline linked to the spot.

- Drag the spot to move it.
- Drag the source to move just the source.

## Heal or clone

- **Heal**: copies texture from the source, matched to the spot's color and
  light. Best for most spots.
- **Clone**: copies the source exactly as it is. Best where heal blends in
  the wrong tone, such as along an edge.

## Settings

- **Size**: 0.2-20% of the photo.
- **Feather**: 0-100, how soft the patch's edge is.
- **Opacity**: 0-100.

With a spot selected, the settings change that spot. They are also kept
for the next one.

**Delete spot** removes the selected spot; **Clear all** removes every
spot.

## Visualize Spots

A, or **Visualize spots**, shows the photo as an edge map where dust stands
out. **Threshold** sets how much shows.

## Keys

| Key | Action |
| --- | --- |
| Q | Heal and clone |
| [ ] | Brush size |
| Scroll | Brush size; ⇧-scroll its feather |
| A | Visualize spots |
| Delete | Remove the selected spot |
| Esc | Deselect the spot |
