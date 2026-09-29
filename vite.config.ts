import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

const DAY = 24 * 60 * 60;

// The LAZ decoder's wasm statically links laz-rs (Apache-2.0), whose notice
// lives in the package's own notices file rather than a license Vite reads.
function lazNotices(): Plugin {
  return {
    name: 'laz-notices',
    apply: 'build',
    generateBundle() {
      const wasm = createRequire(import.meta.url).resolve('@voxelkloud/wasm-codecs/voxelkloud_wasm_codecs_bg.wasm');
      const path = join(dirname(wasm), '..', 'THIRD-PARTY-NOTICES.md');
      this.emitFile({ type: 'asset', fileName: 'laz-decoder-notices.md', source: readFileSync(path, 'utf8') });
    },
  };
}

// Machine-local folders the dev server must not watch (a local scratchpad
// can hold thousands of files), plus build and script output.
const ignored = ['**/scratchpad/**', '**/dist/**', '**/.venv-overture/**', '**/examples_and_inspiration/**', '**/build/**', '**/out/**'];

export default defineConfig({
  // Relative asset paths, so the site works from any GitHub Pages subpath.
  base: './',
  plugins: [
    react(),
    lazNotices(),
    VitePWA({
      // A new version waits until Reload is clicked (see UpdateNotice), so a
      // deploy never reloads the page in the middle of a generation.
      registerType: 'prompt',
      // Already matched by globPatterns below.
      includeManifestIcons: false,
      manifest: {
        id: './',
        name: 'Jarvizar City Model',
        short_name: 'City Model',
        description: 'Turn any area of the map into a multicolour 3D printable city model, or an SVG map for laser engraving, pen plotters and print.',
        theme_color: '#36383d',
        background_color: '#e4e4e4',
        display: 'standalone',
        categories: ['design', 'utilities'],
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app, the 3D engine and the SVG title fonts, so it opens and
        // draws titles offline. The LiDAR decoder loads when it's first used.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,ttf,json}'],
        globIgnores: ['**/lidar*.js', '**/*.wasm'],
        // The engine worker bundle is a few MB.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // Control the first visit right away so its tiles get cached too.
        // Updates still wait for the prompt.
        clientsClaim: true,
        runtimeCaching: [
          {
            // The style and TileJSON point at the latest tile build, so try the network first.
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/(styles\/[^/]+|planet)$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'openfreemap-style',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 10 },
            },
          },
          {
            // Tile and sprite URLs include the build version and glyphs never
            // change, so a cached copy is always good. Areas that were viewed
            // before can be drawn as SVG maps again offline. City centre tiles
            // are 200 to 500 KB each, so keep the count low.
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'openfreemap-tiles',
              expiration: { maxEntries: 500, maxAgeSeconds: 30 * DAY, purgeOnQuotaError: true },
            },
          },
        ],
      },
    }),
  ],
  build: {
    // Not dist/: that folder holds the add-on's release archives.
    outDir: 'build',
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2500,
    license: { fileName: 'licenses.md' },
  },
  worker: { format: 'es' },
  server: { watch: { ignored } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
});
