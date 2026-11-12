// The engine identity stamp: one JSON file in the bundle that says exactly
// which build this is, readable without launching it.
//
// A harness that keys cached results on the engine (Heliades does) needs to
// tell two builds apart even when BACKEND_VERSION did not move: a submodule
// bump, a local libhelios recompile, a Python edit, a dependency upgrade in
// the venv. The three plain stamps cover the first three; this file gathers
// them with the submodule `git describe` output and the versions of the
// native-heavy Python packages, which a frozen bundle cannot report without
// importing them (seconds for torch/open3d) and which `.git` cannot supply
// once packaged.
//
// Read by python/phytograph/_identity.py. Change the schema there too.

import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { pyheliosSubmoduleRevisions } from './backend-version.mjs';

export const BACKEND_IDENTITY_FILE = 'phytograph_backend_identity.json';
export const IDENTITY_SCHEMA = 1;

// Packages whose native code decides the numbers a tool produces.
const PACKAGES = [
  'numpy', 'scipy', 'open3d', 'scikit-learn', 'scikit-image', 'torch',
  'numba', 'llvmlite', 'cut-pursuit-py', 'fastapi', 'starlette', 'httpx',
];

function describe(dir) {
  for (const args of [['describe', '--tags', '--always', '--dirty'], ['rev-parse', '--short', 'HEAD']]) {
    try {
      const out = execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out) return out;
    } catch {
      // next strategy
    }
  }
  return null;
}

function packageVersions(python) {
  if (!python) return { python: null, packages: null };
  const code = [
    'import json, platform, importlib.metadata as m',
    `names = ${JSON.stringify(PACKAGES)}`,
    'out = {}',
    'for n in names:',
    '    try: out[n] = m.version(n)',
    '    except m.PackageNotFoundError: out[n] = None',
    'print(json.dumps({"python": platform.python_version(), "packages": out}))',
  ].join('\n');
  const r = spawnSync(python, ['-c', code], { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`[backend-identity] could not read package versions:\n${r.stderr}`);
  }
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/** The identity document for a bundle built from this checkout. */
export function buildIdentity({ root, python, version, sourcesSha256, libheliosSha256 }) {
  const revs = Object.fromEntries(pyheliosSubmoduleRevisions().map((l) => l.split('=')));
  const { python: pyVersion, packages } = packageVersions(python);
  return {
    schema: IDENTITY_SCHEMA,
    engine_version: version,
    sources_sha256: sourcesSha256,
    libhelios_sha256: libheliosSha256,
    phytograph_commit: describe(root),
    pyhelios: { describe: describe(join(root, 'pyhelios')), commit: revs['pyhelios'] ?? null },
    helios_core: {
      describe: describe(join(root, 'pyhelios', 'helios-core')),
      commit: revs['pyhelios/helios-core'] ?? null,
    },
    python: pyVersion,
    packages,
    os: process.platform,
    arch: process.arch,
  };
}
