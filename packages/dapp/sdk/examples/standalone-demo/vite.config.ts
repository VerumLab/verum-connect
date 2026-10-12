import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Builds like the hub: one self-contained HTML file with relative paths, pinnable to
 * IPFS. Set VITE_HUB_URL at build time to bake in the hub:
 * VITE_HUB_URL=https://<cid>.ipfs.<gateway>/ npm run build -w @verumlab/standalone-demo
 */
export default defineConfig({
  plugins: [viteSingleFile()],
  base: './',
  server: { port: 5174, host: true },
  build: {
    target: 'es2020',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
