import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planUploads, pypiHasVersion } from './upload-backend-archives.mjs';

const MAC = ['phytograph-backend-0.99.0-macos-arm64.tar.gz', 'phytograph-backend-0.99.0-macos-arm64.tar.gz.sha256'];

describe('planUploads', () => {
  it('uploads and replaces everything until PyPI has the version', () => {
    expect(planUploads({ localFiles: MAC, releaseAssets: MAC, pypiHasVersion: false }))
      .toEqual({ upload: [...MAC].sort(), keep: [] });
  });

  it('keeps an archive, and its digest, that a published wheel pins (the v0.99.0 re-run)', () => {
    expect(planUploads({ localFiles: MAC, releaseAssets: [...MAC, 'latest-mac.yml'], pypiHasVersion: true }))
      .toEqual({ upload: [], keep: [...MAC].sort() });
  });

  it('still uploads an archive the release is missing, with its digest', () => {
    expect(planUploads({ localFiles: MAC, releaseAssets: ['latest-mac.yml'], pypiHasVersion: true }))
      .toEqual({ upload: [...MAC].sort(), keep: [] });
  });
});

describe('pypiHasVersion', () => {
  const answer = (status) => async () => ({ status });
  it('reads 200 as published and 404 as not', async () => {
    expect(await pypiHasVersion('0.99.0', answer(200))).toBe(true);
    expect(await pypiHasVersion('0.100.0', answer(404))).toBe(false);
  });

  it('refuses to guess on any other answer or a network failure', async () => {
    await expect(pypiHasVersion('0.99.0', answer(503))).rejects.toThrow('PyPI answered 503');
    await expect(pypiHasVersion('0.99.0', async () => { throw new Error('ECONNRESET'); }))
      .rejects.toThrow('could not reach PyPI');
  });

  it('asks the version-specific endpoint, whose answer does not lag like the project summary', async () => {
    let seen = '';
    await pypiHasVersion('0.99.0.post1', async (url) => { seen = url; return { status: 200 }; });
    expect(seen).toBe('https://pypi.org/pypi/phytograph/0.99.0.post1/json');
  });
});

describe('release.yml', () => {
  const yml = readFileSync(join(process.cwd(), '.github', 'workflows', 'release.yml'), 'utf8');
  it('uploads backend archives only through the guard, never with a bare --clobber', () => {
    expect(yml).toContain('node scripts/upload-backend-archives.mjs');
    expect(yml).not.toMatch(/gh release upload "\$tag" backend-dist/);
  });
  it("takes a real release's wheel digests from the release, not the build artifacts", () => {
    expect(yml).toMatch(/gh release download "\$tag" --pattern '\*\.sha256'/);
  });
});
