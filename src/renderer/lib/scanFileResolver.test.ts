import { describe, it, expect, vi } from 'vitest';
import { resolveAttachedScanFile } from './scanFileResolver';

describe('resolveAttachedScanFile', () => {
  it('returns absolute path when the file exists', async () => {
    const fsExists = vi.fn().mockResolvedValue(true);
    const promptForPath = vi.fn();
    const result = await resolveAttachedScanFile('/abs/data/scan.xyz', '/anywhere', {
      fsExists,
      getCwd: async () => '/cwd',
      promptForPath,
    });
    expect(result).toBe('/abs/data/scan.xyz');
    expect(fsExists).toHaveBeenCalledWith('/abs/data/scan.xyz');
    expect(promptForPath).not.toHaveBeenCalled();
  });

  it('prompts when an absolute path does not exist', async () => {
    const fsExists = vi.fn().mockResolvedValue(false);
    const promptForPath = vi.fn().mockResolvedValue('/picked/scan.xyz');
    const result = await resolveAttachedScanFile('/missing/scan.xyz', '/anywhere', {
      fsExists,
      getCwd: async () => '/cwd',
      promptForPath,
    });
    expect(result).toBe('/picked/scan.xyz');
    expect(promptForPath).toHaveBeenCalledWith('scan.xyz');
  });

  it('tries xml-dir before cwd, and prefers xml-dir when both exist', async () => {
    const calls: string[] = [];
    const fsExists = vi.fn(async (path: string) => {
      calls.push(path);
      return true;
    });
    const result = await resolveAttachedScanFile('../data/scan.xyz', '/project/xml', {
      fsExists,
      getCwd: async () => '/elsewhere',
      promptForPath: async () => null,
    });
    expect(result).toBe('/project/xml/../data/scan.xyz');
    // It should have stopped at the first hit (xml-dir).
    expect(calls).toEqual(['/project/xml/../data/scan.xyz']);
  });

  it('falls through to cwd when xml-dir candidate is missing', async () => {
    const fsExists = vi.fn(async (path: string) => path === '/cwd/scan.xyz');
    const result = await resolveAttachedScanFile('scan.xyz', '/project/xml', {
      fsExists,
      getCwd: async () => '/cwd',
      promptForPath: async () => null,
    });
    expect(result).toBe('/cwd/scan.xyz');
  });

  it('prompts when neither xml-dir nor cwd candidate exists', async () => {
    const fsExists = vi.fn().mockResolvedValue(false);
    const promptForPath = vi.fn().mockResolvedValue('/picked.xyz');
    const result = await resolveAttachedScanFile('scan.xyz', '/project/xml', {
      fsExists,
      getCwd: async () => '/cwd',
      promptForPath,
    });
    expect(result).toBe('/picked.xyz');
    expect(promptForPath).toHaveBeenCalledWith('scan.xyz');
  });

  it('returns null when user cancels the file picker', async () => {
    const fsExists = vi.fn().mockResolvedValue(false);
    const promptForPath = vi.fn().mockResolvedValue(null);
    const result = await resolveAttachedScanFile('scan.xyz', '/dir', {
      fsExists,
      getCwd: async () => '/cwd',
      promptForPath,
    });
    expect(result).toBeNull();
  });

  it('handles Windows-style separators in the input filename', async () => {
    const fsExists = vi.fn().mockResolvedValue(true);
    const result = await resolveAttachedScanFile('C:\\data\\scan.xyz', 'C:\\xml', {
      fsExists,
      getCwd: async () => 'C:\\cwd',
      promptForPath: async () => null,
    });
    // Absolute Windows path short-circuits to the input.
    expect(result).toBe('C:\\data\\scan.xyz');
  });
});
