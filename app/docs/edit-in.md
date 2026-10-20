# Edit In

**Edit In** sends photos to another application for something Immage
doesn't do itself, and brings back the file it saves, ready to edit. Today
that application is **DxO PureRAW**, for its noise reduction and lens
sharpening on raws.

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
| **choose its application in Preferences** | PureRAW wasn't found; set **Application**. |
| **raw files only** | PureRAW only takes raws. |
| **only photos on this computer** | An Immich result that hasn't been opened or downloaded yet. |
