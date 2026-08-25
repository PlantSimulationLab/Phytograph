// Main-process half of the octree-cache-root parity guard.
//
// The failure this pins (GitHub issue #4): main derived the root from
// `app.getPath('userData')` while the Python backend derived it from the OS
// cache dir. On Windows that is Roaming vs Local — the backend wrote octrees
// the renderer could never fetch, so imports rendered nothing. macOS agreed
// only by accident (case-insensitive APFS papering over "phytograph" vs
// "Phytograph"), which is exactly why dev and E2E never caught it.
//
// backend-api/tests/test_octree_cache_root.py asserts the SAME contract file
// against the Python implementation. Both must move together.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveOctreeCacheRoot } from './octreeCacheRoot';

type PlatformSpec = {
  baseEnv: string | null;
  baseHomeSegments: string[];
  segments: string[];
};

const CONTRACT_PATH = resolve(__dirname, '../shared/octreeCacheRoot.contract.json');
const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as {
  overrideEnv: string;
  platforms: Record<string, PlatformSpec>;
};

/** The contract's resolution rule, implemented straight from the prose. */
function expectedRoot(spec: PlatformSpec, env: NodeJS.ProcessEnv, home: string): string {
  const fromEnv = spec.baseEnv ? env[spec.baseEnv] : undefined;
  const base = fromEnv || join(home, ...spec.baseHomeSegments);
  return join(base, ...spec.segments);
}

const HOME = join('/tmp', 'octree-parity-home');

describe('resolveOctreeCacheRoot', () => {
  it('pins every platform in the contract', () => {
    // Guard against the contract silently losing a platform and this suite
    // then asserting nothing.
    expect(Object.keys(contract.platforms).sort()).toEqual(['darwin', 'linux', 'win32']);
  });

  for (const [platform, spec] of Object.entries(contract.platforms)) {
    describe(platform, () => {
      it('matches the contract with no base env set', () => {
        const root = resolveOctreeCacheRoot(platform as NodeJS.Platform, {}, HOME);
        expect(root).toBe(expectedRoot(spec, {}, HOME));
        // The home fallback must actually be used, not silently skipped.
        expect(root.startsWith(HOME)).toBe(true);
      });

      it('honors its base env var when set', () => {
        if (!spec.baseEnv) {
          // darwin has none: an unrelated env var must not perturb the result.
          const root = resolveOctreeCacheRoot(
            platform as NodeJS.Platform,
            { LOCALAPPDATA: '/should/be/ignored', XDG_CACHE_HOME: '/also/ignored' },
            HOME,
          );
          expect(root).toBe(expectedRoot(spec, {}, HOME));
          return;
        }
        const env = { [spec.baseEnv]: join('/custom', 'base') };
        const root = resolveOctreeCacheRoot(platform as NodeJS.Platform, env, HOME);
        expect(root).toBe(expectedRoot(spec, env, HOME));
        expect(root.startsWith(join('/custom', 'base'))).toBe(true);
      });

      it('lets PHYTOGRAPH_OCTREE_CACHE_ROOT override everything', () => {
        const override = join('/tmp', 'pinned-by-supervisor');
        const root = resolveOctreeCacheRoot(
          platform as NodeJS.Platform,
          { [contract.overrideEnv]: override, LOCALAPPDATA: '/x', XDG_CACHE_HOME: '/y' },
          HOME,
        );
        expect(root).toBe(override);
      });
    });
  }

  it('does not put the Windows cache in the roaming profile', () => {
    // The actual issue #4 regression, stated in its own terms: a multi-GB
    // regenerable cache must live in Local. If someone "fixes" a future
    // mismatch by moving main back to app.getPath('userData'), this fails.
    const root = resolveOctreeCacheRoot('win32', {}, 'C:\\Users\\u');
    expect(root).toContain(join('AppData', 'Local'));
    expect(root).not.toContain(join('AppData', 'Roaming'));
  });
});

// The parity above only matters if the two processes actually resolve the root
// the same way at RUNTIME. The supervisor guarantees that by pinning its own
// resolved value into the sidecar's environment, which makes the Python
// fallback irrelevant for the packaged app. That pin is the single line whose
// removal silently reopens issue #4 — on Windows only, where nobody develops —
// so it gets a source-level chokepoint guard rather than trusting review.
describe('backend supervisor pins the cache root into the sidecar env', () => {
  // Both files DESCRIBE the old `app.getPath('userData')` derivation in their
  // comments (that history is why the code looks the way it does), so the
  // "must not appear" assertions below have to read code, not prose.
  const codeOnly = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const backendSrc = codeOnly(readFileSync(resolve(__dirname, 'backend.ts'), 'utf8'));

  it('passes PHYTOGRAPH_OCTREE_CACHE_ROOT when spawning the backend', () => {
    expect(backendSrc).toMatch(
      /PHYTOGRAPH_OCTREE_CACHE_ROOT:\s*resolveOctreeCacheRoot\(\)/,
    );
  });

  it('uses the shared resolver rather than re-deriving a path', () => {
    expect(backendSrc).toContain("from './octreeCacheRoot.js'");
    // app.getPath('userData') is the exact derivation that broke Windows.
    expect(backendSrc).not.toMatch(/getPath\(\s*['"]userData['"]\s*\)/);
  });

  it('keeps the protocol handler on the shared resolver too', () => {
    const protocolSrc = codeOnly(readFileSync(resolve(__dirname, 'octreeProtocol.ts'), 'utf8'));
    expect(protocolSrc).toContain('resolveOctreeCacheRoot');
    expect(protocolSrc).not.toMatch(/getPath\(\s*['"]userData['"]\s*\)/);
  });
});
