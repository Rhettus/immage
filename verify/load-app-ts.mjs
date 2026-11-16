// SPDX-License-Identifier: GPL-3.0-or-later
// Let engine-free Node checks import the app's TypeScript source as ESM.
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withNodeLocales } from './vite-locales.mjs';

const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));

registerHooks({
  load(url, context, next) {
    if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return next(url, context);
    const path = fileURLToPath(url);
    const source = transformSync(path, withNodeLocales(url, readFileSync(path, 'utf8')), { jsx: { runtime: 'automatic' } }).code;
    return { format: 'module', source, shortCircuit: true };
  },
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      for (const ext of ['.ts', '.tsx']) {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(url))) return next(url.href, context);
      }
    }
    return next(specifier, context);
  },
});
