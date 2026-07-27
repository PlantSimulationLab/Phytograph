import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeOpenPaths, extractFilePathsFromArgv, isImportablePath } from './openPaths';
import { allowPath, isPathAllowed, isWriteAllowed, _resetAllowlist } from './fsAllowlist';

let dir: string;
let las: string;
let xml: string;

beforeEach(() => {
  _resetAllowlist();
  dir = mkdtempSync(join(tmpdir(), 'openpaths-'));
  las = join(dir, 'Mission1_1_crop.las');
  xml = join(dir, 'scene.xml');
  writeFileSync(las, 'LASF');
  writeFileSync(xml, '<x/>');
});

describe('authorizeOpenPaths', () => {
  // The bug: Finder "Open With" → Phytograph handed the path straight to the
  // renderer, which then failed fs:readBinary with "is not a user-selected
  // path", while File → Import of the same file worked.
  it('authorizes an OS-opened file for reading', () => {
    expect(isPathAllowed(las)).toBe(false);
    authorizeOpenPaths([las]);
    expect(isPathAllowed(las)).toBe(true);
  });

  it('returns only the importable paths', () => {
    // .txt IS importable (ASCII point clouds); .key is not.
    expect(authorizeOpenPaths([las, join(dir, 'id_rsa.key')])).toEqual([las]);
  });

  it('does not authorize a non-importable path it filtered out', () => {
    const key = join(dir, 'id_rsa.key');
    authorizeOpenPaths([key]);
    expect(isPathAllowed(key)).toBe(false);
  });

  it('authorizes every path in a multi-file open', () => {
    authorizeOpenPaths([las, xml]);
    expect(isPathAllowed(las)).toBe(true);
    expect(isPathAllowed(xml)).toBe(true);
  });

  it('grants companion-file reads next to the opened file (scene.xml -> scene.xyz)', () => {
    // Helios scan XML resolves sibling data; 'file' kind must match a dialog pick.
    authorizeOpenPaths([xml]);
    expect(isPathAllowed(join(dir, 'scene.xyz'))).toBe(true);
  });

  it('grants no wider access than a dialog pick of the same file', () => {
    // The OS route must not be a privilege escalation over File → Import. The
    // allowlist's own semantics (siblings readable, and readable ⇒ writable)
    // are pre-existing and shared by both routes; what matters here is that
    // "Open With" lands in exactly the same state, and grants nothing deeper.
    authorizeOpenPaths([las]);
    const viaOpenWith = {
      sibling: isPathAllowed(join(dir, 'other.las')),
      siblingWrite: isWriteAllowed(join(dir, 'other.las')),
      nested: isPathAllowed(join(dir, 'sub', 'deep.las')),
      outside: isPathAllowed('/etc/hosts'),
    };
    _resetAllowlist();
    allowPath(las, 'file'); // what the dialog handler does
    expect(viaOpenWith).toEqual({
      sibling: isPathAllowed(join(dir, 'other.las')),
      siblingWrite: isWriteAllowed(join(dir, 'other.las')),
      nested: isPathAllowed(join(dir, 'sub', 'deep.las')),
      outside: isPathAllowed('/etc/hosts'),
    });
    // And in absolute terms it still must not reach outside or descend.
    expect(viaOpenWith.nested).toBe(false);
    expect(viaOpenWith.outside).toBe(false);
  });

  it('is a no-op for an empty list', () => {
    expect(authorizeOpenPaths([])).toEqual([]);
  });
});

describe('extractFilePathsFromArgv', () => {
  it('picks out existing importable files and drops flags and the exe', () => {
    const argv = ['/Applications/Phytograph.app/Contents/MacOS/Phytograph', '--no-sandbox', las];
    expect(extractFilePathsFromArgv(argv)).toEqual([las]);
  });

  it('drops importable-looking paths that do not exist on disk', () => {
    expect(extractFilePathsFromArgv([join(dir, 'ghost.las')])).toEqual([]);
  });
});

describe('isImportablePath', () => {
  it('accepts a known extension case-insensitively', () => {
    expect(isImportablePath('/a/b/CLOUD.LAS')).toBe(true);
  });

  it('rejects an unknown extension', () => {
    expect(isImportablePath('/a/b/secret.key')).toBe(false);
  });
});
