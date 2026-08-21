import type { ElectronApplication, Page } from '@playwright/test';
import { stubOpenDialog } from './stubOpenDialog';

// Drive the Export window's batch export ("Export objects"), which asks for a
// destination FOLDER plus a base name typed in the window — not a Save-As path.
//
// The old flow routed through a native Save panel, so specs stubbed
// `dialog:save` with a full file path. That panel named exactly one file and the
// export writes one per object, so it misdescribed every multi-object run; the
// window now owns the base name and previews the resulting file names, and the
// only thing the OS is asked for is the folder.
//
// Call this BEFORE clicking `export-scan-xml`. It re-stubs `dialog:open`, so any
// earlier stub used for importing a fixture is replaced — which is what you want:
// the import has already happened by then.
export async function stubExportFolder(
  app: ElectronApplication,
  page: Page,
  dir: string,
  baseName?: string,
): Promise<void> {
  await stubOpenDialog(app, dir);
  if (baseName !== undefined) {
    await page.getByTestId('export-base-name').fill(baseName);
  }
}
