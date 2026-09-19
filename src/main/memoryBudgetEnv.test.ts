/**
 * The Settings "Memory budget (MB)" value reaches the backend as
 * PHYTOGRAPH_MEMORY_BUDGET_BYTES at spawn — the only way the setting has any
 * effect, since the child's environment is fixed at spawn (memory_budget.py
 * re-reads the var per call, but nothing mutates a running child's env).
 *
 * Source-level, like the octree-cache-root chokepoint test: backend.ts imports
 * electron and cannot be loaded in vitest, and the failure this guards against
 * is silent (a setting the user can edit that changes nothing).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const backendSrc = codeOnly(readFileSync(resolve(__dirname, 'backend.ts'), 'utf8'));
const devSrc = codeOnly(
  readFileSync(resolve(__dirname, '..', '..', 'scripts', 'dev.mjs'), 'utf8'),
);

describe('memory budget setting → backend env', () => {
  it('spreads memoryBudgetEnv() into the spawn env after process.env', () => {
    const env = backendSrc.match(/env:\s*\{([\s\S]*?)\},/);
    expect(env).not.toBeNull();
    const body = env![1];
    expect(body).toMatch(/\.\.\.process\.env/);
    expect(body).toMatch(/\.\.\.memoryBudgetEnv\(\)/);
    // The explicit env var must win over the setting: process.env first.
    expect(body.indexOf('...process.env')).toBeLessThan(body.indexOf('...memoryBudgetEnv()'));
  });

  it('reads the renderer store key and converts MB to bytes', () => {
    expect(backendSrc).toMatch(/store\.get\(\s*['"]settings['"]\s*\)/);
    expect(backendSrc).toMatch(/memoryBudgetMb/);
    expect(backendSrc).toMatch(/PHYTOGRAPH_MEMORY_BUDGET_BYTES:\s*String\(Math\.round\(mb \* 1024 \* 1024\)\)/);
  });

  it('defers to an explicit PHYTOGRAPH_MEMORY_BUDGET_BYTES from the shell', () => {
    expect(backendSrc).toMatch(/if \(process\.env\.PHYTOGRAPH_MEMORY_BUDGET_BYTES\) return \{\};/);
  });
});

/**
 * The dev loop is a SEPARATE spawn path and it was missing this entirely.
 *
 * `scripts/dev.mjs` runs uvicorn itself and sets PHYTOGRAPH_DEV_BACKEND=1, which
 * makes the Electron supervisor stand down (`backend.ts`) — so `spawnChild` and
 * therefore `memoryBudgetEnv()` never run, and the uvicorn env was the only one
 * that mattered. The setting was silently inert for the whole hot-reload
 * workflow: the dev backend always ran on auto, and a developer could not test a
 * pinned budget through the UI at all.
 *
 * Source-level for the same reason as the tests above: the failure is a setting
 * that changes nothing, which no passing dev session would reveal.
 */
describe('memory budget setting → dev uvicorn env', () => {
  it('threads the budget into the uvicorn spawn env', () => {
    const uvicornEnv = devSrc.match(/env:\s*\{[^}]*PHYTOGRAPH_OCTREE_CACHE_ROOT[^}]*\}/);
    expect(uvicornEnv, 'the uvicorn spawn env literal').not.toBeNull();
    expect(uvicornEnv![0]).toMatch(/\.\.\.devMemoryBudgetEnv\(\)/);
  });

  it('reads memoryBudgetMb from the dev profile store and converts MB to bytes', () => {
    expect(devSrc).toMatch(/function devMemoryBudgetEnv\(\)/);
    expect(devSrc).toMatch(/phytograph-store\.json/);
    expect(devSrc).toMatch(/memoryBudgetMb/);
    expect(devSrc).toMatch(
      /PHYTOGRAPH_MEMORY_BUDGET_BYTES:\s*String\(Math\.round\(mb \* 1024 \* 1024\)\)/,
    );
  });

  it('defers to an explicit PHYTOGRAPH_MEMORY_BUDGET_BYTES from the shell', () => {
    expect(devSrc).toMatch(/if \(process\.env\.PHYTOGRAPH_MEMORY_BUDGET_BYTES\) return \{\};/);
  });
});
