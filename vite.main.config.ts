import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { builtinModules } from 'node:module';

const externals = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  'electron-store',
  'electron-updater',
];

export default defineConfig({
  build: {
    outDir: 'dist-main',
    emptyOutDir: true,
    target: 'node20',
    lib: {
      entry: resolve(__dirname, 'src/main/main.ts'),
      formats: ['es'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: externals,
      output: { format: 'es' },
    },
    minify: false,
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
