import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

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
  plugins: [react(), lazNotices()],
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
