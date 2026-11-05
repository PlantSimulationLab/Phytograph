import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetAllowlist, isPathAllowed, isWriteAllowed } from './fsAllowlist';
import { _resetListings, grant, isPlaceholder, listDir, listPlaces, wasListed } from './fileBrowser';

let root: string;

beforeEach(() => {
  _resetAllowlist();
  _resetListings();
  root = mkdtempSync(join(tmpdir(), 'fbrowse-'));
  writeFileSync(join(root, 'scan.LAS'), 'x'.repeat(123));
  writeFileSync(join(root, 'notes.txt'), 'hello');
  writeFileSync(join(root, '.hidden.xyz'), '1 2 3');
  writeFileSync(join(root, 'id_rsa'), 'secret');
  writeFileSync(join(root, 'sibling.xyz'), '1 2 3');
  mkdirSync(join(root, '.config'));
  writeFileSync(join(root, '.config', 'credentials.json'), '{}');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'inner.ply'), 'ply');
});

afterEach(() => {
  try { chmodSync(join(root, 'locked'), 0o755); } catch { /* not created */ }
  rmSync(root, { recursive: true, force: true });
});

describe('listDir', () => {
  it('lists files and folders with size, kind and lower-case extension', async () => {
    const res = await listDir(root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e]));
    expect(Object.keys(byName).sort()).toEqual(['id_rsa', 'notes.txt', 'scan.LAS', 'sibling.xyz', 'sub']);
    expect(byName['scan.LAS']).toMatchObject({ kind: 'file', size: 123, ext: 'las', placeholder: false });
    expect(byName['sub']).toMatchObject({ kind: 'dir', size: 0, ext: '' });
    expect(byName['notes.txt'].path).toBe(join(root, 'notes.txt'));
    expect(res.parent).not.toBeNull();
  });

  it('never lists dotfiles, and refuses to list a hidden folder at all', async () => {
    const res = await listDir(root);
    expect(res.ok && res.entries.some((e) => e.name.startsWith('.'))).toBe(false);
    const hidden = await listDir(join(root, '.config'));
    expect(hidden).toMatchObject({ ok: false, code: 'EHIDDEN' });
  });

  it('follows a symlink to a folder and drops a broken link', async () => {
    symlinkSync(join(root, 'sub'), join(root, 'link-to-sub'));
    symlinkSync(join(root, 'gone'), join(root, 'dangling'));
    const res = await listDir(root);
    if (!res.ok) throw new Error('listing failed');
    expect(res.entries.find((e) => e.name === 'link-to-sub')?.kind).toBe('dir');
    expect(res.entries.some((e) => e.name === 'dangling')).toBe(false);
  });

  it('reports a missing folder as an error rather than throwing', async () => {
    const res = await listDir(join(root, 'nope'));
    expect(res).toMatchObject({ ok: false, code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable folder with a permission message', async () => {
      mkdirSync(join(root, 'locked'));
      chmodSync(join(root, 'locked'), 0o000);
      const res = await listDir(join(root, 'locked'));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(['EACCES', 'EPERM']).toContain(res.code);
      expect(res.message).toMatch(/permission/i);
    });

  it('marks a file that occupies no blocks as a cloud placeholder', () => {
    expect(isPlaceholder({ blocks: 0, size: 5_000_000 }, 'darwin')).toBe(true);
    expect(isPlaceholder({ blocks: 0, size: 0 }, 'darwin')).toBe(false);      // genuinely empty
    expect(isPlaceholder({ blocks: 9_768, size: 5_000_000 }, 'darwin')).toBe(false);
    // Windows reports no block count at all, so it must never read as one.
    expect(isPlaceholder({ blocks: undefined as unknown as number, size: 5 }, 'win32')).toBe(false);
  });

  it('a real local file is not a placeholder', async () => {
    const res = await listDir(root);
    if (!res.ok) throw new Error('listing failed');
    expect(res.entries.every((e) => !e.placeholder)).toBe(true);
  });
});

