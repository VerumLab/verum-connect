/** The injected script, built as one minified IIFE with nothing imported.
 *
 *  It ends up inside a `javascript:` URL, so every byte is typed into a
 *  bookmark: no module graph, no external chunk, no runtime the browser has to
 *  fetch — a dapp with a strict `script-src` would refuse to load any of it.
 */

import { defineConfig } from 'vite';
// @ts-expect-error - plain JS, shared with scripts/build-bookmarklet.mjs
import { POPUP_URL_TOKEN } from './popup-token.mjs';

export default defineConfig({
  define: {
    __POPUP_URL__: JSON.stringify(POPUP_URL_TOKEN),
  },
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/inject.ts',
      formats: ['iife'],
      name: 'VerumBookmarklet',
      fileName: () => 'inject.js',
    },
    minify: 'terser',
    terserOptions: {
      // Every saved byte is a byte fewer in the bookmark, and nothing here is
      // read back by a human.
      compress: { passes: 2 },
      format: { comments: false },
    },
  },
});
