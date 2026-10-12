import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** Content-Security-Policy for the shipped artifact.
 *
 *  Injected at build time only. The dev server loads /src/main.ts as an external
 *  module and opens an HMR websocket, both of which this policy denies — so
 *  applying it in dev blanks the page. The policy describes what the *built*
 *  file needs, which is nothing external at all:
 *
 *    default-src 'none'   nothing is permitted unless named below
 *    script/style inline  everything is inlined by viteSingleFile
 *    connect-src ws(s):   relay transport, the page's only network access. ws:
 *                         is for a relay on the user's own machine; the browser
 *                         confines it to loopback or to a hub served over plain
 *                         http, which is the case a local node produces anyway
 *    img-src data:        dapp icons are data: URIs only, never remote — a
 *                         remote icon would let any paired dapp use this page
 *                         as a beacon reporting when the hub is open
 */
function buildCsp(scriptHashes: string[]): string {
  return [
    "default-src 'none'",
    // Hashes, not 'unsafe-inline'. Gateways demonstrably rewrite the documents
    // they serve — Cloudflare-fronted ones inject a per-request tracking anchor
    // into this very page — and 'unsafe-inline' would execute an injected
    // <script> just as happily as our own. A hash allowlist admits exactly the
    // script we built and nothing else.
    `script-src ${scriptHashes.map((h) => `'${h}'`).join(' ')}`,
    // Styles stay 'unsafe-inline': the UI sets style attributes at runtime,
    // which CSP style hashes cannot cover, and injected CSS cannot exfiltrate
    // or sign anything here.
    "style-src 'unsafe-inline'",
    'connect-src wss: ws:',
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    // No frame-ancestors: browsers ignore it in a meta policy. main.ts refuses to run framed.
  ].join('; ');
}

/** Inject CSP into the final written file.
 *
 *  Runs in writeBundle rather than generateBundle: viteSingleFile rewrites the
 *  HTML during its own bundle hook, so anything computed earlier hashes markup
 *  that no longer ships. Post-processing on disk is order-independent. */
function injectCsp(): Plugin {
  return {
    name: 'verum-inject-csp',
    apply: 'build',
    writeBundle(options) {
      const outDir = options.dir ?? 'dist';
      const file = resolve(outDir, 'index.html');
      const html = readFileSync(file, 'utf8');

      const hashes: string[] = [];
      for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
        const body = match[1] ?? '';
        if (body.trim().length === 0) continue;
        hashes.push(`sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`);
      }
      if (hashes.length === 0) {
        throw new Error('injectCsp: no inline scripts found — the CSP would block the page');
      }

      writeFileSync(
        file,
        html.replace(
          '</head>',
          `  <meta http-equiv="Content-Security-Policy" content="${buildCsp(hashes)}" />\n  </head>`,
        ),
      );
    },
  };
}

/** The hub ships as ONE self-contained HTML file.
 *
 *  Everything inlined means the CID covers the entire application: no
 *  subresource can be swapped by a gateway, and the hash a user verifies is the
 *  hash of all the code that will run. It also makes the build reproducible
 *  enough to pin and re-derive.
 */
export default defineConfig({
  // Order matters: injectCsp must run after singlefile has inlined the script.
  plugins: [viteSingleFile(), injectCsp()],
  // Relative, so the page works under a path gateway (/ipfs/<cid>/) as well as a
  // subdomain one. Everything is inlined so there is nothing to resolve today,
  // but an absolute base would silently break the moment anything isn't.
  base: './',
  build: {
    target: 'es2020',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
