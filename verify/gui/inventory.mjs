#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Source inventory only: imports pure manifest/math modules, never launches GUI.
// Native type stripping requires Node >= 22.18.
import { registerHooks } from 'node:module';
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') || !context.parentURL?.includes('/app/src/')) throw error;
    return next(specifier + '.ts', context);
  }
} });
const { panels, MODULE_CHOICES, MASK_MODULE_CHOICES, LOCAL_CONTROLS } = await import('../../app/src/manifest.ts');
const choices = list => list.map(c => ({ id: c.id, label: c.label, control: c.control, covers: c.covers,
  options: c.options.map(o => ({ value: o.value, name: o.name, op: o.op, controls: o.controls, localControls: o.localControls })) }));
const inventory = {
  scope: 'Expanded editing manifest and module preferences. Does not enumerate every non-manifest menu/dialog setting. Declaration is not executed test coverage.',
  panels: panels.map(p => ({ id: p.id, title: p.title, hidden: !!p.hidden, conditional: !!p.showIf, tabs: !!p.tabs,
    sections: p.sections.map(s => ({ title: s.title, controls: s.controls.map(c => ({
      id: c.id, label: c.label, kind: c.kind || 'slider', rawOnly: !!c.rawOnly,
      min: c.min, max: c.max, step: c.step, nonlinear: !!c.slider,
      options: c.options || c.optionGroups?.flatMap(([, options]) => options),
      status: 'pending',
    })) })) })),
  localControls: LOCAL_CONTROLS.map(c => ({ id:c.id,label:c.label,kind:c.kind||'slider',min:c.min,max:c.max,step:c.step,rawOnly:!!c.rawOnly,status:'pending' })),
  globalModules: choices(MODULE_CHOICES), maskModules: choices(MASK_MODULE_CHOICES),
};
const destination = new URL('./inventory.json', import.meta.url);
const content = JSON.stringify(inventory, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== content) throw Error('GUI inventory is stale; run node verify/gui/inventory.mjs');
  console.log('GUI manifest inventory is current (no GUI launched).');
} else {
  await writeFile(destination, content);
  console.log(`Wrote ${fileURLToPath(destination)}: ${panels.length} panels, ${inventory.panels.flatMap(p => p.sections.flatMap(s => s.controls)).length} control declarations.`);
}
