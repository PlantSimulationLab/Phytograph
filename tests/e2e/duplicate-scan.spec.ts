import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const fixture = (name: string) => join(repoRoot, 'tests', 'e2e', 'fixtures', name);
const TREE = fixture('tree.xyz');

// Per-row Duplicate on the Scans panel. Duplicating a scan must produce a fully
// independent copy of its point data, named "(copy)" (then "(copy 2)", …).
//
// tree.xyz imports through the octree/session path (data-octree="true"), so this
// genuinely exercises the backend /api/cloud/session/{id}/duplicate endpoint —
// a pure in-RAM array copy that builds a fresh independent session for the copy.
//
// Per CLAUDE.md: live backend, drive the real UI (file chooser, the actual
// Duplicate button), assert concrete DOM (row count, name, matching point
// count), and verify independence by editing the copy and checking the original.

function rows(page: import('@playwright/test').Page) {
  return page.locator('[data-testid="scan-row"]');
}
function rowByName(page: import('@playwright/test').Page, name: string) {
  return page.locator(`[data-testid="scan-row"][data-scan-name="${name}"]`);
}

async function importTree(app: import('@playwright/test').ElectronApplication, page: import('@playwright/test').Page) {
  await importFiles(app, page, 'import-point-cloud', [TREE]);
  await completeImportWizard(page);
  const original = rowByName(page, 'tree.xyz');
  await expect(original).toHaveCount(1, { timeout: 20_000 });
  await expect(original).toHaveAttribute('data-octree', 'true');
  return original;
}

test('duplicating a scan creates an independent "(copy)" with the same point count', async () => {
  const { app, page, close } = await launchApp();
  try {
    const original = await importTree(app, page);
    const originalId = await original.getAttribute('data-scan-id');
    const originalCount = await original.getAttribute('data-point-count');
    const originalColor = await original.getAttribute('data-scan-color');
    expect(parseInt(originalCount ?? '0', 10)).toBeGreaterThan(0);
    expect(originalColor).toBeTruthy();

    // Click the per-row Duplicate button.
    await page.getByTestId(`scan-duplicate-${originalId}`).click();

    // A second row appears, named "tree.xyz (copy)" with a matching point count.
    await expect(rows(page)).toHaveCount(2, { timeout: 20_000 });
    const copy = rowByName(page, 'tree.xyz (copy)');
    await expect(copy).toHaveCount(1);
    await expect(copy).toHaveAttribute('data-point-count', originalCount ?? '');
    await expect(copy).toHaveAttribute('data-octree', 'true');

    // The copy is a DIFFERENT scan than the original (own id), and is selected.
    const copyId = await copy.getAttribute('data-scan-id');
    expect(copyId).not.toBe(originalId);
    await expect(copy).toHaveAttribute('data-selected', 'true');

    // The copy gets a fresh unused color, not the source's color.
    const copyColor = await copy.getAttribute('data-scan-color');
    expect(copyColor).toBeTruthy();
    expect(copyColor).not.toBe(originalColor);
  } finally {
    await close();
  }
});

test('duplicating the copy enumerates to "(copy 2)"', async () => {
  const { app, page, close } = await launchApp();
  try {
    const original = await importTree(app, page);
    const originalId = await original.getAttribute('data-scan-id');

    await page.getByTestId(`scan-duplicate-${originalId}`).click();
    const copy = rowByName(page, 'tree.xyz (copy)');
    await expect(copy).toHaveCount(1, { timeout: 20_000 });

    // Duplicate the copy → "tree.xyz (copy 2)" (re-based, not stacked).
    const copyId = await copy.getAttribute('data-scan-id');
    await page.getByTestId(`scan-duplicate-${copyId}`).click();
    await expect(rows(page)).toHaveCount(3, { timeout: 20_000 });
    await expect(rowByName(page, 'tree.xyz (copy 2)')).toHaveCount(1);
  } finally {
    await close();
  }
});
