# Zone System

The Zone System panel shows a black and white photo's tones as eleven
zones, from pure black to pure white. You can see where every tone in the
picture falls, move tones to the zones you want them in, and fine-tune any
band of tones on its own.

## What it is

The Zone System was devised by Ansel Adams and Fred Archer in the 1930s to
take the guesswork out of black and white photography. It divides the range
from black to white into eleven zones, written in Roman numerals:

| Zone | What it usually holds |
| --- | --- |
| 0 | pure black, no detail |
| I | near black, a hint of tone but no texture |
| II | the first deep shadows with any texture |
| III | dark shadows with full detail and texture |
| IV | open shadow, dark foliage, dark stone |
| V | middle gray: the 18% gray card, clear north sky, weathered wood |
| VI | average light skin, shadows on snow, light stone |
| VII | very light skin, light gray objects, bright textures |
| VIII | the brightest whites that still have texture |
| IX | near white, a hint of tone but no texture |
| X | pure white: specular highlights, light sources |

Each zone is one stop (twice the light) brighter than the one below it.
Zone V is middle gray, so zone VI has twice its light and zone IV half.

Immage measures the zones on the black and white image in scene-referred
light, before the tone mapper. So the zones describe the light in the scene,
and the pixels the histogram counts, the pixels the overlay shows and the
pixels a zone adjustment changes are always the same ones.

## The objective

Adams' idea was **previsualization**: decide what the finished print should
look like, then work back to get there. With the Zone System you think in
terms like "the shadow under that rock should be dark but still show
texture" and turn that into "that shadow belongs in zone III".

Editing with the panel follows the same idea:

1. **Decide** where the important tones should sit. For a portrait, the lit
   side of the face often belongs in zone VI; for a landscape, the textured
   shadows in III and the brightest snow or cloud with detail in VII-VIII.
2. **Read** where those tones fall now. Point at the zones and watch where
   they light up on the photo.
3. **Place** them, moving a tone and the tones around it to the zone you
   chose.
4. **Refine** a single band of tones, or one band in one part of the
   photo, where moving everything together isn't enough.

Keep two things in mind as you go:

- **Texture lives in zones II to VIII.** Anything pushed into 0-I or IX-X
  loses its detail. Sometimes that's what you want (a black background, a
  glowing window), but it should be a choice, not an accident.
- **Keep tones in order.** A brighter part of the scene should stay
  brighter than a darker one. If tones cross over, edges get halos and smooth
  gradients break into bands. The panel warns you when an edit would do this.

## Opening the panel

Click the **Zone System** button on the rail, the column of buttons on the
right edge of the window.

The Zone System works only on black and white photos. If the photo is in
color, the panel says so and offers **Convert to Black & White**. That's
the same as setting **Treatment** to **Black & White** in the Adjust panel.

## Reading the zones

### The zone histogram

At the top is a bar for each zone, 0 to X, shaded from black to white. A
bar's height shows how much of the photo falls in that zone. A thin line
over the bars shows the same distribution in finer detail, in tenths of a
zone.

If any of the photo is darker than zone 0 or brighter than zone X, the
percentages show under the histogram: **◀** on the left for the part darker
than zone 0, **▶** on the right for the part brighter than zone X.

After an edit, the bars dim for a moment while the zones are measured
again.

### Pointing and pinning

- **Point** at a zone: it lights up over the photo in the overlay color, so
  you can see exactly which parts of the picture are in that zone.
- **Click** a zone to **pin** it. The tabs below work on what is pinned.
  Click the pinned zone again to unpin it.
- **Drag** across the bars, or **shift-click** a second zone, to pin a run
  of zones (for example, zones III-V).
- **Point at the photo**: the zone of the spot under the pointer lights up
  in the histogram, and **pointer** under the thumbnail gives it exactly,
  such as **zone VI.3**. Past zone 0 or X, the **◀** or **▶** figure lights
  instead.

### The inspector

