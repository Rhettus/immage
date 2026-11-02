// SPDX-License-Identifier: GPL-3.0-or-later
import { startup, exposure } from './specs/smoke.mjs';
import { sliderInput, history, rail, sliders } from './specs/controls.mjs';
import { moduleOptions } from './specs/preferences.mjs';
import { batchPaste } from './specs/batch-paste.mjs';
import { cases } from './suites.mjs';
import { cropGuides,cropLocked,cropPortrait,cropOptions } from './specs/crop.mjs';
import { rangeContract,choiceContract } from './specs/ranges.mjs';
import * as workflows from './specs/workflows.mjs';
import * as dialogs from './specs/dialogs.mjs';
import * as regressions from './specs/regressions.mjs';
import { moduleOutput,panorama,immichWorkflow } from './specs/modules.mjs';

const implementations = { 'batch-paste': batchPaste, startup, exposure, 'slider-input': sliderInput, history, rail, sliders, 'module-options': moduleOptions,
  'crop-guides':cropGuides,'crop-locked':cropLocked,'crop-portrait':cropPortrait,'crop-options':cropOptions,
  'native-reset':workflows.nativeReset,curves:workflows.curves,wheels:workflows.wheels,equalizer:workflows.equalizer,
  masks:workflows.masks,heal:workflows.heal,negative:workflows.negative,zones:workflows.zones,
  'preferences-matrix':dialogs.preferencesMatrix,'slider-wheel':dialogs.sliderWheel,'export-options':dialogs.exportOptions,
  filters:dialogs.filters,presets:dialogs.presets,shortcuts:dialogs.shortcuts,
  'histogram-endpoints':regressions.histogramEndpoints,'preview-alignment':regressions.previewAlignment,
  'loupe-grid':regressions.loupeGrid,'detail-without-loupe':regressions.detailWithoutLoupe,'camera-body':regressions.cameraBody,
  'rejected-deletion':regressions.rejectedDeletion,'folder-race':regressions.folderRace,panorama,'immich-workflow':immichWorkflow,
};
for(const [name,definition] of Object.entries(cases)) if(definition.kind)
  implementations[name] = t => ({range:rangeContract,choice:choiceContract,module:moduleOutput}[definition.kind])(t,definition);

export function implementationFor(name) {
  if (!Object.hasOwn(implementations,name)) throw Error(`Missing GUI implementation: ${name}`);
  return implementations[name];
}
