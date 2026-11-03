// Pins scripts/helios-patches.mjs against the REAL helios-core source, so an
// upstream change to the visualizer's CMakeLists is noticed rather than the
// patch silently ceasing to apply.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchVisualizerX11, X11_PATCH_MARKER } from './helios-patches.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cml = join(root, 'pyhelios', 'helios-core', 'plugins', 'visualizer', 'CMakeLists.txt');

describe('patchVisualizerX11', () => {
  it('guards the X11 lookup on Apple and leaves other platforms alone', () => {
    const src = 'a\n#X11\nfind_package(X11 REQUIRED)\nif(X11_FOUND)\n\tlink()\nendif(X11_FOUND)\n';
    const { text, status } = patchVisualizerX11(src);
    expect(status).toBe('patched');
    expect(text).toContain('if(NOT APPLE)\n\tfind_package(X11 REQUIRED)\nendif()\nif(X11_FOUND)');
    expect(text).toContain(X11_PATCH_MARKER);
    // Idempotent: a second build doesn't stack another guard.
    expect(patchVisualizerX11(text)).toEqual({ text, status: 'already' });
  });

  it('is a no-op once upstream no longer has the unguarded lookup', () => {
    const src = 'if(NOT APPLE)\n  find_package(X11)\nendif()\n';
    expect(patchVisualizerX11(src)).toEqual({ text: src, status: 'absent' });
  });

  it.skipIf(!existsSync(cml))('applies to the checked-out helios-core (or it is already fixed there)', () => {
    const { status } = patchVisualizerX11(readFileSync(cml, 'utf8'));
    expect(['patched', 'already']).toContain(status);
  });

  it('build-pyhelios.mjs applies it on macOS, before compiling', () => {
    const src = readFileSync(join(root, 'scripts', 'build-pyhelios.mjs'), 'utf8');
    const apply = src.indexOf('patchVisualizerX11(readFileSync(');
    expect(apply).toBeGreaterThan(-1);
    expect(src.lastIndexOf("process.platform === 'darwin'", apply)).toBeGreaterThan(-1);
    expect(apply).toBeLessThan(src.indexOf("runStep('Building native library..."));
  });
});
