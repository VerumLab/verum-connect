/** The popup, built as one self-contained file.
 *  Self-contained because it is published to IPFS or Arweave.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
// @ts-expect-error - plain JS, shared with scripts/build-bookmarklet.mjs
import { withCsp } from './csp.mjs';

/**
 * The panel's policy, added to the written file at build time only: the dev server
 * loads modules and an HMR socket that it would block. connect-src covers relays, the
 * public RPC fallbacks and the gateway probe (http: for a node on the user's own
 * machine); images are the QR and dapp icons, both data: URIs. It has to stay
 * framable, which a meta policy cannot change anyway.
 */
function panelCsp(): Plugin {
  return {
    name: 'verum-panel-csp',
    apply: 'build',
    // After viteSingleFile has inlined the script, so the hash is of what ships.
    writeBundle(options) {
      const file = resolve(options.dir ?? 'dist', 'popup.html');
      const html = readFileSync(file, 'utf8');
      writeFileSync(
        file,
        withCsp(html, [
          "style-src 'unsafe-inline'",
          'connect-src wss: ws: https: http:',
          'img-src data:',
          "base-uri 'none'",
          "form-action 'none'",
        ]),
      );
    },
  };
}

export default defineConfig({
  plugins: [viteSingleFile(), panelCsp()],
  build: {
    // Requires name popup.html.
    rollupOptions: { input: 'popup.html' },
    assetsInlineLimit: 100_000_000,
  },
  server: { port: 5178, host: true },
});
