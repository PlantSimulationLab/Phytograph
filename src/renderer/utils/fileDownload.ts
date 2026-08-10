// Save-as helpers backed by Electron's native dialog + fs (via preload IPC).
// Falls back to an anchor-blob download when running in a plain browser (e.g.
// vite dev outside Electron), so dev outside Electron still produces a file.

function fileExt(name: string): string {
  return name.split('.').pop() ?? '';
}

// MIME type for the browser-fallback blob. Only .csv/.json/.xml have registered
// text types worth naming; .obj/.ply/.stl have no standard one, so plain text is
// the honest answer (the extension still drives the saved filename).
function textMimeType(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'csv': return 'text/csv;charset=utf-8;';
    case 'json': return 'application/json;charset=utf-8;';
    case 'xml': return 'application/xml;charset=utf-8;';
    default: return 'text/plain;charset=utf-8;';
  }
}

function browserDownload(content: string | Uint8Array, suggestedFilename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', suggestedFilename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Save bytes to a user-chosen path, WITHOUT showing any toast.
 *
 * Returns the written path, or null if the user cancelled the save dialog.
 * Throws if the write itself fails.
 *
 * This is the primitive the export flows use: they own a single "Export
 * Complete" toast naming the file and point count, so a helper that toasts on
 * its own would double-report. Prefer this over an `<a download>` click —
 * under Electron that becomes an out-of-band Chromium download whose native
 * Save-As the renderer never observes, so the caller cannot tell whether (or
 * where) the file was written and ends up reporting success too early.
 */
export async function saveBinaryFileQuiet(
  content: Uint8Array,
  suggestedFilename: string,
  mimeType: string = 'application/octet-stream',
): Promise<string | null> {
  if (!window.electronAPI) {
    // Plain-browser fallback (vite dev outside Electron): no path to report.
    browserDownload(content, suggestedFilename, mimeType);
    return suggestedFilename;
  }
  const ext = fileExt(suggestedFilename);
  const filePath = await window.electronAPI.dialog.save({
    defaultPath: suggestedFilename,
    title: 'Save Results',
    filters: ext ? [{ name: ext.toUpperCase() + ' files', extensions: [ext] }] : [],
  });
  if (!filePath) return null;

  const ab = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
  await window.electronAPI.fs.writeBinary(filePath, ab);
  return filePath;
}

/** Text sibling of `saveBinaryFileQuiet` — same contract, no toast. */
export async function saveTextFileQuiet(
  content: string,
  suggestedFilename: string,
): Promise<string | null> {
  if (!window.electronAPI) {
    browserDownload(content, suggestedFilename, textMimeType(fileExt(suggestedFilename)));
    return suggestedFilename;
  }
  const ext = fileExt(suggestedFilename);
  const filePath = await window.electronAPI.dialog.save({
    defaultPath: suggestedFilename,
    title: 'Save Results',
    filters: ext ? [{ name: ext.toUpperCase() + ' files', extensions: [ext] }] : [],
  });
  if (!filePath) return null;

  await window.electronAPI.fs.writeText(filePath, content);
  return filePath;
}

export async function downloadBinaryFile(
  content: Uint8Array,
  suggestedFilename: string,
  mimeType: string = 'application/octet-stream',
): Promise<boolean> {
  console.log('downloadBinaryFile:', suggestedFilename, 'bytes:', content.length);

  if (window.electronAPI) {
    try {
      const filePath = await saveBinaryFileQuiet(content, suggestedFilename, mimeType);
      if (!filePath) return false;

      const { showToast } = await import('../components/Toast');
      showToast({ type: 'success', title: 'Download Complete', message: 'File saved successfully', duration: 4000 });
      return true;
    } catch (err) {
      console.error('Binary save failed:', err);
      const { showToast } = await import('../components/Toast');
      showToast({
        type: 'error',
        title: 'Download Failed',
        message: `Failed to save file: ${(err as Error)?.message ?? String(err)}`,
        duration: 6000,
      });
      throw err;
    }
  }

  browserDownload(content, suggestedFilename, mimeType);
  return true;
}

export async function downloadFile(content: string, suggestedFilename: string): Promise<boolean> {
  console.log('downloadFile:', suggestedFilename, 'chars:', content.length);

  if (window.electronAPI) {
    // Derive the filter from the suggested name's own extension. This path
    // serves every TEXT export — .csv, but also .obj/.ply/.stl skeleton and
    // mesh exports, .json parameter/skeleton sets, and .xml scan bundles — so a
    // hardcoded CSV filter hid the file the user was actually saving.
    const ext = fileExt(suggestedFilename);
    try {
      const filePath = await window.electronAPI.dialog.save({
        defaultPath: suggestedFilename,
        title: 'Save Results',
        filters: ext
          ? [{ name: ext.toUpperCase() + ' files', extensions: [ext] }]
          : [],
      });
      if (!filePath) return false;

      await window.electronAPI.fs.writeText(filePath, content);

      const { showToast } = await import('../components/Toast');
      showToast({ type: 'success', title: 'Download Complete', message: 'File saved successfully', duration: 4000 });
      return true;
    } catch (err) {
      console.error('Text save failed:', err);
      const { showToast } = await import('../components/Toast');
      showToast({
        type: 'error',
        title: 'Download Failed',
        message: `Failed to save file: ${(err as Error)?.message ?? String(err)}`,
        duration: 6000,
      });
      throw err;
    }
  }

  browserDownload(content, suggestedFilename, textMimeType(fileExt(suggestedFilename)));
  return true;
}
