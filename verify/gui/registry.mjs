// SPDX-License-Identifier: GPL-3.0-or-later
import { startup, exposure, splash } from './specs/smoke.mjs';
import { sliderInput, sliderClick, history, rail, sliders, panelScroll } from './specs/controls.mjs';
import { moduleOptions } from './specs/preferences.mjs';
import { batchPaste } from './specs/batch-paste.mjs';
import { guiBenchmark } from './specs/benchmark.mjs';
import { cases } from './suites.mjs';
import { cropGuides,cropLocked,cropPortrait,cropOptions } from './specs/crop.mjs';
import { rangeContract,choiceContract } from './specs/ranges.mjs';
import * as workflows from './specs/workflows.mjs';
import * as dialogs from './specs/dialogs.mjs';
import * as regressions from './specs/regressions.mjs';
import { moduleOutput,panorama,immichWorkflow } from './specs/modules.mjs';
import { siteShots } from './specs/site.mjs';

const implementations = { 'batch-paste': batchPaste, startup, splash, exposure, 'slider-input': sliderInput, 'slider-click': sliderClick, history, rail, sliders, 'module-options': moduleOptions,
  'panel-scroll': panelScroll,
  'gui-benchmark': guiBenchmark,
  'gui-benchmark-screen': t => guiBenchmark(t, true),
  'gui-benchmark-whole': t => guiBenchmark(t, false),
  'crop-guides':cropGuides,'crop-locked':cropLocked,'crop-portrait':cropPortrait,'crop-options':cropOptions,
  'native-reset':workflows.nativeReset,curves:workflows.curves,wheels:workflows.wheels,equalizer:workflows.equalizer,
  masks:workflows.masks,heal:workflows.heal,negative:workflows.negative,film:workflows.film,zones:workflows.zones,
  'preferences-matrix':dialogs.preferencesMatrix,'slider-wheel':dialogs.sliderWheel,'export-options':dialogs.exportOptions,
  filters:dialogs.filters,presets:dialogs.presets,shortcuts:dialogs.shortcuts,
  'histogram-endpoints':regressions.histogramEndpoints,'preview-alignment':regressions.previewAlignment,
  'loupe-grid':regressions.loupeGrid,'mask-loupe':regressions.maskLoupe,'detail-without-loupe':regressions.detailWithoutLoupe,'camera-body':regressions.cameraBody,
  'rejected-deletion':regressions.rejectedDeletion,'folder-race':regressions.folderRace,panorama,'immich-workflow':immichWorkflow,
  'site-shots':siteShots,
};
for(const [name,definition] of Object.entries(cases)) if(definition.kind)
  implementations[name] = t => ({range:rangeContract,choice:choiceContract,module:moduleOutput}[definition.kind])(t,definition);

export function implementationFor(name) {
  if (!Object.hasOwn(implementations,name)) throw Error(`Missing GUI implementation: ${name}`);
  return implementations[name];
}
