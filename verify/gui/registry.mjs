import { locationMap } from './specs/location.mjs';
import { aiMaskPaste } from "./specs/ai-mask-paste.mjs";
import { colorRange } from './specs/color-range.mjs';
import { colorProfiles } from "./specs/color-profiles.mjs";
import { maskFold } from './specs/mask-fold.mjs';
import { maskHiddenEdit } from './specs/mask-hidden-edit.mjs';
import { maskMenu } from './specs/mask-menu.mjs';
import { negativeProfileMemory } from './specs/negative-profile-memory.mjs';
import { agxPresets } from './specs/agx-presets.mjs';
// SPDX-License-Identifier: GPL-3.0-or-later
import { startup, exposure, splash } from './specs/smoke.mjs';
import { sliderInput, sliderClick, history, rail, sliders, panelScroll } from './specs/controls.mjs';
import { moduleOptions, preferencesHelp } from './specs/preferences.mjs';
import { batchPaste } from './specs/batch-paste.mjs';
import { guiBenchmark } from './specs/benchmark.mjs';
import { cases } from './suites.mjs';
import { cropGuides,cropLocked,cropPortrait,cropOptions,cropAutoStraighten,cropUndo,beforeAfterIdle } from './specs/crop.mjs';
import { rangeContract,choiceContract } from './specs/ranges.mjs';
import * as workflows from './specs/workflows.mjs';
import * as dialogs from './specs/dialogs.mjs';
import * as regressions from './specs/regressions.mjs';
import { moduleOutput,moduleSwitch,panorama,immichWorkflow } from './specs/modules.mjs';
import { siteShots } from './specs/site.mjs';
import { zoomReady, fitDetail } from './specs/zoom.mjs';
import { demo } from './specs/demo.mjs';
import { overlayOpacity } from './specs/overlay.mjs';
import { shiftRange } from './specs/shift-range.mjs';
import { lensProfile, lensPick } from './specs/lens.mjs';
import { themes, workspaceLayout } from './specs/themes.mjs';
import { engineRestart } from './specs/engine-restart.mjs';
import { saveFailure } from './specs/save-failure.mjs';
import { supportBundle } from './specs/support-bundle.mjs';
import { menus, menusGuards } from './specs/menus.mjs';
import * as release0450 from './specs/release-0450.mjs';
import { hostileText } from './specs/hostile-text.mjs';
import { settingsStore } from './specs/settings-store.mjs';

const implementations = { "ai-mask-paste": aiMaskPaste, 'color-range': colorRange, 'batch-paste': batchPaste, startup, splash, exposure, 'slider-input': sliderInput, 'slider-click': sliderClick, history, rail, sliders, 'module-options': moduleOptions, 'module-switch': moduleSwitch,
  'panel-scroll': panelScroll,
  'agx-presets': agxPresets,
  'color-profiles': colorProfiles,
  'mask-fold': maskFold,
  'mask-hidden-edit': maskHiddenEdit,
  'mask-menu': maskMenu,
  'negative-profile-memory': negativeProfileMemory,
  'gui-benchmark': guiBenchmark,
  'gui-benchmark-screen': t => guiBenchmark(t, true),
  'gui-benchmark-whole': t => guiBenchmark(t, false),
  'crop-guides':cropGuides,'crop-locked':cropLocked,'crop-portrait':cropPortrait,'crop-options':cropOptions,'crop-auto-straighten':cropAutoStraighten,'crop-undo':cropUndo,'before-after-idle':beforeAfterIdle,'zoom-ready':zoomReady,'fit-detail':fitDetail,
  'native-reset':workflows.nativeReset,curves:workflows.curves,wheels:workflows.wheels,equalizer:workflows.equalizer,
  'saturation-curve':workflows.saturationCurve,
  masks:workflows.masks,heal:workflows.heal,negative:workflows.negative,film:workflows.film,zones:workflows.zones,print:workflows.print,
  'preferences-matrix':dialogs.preferencesMatrix,'slider-wheel':dialogs.sliderWheel,'export-options':dialogs.exportOptions,
  filters:dialogs.filters,presets:dialogs.presets,shortcuts:dialogs.shortcuts,
  'histogram-endpoints':regressions.histogramEndpoints,'preview-alignment':regressions.previewAlignment,
  'loupe-grid':regressions.loupeGrid,'mask-loupe':regressions.maskLoupe,'grain-hover':regressions.grainHover,'detail-without-loupe':regressions.detailWithoutLoupe,'detail-fit-drag':regressions.detailFitDrag,'camera-body':regressions.cameraBody,
  'rejected-deletion':regressions.rejectedDeletion,'folder-race':regressions.folderRace,panorama,'immich-workflow':immichWorkflow,
  'overlay-opacity':overlayOpacity,'shift-range':shiftRange,'lens-profile':lensProfile,'lens-pick':lensPick,
  'site-shots':siteShots,
  demo,
  themes,
  'workspace-layout': workspaceLayout,
  'preferences-help': preferencesHelp,
  'location-map': locationMap,
  menus,
  'engine-restart': engineRestart,
  'save-failure': saveFailure,
  'support-bundle': supportBundle,
  'menus-guards': menusGuards,
  'hostile-text': hostileText,
  'settings-store': settingsStore,
  'space-pan': release0450.spacePanTools,
  'heal-show-spots': release0450.healShowSpots,
  'jpeg-preset': release0450.jpegPreset,
  'brush-dot': release0450.brushDot,
};
for(const [name,definition] of Object.entries(cases)) if(definition.kind)
  implementations[name] = t => ({range:rangeContract,choice:choiceContract,module:moduleOutput}[definition.kind])(t,definition);

export function implementationFor(name) {
  if (!Object.hasOwn(implementations,name)) throw Error(`Missing GUI implementation: ${name}`);
  return implementations[name];
}
