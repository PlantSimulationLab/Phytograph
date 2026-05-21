import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { builtinModules } from 'node:module';

const externals = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

export default defineConfig({
  build: {
    outDir: 'dist-preload',
    emptyOutDir: true,
    target: 'node20',
    lib: {
      entry: resolve(__dirname, 'src/preload/preload.ts'),
      formats: ['es'],
      fileName: () => 'preload.mjs',
    },
    rollupOptions: {
      external: externals,
      output: { format: 'es', entryFileNames: 'preload.mjs' },
    },
    minify: false,
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
