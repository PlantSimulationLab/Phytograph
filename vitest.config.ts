import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/setup/electronAPI.mock.ts'],
    // Renderer logic + the handful of pure (electron-free) main-process modules
    // that warrant a unit test (e.g. the fs allowlist). Coverage scope below
    // stays renderer-only by design (CLAUDE.md).
    include: ['src/renderer/**/*.test.{ts,tsx}', 'src/main/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Coverage scope: pure-logic modules only. React components live
      // in src/renderer/components/ and src/renderer/App.tsx; they're
      // covered by Playwright E2E (see CLAUDE.md Testing section).
      include: [
        'src/renderer/lib/**/*.ts',
        'src/renderer/utils/**/*.ts',
        'src/renderer/hooks/**/*.ts',
      ],
      exclude: [
        '**/*.test.*',
        'src/renderer/types/**',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