Below the histogram, a small grayscale thumbnail shows the pinned (or
pointed-at) zones as a mask: white where the photo is fully selected, black
where it isn't, and gray at the soft edges. Next to it:

- the zone or zones selected, marked **(hover)** while you're only pointing
- **% of the image**: how much of the photo they cover
- **mean**: their average zone. A value such as **V.4** means four tenths of
  the way from zone V to zone VI.
- **image: median ... 5-95% ...**: where the middle of the whole photo sits,
  and the range that its darkest 5% and brightest 5% fall outside of. This is
  a quick check of the photo's overall tonal range.

### Show mask overlay

When **Show mask overlay** is on, the pinned zones stay highlighted on the
photo. It steps aside while you drag a slider, so you can see the result.
The zone you are pointing at always shows, whatever this switch is set to.
Press **O** to turn the overlay on or off.

## Placement: moving tones to new zones

The **Placement** tab moves the pinned zones to other zones. It works like a
tone curve, but you describe the move in zones. The tones around the pinned
zones follow, fading out with distance, so the picture stays smooth.

Placement is one curve for the whole photo. Each move you make builds on the
ones before, so you can place the shadows, then the highlights, then the
midtones.

### The curve

The graph shows, for each zone across the bottom, which zone it comes out
in. The diagonal is "no change". Where the curve is above it, tones are
brighter; below it, darker. The pinned zones are shaded.

Above the sliders, a readout such as **Zone III → IV.2 (comes out at IV.1)**
says where you asked the pinned zones to go and where they actually land.
The two can differ a little, because the curve has to stay smooth and keep
tones in order.

### Controls

- **Place at**: the zone the middle of the pinned zones goes to. You can
  move it up to two zones either way. To make shadows that fell in zone II
  hold texture, pin zone II and place it at III.
- **Transition**: how many zones on either side follow the move, from 0.5
  to 4 (1.5 by default). A small value moves only what is pinned, which
  takes contrast out of the zones next to it. A large value moves a broad
  sweep of tones together, which feels more like an exposure change.
- **Reset placement**: undo all placement. Local adjustments stay.

### Notes you may see

- **zones 0 and I move with zone II**: zones 0 and I can't be placed on
  their own. Pinning them moves them together with zone II.
- **transition widened to ... zones to keep tones in order**: the move was
  too sharp for the transition you set, so Immage used a wider one to keep
  brighter tones brighter.
- **tones cross over near zone ...: widen the transition**: somewhere a
  brighter tone now comes out darker than a darker one. Increase the
  transition, or move the zones less.

When the photo has a placement, a dashed line on the histogram shows where
the tones were before it. Compare it with the solid line to see what the
placement did.

## Local: adjusting a band of tones

The **Local** tab adjusts only the pinned zones, through a mask that
selects them. Use it when placement isn't precise enough. For example, you
might add contrast inside zones VI-VII to bring out cloud texture, or darken
zone IV only in the sky.

The first time you move one of its sliders, Immage creates a mask named
after the zones, such as **Zone VI** or **Zones III-V**. These are ordinary
masks: they also appear in the Masks panel, and undo treats them like any
other edit.

### Saved adjustments

Each zone mask you've made shows as a chip at the top of the tab. Click one
to pin its zones again and carry on editing it, or click **×** to delete it.

### Color mask: narrowing to part of the photo

**Color mask** restricts the adjustment to part of the photo as well as to
the pinned zones:

- **All**: the whole photo (the default)
- **Sky**, **Rocks**, **Vegetation**, **Subject**: a part Immage's AI finds
  in the photo. It looks at the photo's original colors, so it can tell a
  gray sky from gray rock even when they share a zone.
- **+ Object**: any one thing in the photo. Click **+ Object**, then drag
  a box around the object on the photo, or click it, and the AI outlines
  what is there (**Esc** cancels). Each object gets a button of its own,
  **Object A**, **Object B** and so on, for choosing it again.