describe('grant', () => {
  it('refuses a path no listing returned, so the renderer cannot name one', async () => {
    const target = join(root, 'scan.LAS');
    const res = grant([target, '/etc/hosts']);
    expect(res.granted).toEqual([]);
    expect(res.refused).toEqual([target, '/etc/hosts']);
    expect(isPathAllowed(target)).toBe(false);
  });

  it('grants a listed path and makes it readable through the fs bridge', async () => {
    await listDir(root);
    const target = join(root, 'scan.LAS');
    expect(wasListed(target)).toBe(true);
    const res = grant([target]);
    expect(res.granted).toEqual([target]);
    expect(isPathAllowed(target)).toBe(true);
  });

  it('does not grant a hidden file the listing left out', async () => {
    await listDir(root);
    const res = grant([join(root, '.hidden.xyz')]);
    expect(res.refused).toHaveLength(1);
  });

  // The rules below bound what a COMPROMISED renderer can get, since it can
  // call listDir/grant directly with no browser on screen.
  it('grants only importable formats, so a listed credential stays unreadable', async () => {
    await listDir(root);
    expect(wasListed(join(root, 'id_rsa'))).toBe(true);
    const res = grant([join(root, 'id_rsa'), join(root, 'notes.txt')]);
    expect(res.refused).toEqual([join(root, 'id_rsa')]);
    expect(isPathAllowed(join(root, 'id_rsa'))).toBe(false);
  });

  it('never grants a folder', async () => {
    await listDir(root);
    expect(grant([join(root, 'sub')]).refused).toHaveLength(1);
    expect(isPathAllowed(join(root, 'sub', 'inner.ply'))).toBe(false);
  });

  it('opens importable siblings (Helios XML companions) but no other file in the folder', async () => {
    await listDir(root);
    grant([join(root, 'scan.LAS')]);
    expect(isPathAllowed(join(root, 'sibling.xyz'))).toBe(true);
    expect(isPathAllowed(join(root, 'id_rsa'))).toBe(false);
    expect(isPathAllowed(join(root, '.hidden.xyz'))).toBe(false);
  });

  it('is read-only: a granted file cannot be overwritten through the bridge', async () => {
    await listDir(root);
    grant([join(root, 'scan.LAS')]);
    expect(isWriteAllowed(join(root, 'scan.LAS'))).toBe(false);
    expect(isWriteAllowed(join(root, 'sibling.xyz'))).toBe(false);
  });

  it('refuses an importable-looking symlink to a credential', async () => {
    symlinkSync(join(root, 'id_rsa'), join(root, 'innocent.json'));
    await listDir(root);
    expect(grant([join(root, 'innocent.json')]).refused).toHaveLength(1);
    // Nor does a sibling allowance reach it.
    grant([join(root, 'scan.LAS')]);
    expect(isPathAllowed(join(root, 'innocent.json'))).toBe(false);
  });

  it('only covers direct children: listing a parent does not grant its subtree', async () => {
    await listDir(root);
    expect(grant([join(root, 'sub', 'inner.ply')]).refused).toHaveLength(1);
    await listDir(join(root, 'sub'));
    expect(grant([join(root, 'sub', 'inner.ply')]).granted).toHaveLength(1);
  });

  it('ignores non-string and non-array input', () => {
    expect(grant('nope' as unknown)).toEqual({ granted: [], refused: [] });
    expect(grant([42, null] as unknown)).toEqual({ granted: [], refused: [] });
  });
});

describe('listPlaces', () => {
  it('offers home plus the standard folders that exist', async () => {
    mkdirSync(join(root, 'Desktop'));
    mkdirSync(join(root, 'Downloads'));
    const res = await listPlaces({ home: root, platform: 'linux', user: 'nobody-here' });
    const labels = res.places.map((p) => p.label);
    expect(labels[0]).toBe('Home');
    expect(labels).toContain('Desktop');
    expect(labels).toContain('Downloads');
    expect(labels).not.toContain('Documents');
    expect(res.places.find((p) => p.kind === 'root')?.path).toBe('/');
    expect(res.sep).toBe('/');
  });
});
