// The extension's four scripts, bundled once, then one folder per browser with its own
// manifest: Chromium has a side panel and a service worker; Firefox runs background
// scripts; Safari has neither side panel nor sidebar API, so a window.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
const common = { bundle: true, target: 'es2022', minify: true, legalComments: 'none' };
await build({ ...common, entryPoints: ['src/page.ts', 'src/content.ts'], outdir: 'dist/shared', format: 'iife' });
await build({ ...common, entryPoints: ['src/background.ts', 'src/panel.ts'], outdir: 'dist/shared', format: 'esm' });
cpSync('panel.html', 'dist/shared/panel.html');

const base = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { side_panel, ...noSidePanel } = base;
const withoutSidePanelPermission = { ...noSidePanel, permissions: base.permissions.filter((p) => p !== 'sidePanel') };
const manifests = {
  chrome: base,
  firefox: {
    ...withoutSidePanelPermission,
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: { gecko: { id: 'connect@verum.me', strict_min_version: '128.0' } },
  },
  safari: withoutSidePanelPermission,
};
for (const [browser, manifest] of Object.entries(manifests)) {
  cpSync('dist/shared', `dist/${browser}`, { recursive: true });
  delete manifest.minimum_chrome_version;
  if (browser === 'chrome') manifest.minimum_chrome_version = base.minimum_chrome_version ?? '116';
  writeFileSync(`dist/${browser}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
}
rmSync('dist/shared', { recursive: true });
console.log('built dist/chrome, dist/firefox, dist/safari');
