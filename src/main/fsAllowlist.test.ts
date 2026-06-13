import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allowPath,
  isPathAllowed,
  isWriteAllowed,
  _resetAllowlist,
} from './fsAllowlist';

// A real temp dir so realpathSync resolves; covers the actual code paths.
let dir: string;
let fileA: string;
let fileB: string;

beforeEach(() => {
  _resetAllowlist();
  dir = mkdtempSync(join(tmpdir(), 'fsallow-'));
  fileA = join(dir, 'scene.xml');
  fileB = join(dir, 'scene.xyz');
  writeFileSync(fileA, '<x/>');
  writeFileSync(fileB, '1 2 3');
});

describe('fsAllowlist reads', () => {
  it('denies a path that was never selected', () => {
    expect(isPathAllowed(join(dir, 'secret.key'))).toBe(false);
    expect(isPathAllowed('/etc/hosts')).toBe(false);
  });

  it('allows an explicitly selected file', () => {
    allowPath(fileA, 'file');
    expect(isPathAllowed(fileA)).toBe(true);
  });

  it('allows reading a direct sibling of a selected file (companion data)', () => {
    // Selecting scene.xml authorizes finding scene.xyz next to it.
    allowPath(fileA, 'file');
    expect(isPathAllowed(fileB)).toBe(true);
  });

  it('does NOT allow reading a nested path under a selected file\'s dir', () => {
    allowPath(fileA, 'file');
    expect(isPathAllowed(join(dir, 'sub', 'deep.xyz'))).toBe(false);
  });

  it('allows reading children of a user-chosen directory', () => {
    allowPath(dir, 'directory');
    expect(isPathAllowed(join(dir, 'anything.las'))).toBe(true);
  });
});

describe('fsAllowlist writes', () => {
  it('denies writing an unlisted path', () => {
    expect(isWriteAllowed(join(dir, 'out.las'))).toBe(false);
  });

  it('allows writing siblings of a save-dialog target', () => {
    // dialog.save returned dir/scan.las; the exporter writes dir/scan_1.las etc.
    allowPath(join(dir, 'scan.las'), 'saveFile');
    expect(isWriteAllowed(join(dir, 'scan.las'))).toBe(true);
    expect(isWriteAllowed(join(dir, 'scan_1.xyz'))).toBe(true);
  });

  it('allows writing into a chosen export directory', () => {
    allowPath(dir, 'directory');
    expect(isWriteAllowed(join(dir, 'qsm_1.json'))).toBe(true);
  });

  it('a saveFile does not grant READ of its siblings', () => {
    // saveFile authorizes writes to the folder, not arbitrary reads of it.
    allowPath(join(dir, 'out.las'), 'saveFile');
    expect(isPathAllowed(join(dir, 'neighbor.txt'))).toBe(false);
  });
});
