import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadBinaryFile, downloadFile } from './fileDownload';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('downloadFile (text)', () => {
  it('returns false when the user cancels the save dialog', async () => {
    window.electronAPI.dialog.save = vi.fn(async () => null);
    window.electronAPI.fs.writeText = vi.fn(async () => undefined);
    const result = await downloadFile('contents', 'out.csv');
    expect(result).toBe(false);
    expect(window.electronAPI.fs.writeText).not.toHaveBeenCalled();
  });

  it('writes the file via fs.writeText when the dialog returns a path', async () => {
    window.electronAPI.dialog.save = vi.fn(async () => '/tmp/out.csv');
    const writeText = vi.fn(async () => undefined);
    window.electronAPI.fs.writeText = writeText;
    const result = await downloadFile('a,b,c\n1,2,3', 'out.csv');
    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledWith('/tmp/out.csv', 'a,b,c\n1,2,3');
  });

  it('rethrows when fs.writeText fails', async () => {
    window.electronAPI.dialog.save = vi.fn(async () => '/tmp/out.csv');
    window.electronAPI.fs.writeText = vi.fn(async () => {
      throw new Error('disk full');
    });
    await expect(downloadFile('contents', 'out.csv')).rejects.toThrow('disk full');
  });

  it('falls back to browser-blob download when electronAPI is absent', async () => {
    // Save and restore so we don't bleed into other tests.
    const orig = window.electronAPI;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electronAPI;

    const clickSpy = vi.fn();
    const createObjectURLSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:fake');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    // Patch HTMLAnchorElement.click on this specific instance via DOM stub.
    const origCreateEl = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = origCreateEl(tag as keyof HTMLElementTagNameMap);
      if (tag === 'a') (el as HTMLAnchorElement).click = clickSpy;
      return el;
    }) as typeof document.createElement);

    try {
      const result = await downloadFile('hello', 'out.csv');
      expect(result).toBe(true);
      expect(createObjectURLSpy).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
      expect(revokeSpy).toHaveBeenCalledWith('blob:fake');
    } finally {
      window.electronAPI = orig;
    }
  });
});

describe('downloadBinaryFile', () => {
  it('returns false on dialog cancel', async () => {
    window.electronAPI.dialog.save = vi.fn(async () => null);
    window.electronAPI.fs.writeBinary = vi.fn(async () => undefined);
    const result = await downloadBinaryFile(new Uint8Array([1, 2, 3]), 'out.bin');
    expect(result).toBe(false);
    expect(window.electronAPI.fs.writeBinary).not.toHaveBeenCalled();
  });

  it('writes via fs.writeBinary with the underlying ArrayBuffer', async () => {
    window.electronAPI.dialog.save = vi.fn(async () => '/tmp/out.las');
    const writeBinary = vi.fn<(path: string, contents: ArrayBuffer) => Promise<void>>(
      async () => undefined,
    );
    window.electronAPI.fs.writeBinary = writeBinary;
    const bytes = new Uint8Array([10, 20, 30, 40]);
    const result = await downloadBinaryFile(bytes, 'out.las');
    expect(result).toBe(true);
    const [savedPath, savedBuf] = writeBinary.mock.calls[0];
    expect(savedPath).toBe('/tmp/out.las');
    expect(savedBuf).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(savedBuf)).toEqual(bytes);
  });

  it('uses the file extension to set the dialog filter', async () => {
    const save = vi.fn(async () => null);
    window.electronAPI.dialog.save = save;
    await downloadBinaryFile(new Uint8Array([0]), 'tree.laz');
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: 'tree.laz',
        filters: [{ name: 'LAZ files', extensions: ['laz'] }],
      }),
    );
  });

  it('rethrows when fs.writeBinary fails', async () => {
    window.electronAPI.dialog.save = vi.fn(async () => '/tmp/out.bin');
    window.electronAPI.fs.writeBinary = vi.fn(async () => {
      throw new Error('permission denied');
    });
    await expect(
      downloadBinaryFile(new Uint8Array([1]), 'out.bin'),
    ).rejects.toThrow('permission denied');
  });

  it('falls back to browser-blob download when electronAPI is absent', async () => {
    const orig = window.electronAPI;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electronAPI;

    const clickSpy = vi.fn();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bin');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const origCreateEl = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = origCreateEl(tag as keyof HTMLElementTagNameMap);
      if (tag === 'a') (el as HTMLAnchorElement).click = clickSpy;
      return el;
    }) as typeof document.createElement);

    try {
      const result = await downloadBinaryFile(new Uint8Array([1, 2, 3]), 'out.bin');
      expect(result).toBe(true);
      expect(clickSpy).toHaveBeenCalled();
    } finally {
      window.electronAPI = orig;
    }
  });
});
