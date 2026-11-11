import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Relative asset paths: works at a domain root or in a sub-folder (GitHub Pages: /music-voice-memo/).
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        debug: fileURLToPath(new URL('./debug.html', import.meta.url)),
      },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    // No hot reload: code edits must never reload the page while someone is recording.
    // Refresh the page yourself to pick up changes.
    hmr: false,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
});
