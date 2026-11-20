#!/usr/bin/env node
// Upload this job's headless backend archives (and their .sha256) to the
// release, without ever replacing an archive a published PyPI wheel pins.
//
// The PyPI wheel embeds the digest of every platform's archive
// (phytograph/_backend_manifest.json), and PyPI never replaces a file. A
// build re-run after publish-pypi used to rebuild its archive and upload it
// with --clobber, so the published wheel pinned an archive that no longer
// existed and `python -m phytograph download` refused it. v0.99.0 shipped
// that way for macOS (its macOS jobs were re-run after Apple's notarization
// agreement lapsed), and needed 0.99.0.post1 to fix.
//
// The rule: once PyPI has this version, the release's archives for it are
// frozen. An archive the release already has is kept (with its .sha256), and
// only a missing one is uploaded. The headless archive then comes from the
// earlier build of the same commit, which is what the published wheel was
// built against. Until PyPI has the version, every archive is uploaded and
// replaces what is there, as before. build-python-wheel reads its digests from
// the release's .sha256 files, so the release and every wheel agree.
//
// Usage: node scripts/upload-backend-archives.mjs <tag> <dir>
// Env:   GH_TOKEN (for gh). Fails if PyPI cannot say whether the version
//        exists, rather than guess and risk replacing a pinned archive.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Decide what to upload. `localFiles`: names in this job's backend-dist/.
 * `releaseAssets`: names already on the release. Returns the files to upload
 * (with --clobber) and the ones to keep as they are.
 */
export function planUploads({ localFiles, releaseAssets, pypiHasVersion }) {
  const onRelease = new Set(releaseAssets);
  if (!pypiHasVersion) return { upload: [...localFiles].sort(), keep: [] };
  // An archive and its .sha256 travel together: keep or upload both.
  const archiveOf = (name) => name.replace(/\.sha256$/, '');
  const upload = [];
  const keep = [];
  for (const f of localFiles) {
    (onRelease.has(archiveOf(f)) ? keep : upload).push(f);
  }
  return { upload: upload.sort(), keep: keep.sort() };
}

/** true if PyPI has `version`, false if it does not; throws if it cannot tell. */
export async function pypiHasVersion(version, fetchImpl = fetch) {
  const url = `https://pypi.org/pypi/phytograph/${encodeURIComponent(version)}/json`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'Cache-Control': 'no-cache' } });
  } catch (err) {
    throw new Error(`could not reach PyPI (${url}): ${err.message}`);
  }
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`PyPI answered ${res.status} for ${url}`);
}

async function main(argv) {
  const [tag, dir] = argv;
  if (!tag || !dir) throw new Error('usage: upload-backend-archives.mjs <tag> <dir>');
  const version = tag.replace(/^v/, '');
  const localFiles = readdirSync(dir).filter((f) => f.startsWith('phytograph-backend-'));
  if (localFiles.length === 0) throw new Error(`no backend archives in ${dir}`);
  const releaseAssets = JSON.parse(
    execFileSync('gh', ['release', 'view', tag, '--json', 'assets', '--jq', '[.assets[].name]'], { encoding: 'utf8' }),
  );
  const published = await pypiHasVersion(version);
  const { upload, keep } = planUploads({ localFiles, releaseAssets, pypiHasVersion: published });
  for (const f of keep) {
    console.log(`::warning::keeping the release's ${f}: phytograph ${version} is already on PyPI and its wheel pins that archive`);
  }
  if (upload.length) {
    execFileSync('gh', ['release', 'upload', tag, ...upload.map((f) => join(dir, f)), '--clobber'], { stdio: 'inherit' });
  }
  console.log(`[upload-backend-archives] PyPI has ${version}: ${published}; uploaded ${upload.length}, kept ${keep.length}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[upload-backend-archives] ${err.message}`);
    process.exit(1);
  });
}
