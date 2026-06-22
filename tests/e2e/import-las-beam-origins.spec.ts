import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// Importing a LAS that carries per-pulse beam-origin ExtraBytes (ox/oy/oz) must
// create a MOVING-platform scan with a reconstructed trajectory — not a plain static
// cloud. The backend reads the float64 origins, rebuilds a decimated platform path
// from them (+ gps_time), and surfaces it as the scan's parameters; the renderer
// auto-attaches it so the scan is flagged moving. Drives the real File→Import → Point
// Cloud pathway against the live backend (no mocks), per CLAUDE.md.
test('Imports a LAS with beam-origin ExtraBytes as a moving-platform scan', async () => {
  const { app, page, close } = await launchApp();

  try {
    const las = join(
      repoRoot, 'tests', 'e2e', 'fixtures', 'moving-scan', 'beam_origins.las');
    await importFiles(app, page, 'import-point-cloud', [las]);
    await completeImportWizard(page);

    const row = page.locator(
      '[data-testid="scan-row"][data-scan-name="beam_origins.las"]');
    await expect(row).toBeVisible({ timeout: 30_000 });

    // The 120 returns load…
    expect(parseInt((await row.getAttribute('data-point-count')) ?? '0', 10)).toBe(120);
    // …and the per-pulse origins made it a MOVING scan with parameters, not a
    // static cloud — the behavior the plain-cloud import used to miss.
    await expect(row).toHaveAttribute('data-has-params', 'true');
    await expect(row).toHaveAttribute('data-moving', 'true');
    await expect(row.getByTestId('scan-row-moving')).toBeVisible();
  } finally {
    await close();
  }
});
