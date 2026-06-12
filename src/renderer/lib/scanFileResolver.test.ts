import { describe, it, expect, vi } from 'vitest';
import { resolveAttachedScanFile } from './scanFileResolver';
import { electronAPIMock } from '../../../tests/setup/electronAPI.mock';

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
    // promptForPath receives the full referenced path so the warning dialog can
    // show the user exactly what the XML pointed at.
    expect(promptForPath).toHaveBeenCalledWith('/missing/scan.xyz');
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

  describe('default prompt (message box before file picker)', () => {
    it('warns the user (naming the missing file) before opening the picker', async () => {
      // No promptForPath injected — exercise the real defaultPromptForPath.
      electronAPIMock.setDialogMessageBoxResponse(0); // "Locate…"
      electronAPIMock.setDialogOpenResult('/picked/scan.xyz');
      const messageBox = window.electronAPI.dialog.messageBox as ReturnType<typeof vi.fn>;
      const open = window.electronAPI.dialog.open as ReturnType<typeof vi.fn>;

      const result = await resolveAttachedScanFile('../data/scan.xyz', '/project/xml', {
        fsExists: async () => false,
        getCwd: async () => '/cwd',
      });

      expect(result).toBe('/picked/scan.xyz');
      // The warning must appear BEFORE the picker, and must name the file.
      expect(messageBox).toHaveBeenCalledTimes(1);
      const mbArg = messageBox.mock.calls[0][0];
      expect(mbArg.message).toContain('scan.xyz');
      expect(mbArg.detail).toContain('../data/scan.xyz'); // the referenced path
      expect(messageBox.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
    });

    it('returns null and never opens the picker when the user chooses Skip', async () => {
      electronAPIMock.setDialogMessageBoxResponse(1); // "Skip" / cancelId
      electronAPIMock.setDialogOpenResult('/should/not/be/used.xyz');
      const open = window.electronAPI.dialog.open as ReturnType<typeof vi.fn>;

      const result = await resolveAttachedScanFile('scan.xyz', '/project/xml', {
        fsExists: async () => false,
        getCwd: async () => '/cwd',
      });

      expect(result).toBeNull();
      expect(open).not.toHaveBeenCalled();
    });
  });
});
