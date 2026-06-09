import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { completeImportWizard } from './helpers/importWizard';

const fixture = (name: string) => join(repoRoot, 'tests', 'e2e', 'fixtures', name);
const TINY = fixture('tiny.xyz');
const TREE = fixture('tree.xyz');
const TREE2 = fixture('tree2.xyz');

// Selection-aware bulk actions on the Scans panel header. The header eye/trash
// act on the current selection when one exists, else on the whole section, and
// a batch delete uses ONE confirmation. These were added to replace the old
// one-row-at-a-time hide/delete (each delete its own modal).
//
// Per CLAUDE.md: live backend, drive the real UI (file chooser, header
// buttons, modifier clicks), assert concrete DOM state (data-visible counts,
// exactly one confirm dialog, row count after delete).

async function importThreeScans(page: import('@playwright/test').Page) {
  await page.getByTestId('import-menu-button').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('import-menu-pointcloud').click(),
  ]);
  await chooser.setFiles([TINY, TREE, TREE2]);
  await completeImportWizard(page);

  const rows = page.locator('[data-testid="scan-row"]');
  await expect(rows).toHaveCount(3, { timeout: 20_000 });
}

function rowByName(page: import('@playwright/test').Page, name: string) {
  return page.locator(`[data-testid="scan-row"][data-scan-name="${name}"]`);
}

test('header hide acts only on the selection, leaving unselected scans visible', async () => {
  const { page, close } = await launchApp();
  try {
    await importThreeScans(page);

    const tiny = rowByName(page, 'tiny.xyz');
    const tree = rowByName(page, 'tree.xyz');
    const tree2 = rowByName(page, 'tree2.xyz');

    // All start visible.
    await expect(tiny).toHaveAttribute('data-visible', 'true');
    await expect(tree).toHaveAttribute('data-visible', 'true');
    await expect(tree2).toHaveAttribute('data-visible', 'true');

    // Select two via plain click + Ctrl/Cmd click.
    await tiny.click();
    await tree.click({ modifiers: ['ControlOrMeta'] });
    await expect(tiny).toHaveAttribute('data-selected', 'true');
    await expect(tree).toHaveAttribute('data-selected', 'true');
    await expect(tree2).toHaveAttribute('data-selected', 'false');

    // Header hide: only the two selected scans go hidden; the third stays.
    await page.getByTestId('scans-bulk-hide').click();
    await expect(tiny).toHaveAttribute('data-visible', 'false');
    await expect(tree).toHaveAttribute('data-visible', 'false');
    await expect(tree2).toHaveAttribute('data-visible', 'true');
  } finally {
    await close();
  }
});

test('header hide with no selection toggles the whole section', async () => {
  const { page, close } = await launchApp();
  try {
    await importThreeScans(page);
    const rows = page.locator('[data-testid="scan-row"]');

    // Nothing selected (deselect any auto-selection from import).
    await page.getByTitle('Deselect All').click();
    await expect(page.locator('[data-testid="scan-row"][data-selected="true"]')).toHaveCount(0);

    // First press hides everything (any visible → hide all).
    await page.getByTestId('scans-bulk-hide').click();
    for (let i = 0; i < 3; i++) {
      await expect(rows.nth(i)).toHaveAttribute('data-visible', 'false');
    }

    // Second press shows everything (all hidden → show all).
    await page.getByTestId('scans-bulk-hide').click();
    for (let i = 0; i < 3; i++) {
      await expect(rows.nth(i)).toHaveAttribute('data-visible', 'true');
    }
  } finally {
    await close();
  }
});

test('header delete removes the selection behind a single confirmation', async () => {
  const { page, close } = await launchApp();
  try {
    await importThreeScans(page);

    const tiny = rowByName(page, 'tiny.xyz');
    const tree = rowByName(page, 'tree.xyz');

    // Select two scans.
    await tiny.click();
    await tree.click({ modifiers: ['ControlOrMeta'] });

    // Header delete → exactly ONE confirm dialog, copy reads "2 scans".
    await page.getByTestId('scans-bulk-delete').click();
    const confirmTitle = page.getByTestId('delete-confirm-title');
    await expect(confirmTitle).toBeVisible();
    await expect(confirmTitle).toHaveText('Delete 2 scans?');
    await expect(page.getByTestId('confirm-delete')).toHaveCount(1);

    await page.getByTestId('confirm-delete').click();

    // Both selected scans gone; the third remains. No second dialog.
    await expect(page.locator('[data-testid="scan-row"]')).toHaveCount(1);
    await expect(rowByName(page, 'tree2.xyz')).toBeVisible();
    await expect(page.getByTestId('confirm-delete')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('a single-row trash still confirms with the scan name, not a count', async () => {
  const { page, close } = await launchApp();
  try {
    await importThreeScans(page);

    // Click the per-row trash on tree.xyz (unchanged single-delete path).
    const tree = rowByName(page, 'tree.xyz');
    const id = await tree.getAttribute('data-scan-id');
    await page.getByTestId(`scan-delete-${id}`).click();

    const confirmTitle = page.getByTestId('delete-confirm-title');
    await expect(confirmTitle).toHaveText('Delete cloud?');
    await page.getByTestId('confirm-delete').click();

    await expect(page.locator('[data-testid="scan-row"]')).toHaveCount(2);
    await expect(rowByName(page, 'tree.xyz')).toHaveCount(0);
  } finally {
    await close();
  }
});
