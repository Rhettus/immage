import { generated, generatedNames } from './generated.mjs';
// SPDX-License-Identifier: GPL-3.0-or-later
// These are coverage claims for cases, not proof they have passed on a platform.
export const cases = {
  startup: { scope: 'visible fixture, stable final canvas, isolated profile', liveValidated: true },
  splash: { scope: 'the launch splash keeps its 640x427 size on a tiling window manager (measured by startup); known to fail on Hyprland, not in smoke', liveValidated: true },
  'gui-benchmark': { scope: 'Preferences Run button, saved schema 9 report, visible stable viewport, restored photo', liveValidated: true,
    verification: 'Linux ARM64 VM, system WebKitGTK 2.54.2, Wayland DPR 2 run 2026-11-02T15-05-22.535Z_ee28973_5104c5ed; DPR 1 with deferred viewport gate run 2026-11-02T15-20-43.128Z_ee28973_46f49c76.',
    limitation: 'Runs the app scripted workload, not pointer latency. VM timings are approximate; no compositor presentation or native GPU claim.' },
  'gui-benchmark-screen': { scope: 'GUI benchmark with screen-scale drafts enabled through Preferences', liveValidated: true,
    verification: 'Linux ARM64 VM, system WebKitGTK 2.54.2, Wayland 125%, DPR 2, draftScale 0.625; run 2026-11-02T15-34-27.864Z_ee28973_66140df8.',
    limitation: 'Requires preconfigured fractional output. Does not change display settings.' },
  'gui-benchmark-whole': { scope: 'GUI benchmark with screen-scale drafts disabled through Preferences', liveValidated: true,
    verification: 'Linux ARM64 VM, system WebKitGTK 2.54.2, Wayland 125%, DPR 2, draftScale 1; run 2026-11-02T15-40-01.172Z_ee28973_e7cc09e0.',
    limitation: 'Requires preconfigured fractional output. Does not change display settings.' },
  exposure: { scope: 'pointer drag both directions, brightness, reset pixels', liveValidated: true },
  'slider-input': { scope: 'Exposure keyboard, inline editor, focus and reset', liveValidated: true,
    verification: 'Linux ARM64, system WebKitGTK 2.54.2, Wayland, DPR 2; run 2026-11-01T23-39-31.087Z_f8f31aa_bc0fb5a5. Remaining controls suite stopped at history.' },
  'slider-click': { scope: 'a click on Exposure/Shadows/Contrast tracks, without moving, jumps the value and the settled photo follows (user report: no change until dragged)', liveValidated: false },
  'batch-paste': { scope: 'two selected photos, Kodak look and strength, unticked groups, batch undo/redo, persistence and untouched photo', liveValidated: false, limitation: 'Copied JPEG fixtures; backend suite covers virtual copies, masks, failures and negative conversion.' },
  history: { scope: 'Exposure undo/redo and basic Reset All value/photo round trip', liveValidated: false,
    limitation: 'Does not yet cover b1d7c4c native-module Reset All regression.' },
  rail: { scope: 'Presets/Masks/Zones/Heal/Adjustments activation, geometry and Windows cursor CSS', liveValidated: false,
    commits: ['fe5dbc2'], limitation: 'Native cursor stacking remains a manual Windows check.' },
  'panel-scroll': { scope: 'each right panel tool keeps its own scroll offset; a first open starts at the top', commits: ['81d4441'], liveValidated: true },
  sliders: { scope: 'currently mounted sliders in available manifest panels; drag and reset', liveValidated: false,
    limitation: 'Hidden tabs/sections/module choices and RAW-only controls require further scenarios. Pixel changes are recorded for review, not universal image-effect assertions.' },
  'module-options': { scope: 'each Global/Masks preference option and independent Contrast choices', liveValidated: false,
    commits: ['faa19d7', '9d956c7'], limitation: 'Does not establish rendered correctness of every engine module.' },
  'crop-guides': {scope:'first-entry crop guides and handles',commits:['323cfa9'],liveValidated:false},
  'crop-locked': {scope:'all locked corners, single-axis inward drags',commits:['b22bd4b'],liveValidated:false},
  'crop-portrait': {scope:'EXIF portrait orientation, resize all edges',commits:['1f2f8b8'],fixture:'portrait',liveValidated:false},
  'crop-options': {scope:'every aspect, custom entry, cancel, rotation/flip',liveValidated:false},
  'native-reset': {scope:'native Contrast edit, Reset All and undo with sidecar evidence',commits:['b1d7c4c'],liveValidated:false,limitation:'Does not seed hidden nondefault native parameters; original trigger remains incompletely covered.'},
  curves:{scope:'point curve: add/lift/double-click removal per channel with distinct photos, black point lift and corner clamp, 20-point limit, drag-off removal, Reset All, parametric switch',liveValidated:true},
  wheels:{scope:'3-way/global wheel changes, reset and slider view',liveValidated:false},
  equalizer:{scope:'every channel and band keyboard change/reset',liveValidated:false},
  masks:{scope:'manual shapes/ranges, Exposure effect, delete/reset',liveValidated:false},
  heal:{scope:'Heal/Clone spot creation/settings/deletion',liveValidated:false},
  negative:{scope:'negative conversion and turn-off round trip',fixture:'negative',liveValidated:false},
  film:{scope:'film simulation on, a preset, and turn-off round trip',liveValidated:false,limitation:'Needs the spektrafilm data pack installed; does not test its download.'},
  zones:{scope:'each zone selection and visible inspection',liveValidated:false},
  'preferences-matrix':{scope:'local checkbox/menu/segmented preference options; hardware/restart/network actions blocked',liveValidated:false},
  'slider-wheel':{scope:'wheel disabled/enabled behavior',liveValidated:false},
  'export-options':{scope:'in-app export option/preview settings without destination chooser or actual export',liveValidated:false},
  filters:{scope:'every filter category layout',liveValidated:false},
  presets:{scope:'available preset application and reset',liveValidated:false},
  shortcuts:{scope:'shortcut dialog open/read/close',liveValidated:false},
  'histogram-endpoints':{scope:'visible histogram endpoint columns',fixture:'endpoints',commits:['de6adf7'],liveValidated:false},
  'preview-alignment':{scope:'scaled final frame geometry after drag',commits:['630672c'],liveValidated:false},
  'loupe-grid':{scope:'loupe delivered-frame counter remains stable in grid',commits:['29b1591'],liveValidated:false},
  'mask-loupe':{scope:'loupe atop a mask\'s Presence; picking with the brush armed moves it without painting',liveValidated:true},
  'detail-without-loupe':{scope:'detail effect and final dimensions without loupe',commits:['f023c4f'],liveValidated:false},
  'camera-body':{scope:'independent same-model body serial options and missing serial',fixture:'camera-a',commits:['7b20937'],liveValidated:false},
  'rejected-deletion':{scope:'reject copied fixture; deletion blocked by native confirmation boundary',commits:['baa8def'],liveValidated:false},
  'folder-race':{scope:'controlled slow unrelated folder and stale result protection',commits:['17ac5e6','74cedc9'],liveValidated:false},
  panorama:{scope:'projection choices and preview with overlapping fixtures',liveValidated:false},
  'immich-workflow':{scope:'isolated local-service prerequisite; no live account access',commits:['33949b6','22840b4'],liveValidated:false},
  'site-shots':{scope:'website and guide screenshots: Basic before/after, color grading, mask, presets, heal, crop, Zone System, first launch, Folders, Library grid, split before/after, History, point tone curve, RYB vectorscope, Preferences; photo info hidden, shots with a visible path skipped',liveValidated:true,
    limitation:'Captures evidence for the website; asserts only that each tool opened. A shot that cannot be reached is recorded as skipped.'},
  ...generated,
};
export const suites = {
  smoke: ['startup', 'exposure'],
  crop: ['startup','crop-guides','crop-locked','crop-options'],
  workflows: ['startup','curves','wheels','equalizer','masks','heal','zones','film','preferences-matrix','slider-wheel','export-options','filters','presets','shortcuts'],
  inventory: ['startup',...generatedNames],
  regressions: ['startup', 'rail', 'panel-scroll', 'module-options', 'batch-paste'],
  controls: ['startup', 'slider-input', 'slider-click', 'history', 'rail', 'sliders', 'module-options'],
};
export function resolveCases(name) {
  // a comma list runs several cases in one launch: startup,masks,heal
  if (name.includes(',')) {
    const names = name.split(',').map(s => s.trim()).filter(Boolean);
    for (const n of names) if (!Object.hasOwn(cases, n)) throw Error(`Unknown case: ${n}`);
    return [...new Set(['startup', ...names])];
  }
  if (name === 'all') return ['startup',...Object.keys(cases).filter(c=>c!=='startup')];
  if (Object.hasOwn(suites, name)) return suites[name];
  if (!Object.hasOwn(cases, name)) throw Error(`Unknown case/suite: ${name}`);
  return name === 'startup' ? ['startup'] : ['startup', name];
}