- **everything but it**: appears once you've chosen a part, and selects the
  rest of the photo instead (for example, zone V everywhere except the sky)

The first time you choose a part on a photo, it takes a moment to find. If
the photo has no such part, the status bar says **nothing found** and the
choice stays as it was.

Choosing a part changes only the overlay at first. Like any zone mask, the
mask is created when you first move a slider, and it is named for both the
zones and the part, for example **Zone V · Sky** or **Zone V · not Sky**.
It is a mask of its own: a **Zone V** mask you made before stays as it was,
so to move an adjustment to the sky, set it on **Zone V · Sky** and return
the sliders of **Zone V** to zero. The overlay and the thumbnail show the
combined selection.

A part changes only where it overlaps the pinned zones. A bright sky may
sit in zones VIII-X, so with zones III-VII pinned, **Sky** selects nothing
and the sliders have no effect. Check the overlay: if it shows nothing
over the part, pin zones that it covers.

### Controls

- **Exposure**: brighten or darken the selected tones, by up to ±2 EV
  (stops).
- **Contrast**: from -100 to +100. It spreads the selected tones apart or
  draws them together around the middle of the pinned zones, so the zones'
  overall brightness holds while texture within them strengthens or
  softens.
- **Mask strength**: how much of the adjustment is applied, from 0 to
  100%. Lower it to tone the adjustment down without changing the sliders.
- **Transition**: how softly the mask fades into the neighboring zones,
  from 0.1 to 2 EV (1 by default). Narrow values select the zones sharply;
  wide ones blend more gently.
- **Edge aware**: from 0 to 100. Makes the mask follow the edges in the
  photo, so a change to the sky doesn't spill over onto a dark tree
  against it as a halo.

### When tones turn around

If you see **this much exposure turns tones around at the zones' edge**,
the exposure pushes the selected tones past the tones just outside the
mask. Brightening zone IV by two stops, for example, takes it beyond parts
of zone V that weren't brightened. To fix it, widen the **Transition**,
lower the **Mask strength**, or make the move on the **Placement** tab,
which always keeps tones in order.

### Placement or Local?

- Use **Placement** to set the overall tonality of the photo: where the
  shadows, midtones and highlights sit. It changes the whole range smoothly
  and can't reverse tones.
- Use **Local** for targeted work: texture within one band, one zone in one
  part of the photo, or a change too narrow for placement.

## Advanced

Click **Advanced** at the bottom of the panel for:

- **Overlay color**: blue, red, green, yellow or magenta. Choose whichever
  stands out best against the photo.
- **Overlay opacity**: from 10 to 100%.
- **Reset zones**: removes the placement and every zone adjustment from
  the photo. Your other edits stay.

Immage remembers the overlay settings between photos and sessions.

## Keyboard

| Key | Action |
| --- | --- |
| O | show or hide the pinned zones' overlay |
| ← → | move the pinned zones down or up one zone (click the histogram first) |
| ⇧← ⇧→ | shrink or grow the run of pinned zones |
| Esc | unpin |

If nothing is pinned, an arrow key pins zone V.

## A worked example

A landscape with a bright sky and a shaded foreground:

1. Open the **Zone System** panel and **Convert to Black & White**.
2. Point at the zones. Say the foreground rocks light up in zone II and
   the clouds in zone IX: the rocks have lost texture and the clouds are
   nearly white.
3. Pin zone II. On **Placement**, set **Place at** to III. The rocks move
   up a zone and their texture comes back.
4. Pin zone IX and place it at VIII to bring tone back into the clouds.
5. The clouds still look flat. On **Local**, pin zones VII-VIII, choose
   **Sky** under **Color mask**, and raise **Contrast** to bring out their
   structure. Add some **Edge aware** if a halo appears where the sky meets
   the hills.
6. Check the **◀ ▶** percentages under the histogram. Only what you mean to
   be pure black or pure white should be there.
