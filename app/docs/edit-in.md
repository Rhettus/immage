# Edit In

**Edit In** sends photos to another application. Use **DxO PureRAW** for
noise reduction and lens sharpening on raw photos, **Macro Studio** for
[focus stacking](#macro-studio-focus-stacking), **Helicon Focus** for
[focus stacking on Windows and macOS](#stack-a-focus-bracket-in-helicon-focus), or
**PhotoCraft** for [layered editing](#open-photos-as-layers-in-photocraft).

**If you've used another editor:** this is the usual Edit In command and
PureRAW's own plugin in one. The returned file appears beside its original,
and Immage switches off the corrections PureRAW has already made.

## Setting it up

1. Open **Preferences** (⌘,), the **Plugins** tab.
2. Click **Add Plugin ▾** and choose **DxO PureRAW**. Immage looks for the
   application in your Applications folder. If it isn't found, click
   **Choose…** beside **Application**.
3. In PureRAW, set it to save **DNG** files.
4. Leave **Results folder** empty if PureRAW saves to a "DxO" folder beside
   the photo, or beside the photo itself. Otherwise choose where it
   saves.
5. Choose what to switch off on a returned file, the first time it opens:
   - **Turn off lens corrections**: on, as PureRAW has corrected the lens
   - **Turn off noise reduction**: on, as PureRAW has removed the noise
   - **Turn off sharpening**: off; turn it on if PureRAW's lens sharpness
     was on

**Name** sets what the Edit In menu calls it.

![Preferences, Plugins tab with DxO PureRAW set up](images/edit-in-prefs.png)
<!-- screenshot: Preferences > Plugins with one DxO PureRAW card, application found -->

## Sending photos

Select one or more raw photos, right-click, and choose **Edit In ›
DxO PureRAW**. PureRAW opens with them.

While PureRAW works, a banner reads **Waiting for DxO PureRAW · 1 of 3
back…**, with **Stop waiting**. You can keep editing meanwhile.

## What comes back

As each DNG is saved, it appears in the filmstrip beside its raw. The first
one opens. The first time each opens, the corrections you chose are
switched off, and the History card shows it, for example
**DxO PureRAW: lens corrections, noise reduction off**. After that it is a
photo like any other.

Immage stops waiting when every photo is back, when you click **Stop
waiting**, or after three hours.

## When Edit In is grayed out

| Reason shown | Why |
| --- | --- |
| **choose its application in Preferences** | Immage couldn't find the editor. Set **Application**. |
| **raw files only** | PureRAW, Macro Studio's **Raws**, and Helicon Focus's **RAWs** and **Auto DNG** take RAW files. |
| **select at least 2 photos** | Macro Studio and Helicon Focus stack two or more photos. |
| **only photos on this computer** | An Immich result that hasn't been opened or downloaded yet. |

## Macro Studio: focus stacking

[Macro Studio](https://macrostudio.pro) merges a focus bracket, the same
subject shot at a run of focus distances, into one photo sharp from front
to back. Immage hands it the bracket and takes back the stack.

**If you've used another editor:** this is the same handoff Macro
Studio's plugins for other editors use: the stack opens in Macro Studio
for you to check and retouch, and comes back when you save it there.

### Setting it up

1. In **Preferences › Plugins**, click **Add Plugin ▾** and choose
   **Macro Studio**. Immage looks for it in your Applications folder; if
   it isn't found, click **Choose…** beside **Application**.
2. **Send**:
   - **Raws** (the default): the raw files go over as they are, with
     nothing clipped on the way, and the stack comes back as a raw DNG to
     edit here from the start. Your edit to the frames doesn't go with
     them.
   - **16-bit TIFFs**: each frame is written with its edit so far, as
     "-Edit" TIFFs beside the photos, and the stack has that edit baked
     in. Very saturated colors can clip. Takes photos that aren't raws.
3. **Look**: Macro Studio's finish on the stack. **Natural** leaves it
   as stacked, **Enhanced** sharpens it and adds clarity, and
   **Default** is what Macro Studio's own preferences say.

### Stacking

Select the frames of one bracket (two or more), right-click, and choose
**Edit In › Macro Studio**. Macro Studio stacks them and opens the result
in its editor. The banner reads **Waiting for Macro Studio…** meanwhile,
and you can keep editing.

Save the stack in Macro Studio, as DNG for the most latitude. It appears
in the filmstrip beside the first frame, named after it
(**P1010001-stacked.dng**), and opens. A stack made from raws starts
with the defaults a new raw gets. Saved again, it comes back again.

A stack saved after Immage stopped waiting, or while Immage was closed,
comes back the next time its folder is shown. Immage stops waiting when
the stack is saved or closed in Macro Studio, when you click **Stop
waiting**, or if Macro Studio doesn't start or stops responding.


The first returned result opens automatically when **Open generated photos**
is enabled in Preferences › General › Workspace. Turn it off to keep editing
the current photo and open the result from its completion notification.

## Stack a focus bracket in Helicon Focus

Install Helicon Focus on Windows or macOS. [Download Helicon Focus](https://www.heliconsoft.com/software-downloads/)

1. In **Preferences › Plugins › Edit In**, turn on **Helicon Focus**.
   If Immage doesn't find it, use **Choose…** beside **Application** to select
   the app on macOS or `HeliconFocus.exe` on Windows.
2. Select at least two photos from one focus bracket. Right-click and choose
   an option under **Edit In**.
   - **Helicon Focus (RAWs)** opens the original RAW files in Helicon Focus.
     Choose a rendering method and adjust the stack there. Save as DNG to
     develop the composite as a RAW in Immage.
   - **Helicon Focus (16-bit TIFFs)** renders the photos in Linear ProPhoto
     RGB with their Immage edits and opens those TIFFs in Helicon Focus.
     Choose your rendering settings and save the composite as a TIFF.
   - **Helicon Focus (Auto DNG)** uses Helicon Focus's current settings to
     stack the original RAW files in the background. Immage saves the
     result beside the first photo with `-Helicon.dng` in its name.
3. For either interactive option, Helicon Focus defaults to saving in the
   first photo's folder. Immage lists the composite when you save it.
   Quit the Helicon Focus session when you are ready to send another bracket.

DNG output requires Helicon Focus Pro, Adobe DNG Converter, and the
Raw-in-DNG-out loader. [Helicon Focus RAW requirements](https://www.heliconsoft.com/focus/help9/english/HeliconFocus.html#processing-of-raw-files)

Select the composite in Immage and choose **Edit In › PhotoCraft** to continue
editing it there.

## Open photos as layers in PhotoCraft

Install a version of PhotoCraft that includes `photocraft-cli` and supports
**Load Files into Stack**.
[PhotoCraft downloads](https://github.com/storytold/photocraft/releases)

1. In **Preferences › Plugins › Edit In**, turn on **PhotoCraft**.
2. If Immage doesn't find PhotoCraft, click **Choose…** beside **Application**.
   On macOS, select **PhotoCraft.app**. On Windows, select `photocraft.exe`
   in the same folder as `photocraft-cli.exe`. On Linux, select the executable
   AppImage with the bundled CLI, or select `photocraft` in the same folder
   as `photocraft-cli`.
3. Select one or more photos in the filmstrip or Library grid.
4. Right-click the selection and choose **Edit In › PhotoCraft**.

Immage renders each selected photo with its current edits at full resolution
in 16-bit linear ProPhoto RGB. Each photo or virtual copy gets its own editable
pixel layer in one PhotoCraft document.

The progress bar counts the rendered photos, then shows when PhotoCraft is
preparing the layers. You can start another PhotoCraft handoff once the
current document opens.

Immage saves a ZIP-compressed layered TIFF beside the first photo when the
estimated uncompressed layers and composite fit under 2 GiB. Larger stacks use
PSB. If PhotoCraft cannot write the layered TIFF, Immage tries PSB.

Use **Save** in PhotoCraft to update the document. Immage shows the TIFF beside
the source photos and edits its composite through an XMP sidecar. Use PhotoCraft
to edit individual layers. If you are working on a PSB, save a flattened
16-bit TIFF copy beside the photos to continue editing the composite in Immage.
