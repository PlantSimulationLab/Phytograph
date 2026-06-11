import type { ElectronApplication, Page } from '@playwright/test';

// File→Import menu command kinds (mirror of MenuCommandPayload's import
// variants in src/shared/ipc.ts).
export type ImportKind = 'import-auto' | 'import-point-cloud' | 'import-mesh' | 'import-skeleton';

// Imports files through the File→Import menu pathway.
//
// First fires the real menu command over IPC — exactly what a native menu
// click does (main → `webContents.send(IPC.MenuCommand, payload)`,
// src/main/menu.ts) — which the renderer's onMenuCommand handler receives,
// setting the pending import type. Then it hands the files to the dropzone's
// hidden <input> directly: the same onDrop path drag-and-drop uses.
//
// We feed the input rather than waiting on an OS file chooser because the menu
// command reaches the renderer without user activation, so react-dropzone's
// open() can't surface a native dialog under automation. (Routing is by file
// extension regardless, so the explicit `kind` and auto-detect agree for every
// fixture here; the menu command keeps the type explicit and exercises the
// real menu IPC.) E2E runs with the native menu chrome disabled (menu.ts
// short-circuits under PHYTOGRAPH_E2E) and the in-window import dropdown was
// removed, so this is the import entry point for the suite.
export async function importFiles(
  app: ElectronApplication,
  page: Page,
  kind: ImportKind,
  files: string | string[],
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, k) => {
    // IPC.MenuCommand === 'menu:command' (src/shared/ipc.ts). Hard-coded for
    // the same reason stubOpenDialog hard-codes 'dialog:open': the evaluate
    // body is serialized into the main process and can't close over TS imports.
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: k });
  }, kind);
  await page.getByTestId('app-dropzone-input').setInputFiles(files);
}
