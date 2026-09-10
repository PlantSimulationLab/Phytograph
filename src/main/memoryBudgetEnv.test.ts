/**
 * The Settings "Memory budget (MB)" value reaches the backend as
 * PHYTOGRAPH_MEMORY_BUDGET_BYTES at spawn — the only way the setting has any
 * effect, since `memory_budget.py` reads the environment once at import.
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
