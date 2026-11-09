// Compile the actual custom template, including its uninstaller and UAC calls.
// Requires makensis, Handlebars, and the matching Tauri NSIS helper includes/DLL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { execFileSync } = require('node:child_process');
const h = require(process.env.IMMAGE_HANDLEBARS || 'handlebars');
const helpers = process.env.IMMAGE_TAURI_NSIS;
assert(helpers, 'Set IMMAGE_TAURI_NSIS to matching Tauri NSIS includes and plugins');
h.registerHelper('or', (a, b) => a || b);
h.registerHelper('association-description', (description, ext) => description || `${ext} file`);
h.registerHelper('no-escape', value => value);
const root = resolve(__dirname, '..');
const template = h.compile(readFileSync(join(root, 'app/src-tauri/windows/installer.nsi'), 'utf8'), { noEscape: true });
for (const mode of ['downloadBootstrapper', 'embedBootstrapper', 'offlineInstaller', 'skip']) {
  test(`compile installer and uninstaller: WebView2 ${mode}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'immage installer '));
    try {
      for (const file of ['utils.nsh', 'FileAssociation.nsh', 'English.nsh'])
        copyFileSync(join(helpers, file), join(dir, file));
      const fixture = join(dir, 'fixture.exe');
      writeFileSync(fixture, 'compile-only fixture, never executed');
      const out = join(dir, 'Immage_0.44.0_x64-setup.exe');
      writeFileSync(join(dir, 'installer.nsi'), template({
        compression: 'none', product_name: 'Immage', manufacturer: 'immage',
        version: '0.44.0', version_with_build: '0.44.0.0',
        main_binary_name: 'immage', main_binary_path: fixture,
        bundle_id: 'app.immage', out_file: out, arch: 'x64',
        additional_plugins_path: join(helpers, 'plugins'),
        allow_downgrades: 'false', display_language_selector: 'false',
        install_mode: 'both', install_webview2_mode: mode, estimated_size: '1',
        webview2_bootstrapper_path: fixture, webview2_installer_path: fixture,
        webview2_installer_args: '/silent', minimum_webview2_version: '120.0.0.0',
        installer_hooks: join(root, 'app/src-tauri/windows/installer-hooks.nsh'),
        license: join(root, 'LICENSE'), start_menu_folder: 'Immage',
        languages: ['English'], language_files: [join(dir, 'English.nsh')],
        file_associations: [{ ext: ['raw'], name: 'Immage.Raw', description: 'Raw photo' }],
        deep_link_protocols: ['immage'],
      }));
      execFileSync(process.env.MAKENSIS || 'makensis', ['-V2', join(dir, 'installer.nsi')], { stdio: 'pipe' });
      // Check the built PE's manifest, not merely the template directive.
      const exe = readFileSync(out).toString('latin1');
      assert.match(exe, /requestedExecutionLevel level="asInvoker"/);
      assert.doesNotMatch(exe, /requestedExecutionLevel level="(?:highestAvailable|requireAdministrator)"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
