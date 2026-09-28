import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Machine-local folders the dev server must not watch (a local scratchpad
// can hold thousands of files), plus build and script output.
const ignored = ['**/scratchpad/**', '**/dist/**', '**/.venv-overture/**', '**/examples_and_inspiration/**', '**/build/**', '**/out/**'];

export default defineConfig({
  // Relative asset paths, so the site works from any GitHub Pages subpath.
  base: './',
  plugins: [react()],
  build: {
    // Not dist/: that folder holds the add-on's release archives.
    outDir: 'build',
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2500,
  },
  worker: { format: 'es' },
  server: { watch: { ignored } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
});
